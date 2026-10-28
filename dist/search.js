/**
 * Memory Search — 中性通用检索
 *
 * 策略：
 *   1. 标签搜索(0 向量调用)→ 不够回退向量 KNN
 *   2. 评分：语义一致性为主(60%)，时间衰减(30%)，情绪标记弱化(10%)
 *
 * 权重全部可经环境变量调整，适用于通用 agent 记忆场景。
 */
import { DatabaseManager, listProjectNames } from './db.js';
import { embed } from './ollama.js';
import { normalizeProject, isEmbedEnabled } from './env.js';
import { normalizeMemType } from './memType.js';
import { parseTagsSafe } from './tags.js';
// 中性评分权重(可配)
const WEIGHT_CONSISTENCY = parseFloat(process.env.WEIGHT_CONSISTENCY || '0.65'); // 语义/标签匹配
const WEIGHT_TIME = parseFloat(process.env.WEIGHT_TIME || '0.35'); // 时间衰减
// 时间衰减半衰期(小时),默认 30 天
const HALF_LIFE_HOURS = parseFloat(process.env.HALF_LIFE_HOURS || (30 * 24).toString());
// minScore 阈值可配;harness 可用 SEARCH_MIN_SCORE 覆盖
const SEARCH_PROFILES = {
    quick: { topK: 3, minScore: 0.6 },
    balanced: { topK: 5, minScore: parseFloat(process.env.SEARCH_MIN_SCORE || '0.15') },
    deep: { topK: 10, minScore: 0.1 },
};
/** 指数时间衰减:30 天半衰期 */
function timeDecay(hoursSinceCreated) {
    if (hoursSinceCreated <= 0)
        return 1;
    return Math.pow(0.5, hoursSinceCreated / HALF_LIFE_HOURS);
}
// 时效类内容(对话/会话记录)半衰期缩短,自然沉底(可配,默认 10 天)
const EPHEMERAL_HALF_LIFE_HOURS = parseFloat(process.env.EPHEMERAL_HALF_LIFE_HOURS || (10 * 24).toString());
const EPHEMERAL_CATEGORIES = new Set((process.env.EPHEMERAL_CATEGORIES || 'conversation,session,context').split(',').map(s => s.trim()).filter(Boolean));
/**
 * 分级时间衰减:
 * - critical 权威结论/身份/里程碑→ 时间不衰减(ban 时间,永葆权威)
 * - 时效类(对话/会话记录)→ 短半衰期,自然沉底(可用 EPHEMERAL_CATEGORIES 配置)
 * - 其余(standard 画像等)→ 默认 30 天半衰期
 */
function decayFor(row, hoursSinceCreated) {
    if (hoursSinceCreated <= 0)
        return 1;
    if (row.tier === 'critical')
        return 1; // 权威结论不随时间衰减
    const cat = row.category || '';
    const src = row.source || '';
    if (EPHEMERAL_CATEGORIES.has(cat) || src === 'conversation_log' || src === 'session_memory') {
        return Math.pow(0.5, hoursSinceCreated / EPHEMERAL_HALF_LIFE_HOURS);
    }
    return timeDecay(hoursSinceCreated);
}
/** 统一评分:一致性 + 情绪(弱) + 时间 */
function computeScore(similarity, row) {
    const consistency = Math.min(Math.max(similarity, 0), 0.85);
    const hoursSinceCreated = (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60);
    const decay = decayFor(row, hoursSinceCreated);
    // 2026-10-28:原来 critical ×2.0、importance ×(0.5+imp)、访问次数 ×(1~1.5) 全乘在总分上,
    // 结构性元数据能压过相关性(Anima 上实测:6 字垃圾行 score 4.3 排第一,真答案 1.88)。收成有界项。
    const tierBoost = row.tier === 'critical' ? 1.10 : (row.tier === 'temporary' ? 0.95 : 1.0);
    const importanceMult = 0.85 + 0.3 * (row.importance || 0.5);
    const accessBoost = 1 + Math.min(0.08, Math.log2(1 + (row.accessed_count || 0)) * 0.02);
    const rawScore = WEIGHT_CONSISTENCY * consistency
        + WEIGHT_TIME * decay;
    return Math.round(rawScore * importanceMult * tierBoost * accessBoost * 1000) / 1000;
}
/**
 * 标签优先搜索 → 不足时回退向量 KNN
 */
export async function searchMemory(options) {
    const proj = normalizeProject(options.project);
    const topK = options.topK ?? 10;
    // memdir:memType 指定 → 单分类库;未指定 → 聚合项目**已存在**的分类库
    // v1.23.2-fix: 读路径不能懒建库（拼错 project 会在磁盘造 5 个空库）
    const existing = DatabaseManager.existingMemTypes(proj);
    const mtFilter = options.memType ? normalizeMemType(options.memType) : null;
    const dirs = mtFilter ? existing.filter(mt => mt === mtFilter) : existing;
    const all = [];
    const perDb = [];
    for (const mt of dirs) {
        try {
            const db = DatabaseManager.getInstance(proj, mt);
            const r = await searchInDb(db, { ...options, project: proj });
            perDb.push({ db, results: r });
            all.push(...r);
        }
        catch { /* 单分类库失败不影响其他 */ }
    }
    all.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const unique = [];
    for (const r of all) {
        if (!seen.has(r.id)) {
            seen.add(r.id);
            unique.push(r);
        }
        if (unique.length >= topK)
            break;
    }
    // v1.23.2-fix: 只在全局 topK 选定后记账（旧实现每个库各自记 5×topK 条）
    const chosen = new Set(unique.map(r => r.id));
    for (const p of perDb) {
        const rows = p.results.filter(r => chosen.has(r.id));
        if (rows.length)
            updateAccessed(p.db, rows);
    }
    return unique.slice(0, topK);
}
/** 单库搜索主体(标签 → 向量 KNN → 文本回退),按分类库调用 */
async function searchInDb(db, options) {
    const profile = options.profile ? SEARCH_PROFILES[options.profile] : null;
    const topK = options.topK ?? profile?.topK ?? 10;
    const minScore = options.minScore ?? profile?.minScore ?? 0;
    // ═══ Phase 1: 标签搜索 + 词法(FTS5/BM25)(0 次向量调用) ═══
    // v1.24: 词法通道与标签并列进 Phase 1 —— 精确短语命中不该排在向量后面，
    // 而且 FTS 是本地 CPU 活，比一次远端 embed 便宜三个数量级。
    const tagResults = tagSearch(db, options);
    const lexical = lexicalSearch(db, options, new Set(tagResults.map(r => r.id)), topK);
    const tagResults2 = [...tagResults, ...lexical].sort((a, b) => b.score - a.score);
    // 标签/词法结果足够好 → 直接返回（访问记账统一在 searchMemory 里做）
    if (tagResults2.length >= topK && tagResults2[0].score >= 0.5) {
        return tagResults2.slice(0, topK);
    }
    // ═══ Phase 2: 不足 → 向量 KNN 补充(EMBED_MODE=none 时跳过,纯文本回退) ═══
    const existingIds = new Set(tagResults2.map(r => r.id));
    let vectorResults = [];
    if (isEmbedEnabled()) {
        let vecOk = false;
        try {
            const queryVector = await embed(options.query, options.project);
            const floatQuery = new Float32Array(queryVector);
            vectorResults = vectorKnnSearch(db, options, floatQuery, existingIds, topK, minScore);
            vecOk = true;
        }
        catch {
            vecOk = false;
        }
        // 2026-10-27 修复(E6a):原来只在 embed/KNN **抛错**时回退。vec_memory 为空
        // (换模型清空后尚未补齐、维度刚重建、批量嵌入没跑)时 KNN 会"成功返回 0 行",
        // 于是嵌入服务明明健康却静默 0 命中。零命中同样要回退到文本检索。
        // 2026-10-28(2):有向量时也**始终**合并词法结果。原来只在 KNN 抛错/零命中时才回退,
        // 向量一旦返回任何一条(哪怕相似度 0.37)就把精确词法命中(0.5~1.0)整条挤掉。
        // 同 id 去重时保留 similarity 更高的那份(下方 bestById)。
        vectorResults = [...vectorResults, ...textFallbackSearch(db, options, new Set(), topK, minScore)];
        if (vectorResults.length === 0 && !vecOk) {
            vectorResults = textFallbackSearch(db, options, new Set(), topK, minScore);
        }
    }
    else {
        // 纯本地模式:标签结果不足时直接文本回退
        vectorResults = textFallbackSearch(db, options, existingIds, topK, minScore);
    }
    // 合并 + 去重 + 排序
    const merged = [...tagResults2, ...vectorResults];
    merged.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const unique = [];
    for (const r of merged) {
        if (!seen.has(r.id)) {
            seen.add(r.id);
            unique.push(r);
        }
        if (unique.length >= topK)
            break;
    }
    return unique.slice(0, topK);
}
/**
 * 跨库搜索(多项目合并,2026-08-16) — 显式语义:
 * 调用方明确指定要搜哪些库(projects),引擎不做隐式合并/共享魔法;
 * 互通规则由上层决定(接口先行)。结果按 score 降序,每行 project 标注来源库。
 * projects=['*'] 或 ['all'] → 本实例全部库(扫描 memory 目录)。
 */
export async function searchMemoryAcross(options) {
    const raw = (options.projects ?? []).map(x => (x ?? '').trim()).filter(Boolean);
    const targetProjects = raw.length === 0
        ? [normalizeProject(options.project)]
        : raw.some(x => x === '*' || x === 'all')
            ? listProjectNames()
            : raw.map(normalizeProject);
    const perProject = Math.max(3, Math.ceil((options.topK ?? 10) * 1.5));
    const all = [];
    for (const proj of targetProjects) {
        try {
            const r = await searchMemory({ ...options, project: proj, topK: perProject });
            all.push(...r);
        }
        catch {
            // 单个库失败不影响其他库
        }
    }
    all.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const unique = [];
    for (const r of all) {
        if (seen.has(r.id))
            continue;
        seen.add(r.id);
        unique.push(r);
    }
    return unique.slice(0, options.topK ?? 10);
}
// ═══════════════════════════════════════════════════════════════════
// 标签搜索 — 从 query 提取关键词，SQL tag LIKE 匹配
// ═══════════════════════════════════════════════════════════════════
const QUERY_STOP_WORDS = new Set(['的', '了', '是', '我', '你', '他', '她', '吗', '呢', '吧', '啊',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'of', 'and', 'or',
    '有', '在', '不', '要', '会', '能', '就', '都', '也', '还', '和', '与', '这', '那', '什么', '怎么']);
/**
 * 检索词切分(2026-10-28,移植自 Anima v1.28.3):中文没有空格时整句会变成一个超长 token,
 * `text LIKE` / `tags LIKE` 永远匹配不到 —— 自然问句召回 0 条。CJK 连续段按 bigram 切分,
 * 其它语言仍按空白/标点切;词数封顶,避免 SQL 条件爆炸。
 */
export function queryTerms(query, max = 16) {
    const out = new Set();
    for (const raw of String(query ?? '').split(/[\s,，。！？、；：""''（）()\[\]【】\-\/\\|]+/)) {
        const seg = raw.trim();
        if (seg.length < 2)
            continue;
        if (!/[\u4e00-\u9fff]/.test(seg))
            out.add(seg);
        else
            for (let i = 0; i + 2 <= seg.length; i++)
                out.add(seg.slice(i, i + 2));
        if (out.size >= max)
            break;
    }
    return [...out].slice(0, max);
}
/** 从中文/英文 query 中提取关键词 */
function extractKeywords(query) {
    return queryTerms(query).filter(t => !QUERY_STOP_WORDS.has(t.toLowerCase()));
}
/** SQL 标签搜索：匹配 memory.tags JSON 数组 */
function tagSearch(db, options) {
    const keywords = extractKeywords(options.query);
    if (keywords.length === 0)
        return [];
    const profile = options.profile ? SEARCH_PROFILES[options.profile] : null;
    const topK = options.topK ?? profile?.topK ?? 10;
    const project = normalizeProject(options.project);
    const tagCond = keywords.map(() => `m.tags LIKE ?`).join(' OR ');
    const tagParams = keywords.map(k => `%"${k}"%`);
    const looseCond = keywords.map(() => `m.tags LIKE ?`).join(' OR ');
    const looseParams = keywords.map(k => `%${k}%`);
    // v1.23-fix: superseded 在三条检索路径上一致排除（此前只有向量路径过滤，标签/文本路径仍会返回被接管的旧记忆）
    const conditions = ['m.is_active = 1', 'm.project = ?', "COALESCE(m.status, '') <> 'superseded'"];
    const params = [project];
    conditions.push(`((${tagCond}) OR (${looseCond}))`);
    params.push(...tagParams, ...looseParams);
    if (options.type) {
        conditions.push('m.type = ?');
        params.push(options.type);
    }
    if (options.memType) {
        conditions.push('m.mem_type = ?');
        params.push(options.memType);
    }
    if (options.category) {
        conditions.push('m.category = ?');
        params.push(options.category);
    }
    if (options.characterId) {
        conditions.push('m.character_id = ?');
        params.push(options.characterId);
    }
    if (options.subject) {
        conditions.push('m.subject = ?');
        params.push(options.subject);
    }
    const rows = db.prepare(`
    SELECT m.id, m.text, m.project, m.type, m.mem_type, m.category, m.subcategory, m.tags,
      m.importance, m.character_id, m.source,
      m.subject, m.tier, m.parent_id,
      m.created_at, m.last_accessed_at, m.accessed_count
    FROM memory m
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${options.sort === 'priority'
        ? 'COALESCE(m.score_priority, 0) DESC, m.importance DESC, m.created_at DESC'
        : options.sort === 'urgency'
            ? 'COALESCE(m.score_urgency, 0) DESC, m.importance DESC, m.created_at DESC'
            : 'm.importance DESC, m.created_at DESC'}
    LIMIT ?
  `).all(...params, topK * 3);
    return rows.map(row => {
        const memTags = parseTagsSafe(row.tags);
        const matchedTags = keywords.filter(k => memTags.some((t) => t.toLowerCase().includes(k.toLowerCase()))).length;
        const tagScore = Math.min(1.0, matchedTags / Math.max(1, keywords.length));
        return {
            id: row.id, text: row.text, project: row.project || 'default', type: row.type, memType: row.mem_type || 'general', category: row.category,
            subcategory: row.subcategory, tags: memTags,
            importance: row.importance,
            characterId: row.character_id, source: row.source,
            subject: row.subject || 'user', tier: row.tier || 'standard',
            parentId: row.parent_id || null,
            score: computeScore(tagScore, row), similarity: Math.round(tagScore * 1000) / 1000,
            createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
            accessedCount: row.accessed_count,
        };
    });
}
/**
 * v1.24 词法通道：FTS5(trigram) + BM25。
 * 与 tags LIKE / 向量 KNN / text LIKE 并列的第四路，专治"精确短语"：
 * 古籍原句、卦名爻辞、错误码、文件路径、端口号、函数名。
 * 相似度由 BM25 排名折算（不是原始 bm25 值 —— 它随查询长度剧烈变化），
 * 再走同一个 computeScore，保证时间衰减/重要性/层级的语义与其它通道一致。
 */
function lexicalSearch(db, options, excludeIds, topK) {
    const terms = String(options.query || '').split(/\s+/).map(t => t.trim()).filter(Boolean);
    // trigram 分词器要求每个词 ≥3 字符；短词（中文二字）由 textFallbackSearch 的 LIKE 兜底
    if (terms.length === 0 || terms.some(t => t.length < 3))
        return [];
    const match = terms.map(t => `"${t.replace(/"/g, '""')}"`).join(' AND ');
    const where = ['memory_fts MATCH ?', 'm.is_active = 1', "COALESCE(m.status,'') <> 'superseded'"];
    const params = [match];
    if (options.project) {
        where.push('m.project = ?');
        params.push(options.project);
    }
    if (options.category) {
        where.push('m.category = ?');
        params.push(options.category);
    }
    let rows = [];
    try {
        rows = db.prepare(`
      SELECT m.*, bm25(memory_fts) AS rank
      FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
      WHERE ${where.join(' AND ')}
      ORDER BY rank LIMIT ?
    `).all(...params, Math.max(topK * 3, 12));
    }
    catch {
        return []; // 库没建 FTS 或语法不支持 → 静默退回其它通道
    }
    return rows
        .filter(row => !excludeIds.has(row.id))
        .map((row, i) => {
        // 排名折算：首位 0.88，按名次递减，下限 0.45（仍高于纯 LIKE 的 0.3）
        const similarity = Math.max(0.45, 0.88 - i * 0.06);
        return {
            id: row.id, text: row.text, project: row.project || 'default', type: row.type,
            memType: row.mem_type || 'general', category: row.category,
            subcategory: row.subcategory, tags: parseTagsSafe(row.tags),
            importance: row.importance, characterId: row.character_id, source: row.source,
            subject: row.subject || 'user', tier: row.tier || 'standard',
            parentId: row.parent_id || null,
            score: computeScore(similarity, row), similarity: Math.round(similarity * 1000) / 1000,
            basis: 'vector', // 2026-10-28:向量命中自带 basis(注入层按来源取门槛)
            createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
            accessedCount: row.accessed_count,
        };
    });
}
/** 向量 KNN 搜索 */
/**
 * sqlite-vec 的 vec0 默认是 **L2** 距离(建表时没写 distance_metric,见 db.ts),
 * 而这里一直按 `1 - 距离` 当作余弦相似度 —— 单位向量下正确换算是 `1 - d²/2`
 * (d² = 2 - 2cos)。实测:「第 127 位谕女」那句查自己的行,distance=0.6683 而真实
 * 余弦=0.7767,按旧算法得 0.33 → 低于注入门槛,于是**真实语义命中被丢掉**。
 * 排序本来就没错(单位向量下 L2 序 = 余弦序),错的只是喂给门槛的值。
 */
export function l2ToCosine(dist) {
    if (!Number.isFinite(dist))
        return 0;
    return Math.max(0, Math.min(1, 1 - (dist * dist) / 2));
}
function vectorKnnSearch(db, options, floatQuery, excludeIds, topK, minScore) {
    // v1.5: vec0 虚拟表禁止 JOIN(KNN 必须在 vec0 上 LIMIT),项目过滤放在第二段 memory 查询
    // 候选集放大(全库 KNN)保证单项目召回;隔离语义由 memory 查询的 project=? 保证
    const knnLimit = Math.min(topK * 8, 60);
    const project = normalizeProject(options.project);
    let knnRows;
    try {
        knnRows = db.prepare(`
      SELECT rowid, distance FROM vec_memory
      WHERE embedding MATCH ? ORDER BY distance LIMIT ?
    `).all(floatQuery, knnLimit);
    }
    catch {
        return [];
    }
    if (knnRows.length === 0)
        return [];
    const rowidMap = new Map();
    for (const r of knnRows)
        rowidMap.set(Number(r.rowid), r.distance);
    const rowidPlaceholders = knnRows.map(() => '?').join(',');
    const rowidParams = knnRows.map(r => Number(r.rowid));
    const conditions = [`m.rowid IN (${rowidPlaceholders})`, 'm.is_active = 1', 'm.project = ?',
        // v1.23: 被新记忆接管的旧记忆默认不出现在检索结果里（仍可按 id 展开）
        "COALESCE(m.status, '') <> 'superseded'"];
    const params = [...rowidParams, project];
    if (options.type) {
        conditions.push('m.type = ?');
        params.push(options.type);
    }
    if (options.memType) {
        conditions.push('m.mem_type = ?');
        params.push(options.memType);
    }
    if (options.category) {
        conditions.push('m.category = ?');
        params.push(options.category);
    }
    if (options.characterId) {
        conditions.push('m.character_id = ?');
        params.push(options.characterId);
    }
    const rows = db.prepare(`
    SELECT m.id, m.text, m.project, m.type, m.mem_type, m.category, m.subcategory, m.tags,
      m.importance, m.character_id, m.source,
      m.subject, m.tier, m.parent_id,
      m.created_at, m.last_accessed_at, m.accessed_count, m.rowid
    FROM memory m WHERE ${conditions.join(' AND ')}
  `).all(...params);
    const results = [];
    for (const row of rows) {
        // 2026-10-28:原来标签路弱命中(0.33)的行在这里被整条跳掉,强相似度永远上报不了。
        // 不排除,交给合并去重取 similarity 高者。
        const dist = rowidMap.get(row.rowid) ?? 1.0;
        const similarity = l2ToCosine(dist); // L2 → 余弦(2026-10-28)
        const score = computeScore(similarity, row);
        if (score >= minScore) {
            results.push({
                id: row.id, text: row.text, project: row.project || 'default', type: row.type, memType: row.mem_type || 'general', category: row.category,
                subcategory: row.subcategory, tags: parseTagsSafe(row.tags),
                importance: row.importance,
                characterId: row.character_id, source: row.source,
                subject: row.subject || 'user', tier: row.tier || 'standard',
                parentId: row.parent_id || null,
                score, similarity: Math.round(similarity * 1000) / 1000,
                createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
                accessedCount: row.accessed_count,
            });
        }
    }
    return results;
}
/** 文本回退搜索(向量不可用时) */
function textFallbackSearch(db, options, excludeIds, topK, minScore) {
    const terms = queryTerms(options.query);
    if (terms.length === 0)
        return [];
    const project = normalizeProject(options.project);
    // 召回优先:命中 ≥1 词就进候选,精度交给排序(命中词多的排前面)。试过 need=2 的闸门,
    // 结果短问句(只共享 1 个 bigram)又变 0 条,等于没修(2026-10-28)。
    const likeParams = terms.map(t => `%${t}%`);
    const conds = [`m.is_active = 1`, `m.project = ?`, "COALESCE(m.status, '') <> 'superseded'", `(${terms.map(() => 'm.text LIKE ?').join(' OR ')})`];
    const params = [project, ...likeParams];
    if (options.memType) {
        conds.push('m.mem_type = ?');
        params.push(options.memType);
    }
    if (options.type) {
        conds.push('m.type = ?');
        params.push(options.type);
    }
    if (options.category) {
        conds.push('m.category = ?');
        params.push(options.category);
    }
    if (options.characterId) {
        conds.push('m.character_id = ?');
        params.push(options.characterId);
    }
    if (options.subject) {
        conds.push('m.subject = ?');
        params.push(options.subject);
    }
    // 2026-10-28:IDF 加权 —— 「母亲」「黑潮」这类罕见词比「自己」「记得」这种高频 bigram 有信息量,
    // 按命中个数一视同仁会让实体问句的要点行排在后面。
    const dfSql = `SELECT COUNT(*) c FROM memory m WHERE m.is_active = 1 AND m.project = ?`
        + ` AND COALESCE(m.status, '') <> 'superseded'`
        + (options.memType ? ' AND m.mem_type = ?' : '')
        + (options.characterId ? ' AND m.character_id = ?' : '');
    const dfBase = [project, ...(options.memType ? [String(options.memType)] : []), ...(options.characterId ? [options.characterId] : [])];
    let corpusN = 1;
    try {
        corpusN = Number(db.prepare(dfSql).get(...dfBase)?.c) || 1;
    }
    catch {
        corpusN = 1;
    }
    const idf = terms.map((t) => {
        let df = 0;
        try {
            df = Number(db.prepare(`${dfSql} AND m.text LIKE ?`).get(...dfBase, `%${t}%`)?.c) || 0;
        }
        catch {
            df = 0;
        }
        return Math.log(1 + corpusN / (1 + df));
    });
    const totalWeight = idf.reduce((a, b) => a + b, 0) || 1;
    const rows = db.prepare(`
    SELECT m.id, m.text, m.project, m.type, m.mem_type, m.category, m.subcategory, m.tags,
      m.importance, m.character_id, m.source,
      m.subject, m.tier, m.parent_id,
      m.created_at, m.last_accessed_at, m.accessed_count
    FROM memory m
    WHERE ${conds.join(' AND ')}
    ORDER BY (${terms.map(() => `CASE WHEN m.text LIKE ? THEN 1 ELSE 0 END`).join(' + ')}) DESC, m.created_at DESC
    LIMIT ?
  `).all(...params, ...likeParams, topK * 2);
    return rows
        .filter(row => !excludeIds.has(row.id))
        .map(row => {
        // 真实词法覆盖率(IDF 加权),不再硬写 0.3 —— 硬写会让所有词法命中在相关性上完全并列,
        // 排序只能靠元数据决定(2026-10-28)。
        const lower = String(row.text || '').toLowerCase();
        const matchedWeight = terms.reduce((n, t, i) => n + (lower.includes(t.toLowerCase()) ? idf[i] : 0), 0);
        const lexSim = Math.min(1, matchedWeight / totalWeight);
        return {
            id: row.id, text: row.text, project: row.project || 'default', type: row.type, memType: row.mem_type || 'general', category: row.category,
            subcategory: row.subcategory, tags: parseTagsSafe(row.tags),
            importance: row.importance,
            characterId: row.character_id, source: row.source,
            subject: row.subject || 'user', tier: row.tier || 'standard',
            parentId: row.parent_id || null,
            score: computeScore(lexSim, row), similarity: Math.round(lexSim * 1000) / 1000,
            createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
            accessedCount: row.accessed_count,
        };
    });
}
/** 更新记忆访问计数 */
function updateAccessed(db, results) {
    if (results.length === 0)
        return;
    try {
        // v1.23 冷存回温：被检索命中即回到工作集（清掉 status='cold'）。
        // 否则"冷"会变成永久标记——经常被用的记忆反而永远被排除在新沉淀之外。
        const stmt = db.prepare("UPDATE memory SET accessed_count = accessed_count + 1, last_accessed_at = ?, status = CASE WHEN status = 'cold' THEN NULL ELSE status END WHERE id = ?");
        const now = new Date().toISOString();
        const tx = db.transaction((ids) => { for (const id of ids)
            stmt.run(now, id); });
        tx(results.map(r => r.id));
    }
    catch { }
}
/**
 * 快速获取近期重要记忆(用于请求前注入，<5ms)
 * 不做向量搜索，直接按时间+importance 捞
 */
export function getRecentMemories(characterId, limit = 5, hoursBack = 24, project, memType) {
    const proj = normalizeProject(project);
    // memdir:memType 指定 → 单分类库;未指定 → 已存在的分类库（读路径不建库）
    const existing = DatabaseManager.existingMemTypes(proj);
    const dirs = memType ? existing.filter(mt => mt === normalizeMemType(memType)) : existing;
    const all = [];
    const since = new Date(Date.now() - hoursBack * 3600000).toISOString();
    for (const mt of dirs) {
        try {
            const db = DatabaseManager.getInstance(proj, mt);
            const conds = ['is_active = 1', 'character_id = ?', 'project = ?', 'created_at > ?', "COALESCE(status, '') <> 'superseded'"];
            const params = [characterId, proj, since];
            if (memType) {
                conds.push('mem_type = ?');
                params.push(memType);
            }
            params.push(limit);
            const rows = db.prepare(`
        SELECT id, text, project, type, mem_type, category, subcategory, tags,
               importance, character_id, source, subject, tier,
               created_at, last_accessed_at, accessed_count
        FROM memory
        WHERE ${conds.join(' AND ')}
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `).all(...params);
            all.push(...rows.map(row => ({
                id: row.id, text: row.text, project: row.project || 'default', type: row.type, memType: row.mem_type || 'general', category: row.category,
                subcategory: row.subcategory, tags: parseTagsSafe(row.tags),
                importance: row.importance,
                characterId: row.character_id, source: row.source, subject: row.subject || 'user',
                tier: row.tier || 'standard',
                score: row.importance, similarity: 0,
                createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
                accessedCount: row.accessed_count,
            })));
        }
        catch { /* 单分类库失败不影响其他 */ }
    }
    all.sort((a, b) => (b.importance - a.importance) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return all.slice(0, limit);
}
/**
 * 语义搜索事实
 * 将查询文本做 embedding，在 vec_facts 中 KNN 搜索。
 */
export async function searchFacts(query, options = {}) {
    // v1.23.2-fix: facts 只在 general 库；库不存在时返回空，而不是懒建一个空库
    if (!DatabaseManager.existingMemTypes(normalizeProject(options.project)).includes('general'))
        return [];
    const db = DatabaseManager.getInstance(options.project);
    const topK = options.topK ?? 10;
    const minConfidence = options.minConfidence ?? 0.3;
    const proj = normalizeProject(options.project);
    if (!isEmbedEnabled()) {
        return []; // 纯本地模式:facts 无向量可查
    }
    // v1.23.2-fix: 嵌入不可用时返回空结果，而不是让 fact_search 整个工具抛错
    let queryVector;
    try {
        queryVector = await embed(query, options.project);
    }
    catch {
        return [];
    }
    const floatQuery = new Float32Array(queryVector);
    const knnLimit = Math.min(topK * 8, 60);
    let knnRows;
    try {
        knnRows = db.prepare(`
      SELECT rowid, distance
      FROM vec_facts
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(floatQuery, knnLimit);
    }
    catch {
        return [];
    }
    if (knnRows.length === 0)
        return [];
    const rowidMap = new Map();
    for (const r of knnRows) {
        rowidMap.set(Number(r.rowid), r.distance);
    }
    // v1.23-fix: 已失效（valid_to 有值）的旧事实不进检索结果
    const conditions = ['f.is_active = 1', 'f.project = ?', "(f.valid_to IS NULL OR f.valid_to = '')", `f.rowid IN (${knnRows.map(() => '?').join(',')})`];
    const params = [proj, ...knnRows.map(r => Number(r.rowid))];
    if (options.subject) {
        conditions.push('f.subject = ?');
        params.push(options.subject);
    }
    const rows = db.prepare(`
    SELECT f.rowid, f.id, f.subject, f.predicate, f.object, f.confidence,
           f.source_memory_id, f.created_at, f.updated_at
    FROM facts f
    WHERE ${conditions.join(' AND ')}
    ORDER BY f.confidence DESC
  `).all(...params);
    const results = [];
    for (const row of rows) {
        const dist = rowidMap.get(row.rowid) ?? 1.0;
        const similarity = l2ToCosine(dist); // L2 → 余弦(2026-10-28)
        const confidence = row.confidence;
        if (confidence < minConfidence)
            continue;
        results.push({
            id: row.id,
            subject: row.subject,
            predicate: row.predicate,
            object: row.object,
            confidence,
            similarity: Math.round(similarity * 1000) / 1000,
            sourceMemoryId: row.source_memory_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        });
    }
    // 按 similarity × confidence 排序
    results.sort((a, b) => (b.similarity * b.confidence) - (a.similarity * a.confidence));
    // 更新 accessed_count
    if (results.length > 0) {
        try {
            const now = new Date().toISOString();
            const update = db.prepare('UPDATE facts SET accessed_count = accessed_count + 1, updated_at = ? WHERE id = ?');
            const tx = db.transaction((ids) => { for (const id of ids)
                update.run(now, id); });
            tx(results.map(r => r.id));
        }
        catch { }
    }
    // v1.23.2-fix: 按 topK 截断（此前会把 knnLimit 内的 60 条全返回并全部记访问）
    return results.slice(0, topK);
}
