/**
 * 记忆整理 — sigmoid 时间衰减 + reference_count 升华
 *
 * 去重完全交给大模型 reflect 接口做语义判断，consolidate 只做纯规则维护：
 * - Phase 1: sigmoid 时间衰减 → 旧记忆自动降权，低于阈值软删除
 * - Phase 2: reference_count 升华 → 被反复引用的记忆重要性提升
 *
 * v1.10: findSimilarCandidates — 记忆整合(Memory Consolidator)的向量预筛候选。
 */
import { DatabaseManager, listMemTypeDirs } from './db.js';
import { cosineSimilarity } from './ollama.js';
import { isEmbedEnabled, normalizeProject } from './env.js';
const ACTIVATION_THRESHOLD = 0.15;
// ═══ v1.10: 记忆整合候选预筛配置(env 可配;config.json 的 consolidate.similarity 会覆盖) ═══
export const CONSOLIDATE_SIMILARITY = (() => {
    const v = parseFloat(process.env.CONSOLIDATE_SIMILARITY || '0.88');
    return Number.isFinite(v) && v > 0 ? v : 0.88;
})();
/**
 * v1.11 结构兜底候选:反思/摘要写出的"报告式"记忆(表头形如 `# User Profile: …`)表头相同、内容各异,
 * 实测组内向量余弦中位只有 0.55(远低于 0.88 阈值)、词袋重叠 0.06 —— 纯语义预筛抓不到它们,
 * 于是这类"看着像重复"的记忆永远进不了 LLM 裁决。这里按 (memType + `# 表头`) 分桶补候选:
 * 每桶以"最长的一条"为锚,最多补 N 对,判断权仍完全交给 LLM(它完全可以判"不是重复")。
 * 设 0 即关闭该兜底。
 */
export const CONSOLIDATE_BUCKET_PAIRS = (() => {
    const v = parseInt(process.env.CONSOLIDATE_BUCKET_PAIRS || '3', 10);
    return Number.isFinite(v) && v >= 0 ? v : 3;
})();
/**
 * v1.23-fix: 给"结构兜底候选"预留的名额。原实现先跑语义预筛、再跑结构兜底，
 * 语义候选一旦占满 limit（现网长期 50/50），同表头的报告式重复永远进不了裁决
 * （实测 269 条 `# Project Context:` 结构对 = 0）。预留一小段名额即可让两类都上桌。
 */
export const CONSOLIDATE_BUCKET_RESERVE = (() => {
    const v = parseInt(process.env.CONSOLIDATE_BUCKET_RESERVE || '15', 10);
    return Number.isFinite(v) && v >= 0 ? v : 15;
})();
/** 候选对数上限,防止相似爆炸 */
export const CONSOLIDATE_MAX_PAIRS = (() => {
    const v = parseInt(process.env.CONSOLIDATE_MAX_PAIRS || '50', 10);
    return Number.isFinite(v) && v > 0 ? v : 50;
})();
/**
 * v1.10: 向量预筛相似记忆对(cos 相似度 > threshold)。
 * - EMBED_MODE=none → 直接返回 [] (LLM 全量扫兜底)
 * - vec0 虚拟表禁止 JOIN:先对每条记忆做 KNN 取候选 rowid,再二段过滤 project/locked
 * - 每对去重(不重复 idA/idB、不反向),数量上限 limit 防爆炸
 */
/** v1.11.2 单个 memType 库的语义预筛(向量 KNN);候选并入共享 seen/pairs。 */
function scanVectorPairs(db, proj, threshold, limit, seen, pairs) {
    const mems = db.prepare(`
    SELECT m.rowid, m.id FROM memory m
    WHERE m.is_active = 1 AND m.project = ? AND (m.locked IS NULL OR m.locked = 0)
      AND COALESCE(m.tier, 'standard') <> 'critical'
      AND COALESCE(m.status, '') NOT IN ('cold', 'superseded')
      -- v1.27: 派生叙述不参与整合（摘要之间互合并只会让模型的自述越滚越大）
      AND m.derived = 0
    ORDER BY m.created_at DESC
    LIMIT 500
  `).all(proj);
    if (mems.length < 2)
        return;
    const rowidList = mems.map(m => Number(m.rowid));
    let vecRows = [];
    try {
        vecRows = db.prepare(`
      SELECT rowid, embedding FROM vec_memory WHERE rowid IN (${rowidList.map(() => '?').join(',')})
    `).all(...rowidList);
    }
    catch {
        return;
    }
    if (vecRows.length < 2)
        return;
    const memByRowid = new Map();
    for (const m of mems)
        memByRowid.set(Number(m.rowid), m.id);
    const vecByRowid = new Map();
    for (const r of vecRows) {
        const b = r.embedding;
        vecByRowid.set(Number(r.rowid), Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)));
    }
    if (vecByRowid.size < 2)
        return;
    const scanK = Math.min(20, mems.length);
    for (const m of mems) {
        const rowid = Number(m.rowid);
        const vec = vecByRowid.get(rowid);
        if (!vec)
            continue;
        let knn = [];
        try {
            knn = db.prepare(`
        SELECT rowid, distance FROM vec_memory
        WHERE embedding MATCH ? ORDER BY distance LIMIT ?
      `).all(new Float32Array(vec), scanK);
        }
        catch {
            continue;
        }
        for (const n of knn) {
            const nRowid = Number(n.rowid);
            if (nRowid === rowid)
                continue;
            // 二段过滤:只保留同项目 active 记忆(locked 已排除)的邻居
            const otherId = memByRowid.get(nRowid);
            if (!otherId)
                continue;
            const otherVec = vecByRowid.get(nRowid);
            if (!otherVec)
                continue;
            const sim = cosineSimilarity(vec, otherVec);
            if (sim < threshold)
                continue;
            const a = m.id;
            const b = otherId;
            const key = a < b ? `${a}|${b}` : `${b}|${a}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            pairs.push({ idA: a, idB: b, similarity: Math.round(sim * 1000) / 1000 });
            if (pairs.length >= limit)
                return;
        }
    }
}
/** v1.11.2 单个 memType 库的结构兜底(同 `# 表头` 分桶);由 findSimilarCandidates 跨库调度。 */
function scanStructPairs(db, proj, limit, seen, pairs) {
    // ═══ v1.11 结构兜底:同 `# 表头` + 同 memType 分桶补候选(相似度记 0,表示"结构配对"而非语义相似)═══
    if (CONSOLIDATE_BUCKET_PAIRS > 0 && pairs.length < limit) {
        let rows2 = [];
        try {
            rows2 = db.prepare(`
        SELECT id, text, mem_type FROM memory
        WHERE is_active = 1 AND project = ? AND (locked IS NULL OR locked = 0)
          AND COALESCE(tier, 'standard') <> 'critical'
          AND COALESCE(status, '') NOT IN ('cold', 'superseded')
          AND derived = 0
        ORDER BY created_at DESC LIMIT 500
      `).all(proj);
        }
        catch {
            rows2 = [];
        }
        const buckets = new Map();
        for (const r of rows2) {
            const mm = /^\s*#\s*([^:\n·]{2,26})/.exec(String(r.text || ''));
            if (!mm)
                continue;
            const head = mm[1].replace(/\s+/g, ' ').trim();
            if (!head)
                continue;
            const key = String(r.mem_type || 'general') + '\u0000' + head;
            if (!buckets.has(key))
                buckets.set(key, []);
            buckets.get(key).push(r);
        }
        for (const [, arr] of buckets) {
            if (arr.length < 2)
                continue;
            // 锚 = 最长的一条(信息量最大),其余各与锚配一对
            const sorted = arr.slice().sort((a, b) => String(b.text || '').length - String(a.text || '').length);
            let added = 0;
            for (let i = 1; i < sorted.length && added < CONSOLIDATE_BUCKET_PAIRS; i++) {
                const a = String(sorted[0].id), b = String(sorted[i].id);
                if (!a || !b || a === b)
                    continue;
                const k = a < b ? `${a}|${b}` : `${b}|${a}`;
                if (seen.has(k))
                    continue;
                seen.add(k);
                pairs.push({ idA: a, idB: b, similarity: 0 });
                added++;
                if (pairs.length >= limit)
                    return;
            }
        }
    }
    return;
}
export async function findSimilarCandidates(project, threshold = CONSOLIDATE_SIMILARITY, limit = CONSOLIDATE_MAX_PAIRS) {
    if (!isEmbedEnabled())
        return [];
    const proj = normalizeProject(project);
    const seen = new Set();
    const pairs = [];
    // v1.11.2 memdir:每个 memType 是**独立 sqlite** —— 旧版只扫 general,user/feedback/project 里的
    // "报告式"重复(带 # 表头的成组记录)完全够不到,LLM 也就无从裁决。
    // 逐库扫描并把候选并起来;两阶段(先全库语义 → 再全库结构)是为了让表头对不挤占语义候选的名额。
    const dirs = listMemTypeDirs(proj);
    // 语义预筛给结构兜底预留名额，避免语义候选占满 50 对后结构对永远轮不到
    const structReserve = Math.min(CONSOLIDATE_BUCKET_RESERVE, limit);
    const vecLimit = Math.max(1, limit - structReserve);
    for (const mt of dirs) {
        if (pairs.length >= vecLimit)
            break;
        scanVectorPairs(DatabaseManager.getInstance(project, mt), proj, threshold, vecLimit, seen, pairs);
    }
    if (CONSOLIDATE_BUCKET_PAIRS > 0) {
        for (const mt of dirs) {
            if (pairs.length >= limit)
                break;
            scanStructPairs(DatabaseManager.getInstance(project, mt), proj, limit, seen, pairs);
        }
    }
    return pairs.slice(0, limit);
}
// ═══ 衰减/升华参数(config.json 的 consolidate.* → env,均可在部署侧自定义)═══
// 默认值即原行为:sigmoid 衰减(0.04 陡度 / 90 天中点),重要度 <0.15 且年龄 >60 天剪枝;
// 引用数 >2 升华 +0.1,上限 0.95。调大 midpointDays = 衰减更慢;调小 = 更快被剪。
const _pnum = (v, d) => {
    const n = parseFloat(v || '');
    return Number.isFinite(n) && n > 0 ? n : d;
};
const DECAY_STEEPNESS = _pnum(process.env.CONSOLIDATE_DECAY_STEEPNESS, 0.04);
const DECAY_MIDPOINT_DAYS = _pnum(process.env.CONSOLIDATE_DECAY_MIDPOINT_DAYS, 90);
const DECAY_MIN_IMPORTANCE = _pnum(process.env.CONSOLIDATE_DECAY_MIN_IMPORTANCE, ACTIVATION_THRESHOLD);
const DECAY_MIN_AGE_DAYS = _pnum(process.env.CONSOLIDATE_DECAY_MIN_AGE_DAYS, 60);
const PROMOTE_REF_COUNT = _pnum(process.env.CONSOLIDATE_PROMOTE_REF_COUNT, 2);
const PROMOTE_BOOST = _pnum(process.env.CONSOLIDATE_PROMOTE_BOOST, 0.1);
const PROMOTE_CAP = _pnum(process.env.CONSOLIDATE_PROMOTE_CAP, 0.95);
export async function consolidate(project) {
    const now = Date.now();
    let prunedCount = 0;
    let updatedCount = 0;
    let consolidateCount = 0;
    // ═══ 衰减范围(分级口径,与检索侧的 decayFor 对齐)═══
    // 检索侧:critical→永不衰减 / 时效类→10天半衰 / 其余→30天半衰。
    // 存储侧沿用同一原则:只让 general(流水/未分类)参与衰减+升华;
    // 四个语义分类库 user(画像)/feedback(纠偏)/project(项目)/reference(资料)**永不衰减**。
    // 覆盖方式:env CONSOLIDATE_DECAY_MEMTYPES(逗号分隔;"all" = 全部分类库),
    //          或 memory/config.json 的 consolidate.decayMemTypes。
    const proj = normalizeProject(project);
    const decayTypes = (process.env.CONSOLIDATE_DECAY_MEMTYPES || 'general')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const decayAll = decayTypes.includes('all');
    const decayDirs = listMemTypeDirs(proj)
        .filter(mt => decayAll || decayTypes.includes(mt.toLowerCase()));
    for (const mt of decayDirs) {
        const db = DatabaseManager.getInstance(proj, mt);
        // ═══ Phase 1: sigmoid 时间衰减 ═══
        // v1.23.1-fix: 从 base_importance 基线算，避免“已衰减值再乘一次”导致衰减取决于运行次数。
        // identity_locked 是 forgetMemory 的同款保护位，不能在这里被自动剪枝。
        const activeRecords = db.prepare(`
      SELECT id, importance, COALESCE(base_importance, importance) AS base_importance, last_accessed_at
      FROM memory WHERE is_active = 1 AND COALESCE(source, '') != 'manual_lore'
        AND COALESCE(tier, 'standard') != 'critical' AND (locked IS NULL OR locked = 0)
        AND COALESCE(identity_locked, 0) = 0
    `).all();
        const decayTx = db.transaction(() => {
            for (const mem of activeRecords) {
                const ts = new Date(mem.last_accessed_at).getTime();
                if (!Number.isFinite(ts))
                    continue; // 非法时间戳跳过,避免 importance 被写成 NaN
                const hoursSince = (now - ts) / 3600000;
                const daysSince = hoursSince / 24;
                const decay = 1.0 / (1.0 + Math.exp(DECAY_STEEPNESS * (daysSince - DECAY_MIDPOINT_DAYS)));
                const base = Number(mem.base_importance ?? mem.importance) || 0;
                const newImportance = Math.round(base * decay * 1000) / 1000;
                if (newImportance < DECAY_MIN_IMPORTANCE && daysSince > DECAY_MIN_AGE_DAYS) {
                    db.prepare('UPDATE memory SET is_active = 0, importance = ? WHERE id = ?')
                        .run(newImportance, mem.id);
                    prunedCount++;
                }
                else {
                    db.prepare('UPDATE memory SET importance = ?, base_importance = ? WHERE id = ?')
                        .run(newImportance, base, mem.id);
                    updatedCount++;
                }
            }
        });
        decayTx();
        // ═══ Phase 2: reference_count 升华 ═══
        const dupes = db.prepare(`SELECT id FROM memory WHERE is_active = 1 AND reference_count > ${PROMOTE_REF_COUNT} LIMIT 20`).all();
        for (const dup of dupes) {
            db.prepare(`UPDATE memory SET reference_count = 0,
           importance = MIN(${PROMOTE_CAP}, COALESCE(base_importance, importance) + ${PROMOTE_BOOST}),
           base_importance = MIN(${PROMOTE_CAP}, COALESCE(base_importance, importance) + ${PROMOTE_BOOST})
         WHERE id = ?`).run(dup.id);
            consolidateCount++;
        }
    }
    return {
        success: true,
        decayedOrUpdated: updatedCount,
        pruned: prunedCount,
        consolidated: consolidateCount,
    };
}
