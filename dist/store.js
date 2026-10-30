/**
 * Memory Store — 原文秒存，去重软抑制
 *
 * v5.0: skipEmbed 参数 — digest 暂不向量化，reflect 后统一 embed
 * v4.0: 去重不再丢弃，SQLite 持久化 embedding 缓存
 */
import { DatabaseManager, generateId, listMemTypeDirs } from './db.js';
import { embed, getEmbeddingCached } from './ollama.js';
import { CHAR_ID, normalizeProject, isEmbedEnabled } from './env.js';
import { isMemType, isClosedMemType, normalizeMarkdown, normalizeMemType } from './memType.js';
import { parseTagsSafe, normalizeTagsForWrite, serializeTags } from './tags.js';
import { reflectionPolicySafe } from './reflectionFidelity.js';
import { isDerivedSource, normalizeEvidenceIds, serializeEvidenceIds, evidenceKeyOf, parseEvidenceIds } from './provenance.js';
import { debugCatch, debugLog } from './log.js';
let saveCount = 0;
const CONSOLIDATE_INTERVAL = 50;
export async function saveMemory(params) {
    if (!params.text || !params.text.trim())
        throw new Error('memory text must not be empty');
    // memdir 路由:按 memType 落对应分类库(memory/<project>/<memType>/memory.sqlite)
    const now = new Date().toISOString();
    const project = normalizeProject(params.project);
    // v1.27 来源分界：派生叙述不向量化（它不该成为检索目标，也不该占向量位）、
    // 记录 provenance，并用 evidence_key 做崩溃重试幂等。
    const derived = params.derived === true || isDerivedSource(params.source);
    const generatedBy = params.generatedBy ?? (derived ? (params.source ?? null) : null);
    const evidenceIds = normalizeEvidenceIds(params.evidenceIds);
    const evidenceKey = params.evidenceKey ?? (derived ? evidenceKeyOf(generatedBy || 'derived', evidenceIds) : null);
    // v1.27-B: 派生叙述仍然可检索（降权而非隐藏），所以照常向量化；
    // 只有调用方显式 skipEmbed（digest 暂存）才不嵌。
    const skipEmbed = params.skipEmbed === true;
    // 2026-10-27 修复(NF-1):写路径必须用 Safe 版 —— 坏 config.json 不能让 memory_save 失效
    const preserve = reflectionPolicySafe(project) !== 'standard';
    let memType;
    if (params.memType && isMemType(params.memType)) {
        memType = normalizeMemType(params.memType);
    }
    else if (params.autoClassify === true) {
        try {
            const { classifyMemTypeLLM } = await import('./triage.js');
            memType = (await classifyMemTypeLLM(params.text, params.project)).memType;
        }
        catch {
            memType = 'general';
        }
    }
    else {
        memType = 'general';
    }
    const db = DatabaseManager.getInstance(project, memType);
    // v1.8: 4 种封闭类型(memType≠general)且 text 非 Markdown 时,自动规范化包装(加标题行+转列表)
    const text = normalizeMarkdown(params.text, memType);
    // ═══ 精确去重：完全相同的文本不重复存(仅限同项目) ═══
    const recordOf = (row) => ({
        id: row.id, text: row.text, project: row.project,
        sessionId: row.session_id, type: row.type, memType: row.mem_type,
        category: row.category, subcategory: row.subcategory,
        tags: parseTagsSafe(row.tags), importance: row.importance,
        characterId: row.character_id, source: row.source, subject: row.subject,
        tier: row.tier, expiresAt: row.expires_at, isActive: !!row.is_active,
        createdAt: row.created_at, updatedAt: row.updated_at,
        lastAccessedAt: row.last_accessed_at, accessedCount: row.accessed_count,
        metadata: row.metadata, title: row.title, status: row.status,
        scoreConfidence: row.score_confidence, scoreImpact: row.score_impact,
        scorePriority: row.score_priority, scoreUrgency: row.score_urgency,
        identityLocked: !!row.identity_locked,
        derived: !!row.derived, generatedBy: row.generated_by ?? null,
        evidenceIds: parseEvidenceIds(row.evidence_ids), evidenceKey: row.evidence_key ?? null,
    });
    // ═══ v1.27 evidence_key 幂等：同一证据集合 + 同一派生种类只落一行 ═══
    // 崩溃发生在"写完日记/摘要"与"提交处理进度"之间时，重试必须复用已有派生行，
    // 不能因为模型重新措辞就多出一条（那正是自我强化/重复摘要的来源）。
    if (evidenceKey) {
        for (const mt of DatabaseManager.existingMemTypes(project)) {
            try {
                const d = DatabaseManager.getInstance(project, mt);
                const hit = d.prepare('SELECT * FROM memory WHERE is_active = 1 AND project = ? AND evidence_key = ? LIMIT 1').get(project, evidenceKey);
                if (hit) {
                    d.prepare('UPDATE memory SET reference_count = reference_count + 1 WHERE id = ?').run(hit.id);
                    return recordOf(hit);
                }
            }
            catch { /* 旧库缺列时按无幂等处理 */ }
        }
    }
    const exactDup = db.prepare(`
    SELECT * FROM memory
    WHERE is_active = 1 AND project = ? AND ${preserve ? 'TRIM(text) = TRIM(?)' : 'LOWER(TRIM(text)) = LOWER(TRIM(?))'}
    LIMIT 1
  `).get(project, text?.trim() || '');
    if (exactDup) {
        db.prepare('UPDATE memory SET reference_count = reference_count + 1 WHERE id = ?').run(exactDup.id);
        return recordOf(exactDup);
    }
    // ═══ v1.23.2: 反思提取的归一化去重 ═══
    // 同一段摘要常被反复提取，只差空白/大小写；exact 比较漏掉后，星图上就出现
    // "同一段文字两个点"。这里按 大小写+空白归一化 在项目的所有 memType 库里找，
    // 命中就只加引用计数（跨 memType 也不再复制一份）。
    if (params.source === 'reflect_extract') {
        const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const targetNorm = norm(text);
        for (const mt of listMemTypeDirs(project)) {
            const d = DatabaseManager.getInstance(project, mt);
            const rows = d.prepare('SELECT * FROM memory WHERE is_active = 1 AND project = ?').all(project);
            const hit = rows.find((r) => norm(r.text) === targetNorm);
            if (hit) {
                d.prepare('UPDATE memory SET reference_count = reference_count + 1 WHERE id = ?').run(hit.id);
                return recordOf(hit);
            }
        }
    }
    // ═══ 向量去重：仅当不跳过 embed 且嵌入可用时执行(仅限同项目) ═══
    let vector = null;
    let isNearDup = false;
    let dupId = null;
    if (!skipEmbed && isEmbedEnabled()) {
        try {
            vector = await getEmbeddingCached(text, project);
            const floatVec = new Float32Array(vector);
            const knn = db.prepare(`
        SELECT rowid, distance FROM vec_memory
        WHERE embedding MATCH ? ORDER BY distance LIMIT 10
      `).all(floatVec);
            if (!preserve && knn.length > 0 && knn[0].distance < 0.05) {
                // v1.5: 项目隔离 — 仅当最近邻属于同项目才算重复
                const dupRow = db.prepare('SELECT id FROM memory WHERE rowid = ? AND project = ?').get(Number(knn[0].rowid), project);
                if (dupRow) {
                    dupId = dupRow.id;
                    isNearDup = true;
                    db.prepare('UPDATE memory SET reference_count = reference_count + 1 WHERE id = ?').run(dupId);
                }
            }
        }
        catch {
            // KNN 不可用，跳过去重检查
        }
    }
    // ═══ 存入新记忆（不管是否近重复，都存） ═══
    const id = generateId();
    // tier + expires_at 计算:显式 expiresAt 优先;否则 temporary 默认 3 天 TTL,standard/critical 永不过期
    const tier = params.tier || 'standard';
    const expiresAt = params.expiresAt || (tier === 'temporary'
        ? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() // 3天TTL
        : null // standard/critical 永不过期
    );
    const record = {
        id, text, project,
        sessionId: params.sessionId ?? null,
        type: params.type ?? 'episodic',
        memType,
        category: params.category ?? 'general',
        subcategory: params.subcategory ?? null,
        tags: normalizeTagsForWrite(params.tags),
        importance: params.importance ?? 0.5,
        characterId: params.characterId ?? null,
        source: params.source ?? null,
        subject: params.subject ?? 'user',
        tier,
        expiresAt,
        isActive: true,
        createdAt: now, updatedAt: now, lastAccessedAt: now, accessedCount: 0,
        metadata: params.metadata ?? null, title: params.title ?? null, status: params.status ?? null,
        scoreConfidence: params.scoreConfidence ?? null, scoreImpact: params.scoreImpact ?? null,
        scorePriority: params.scorePriority ?? null, scoreUrgency: params.scoreUrgency ?? null,
        identityLocked: params.identityLocked === true,
        derived, generatedBy, evidenceIds, evidenceKey,
    };
    const storeTx = db.transaction(() => {
        db.prepare(`
      INSERT INTO memory (id, text, project, session_id, type, mem_type, category, subcategory, tags, importance, base_importance, character_id, source, subject, tier, expires_at, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count, locked, metadata, title, status, score_confidence, score_impact, score_priority, score_urgency, identity_locked, derived, generated_by, evidence_ids, evidence_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, record.text, record.project, record.sessionId, record.type, record.memType, record.category, record.subcategory, serializeTags(record.tags), record.importance, record.importance, record.characterId, record.source, record.subject, record.tier, record.expiresAt, 1, record.createdAt, record.updatedAt, record.lastAccessedAt, 0, 0, 0, record.metadata, record.title, record.status, record.scoreConfidence, record.scoreImpact, record.scorePriority, record.scoreUrgency, record.identityLocked ? 1 : 0, derived ? 1 : 0, generatedBy, serializeEvidenceIds(evidenceIds), evidenceKey);
        // v5.0: 仅在非 skipEmbed 时写入向量
        if (!skipEmbed && vector) {
            const info = db.prepare('SELECT rowid FROM memory WHERE id = ?').get(record.id);
            const rowid = BigInt(info.rowid);
            // v5.0-fix: 新行刚拿到该 rowid，memory 里不可能有别的行占用它；
            // 若 vec_memory 同 rowid 已有行，必是历史硬删留下的孤儿。先清再插，
            // 否则 sqlite-vec 主键冲突会让整笔记忆永久保存失败。
            try {
                db.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(rowid);
            }
            catch { /* 无 vec 表 */ }
            db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(rowid, new Float32Array(vector));
        }
    });
    try {
        storeTx();
    }
    catch (e) {
        // v1.27: 唯一索引 ux_memory_evidence_key 兜住跨进程竞态 ——
        // 两个进程同时算同一批证据时，后到的那个在这里撞约束，回读已存在的行即可。
        if (evidenceKey && /UNIQUE constraint failed.*evidence_key/i.test(String(e.message))) {
            for (const mt of DatabaseManager.existingMemTypes(project)) {
                const d = DatabaseManager.getInstance(project, mt);
                const hit = d.prepare('SELECT * FROM memory WHERE is_active = 1 AND project = ? AND evidence_key = ? LIMIT 1')
                    .get(project, evidenceKey);
                if (hit)
                    return recordOf(hit);
            }
        }
        throw e;
    }
    // 定期整理
    saveCount++;
    if (saveCount >= CONSOLIDATE_INTERVAL) {
        saveCount = 0;
        try {
            const { consolidate } = await import('./consolidate.js');
            consolidate(project).catch((e) => debugCatch('store:consolidateInterval', e));
        }
        catch (e) {
            debugCatch('store:consolidateImport', e);
        }
    }
    return record;
}
/** 按 id 定位记忆所在分类库(memdir 遍历),返回库连接+分类;找不到返回 null */
export function findDbByMemoryId(id, project) {
    const proj = normalizeProject(project);
    const dirs = DatabaseManager.existingMemTypes(proj);
    /* v1.21:先找**活跃**行。跨 memType 搬家会在源库留 is_active=0 墓碑;旧实现按目录顺序取第一个命中,
     * 会命中墓碑 → update/forget/restore 打在死行上、真活跃副本留在原地(实测出现"同一 id 两个库同时活跃")。*/
    for (const mt of dirs) {
        const db = DatabaseManager.getInstance(proj, mt);
        if (db.prepare('SELECT id FROM memory WHERE id = ? AND is_active = 1').get(id))
            return { db, memType: mt };
    }
    for (const mt of dirs) {
        /* 兜底:只剩死行时(restoreMemory / 软删后清理)按原顺序返回 */
        const db = DatabaseManager.getInstance(proj, mt);
        if (db.prepare('SELECT id FROM memory WHERE id = ?').get(id))
            return { db, memType: mt };
    }
    return null;
}
export function forgetMemory(id, project) {
    const found = findDbByMemoryId(id, project);
    if (!found)
        return false;
    // v1.15: identity_locked=1 的身份记忆禁止自动软删(LLM 提取的 remove 会被拦,人工可先解锁)
    const row = found.db.prepare('SELECT identity_locked FROM memory WHERE id = ? AND is_active = 1').get(id);
    if (row && row.identity_locked === 1)
        return false;
    return found.db.prepare('UPDATE memory SET is_active = 0 WHERE id = ?').run(id).changes > 0;
}
export function restoreMemory(id, project) {
    const found = findDbByMemoryId(id, project);
    if (!found)
        return false;
    return found.db.prepare('UPDATE memory SET is_active = 1 WHERE id = ?').run(id).changes > 0;
}
export async function updateMemory(id, updates) {
    const found = findDbByMemoryId(id, updates.project);
    if (!found)
        return null;
    let db = found.db;
    const existing = db.prepare('SELECT * FROM memory WHERE id = ?').get(id);
    if (!existing)
        return null;
    // memdir 跨分类移动:memType 变更 → 复制到新分类库 + 软删原库
    const newMt = updates.memType !== undefined ? normalizeMemType(updates.memType) : found.memType;
    if (newMt !== found.memType) {
        const proj = normalizeProject(updates.project);
        const newDb = DatabaseManager.getInstance(proj, newMt);
        const text = updates.text !== undefined ? normalizeMarkdown(updates.text, newMt) : existing.text;
        const tags = updates.tags !== undefined
            ? serializeTags(updates.tags)
            : serializeTags(existing.tags);
        const now = new Date().toISOString();
        // v1.23.2-fix: 搬家保留 parent_id/base_importance；先清目标库同 id 的旧向量，
        // 否则 INSERT OR REPLACE 换 rowid 后旧向量成为孤儿（KNN 白占名额，rowid 复用还会算错记忆）。
        const srcVec = (() => {
            try {
                return db.prepare('SELECT embedding FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').get(id);
            }
            catch {
                return null;
            }
        })();
        try {
            const oldTarget = newDb.prepare('SELECT rowid FROM memory WHERE id = ?').get(id);
            if (oldTarget)
                newDb.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(oldTarget.rowid);
        }
        catch { /* 目标库无 vec 表时忽略 */ }
        newDb.prepare(`
      INSERT OR REPLACE INTO memory (id, text, project, session_id, type, mem_type, category, subcategory, tags, importance, base_importance, character_id, source, subject, tier, expires_at, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count, locked, metadata, title, status, score_confidence, score_impact, score_priority, score_urgency, identity_locked, parent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, text, proj, existing.session_id, updates.type !== undefined ? updates.type : existing.type, newMt, updates.category !== undefined ? updates.category : existing.category, updates.subcategory !== undefined ? updates.subcategory : existing.subcategory, tags, updates.importance !== undefined ? updates.importance : existing.importance, updates.importance !== undefined ? updates.importance : (existing.base_importance ?? existing.importance), updates.characterId !== undefined ? updates.characterId : existing.character_id, updates.source !== undefined ? updates.source : existing.source, updates.subject !== undefined ? updates.subject : existing.subject, updates.tier !== undefined ? updates.tier : existing.tier, existing.expires_at ?? null, existing.created_at, now, now, existing.accessed_count, existing.reference_count ?? 0, existing.locked ?? 0, updates.metadata !== undefined ? updates.metadata : (existing.metadata ?? null), updates.title !== undefined ? updates.title : (existing.title ?? null), updates.status !== undefined ? updates.status : (existing.status ?? null), updates.scoreConfidence !== undefined ? updates.scoreConfidence : (existing.score_confidence ?? null), updates.scoreImpact !== undefined ? updates.scoreImpact : (existing.score_impact ?? null), updates.scorePriority !== undefined ? updates.scorePriority : (existing.score_priority ?? null), updates.scoreUrgency !== undefined ? updates.scoreUrgency : (existing.score_urgency ?? null), updates.identityLocked !== undefined ? (updates.identityLocked ? 1 : 0) : (existing.identity_locked ?? 0), existing.parent_id ?? null);
        // 向量一并搬移(若有)：写在目标行的新 rowid 上
        try {
            if (srcVec) {
                const rowInfo = newDb.prepare('SELECT rowid FROM memory WHERE id = ?').get(id);
                newDb.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(BigInt(rowInfo.rowid), srcVec.embedding);
            }
        }
        catch { /* 无向量/损坏忽略 */ }
        db.prepare('UPDATE memory SET is_active = 0 WHERE id = ?').run(id);
        db = newDb;
        // 已处理 memType 变更,移除以免重复 SET
        if (updates.memType !== undefined)
            delete updates.memType;
        return db.prepare('SELECT * FROM memory WHERE id = ?').get(id);
    }
    const fields = [];
    const values = [];
    let text;
    if (updates.text !== undefined) {
        // v1.8: memType 为 4 种封闭类型时,更新 text 同样规范化包装
        text = normalizeMarkdown(updates.text, updates.memType);
        fields.push('text = ?');
        values.push(text);
    }
    if (updates.memType !== undefined) {
        fields.push('mem_type = ?');
        values.push(normalizeMemType(updates.memType));
    }
    if (updates.type !== undefined) {
        fields.push('type = ?');
        values.push(updates.type);
    }
    if (updates.category !== undefined) {
        fields.push('category = ?');
        values.push(updates.category);
    }
    if (updates.subcategory !== undefined) {
        fields.push('subcategory = ?');
        values.push(updates.subcategory);
    }
    if (updates.tags !== undefined) {
        fields.push('tags = ?');
        values.push(serializeTags(updates.tags));
    }
    if (updates.importance !== undefined) {
        // 显式改重要性 = 重新设基线，避免下一次衰减从旧基线把它拉回去
        fields.push('importance = ?, base_importance = ?');
        values.push(updates.importance, updates.importance);
    }
    // v1.15: LobeHub 精细化吸收
    if (updates.metadata !== undefined) {
        fields.push('metadata = ?');
        values.push(updates.metadata);
    }
    if (updates.title !== undefined) {
        fields.push('title = ?');
        values.push(updates.title);
    }
    if (updates.status !== undefined) {
        fields.push('status = ?');
        values.push(updates.status);
    }
    if (updates.scoreConfidence !== undefined) {
        fields.push('score_confidence = ?');
        values.push(updates.scoreConfidence);
    }
    if (updates.scoreImpact !== undefined) {
        fields.push('score_impact = ?');
        values.push(updates.scoreImpact);
    }
    if (updates.scorePriority !== undefined) {
        fields.push('score_priority = ?');
        values.push(updates.scorePriority);
    }
    if (updates.scoreUrgency !== undefined) {
        fields.push('score_urgency = ?');
        values.push(updates.scoreUrgency);
    }
    if (updates.identityLocked !== undefined) {
        fields.push('identity_locked = ?');
        values.push(updates.identityLocked ? 1 : 0);
    }
    if (fields.length === 0)
        return existing;
    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    db.prepare(`UPDATE memory SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    if (updates.text !== undefined && isEmbedEnabled()) {
        const newVec = await getEmbeddingCached(text, updates.project);
        db.prepare('DELETE FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').run(id);
        const rowInfo = db.prepare('SELECT rowid FROM memory WHERE id = ?').get(id);
        db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(BigInt(rowInfo.rowid), new Float32Array(newVec));
    }
    return db.prepare('SELECT * FROM memory WHERE id = ?').get(id);
}
/**
 * 存储对话原文（轻量，不做分析，不做向量化）
 * v5.0: 对话原文永不 embed — digest 分拣后再由 reflect 统一向量化
 */
export async function saveConversationTurn(userMsg, assistantMsg, characterId = 'airi', moodValue, moodReason, project) {
    const db = DatabaseManager.getInstance(project);
    const now = new Date().toISOString();
    const id = generateId();
    const proj = normalizeProject(project);
    const assistantName = (process.env.CASTALIA_ASSISTANT_NAME || '助手').trim() || '助手';
    const text = `用户: ${userMsg}\n${assistantName}: ${assistantMsg}`;
    /* v1.19 分隔带:对话原文审计可见(is_active=0)——检索/星图/readDigest 只读 is_active=1,自动不进总图;
       mood 前缀剥离入 metadata,正文纯净 */
    const meta = {};
    if (moodValue !== undefined) {
        meta.mood = moodValue;
        if (moodReason)
            meta.moodReason = moodReason;
    }
    db.prepare(`
    INSERT INTO memory (id, text, project, type, category, tags, importance, character_id, source, subject, tier, expires_at, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count, metadata)
    VALUES (?, ?, ?, 'episodic', 'conversation', ?, 0.3, ?, 'conversation_log', 'user', 'standard', NULL, 0, ?, ?, ?, 0, 0, ?)
  `).run(id, text, proj, serializeTags([]), characterId, now, now, now, JSON.stringify(meta));
    return { id, ok: true };
}
/**
 * 清理过期的临时记忆 (tier='temporary', expires_at < now)
 * 返回清理数量
 */
// ═══ v1.3: 热度升格 — 常被访问的记忆自动变强(UPSP 热度思想) ═══
// 访问次数 ≥ HEAT_PROMOTE_THRESHOLD 的 temporary 记忆自动升 standard(免清理)
const HEAT_PROMOTE_THRESHOLD = parseInt(process.env.HEAT_PROMOTE_THRESHOLD || '5', 10);
// ═══ v1.23 冷存分层：长期不用的低价值记忆退出"新沉淀"，但不删除、仍可检索 ═══
// 判定：非 critical / 非 locked / 非 superseded，importance < 0.6，无引用，且
//       last_accessed_at（没有则 created_at）超过 N 天（默认 60）。
const COLD_AFTER_DAYS = (() => { const v = parseFloat(process.env.COLD_AFTER_DAYS || '60'); return Number.isFinite(v) && v > 0 ? v : 60; })();
const COLD_MAX_IMPORTANCE = (() => { const v = parseFloat(process.env.COLD_MAX_IMPORTANCE || '0.6'); return Number.isFinite(v) && v > 0 ? v : 0.6; })();
export function markColdMemories(project) {
    const proj = normalizeProject(project);
    const cutoff = new Date(Date.now() - COLD_AFTER_DAYS * 86400000).toISOString();
    let marked = 0;
    for (const mt of DatabaseManager.existingMemTypes(proj)) {
        try {
            const db = DatabaseManager.getInstance(proj, mt);
            const r = db.prepare(`
        UPDATE memory SET status = 'cold'
        WHERE project = ? AND is_active = 1
          AND COALESCE(status, '') NOT IN ('cold', 'superseded')
          AND COALESCE(tier, 'standard') = 'standard'
          AND (locked IS NULL OR locked = 0)
          AND importance < ?
          AND COALESCE(reference_count, 0) = 0
          -- v1.23-fix: created_at 混着 SQLite "YYYY-MM-DD HH:MM:SS" 与 JS ISO "…T…Z" 两种格式，
          -- 直接字符串比较会把边界差出一天；统一用 datetime() 归一化后再比。
          AND datetime(COALESCE(last_accessed_at, created_at)) < datetime(?)
      `).run(proj, COLD_MAX_IMPORTANCE, cutoff);
            marked += r.changes;
        }
        catch { /* 单库失败不影响其它库 */ }
    }
    if (marked > 0)
        console.error(`[cold] ${marked} 条记忆转为冷存（>${COLD_AFTER_DAYS} 天未访问且 importance<${COLD_MAX_IMPORTANCE}）`);
    return marked;
}
export function promoteByAccess(project) {
    const proj = normalizeProject(project);
    const now = new Date().toISOString();
    let total = 0;
    // memdir:遍历项目全部分类库(临时记忆可能落在任意 memType 分类库)
    for (const mt of DatabaseManager.existingMemTypes(proj)) {
        const db = DatabaseManager.getInstance(proj, mt);
        const r = db.prepare(`
      UPDATE memory SET tier = 'standard', updated_at = ?
      WHERE tier = 'temporary' AND accessed_count >= ? AND is_active = 1
    `).run(now, HEAT_PROMOTE_THRESHOLD);
        total += r.changes;
    }
    if (total > 0)
        console.error(`[memory] heat promote: ${total} temporary → standard`);
    return total;
}
export function cleanupExpiredMemories(project) {
    const proj = normalizeProject(project);
    const now = new Date().toISOString();
    // 先升格再清理:被反复访问的 temporary 不该被清
    promoteByAccess(project);
    let total = 0;
    // memdir:遍历项目全部分类库清理过期 temporary(避免只清 general 漏掉 user/feedback/project/reference)
    for (const mt of DatabaseManager.existingMemTypes(proj)) {
        const db = DatabaseManager.getInstance(proj, mt);
        const result = db.prepare(`
      UPDATE memory SET is_active = 0, updated_at = ?
      WHERE tier = 'temporary' AND expires_at IS NOT NULL AND expires_at < ? AND is_active = 1
    `).run(now, now);
        total += result.changes;
    }
    return total;
}
/**
 * v5.0: 重新向量化单条记忆 — reflect 后调用
 * 删旧向量 + embed 新文本 + 插入新向量
 */
export async function reEmbedMemory(id, project) {
    const found = findDbByMemoryId(id, project);
    if (!found)
        return false;
    const db = found.db;
    const proj = normalizeProject(project);
    const mem = db.prepare('SELECT rowid, text FROM memory WHERE id = ? AND is_active = 1').get(id);
    if (!mem)
        return false;
    try {
        const vec = new Float32Array(await embed(mem.text, proj));
        db.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(BigInt(mem.rowid));
        db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(BigInt(mem.rowid), vec);
        return true;
    }
    catch (e) {
        console.error(`[store] reEmbedMemory failed for ${id}: ${e.message}`);
        return false;
    }
}
/**
 * v5.0: 批量向量化 — reflect 后一次性处理所有未嵌入记忆
 * v1.5: 支持按项目隔离 — 传 project 只处理该项目;不传则默认项目
 * 扫描 is_active=1 但 vec_memory 中无对应向量的记录
 */
export async function batchEmbedPending(characterId = 'airi', project, opts = {}) {
    if (!isEmbedEnabled())
        return { embedded: 0, embeddedFacts: 0, errors: ['embedding disabled (EMBED_MODE=none)'] };
    const proj = normalizeProject(project);
    let embedded = 0;
    let embeddedFacts = 0;
    const errors = [];
    // memdir:遍历项目全部分类库补嵌入
    for (const mt of DatabaseManager.existingMemTypes(proj)) {
        const db = DatabaseManager.getInstance(proj, mt);
        // v1.24: 嵌入空间切换后，旧空间留下的失败计数没有意义（失败原因已不存在），
        // 否则这些行会被 COALESCE(embed_fail_count,0) < 3 永久挡在窗口外 —— 实测本机 190 条
        // 卡在 fc=3，覆盖率永远是 74%。resetFailures 只清"没有向量"的行，不会掩盖真错误：
        // 每轮重新失败一样会被重新计数。
        if (opts.resetFailures) {
            try {
                db.prepare(`UPDATE memory SET embed_fail_count = 0
        WHERE COALESCE(embed_fail_count, 0) >= 3
          AND rowid NOT IN (SELECT rowid FROM vec_memory)`).run();
            }
            catch { /* 旧库无列 */ }
        }
        // 找所有有记忆但无向量的记录(source 为 NULL 也算,修复 NULL != 'x' 恒假的坑)
        // characterId='any' 时不按角色过滤(跨库产物如 reflect 库 character_id 为 NULL 也能补嵌入)
        const conditions = [
            'm.is_active = 1',
            'm.rowid NOT IN (SELECT rowid FROM vec_memory)',
            'COALESCE(m.embed_fail_count, 0) < 3',
        ];
        const params = [];
        if (characterId !== 'any') {
            conditions.push('m.character_id = ?');
            params.push(characterId);
        }
        conditions.push("COALESCE(m.source, '') != 'conversation_log'");
        // v1.27-B: 派生叙述参与检索（降权），同样需要补向量；不再排除
        if (project) {
            conditions.push('m.project = ?');
            params.push(proj);
        }
        const pending = db.prepare(`
    SELECT m.id, m.text, m.rowid FROM memory m
    WHERE ${conditions.join(' AND ')}
    ORDER BY COALESCE(m.embed_fail_count, 0) ASC, m.created_at ASC
    LIMIT 200
  `).all(...params);
        for (const row of pending) {
            try {
                const vec = new Float32Array(await embed(row.text, project));
                // v1.24: 先删后插 —— 多个引擎共用一个库时（bridge 各自起进程），
                // 补历史欠账会并发插同一个 rowid，直接 INSERT 会撞
                // "UNIQUE constraint failed on vec_memory primary key"（本机实测 165 条）。
                // 行已被别的进程补上时，这次覆盖是同值，无害。
                try {
                    db.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(BigInt(row.rowid));
                }
                catch { /* 无 vec 表 */ }
                db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(BigInt(row.rowid), vec);
                db.prepare('UPDATE memory SET embed_fail_count = 0 WHERE rowid = ?').run(row.rowid);
                embedded++;
            }
            catch (e) {
                // v1.24: 并发/重入时 rowid 可能已被别人补上 —— 只要现在有向量就算成功，
                // 不要把它记成失败（否则 embed_fail_count 被无谓推到 3，窗口永久跳过）。
                const dup = /UNIQUE constraint failed on vec_memory/i.test(String(e.message));
                let nowHasVec = false;
                if (dup) {
                    try {
                        nowHasVec = !!db.prepare('SELECT rowid FROM vec_memory WHERE rowid = ?').get(BigInt(row.rowid));
                    }
                    catch { /* 忽略 */ }
                }
                if (nowHasVec) {
                    try {
                        db.prepare('UPDATE memory SET embed_fail_count = 0 WHERE rowid = ?').run(row.rowid);
                    }
                    catch { /* 旧库无列 */ }
                    embedded++;
                }
                else {
                    // 失败重试 3 次后跳过，避免坏记录永久堵住窗口
                    try {
                        db.prepare('UPDATE memory SET embed_fail_count = COALESCE(embed_fail_count, 0) + 1 WHERE rowid = ?').run(row.rowid);
                    }
                    catch { /* 旧库无列 */ }
                    errors.push(`${row.id}: ${e.message}`);
                }
            }
            // v1.24: 补历史欠账时是连续几百次请求，远端 API 会 429（表现为 fetch failed）。
            // 加一点间隔比调大重试次数便宜；正常写入路径默认 0 延迟，不受影响。
            if (opts.paceMs && opts.paceMs > 0)
                await new Promise(r => setTimeout(r, opts.paceMs));
        }
    }
    // v1.21: facts 补嵌入 —— saveFacts 只在写入那一刻嵌,历史 facts 会永远缺向量(fact_search 的 KNN 搜不到)
    try {
        const fdb = DatabaseManager.getInstance(proj);
        const pendingFacts = fdb.prepare(`
    SELECT rowid, subject, predicate, object FROM facts f
    WHERE f.is_active = 1 AND f.rowid NOT IN (SELECT rowid FROM vec_facts)
    LIMIT 200
  `).all();
        for (const row of pendingFacts) {
            try {
                const factText = `${row.subject} ${row.predicate} ${row.object}`;
                const vec = new Float32Array(await getEmbeddingCached(factText, proj));
                fdb.prepare('DELETE FROM vec_facts WHERE rowid = ?').run(BigInt(row.rowid));
                fdb.prepare('INSERT INTO vec_facts (rowid, embedding) VALUES (?, ?)').run(BigInt(row.rowid), vec);
                embeddedFacts++;
            }
            catch (e) {
                errors.push(`fact#${row.rowid}: ${e.message}`);
            }
        }
    }
    catch { /* facts 表可能不存在(旧库) */ }
    return { embedded, embeddedFacts, errors };
}
/**
 * 批量存储事实 — 自动处理去重（subject+predicate+object 唯一）
 *
 * 去重策略：
 *   - 同一 S-P-O → 更新 confidence 为 MAX(old, new)，不重复插入
 *   - 不同 S-P-O → 正常插入
 */
export async function saveFacts(facts, sourceMemoryId = null, characterId = 'airi', project, // v1.5: 项目隔离
/**
 * v1.27 来源出处：跨 memType 的证据不再把 provenance 丢成 NULL。
 * source_memory_id 仍只在同库（general）时挂 —— 跨库外键本来就是错的；
 * 但 source / mem_type / evidence_ids 一定落库，事实永远能追回出处。
 */
sourceRef) {
    if (!facts || facts.length === 0)
        return { inserted: 0, updated: 0 };
    const db = DatabaseManager.getInstance(project);
    const now = new Date().toISOString();
    const proj = normalizeProject(project);
    let inserted = 0;
    let updated = 0;
    // 来源校验：必须存在、active、同项目，且不能是派生叙述（模型自己写的解释不能再当出处）
    let resolvedSourceId = null;
    let resolvedSource = sourceRef?.source ?? null;
    let resolvedMemType = sourceRef?.memType ?? null;
    let resolvedEvidenceIds = serializeEvidenceIds(sourceRef?.evidenceIds);
    if (sourceMemoryId) {
        const found = findDbByMemoryId(sourceMemoryId, project);
        if (found) {
            const row = found.db.prepare('SELECT source, derived, is_active, project FROM memory WHERE id = ?').get(sourceMemoryId);
            if (row && row.is_active && normalizeProject(row.project) === proj && !row.derived) {
                resolvedSource = row.source ?? resolvedSource;
                resolvedMemType = found.memType;
                // 跨 memType 不挂本地外键（facts 表在 general 库），provenance 用 source+mem_type 表达
                resolvedSourceId = found.memType === 'general' ? sourceMemoryId : null;
            }
            else {
                // 派生叙述 / 失活 / 跨项目来源：一律不挂，连出处信息也不留。
                // 留下"这条事实出自某段模型自述"本身就是把派生记录当成了证据。
                if (row?.derived) {
                    debugLog(`[facts] 拒绝派生叙述作为出处: ${sourceMemoryId} (source=${row.source})`);
                }
                resolvedSourceId = null;
                resolvedSource = null;
                resolvedMemType = null;
            }
        }
        else {
            resolvedSourceId = null;
            resolvedSource = null;
            resolvedMemType = null;
        }
    }
    // v1.23.1-fix: 不再依赖 ON CONFLICT 目标（旧实现每次启动 DROP 唯一索引再重建，
    // 一旦重建失败，ON CONFLICT 在 prepare 阶段就抛错 → facts 永久断流）。
    // 这里显式 find→update/insert，并把整批写入 + 互斥失效放进同一个事务。
    const findStmt = db.prepare('SELECT id FROM facts WHERE subject=? AND predicate=? AND object=? AND project=?');
    const insertStmt = db.prepare(`
    INSERT INTO facts (id, subject, predicate, object, project, confidence, source_memory_id, character_id, is_active, created_at, updated_at, evidence, valid_from, valid_to, source_memory_source, source_memory_mem_type, evidence_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const updateStmt = db.prepare(`
    UPDATE facts SET
      confidence = MAX(confidence, ?),
      updated_at = ?,
      is_active = 1,
      evidence = COALESCE(NULLIF(?, ''), evidence),
      valid_from = COALESCE(?, valid_from),
      valid_to = ?,
      source_memory_id = COALESCE(?, source_memory_id),
      source_memory_source = COALESCE(?, source_memory_source),
      source_memory_mem_type = COALESCE(?, source_memory_mem_type),
      evidence_ids = COALESCE(?, evidence_ids)
    WHERE id = ?
  `);
    // v1.23 冲突失效（Graphiti 式）：功能性关系（一个主体只能有一个值）出现新值时，
    // 旧事实只打 valid_to 保留，不删除 —— 历史版本可查，当前值以最新为准。
    // v1.23-fix: 必须排除"本批一起写入的对象"，否则同批 姓名=张三 + 姓名=李四 会互相失效。
    const FUNCTIONAL_PREDICATES = new Set([
        '姓名', '名字', '年龄', '职业', '居住地', '工作单位', '生日', '称呼', '昵称',
        'name', 'age', 'job', 'occupation', 'residence', 'birthday',
    ]);
    const functionalBatch = new Map(); // subject\u0001predicate -> 本批 objects
    for (const f of facts) {
        const predicate = String(f.predicate || '').trim();
        if (!FUNCTIONAL_PREDICATES.has(predicate))
            continue;
        const subject = String(f.subject || '').trim();
        const key = `${subject}\u0001${predicate}`;
        const set = functionalBatch.get(key) || new Set();
        set.add(String(f.object || '').trim());
        functionalBatch.set(key, set);
    }
    const applyTx = db.transaction(() => {
        for (const f of facts) {
            const before = findStmt.get(f.subject, f.predicate, f.object, proj);
            if (before) {
                updateStmt.run(f.confidence, now, f.evidence ?? '', f.validFrom ?? null, f.validTo ?? null, resolvedSourceId, resolvedSource, resolvedMemType, resolvedEvidenceIds, before.id);
                updated++;
            }
            else {
                insertStmt.run(generateId(), f.subject, f.predicate, f.object, proj, f.confidence, resolvedSourceId, characterId, now, now, f.evidence ?? null, f.validFrom ?? null, f.validTo ?? null, resolvedSource, resolvedMemType, resolvedEvidenceIds);
                inserted++;
            }
        }
        for (const [key, objects] of functionalBatch) {
            const [subject, predicate] = key.split('\u0001');
            const batchObjects = [...objects].filter(Boolean);
            if (batchObjects.length >= 2) {
                console.error(`[facts] 同批出现互斥值 ${subject}/${predicate}=${batchObjects.join(' | ')}，保留全部待裁决`);
            }
            const placeholders = batchObjects.length ? batchObjects.map(() => '?').join(',') : null;
            const sql = `UPDATE facts SET valid_to = ?, updated_at = ?
        WHERE project = ? AND subject = ? AND predicate = ?
          AND is_active = 1 AND (valid_to IS NULL OR valid_to = '')
          ${placeholders ? `AND object NOT IN (${placeholders})` : ''}`;
            db.prepare(sql).run(now, now, proj, subject, predicate, ...batchObjects);
        }
    });
    try {
        // v1.27: 读-判-写必须 BEGIN IMMEDIATE —— 多桥进程并发写 facts 时，
        // deferred 事务会让两个进程读到同一个 before，然后各自 INSERT。
        applyTx.immediate();
    }
    catch (e) {
        console.error('[facts] 批量写入失败（整批回滚）:', e.message);
        throw e;
    }
    // 为新增 / 更新的事实生成 embedding 并写入 vec_facts
    if (!isEmbedEnabled())
        return { inserted, updated };
    try {
        const allFacts = db.prepare(`
      SELECT rowid, subject, predicate, object FROM facts
      WHERE project = ? AND subject || ' ' || predicate || ' ' || object IN (
        ${facts.map(() => '?').join(',')}
      )
    `).all(proj, ...facts.map(f => `${f.subject} ${f.predicate} ${f.object}`));
        for (const row of allFacts) {
            const factText = `${row.subject} ${row.predicate} ${row.object}`;
            try {
                const vec = new Float32Array(await getEmbeddingCached(factText, proj));
                // upsert: delete old + insert new
                db.prepare('DELETE FROM vec_facts WHERE rowid = ?').run(BigInt(row.rowid));
                db.prepare('INSERT INTO vec_facts (rowid, embedding) VALUES (?, ?)').run(BigInt(row.rowid), vec);
            }
            catch (e) {
                debugCatch('store:factEmbedRow', e);
            }
        }
    }
    catch (e) {
        debugCatch('store:factEmbedBatch', e);
    }
    return { inserted, updated };
}
/**
 * 查询某个主体的所有活跃事实
 */
export function getFactsBySubject(subject, characterId, project) {
    const db = DatabaseManager.getInstance(project);
    const proj = normalizeProject(project);
    // v1.23-fix: 默认只返回当前有效事实；历史版本留在表里（valid_to 有值）供按需追溯。
    let query = "SELECT * FROM facts WHERE subject = ? AND is_active = 1 AND project = ? AND (valid_to IS NULL OR valid_to = '')";
    const params = [subject, proj];
    if (characterId) {
        query += ' AND character_id = ?';
        params.push(characterId);
    }
    query += ' ORDER BY confidence DESC, updated_at DESC LIMIT 50';
    return db.prepare(query).all(...params);
}
// ═══════════════════════════════════════════════════════════════════
// v1.11 Part2: 会话记忆数据层 — 渐进式临时反思
//   getSessionMemory      : 读会话滚动快照(source=session_memory)
//   upsertSessionMemory   : 会话滚动状态滚动覆盖(同 session_id 单行 upsert)
//   promoteToProject      : 长效干货晋升到项目级(session_id=NULL, 4 类强制 Markdown)
//   deleteSessionFragments: 晋升即删(清空该会话已晋升的 session_memory 碎片)
// ═══════════════════════════════════════════════════════════════════
/** 读取某会话当前滚动记忆快照(source=session_memory,最新一条) */
export function getSessionMemory(project, sessionId) {
    const db = DatabaseManager.getInstance(project);
    const proj = normalizeProject(project);
    const row = db.prepare(`
    SELECT text FROM memory
    WHERE project = ? AND session_id = ? AND source = 'session_memory' AND is_active = 1
    ORDER BY updated_at DESC LIMIT 1
  `).get(proj, sessionId);
    return row?.text ?? null;
}
/**
 * 会话滚动状态覆盖:按 (project, session_id) 查同会话已有 session_memory
 * → 有则 UPDATE text(覆盖),无则 INSERT(session_id 非空, source=session_memory,
 *   memType=general 或 LLM 给的, category=session)。
 * 单会话单行,实现"滚动覆盖"而非碎片堆积。
 */
export function upsertSessionMemory(project, sessionId, content, memType) {
    const db = DatabaseManager.getInstance(project);
    const proj = normalizeProject(project);
    const now = new Date().toISOString();
    const existing = db.prepare(`
    SELECT id FROM memory
    WHERE project = ? AND session_id = ? AND source = 'session_memory' AND is_active = 1
    ORDER BY updated_at DESC LIMIT 1
  `).get(proj, sessionId);
    if (existing) {
        db.prepare('UPDATE memory SET text = ?, updated_at = ? WHERE id = ?').run(content, now, existing.id);
        return { id: existing.id, updated: true };
    }
    const id = generateId();
    db.prepare(`
    INSERT INTO memory (id, text, project, session_id, type, mem_type, category, tags, importance, source, subject, tier, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count)
    VALUES (?, ?, ?, ?, 'episodic', ?, 'session', ?, 0.5, 'session_memory', 'user', 'standard', 1, ?, ?, ?, 0, 0)
  `).run(id, content, proj, sessionId, normalizeMemType(memType), serializeTags([]), now, now, now);
    return { id, updated: false };
}
/**
 * 长效干货晋升:每条 INSERT 到项目级(session_id=NULL, memType, 4 类强制 Markdown)。
 * 返回落库 ids。
 * 设计取舍:不用 saveMemory(其精确去重不区分 session_id,可能把晋升项去重到
 * 会话级碎片——而碎片随后会被"晋升即删"删掉,导致晋升引到已删行)。
 * 这里自己做"仅项目级"精确去重(session_id IS NULL),命中返回已有 id,否则直接 INSERT。
 * 同步执行 + 不嵌向量:后台反思不依赖嵌入服务。
 */
export function promoteToProject(project, items, characterId) {
    const cid = characterId || CHAR_ID;
    const proj = normalizeProject(project);
    // 2026-10-27 修复(NF-1):同 saveMemory,晋升路径也不能被坏配置打断
    const preserve = reflectionPolicySafe(proj) !== 'standard';
    const now = new Date().toISOString();
    const ids = [];
    const gateRejected = { tooloong: [], noInfo: [], foreign: [], delta: [] };
    globalThis.__lastPromoteGates = gateRejected;
    for (const item of items || []) {
        const mt = isClosedMemType(item.memType) ? item.memType : undefined;
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        if (!mt || !text)
            continue;
        /* ── v1.19 promote 三闸(Claude 写前语义回流) ── */
        // 闸1 密度:>240 字或结构词密度过低(信息/字符比)拒
        if (!preserve && text.length > 240) {
            gateRejected.tooloong.push(text.slice(0, 40));
            continue;
        }
        const infoWords = (text.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,}/g) || []).join('');
        if (infoWords.replace(/[\u4e00-\u9fa5A-Za-z0-9]/g, '').length === text.length) {
            gateRejected.noInfo.push(text.slice(0, 40));
            continue;
        }
        // 闸2 归属:跨项目专名(本库外的软件名/系统名)拒——防跨盘串库(AIRI 内容经 lobehub 通道入库事件)
        // 跨库污染闸门:promote 时若文本提到"属于其它库的名字"则拒绝(避免跨库串味)。
        // 名单按实例配置,公共版不预设任何本地库名 —— 默认不拦:
        //   CASTALIA_FOREIGN_NAMES="Name1,Name2"      其它库名总表(兜底)
        //   CASTALIA_HOME_NAMES='{"proj":["Name"]}'   各库自己的名字(优先)
        const foreignNames = (process.env.CASTALIA_FOREIGN_NAMES || '')
            .split(',').map(s => s.trim()).filter(Boolean);
        let homeNames = {};
        try {
            homeNames = JSON.parse(process.env.CASTALIA_HOME_NAMES || '{}');
        }
        catch {
            homeNames = {};
        }
        const ban = new Set([...(homeNames[proj] || foreignNames)].filter(x => x && x.toLowerCase() !== proj.toLowerCase()));
        const hitForeign = [...ban].find(n => text.includes(n));
        if (hitForeign && !(proj === 'default')) {
            gateRejected.foreign.push(`${hitForeign}:${text.slice(0, 30)}`);
            continue;
        }
        // memdir 路由按 memType 落对应分类库
        const db = DatabaseManager.getInstance(proj, mt);
        const md = normalizeMarkdown(text, mt);
        // 闸3 delta:与库存项目级同 memType 记忆 bigram Jaccard>0.72 视为无增量(旧闻重复入库)
        if (!preserve) {
            const existRows = db.prepare(`
        SELECT text FROM memory
        WHERE is_active = 1 AND project = ? AND session_id IS NULL AND mem_type = ?
        ORDER BY updated_at DESC LIMIT 200
      `).all(proj, mt);
            const norm = (s) => (s || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '');
            const bigrams = (s) => { const n = norm(s); const out = new Set(); for (let q = 0; q + 2 <= n.length; q++)
                out.add(n.slice(q, q + 2)); return out; };
            const bg = bigrams(md);
            if (bg.size >= 6) {
                let dupByDelta = false;
                for (const r of existRows) {
                    const ob = bigrams(r.text || '');
                    if (ob.size < 6)
                        continue;
                    let inter = 0;
                    for (const g of bg)
                        if (ob.has(g))
                            inter++;
                    const jac = inter / (bg.size + ob.size - inter);
                    if (jac > 0.72) {
                        dupByDelta = true;
                        break;
                    }
                }
                if (dupByDelta) {
                    gateRejected.delta.push(md.slice(0, 40));
                    continue;
                }
            }
        }
        const dup = db.prepare(`
      SELECT id FROM memory
      WHERE is_active = 1 AND project = ? AND session_id IS NULL AND ${preserve ? 'TRIM(text) = TRIM(?)' : 'LOWER(TRIM(text)) = LOWER(TRIM(?))'}
      LIMIT 1
    `).get(proj, md);
        if (dup) {
            ids.push(dup.id);
            continue;
        }
        const id = generateId();
        db.prepare(`
      INSERT INTO memory (id, text, project, session_id, type, mem_type, category, tags, importance, character_id, source, subject, tier, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count)
      VALUES (?, ?, ?, NULL, 'semantic', ?, ?, ?, ?, ?, 'session_promoted', 'user', 'standard', 1, ?, ?, ?, 0, 0)
    `).run(id, md, proj, mt, (item.category && String(item.category).trim().slice(0, 40)) || 'knowledge', serializeTags([]), 0.6, cid, now, now, now);
        ids.push(id);
    }
    return ids;
}
/**
 * 晋升即删(吸收 Claude cleaner.onPromoted):晋升成功后清空该会话
 * source=session_memory 的已晋升碎片。硬删(内部家计行,不嵌向量)。
 */
export function deleteSessionFragments(project, sessionId) {
    const db = DatabaseManager.getInstance(project);
    const proj = normalizeProject(project);
    // v1.23.2-fix: 与 sweep 一致，硬删前清掉向量与边
    try {
        const rows = db.prepare(`
      SELECT rowid, id FROM memory
      WHERE project = ? AND session_id = ? AND source = 'session_memory' AND is_active = 1
    `).all(proj, sessionId);
        const tx = db.transaction(() => {
            const delVec = db.prepare('DELETE FROM vec_memory WHERE rowid = ?');
            const delEdge = db.prepare('DELETE FROM edges WHERE source_id = ? OR target_id = ?');
            for (const row of rows) {
                try {
                    delVec.run(row.rowid);
                }
                catch { /* 无 vec 表 */ }
                try {
                    delEdge.run(row.id, row.id);
                }
                catch { /* 无 edges 表 */ }
            }
            return db.prepare(`
        DELETE FROM memory
        WHERE project = ? AND session_id = ? AND source = 'session_memory' AND is_active = 1
      `).run(proj, sessionId).changes;
        });
        return tx();
    }
    catch (e) {
        debugCatch('store:deleteSessionFragments', e);
        return 0;
    }
}
/**
 * v1.26：晋升后精确删 —— 只摘掉「已经被晋升吸走」的那几行，不再整段清空会话滚动状态
 *
 * 旧行为（deleteSessionFragments）在晋升成功后按 (project, session_id) 删掉**整条**
 * session_memory 行。而 session_memory 是「单会话单行滚动快照」（见 upsertSessionMemory），
 * 于是：只要这一轮 LLM 没有返回新的 sessionMemory，整段滚动状态当场消失；就算返回了，
 * 没被晋升、也没被新快照覆盖的线索也一并没了。TECHNICAL.md §12 记的就是这一条。
 *
 * 这里的口径是「按内容认领」：把快照按行拆开，与晋升文本比对（归一化后互相包含，
 * 或 bigram Jaccard ≥ 0.6），命中的行才算被吸收，其余原样写回。
 * 行被删光才硬删整行（连带向量/边，与 deleteSessionFragments 的清法一致）。
 */
export function deletePromotedFragments(project, sessionId, promotedTexts) {
    const db = DatabaseManager.getInstance(project);
    const proj = normalizeProject(project);
    const nothing = { removedLines: 0, keptLines: 0, deleted: false };
    const norm = (s) => String(s || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '');
    const bigrams = (s) => {
        const n = norm(s);
        const out = new Set();
        for (let q = 0; q + 2 <= n.length; q++)
            out.add(n.slice(q, q + 2));
        return out;
    };
    const targets = (promotedTexts || [])
        .map(t => ({ n: norm(t), bg: bigrams(t) }))
        .filter(t => t.n.length >= 4);
    if (targets.length === 0)
        return nothing;
    const row = db.prepare(`
    SELECT rowid, id, text FROM memory
    WHERE project = ? AND session_id = ? AND source = 'session_memory' AND is_active = 1
    ORDER BY updated_at DESC LIMIT 1
  `).get(proj, sessionId);
    if (!row)
        return nothing;
    const lines = String(row.text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length === 0)
        return nothing;
    const kept = [];
    let removed = 0;
    for (const line of lines) {
        const ln = norm(line);
        if (ln.length < 4) {
            kept.push(line);
            continue;
        }
        const lb = bigrams(line);
        const hit = targets.some(t => {
            if (t.n.includes(ln))
                return true; // 该行整句被晋升文本吸走
            // 该行包住整条晋升文本：要求晋升文本够长、且这一行没有比它长太多，
            // 否则一个短词（"用户喜欢猫"）就能认领整段快照。
            if (ln.includes(t.n) && t.n.length >= 5 && ln.length <= t.n.length * 3)
                return true;
            if (lb.size < 6 || t.bg.size < 6)
                return false;
            let inter = 0;
            for (const g of lb)
                if (t.bg.has(g))
                    inter++;
            return inter / (lb.size + t.bg.size - inter) >= 0.6; // 换行/标点差异仍认得出是同一句
        });
        if (hit)
            removed++;
        else
            kept.push(line);
    }
    if (removed === 0)
        return { removedLines: 0, keptLines: lines.length, deleted: false };
    if (kept.length === 0) {
        try {
            db.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(row.rowid);
        }
        catch (e) {
            debugCatch('store:promotedFragments:vec', e);
        }
        try {
            db.prepare('DELETE FROM edges WHERE source_id = ? OR target_id = ?').run(row.id, row.id);
        }
        catch (e) {
            debugCatch('store:promotedFragments:edges', e);
        }
        db.prepare('DELETE FROM memory WHERE id = ?').run(row.id);
        return { removedLines: removed, keptLines: 0, deleted: true };
    }
    db.prepare('UPDATE memory SET text = ?, updated_at = ? WHERE id = ?')
        .run(kept.join('\n'), new Date().toISOString(), row.id);
    // 正文变了旧向量就失效；会话草稿行本不该走语义检索，摘掉让它按需重嵌
    try {
        db.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(row.rowid);
    }
    catch (e) {
        debugCatch('store:promotedFragments:vec', e);
    }
    return { removedLines: removed, keptLines: kept.length, deleted: false };
}
/**
 * v1.26：晋升项立刻补向量（后台、不 await）
 *
 * promoteToProject 刻意不嵌（后台反思不能依赖嵌入服务），代价是晋升出来的记忆要等
 * 重启补账或手动 `reflect_batch_embed` 才能语义检索 —— TECHNICAL.md §12 第一条。
 * 这里在晋升返回后起火并忘：不阻塞这次反思的响应，失败只记调试日志；
 * 嵌入服务不可用时干脆不做（行为与旧版一致）。
 */
export function embedPromotedInBackground(ids, project, cap = 50) {
    if (!ids || ids.length === 0)
        return;
    if (!isEmbedEnabled()) {
        debugLog('store:embedPromoted', 'skip — 嵌入未启用（EMBED_MODE=none）');
        return;
    }
    const proj = normalizeProject(project);
    const list = ids.slice(0, Math.max(0, cap));
    setTimeout(() => {
        void (async () => {
            let ok = 0;
            for (const id of list) {
                try {
                    if (await reEmbedMemory(id, proj))
                        ok++;
                }
                catch (e) {
                    debugCatch('store:embedPromoted', e);
                }
            }
            if (ok < list.length)
                debugLog('store:embedPromoted', `${ok}/${list.length} 条晋升项已补向量`);
        })();
    }, 0);
}
export async function applyIdentityActions(actions, project) {
    const rejected = [];
    let applied = 0;
    // add:新身份事实(不走 exact-dup 抑制?保留,重复文本仍会 reference_count++,天然防重复)
    for (const a of actions.add ?? []) {
        await saveMemory({
            text: a.text, type: 'entity', tags: a.tags, title: a.title,
            importance: a.importance ?? 0.7, metadata: a.metadata, project,
            scoreConfidence: a.scoreConfidence, scoreImpact: a.scoreImpact,
            scorePriority: a.scorePriority, scoreUrgency: a.scoreUrgency,
        });
        applied++;
    }
    // update:id 白名单校验(存在 + type=entity + active)
    for (const u of actions.update ?? []) {
        const found = findDbByMemoryId(u.id, project);
        if (!found) {
            rejected.push(`update:unknown-id:${u.id}`);
            continue;
        }
        const existing = found.db.prepare('SELECT * FROM memory WHERE id = ? AND is_active = 1').get(u.id);
        if (!existing) {
            rejected.push(`update:inactive:${u.id}`);
            continue;
        }
        if (existing.type !== 'entity') {
            rejected.push(`update:not-entity:${u.id}`);
            continue;
        }
        if (u.mergeStrategy === 'replace') {
            await updateMemory(u.id, { ...u.set, project, type: 'entity' });
        }
        else {
            // merge:tags 合并去重、metadata 对象级 merge,其余字段由 set 覆盖
            const merged = { ...u.set, project, type: 'entity' };
            if (u.set.tags && existing.tags) {
                merged.tags = [...new Set([...parseTagsSafe(existing.tags), ...normalizeTagsForWrite(u.set.tags)])];
            }
            if (u.set.metadata && existing.metadata) {
                try {
                    merged.metadata = JSON.stringify({ ...JSON.parse(existing.metadata), ...JSON.parse(u.set.metadata) });
                }
                catch { /* 保持 set */ }
            }
            await updateMemory(u.id, merged);
        }
        applied++;
    }
    // remove:白名单校验 + identity_locked 保护(forgetMemory 内二次校验)
    for (const r of actions.remove ?? []) {
        const found = findDbByMemoryId(r.id, project);
        if (!found) {
            rejected.push(`remove:unknown-id:${r.id}`);
            continue;
        }
        const existing = found.db.prepare('SELECT * FROM memory WHERE id = ? AND is_active = 1').get(r.id);
        if (!existing) {
            rejected.push(`remove:inactive:${r.id}`);
            continue;
        }
        if (existing.type !== 'entity') {
            rejected.push(`remove:not-entity:${r.id}`);
            continue;
        }
        if (existing.identity_locked === 1) {
            rejected.push(`remove:locked:${r.id}`);
            continue;
        }
        if (forgetMemory(r.id, project))
            applied++;
        else
            rejected.push(`remove:failed:${r.id}`);
    }
    return { applied, rejected };
}
