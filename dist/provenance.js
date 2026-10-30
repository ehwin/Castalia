/**
 * Provenance —— 证据与派生记录的硬边界（纯记忆体层，不含任何情感/psyche 概念）
 *
 * 取自 psyche-memory-self-cycle-audit / full-chain-upgrade 两份报告里与记忆体有关的不变量：
 *
 *   1. 证据（对话原文、用户显式写入）与派生记录（模型自己写的摘要/洞察）必须可区分；
 *   2. 派生记录必须带 provenance：generated_by / evidence_ids / evidence_key；
 *   3. 派生记录默认不参与检索、上下文注入、反思输入、整合与事实来源；
 *      只有显式 includeDerived 才能看到；
 *   4. 幂等：同一 evidence_key 只落一行，崩溃后重试复用已有行，而不是再造一条。
 *
 * 注意分类：报告里"日记"对应本仓的 reflect_summary / reflect_insight（模型叙述）。
 * reflect_extract / reflect_merge / reflect_split 是**内容**（从证据里抽出的原子记忆，
 * 检索主链就是靠它们），它们记 provenance 但不打 derived 标记 —— 否则记忆体等于被清空。
 */
import { createHash } from 'node:crypto';
/** 派生叙述来源：模型对自己的解释，不得回流成证据 */
export const DERIVED_SOURCES = ['reflect_summary', 'reflect_insight'];
/** 已知的派生写入来源（含内容型），用于打 generated_by */
export const REFLECT_SOURCES = [
    'reflect_summary',
    'reflect_insight',
    'reflect_extract',
    'reflect_merge',
    'reflect_split',
];
export function isDerivedSource(source) {
    return typeof source === 'string' && DERIVED_SOURCES.includes(source);
}
export function isReflectSource(source) {
    return typeof source === 'string' && REFLECT_SOURCES.includes(source);
}
export const DERIVED_POLICY_DEFAULT = 'demoted';
export function normalizeDerivedPolicy(v) {
    return v === 'only' || v === 'excluded' || v === 'demoted' ? v : DERIVED_POLICY_DEFAULT;
}
/** 裸谓词（给"按 AND 拼接条件数组"的调用方；空串 = 不过滤） */
export function derivedPredicate(alias = 'm', policy = DERIVED_POLICY_DEFAULT) {
    if (policy === 'only')
        return `${alias}.derived = 1`;
    if (policy === 'excluded')
        return `${alias}.derived = 0`;
    return '';
}
/**
 * 带前导 AND 的片段（给"直接拼进 SQL 字符串"的调用方）。
 * 注意：拼进条件数组时必须用 derivedPredicate —— 否则会拼出 "AND  AND ..." 的语法错误，
 * 而单库的 catch 会把它变成"返回 0 条"，看起来像过滤生效。
 */
export function derivedFilter(alias = 'm', policy = DERIVED_POLICY_DEFAULT) {
    const p = derivedPredicate(alias, policy);
    return p ? ` AND ${p}` : '';
}
/** @deprecated 用 derivedFilter；保留只为旧调用点（按 includeDerived 布尔）不破 */
export function derivedGuard(alias = 'm', includeDerived = false) {
    return includeDerived ? '' : ` AND ${alias}.derived = 0`;
}
/** 归一化 evidence id 列表：去空、去重、排序（保证 evidence_key 与顺序无关） */
export function normalizeEvidenceIds(ids) {
    if (!Array.isArray(ids))
        return [];
    const seen = new Set();
    for (const raw of ids) {
        const s = typeof raw === 'string' ? raw.trim() : '';
        if (s)
            seen.add(s);
    }
    return [...seen].sort();
}
/**
 * evidence_key —— 幂等键。
 * 同一来源集合 + 同一派生种类 → 同一个键；与模型重新生成时的措辞无关。
 */
export function evidenceKeyOf(kind, evidenceIds) {
    const ids = normalizeEvidenceIds(evidenceIds);
    if (!ids.length)
        return null;
    const hash = createHash('sha256')
        .update(`${kind}\u0000${ids.join('\u0001')}`)
        .digest('hex');
    return `${kind}:${hash.slice(0, 24)}`;
}
export function serializeEvidenceIds(ids) {
    const list = normalizeEvidenceIds(ids);
    return list.length ? JSON.stringify(list) : null;
}
export function parseEvidenceIds(raw) {
    if (typeof raw !== 'string' || !raw.trim())
        return [];
    try {
        const parsed = JSON.parse(raw);
        return normalizeEvidenceIds(parsed);
    }
    catch {
        return [];
    }
}
/**
 * 一次性回填：历史库里已经存在的反思摘要/洞察补上 derived=1。
 * 用 _provenance_meta 打点，避免每次打开库都全表扫一遍。
 */
export function backfillDerivedFlag(db) {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS _provenance_meta (k TEXT PRIMARY KEY, v TEXT)`);
        const done = db.prepare(`SELECT v FROM _provenance_meta WHERE k = 'derived_backfill'`).get();
        if (done)
            return;
        const placeholders = DERIVED_SOURCES.map(() => '?').join(', ');
        const res = db.prepare(`
      UPDATE memory
         SET derived = 1,
             generated_by = COALESCE(generated_by, source)
       WHERE COALESCE(derived, 0) = 0
         AND source IN (${placeholders})
    `).run(...DERIVED_SOURCES);
        db.prepare(`INSERT OR REPLACE INTO _provenance_meta (k, v) VALUES ('derived_backfill', ?)`)
            .run(JSON.stringify({ at: new Date().toISOString(), rows: res.changes }));
        if (res.changes > 0) {
            console.error(`[provenance] backfilled derived=1 on ${res.changes} legacy rows`);
        }
    }
    catch {
        /* 旧库缺列时由 db.ts 的补列迁移负责；这里失败不阻断打开 */
    }
}
