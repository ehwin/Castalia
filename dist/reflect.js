/**
 * 记忆反思接口 — 供大模型（如 DeepSeek/GPT）调用
 *
 * 大模型拿到所有记忆，做反思式重构：
 *   - 合并重复记忆
 *   - 拆分过长的记忆
 *   - 建立关联（edges）
 *   - 降级/升级 importance
 *   - 重新分类
 *
 * HTTP 接口：
 *   GET  /memory/reflect/list    — 获取所有记忆（供大模型分析）
 *   POST /memory/reflect/apply   — 应用大模型的重构指令
 */
import { loadPromptOverride } from './promptFile.js';
import { DatabaseManager, listMemTypeDirs, currentMemDir } from './db.js';
import { saveFacts, saveMemory, batchEmbedPending, updateMemory, applyIdentityActions, findDbByMemoryId } from './store.js';
import { normalizeProject } from './env.js';
import { isMemType, MEM_TYPES } from './memType.js';
import fs from 'node:fs';
import path from 'node:path';
import { protectedReflectionProject, reflectionPolicy, wholeRecordBatches, fidelitySystemPrompt } from './reflectionFidelity.js';
import { getUnanalyzedConversations } from './reflectionSources.js';
export { getUnanalyzedConversations, markConversationsReflected, deepReflectionCursor } from './reflectionSources.js';
/**
 * 获取所有记忆（供大模型分析）
 */
export function listAllMemories(characterId = 'airi', limit = 200, project) {
    const proj = normalizeProject(project);
    // memdir:聚合项目全部分类库
    const dirs = listMemTypeDirs(proj);
    const all = [];
    for (const mt of dirs) {
        try {
            const db = DatabaseManager.getInstance(proj, mt);
            const rows = db.prepare(`
        SELECT id, text, type, mem_type, category, tags, importance,
               subject, source, tier, expires_at, created_at, last_accessed_at, accessed_count, reference_count, locked
        FROM memory
        WHERE is_active = 1 AND project = ?
          -- v1.23: 冷存与被接管的旧记忆不参加新一轮沉淀（否则深反思会反复处理同一批死记忆）
          AND COALESCE(status, '') NOT IN ('cold', 'superseded')
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `).all(proj, limit);
            all.push(...rows);
        }
        catch { /* 单分类库失败不影响其他 */ }
    }
    all.sort((a, b) => (b.importance - a.importance) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const rows = all.slice(0, limit);
    return rows.map(r => {
        let tags = [];
        try {
            const parsed = JSON.parse(r.tags || '[]');
            tags = Array.isArray(parsed) ? parsed : [];
        }
        catch {
            tags = [];
        }
        return {
            id: r.id,
            text: r.text,
            type: r.type,
            memType: r.mem_type || 'general',
            category: r.category,
            tags,
            importance: r.importance,
            subject: r.subject,
            source: r.source,
            tier: r.tier || 'standard',
            expiresAt: r.expires_at,
            createdAt: r.created_at,
            lastAccessedAt: r.last_accessed_at,
            accessedCount: r.accessed_count,
            referenceCount: r.reference_count || 0,
            locked: r.locked || 0,
        };
    });
}
/**
 * 应用大模型的重构指令
 */
// ═════════════════════════════════════════════════
// 护栏：拒绝明显无效的值，防止大模型幻觉污染数据库
// ═════════════════════════════════════════════════
const VALID_TYPES = new Set(['episodic', 'semantic', 'entity', 'preference']);
const VALID_MEM_TYPES = new Set(MEM_TYPES); // v1.8: 4 种封闭类型 + general
const VALID_CATEGORIES = new Set(['conversation', 'milestone', 'identity', 'relationship', 'knowledge', 'preference', 'general']);
function safeCategory(raw) {
    if (typeof raw !== 'string')
        return null;
    const value = raw.trim();
    return /^[\p{L}\p{N}_:-]{1,64}$/u.test(value) ? value : null;
}
const VALID_RELATIONS = new Set(['caused_by', 'part_of', 'follows', 'related_to', 'same_subject', 'causes', 'leads_to', 'sequence']);
function safeTags(raw) {
    if (!raw)
        return null;
    if (!Array.isArray(raw))
        return null;
    const filtered = raw.filter(t => typeof t === 'string' && t.length > 0 && t.length < 50);
    return filtered.length > 0 ? filtered : null;
}
/**
 * v1.11.4 跨 memType 库解析目标记忆 —— **同族坑第三次**:applyReflectActions 旧实现把 merge/split/
 * delete/reclassify/relate/boost/decay 的语句全打在 `getInstance(project)`(= 只 general 一个 sqlite)上,
 * 于是 user/feedback/project 里的记忆一律 "not found or locked";更糟的是 merge 仍会**无条件插入**合并结果
 * → 源还在、又多一条 = 净增重复(2026-09-19 副本实测:9 个 merge 全失败,活跃 229→238)。
 * 顺序:精确 id(store 的 findDbByMemoryId,内部先扫活跃再兜底墓碑)→ 前缀 LIKE(LLM 会给短 ID),先活跃后兜底;
 * 找不到则回退 fallback(默认 general 库),让调用方原本的 "not found" 判断照常生效。
 */
function resolveReflectTarget(idPrefix, project, allowInactiveConversation = false) {
    if (!idPrefix || typeof idPrefix !== 'string')
        return null;
    const matches = [];
    for (const mt of listMemTypeDirs(normalizeProject(project))) {
        const db = DatabaseManager.getInstance(project, mt);
        const rows = db.prepare(`SELECT id FROM memory WHERE project = ? AND (is_active = 1${allowInactiveConversation ? " OR (is_active = 0 AND source = 'conversation_log')" : ''}) AND substr(id, 1, length(?)) = ?`)
            .all(normalizeProject(project), idPrefix, idPrefix);
        for (const row of rows)
            matches.push({ db, id: row.id });
    }
    const exact = matches.filter(m => m.id === idPrefix);
    if (exact.length === 1)
        return exact[0];
    return matches.length === 1 ? matches[0] : null;
}
function memDbFor(id, project, fallback) {
    return findDbByMemoryId(id, project)?.db ?? fallback;
}
// ═══ v1.23 反思保真：硬事实覆盖 + 证据附录 ═══════════════════════════════
// 背景：实测提取只保住 ~75% 的硬事实（路径/端口/版本/日期/数字）。这些是"复核所需"的锚点，
// 用程序算覆盖率比让模型自觉可靠；不够就把没覆盖到的原句**原样**补进去（纯字符串操作，零额外调用）。
const HARD_TOKEN_PATTERNS = [
    /[A-Za-z]:\\[^\s，。；、）)】"'`]+/g,
    /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
    /\b\d{2,5}\s*(?:B|KB|MB|GB|文件|条|帧|事件|个|秒|分钟|小时)\b/g,
    /\b\d+\.\d+(?:\.\d+)?\b/g,
    /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/g,
    /\b\d{1,5}\b/g,
    /[A-Z]{2,}-\d+/g,
];
/** 覆盖率闸门：低于该值就补证据附录。 */
const HARD_COVERAGE_MIN = 0.9;
function hardTokens(text) {
    const out = new Set();
    for (const re of HARD_TOKEN_PATTERNS) {
        for (const m of String(text || '').match(re) || []) {
            if (m.length > 3)
                out.add(m);
        }
    }
    return [...out];
}
function splitSentences(text) {
    return String(text || '')
        .split(/(?<=[。！？!?；;\n])/)
        .map(s => s.replace(/^[\s>]+/, '').trim())
        .filter(s => s.length >= 8);
}
function hardCoverage(sourceText, outputText) {
    const tokens = hardTokens(sourceText);
    if (!tokens.length)
        return { total: 0, ratio: 1, missing: [] };
    const haystack = String(outputText || '');
    const missing = tokens.filter(t => !haystack.includes(t));
    return { total: tokens.length, ratio: (tokens.length - missing.length) / tokens.length, missing };
}
/**
 * 提取完成后按来源检查硬事实覆盖：不达标就把"含缺失 token 的原句"追加到该来源第一条 extract 上。
 * 多主题拆条时按来源汇总判断，避免每条都被误判为低覆盖而重复补。
 */
function attachEvidenceAppendix(result, project, warnings) {
    const actions = Array.isArray(result.actions) ? result.actions : [];
    const bySource = new Map();
    for (const a of actions) {
        if (!a || a.action !== 'extract' || typeof a.sourceId !== 'string')
            continue;
        const list = bySource.get(a.sourceId) || [];
        list.push(a);
        bySource.set(a.sourceId, list);
    }
    for (const [sourceId, list] of bySource) {
        const target = resolveReflectTarget(sourceId, project, true);
        if (!target)
            continue;
        let sourceText = '';
        try {
            sourceText = target.db.prepare('SELECT text FROM memory WHERE id = ?').get(target.id)?.text || '';
        }
        catch {
            continue;
        }
        if (!sourceText)
            continue;
        const merged = list.map((a) => String(a.newText || '')).join('\n');
        const { total, ratio, missing } = hardCoverage(sourceText, merged);
        if (!total || !missing.length || ratio >= HARD_COVERAGE_MIN)
            continue;
        const missingSet = new Set(missing);
        const sentences = [...new Set(splitSentences(sourceText).filter(s => hardTokens(s).some(t => missingSet.has(t))))].slice(0, 12);
        if (!sentences.length)
            continue;
        const appendix = `\n\n【证据附录·原文】\n${sentences.map(s => `> ${s}`).join('\n')}`;
        list[0].newText = String(list[0].newText || '') + appendix;
        warnings.push(`证据附录：来源 ${String(sourceId).slice(0, 8)} 硬事实覆盖 ${(ratio * 100).toFixed(0)}%，补 ${sentences.length} 句原文`);
    }
}
export async function applyReflectActions(actions, characterId = 'airi', project, options = {}) {
    const db = DatabaseManager.getInstance(project);
    const result = { applied: 0, errors: [], details: [], receipts: [] };
    for (let action of actions) {
        const receipt = {
            action: action.action,
            status: 'applied',
            targetId: action.targetId || action.sourceId || null,
            reason: '',
            rowsAffected: 0,
        };
        try {
            action = { ...action };
            // v1.23-fix: 整合模式放行 merge（合并结果落库后再软删源，内容可回查）；其余破坏性动作照旧禁止。
            const mergeAllowedByConsolidation = options.consolidation === true && action.action === 'merge';
            if ((protectedReflectionProject(project) || (options.automatic && reflectionPolicy(project) === 'evidence')) &&
                !mergeAllowedByConsolidation &&
                (['merge', 'delete', 'split', 'identityUpdate'].includes(action.action) || (action.action === 'reclassify' && action.newText !== undefined))) {
                throw new Error('preservation policy forbids destructive reflection actions');
            }
            if (action.action === 'reclassify') {
                action.newTypeSingle ??= action.newType;
                action.newCategorySingle ??= action.newCategory;
            }
            const ids = action.action === 'merge' ? action.sourceIds :
                [action.targetId, action.sourceId, action.targetIdRelate].filter((id) => !!id);
            if (ids) {
                if (options.allowedSourceIds && ids.some(id => !options.allowedSourceIds.has(id))) {
                    throw new Error('target is outside the current reflection input');
                }
                const resolved = ids.map(id => resolveReflectTarget(id, project, action.action === 'extract'));
                if (resolved.some(target => !target))
                    throw new Error('target missing, inactive or ambiguous');
                if (action.action === 'merge') {
                    action.sourceIds = resolved.map(target => target.id);
                    if (new Set(action.sourceIds).size !== action.sourceIds.length)
                        throw new Error('duplicate merge sources');
                }
                else {
                    let i = 0;
                    if (action.targetId)
                        action.targetId = resolved[i++].id;
                    if (action.sourceId)
                        action.sourceId = resolved[i++].id;
                    if (action.targetIdRelate)
                        action.targetIdRelate = resolved[i++].id;
                }
            }
            switch (action.action) {
                case 'merge': {
                    if (protectedReflectionProject(project))
                        throw new Error(`merge is disabled for ${reflectionPolicy(project)} projects`);
                    // 合并多个记忆为一个
                    if (!action.sourceIds || action.sourceIds.length < 2 || !action.newText) {
                        result.errors.push('merge: need sourceIds and newText');
                        receipt.status = 'failed';
                        receipt.reason = 'need sourceIds and newText';
                        result.receipts.push(receipt);
                        continue;
                    }
                    // 先完整校验所有源，再执行任何软删除；避免混合合法/非法 ID 造成部分破坏。
                    const mergeSources = [];
                    let mergeInvalid = null;
                    for (const id of action.sourceIds) {
                        const sdb = memDbFor(id, project, db);
                        // v1.23: critical 不参与合并（否则核心记忆会被"沉淀"掉）
                        const src = sdb.prepare("SELECT id FROM memory WHERE id = ? AND is_active = 1 AND (locked IS NULL OR locked = 0) AND COALESCE(identity_locked, 0) = 0 AND COALESCE(tier, 'standard') <> 'critical'").get(id);
                        if (!src) {
                            mergeInvalid = `source not found or locked: ${id}`;
                            break;
                        }
                        mergeSources.push({ db: sdb, id: src.id });
                    }
                    if (mergeInvalid) {
                        receipt.status = 'failed';
                        receipt.reason = mergeInvalid;
                        result.errors.push(`merge: ${mergeInvalid}`);
                        result.receipts.push(receipt);
                        continue;
                    }
                    // 先成功写入合并结果，再删除源；若嵌入/数据库写入失败，源记忆保持完整。
                    // saveMemory 是 async，跨 memType 删除无法使用单一 SQLite transaction。
                    const { saveMemory } = await import('./store.js');
                    const merged = await saveMemory({
                        text: action.newText,
                        type: (action.newType || 'semantic'),
                        // v1.10: merge 支持 newMemType — 记忆整合输出保持 4 种封闭类型之一
                        memType: isMemType(action.newMemType) ? action.newMemType : undefined,
                        category: action.newCategory || 'general',
                        tags: action.newTags || [],
                        importance: action.newImportance ?? 0.7,
                        characterId,
                        project,
                        source: 'reflect_merge',
                    });
                    receipt.rowsAffected = mergeSources.length;
                    // 所有源均已确认 active 且合并结果已落库后，才软删除并清理向量。
                    for (const src of mergeSources) {
                        if (src.id === merged.id)
                            continue;
                        src.db.prepare('UPDATE memory SET is_active = 0 WHERE id = ? AND is_active = 1 AND (locked IS NULL OR locked = 0) AND COALESCE(identity_locked, 0) = 0').run(src.id);
                        try {
                            const row = src.db.prepare('SELECT rowid FROM memory WHERE id = ?').get(src.id);
                            if (row)
                                src.db.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(row.rowid);
                        }
                        catch { /* 无向量时不阻断合并 */ }
                    }
                    if (receipt.status === 'applied')
                        result.applied++;
                    result.details.push(`merge: ${action.sourceIds.length} → 1`);
                    break;
                }
                case 'split': {
                    if (protectedReflectionProject(project))
                        throw new Error(`split is disabled for ${reflectionPolicy(project)} projects`);
                    if (!action.targetId || !action.fragments?.length ||
                        action.fragments.some(f => !f.text?.trim())) {
                        throw new Error('split: need targetId and non-empty fragments');
                    }
                    const source = resolveReflectTarget(action.targetId, project);
                    const row = source.db.prepare('SELECT * FROM memory WHERE id = ? AND is_active = 1').get(source.id);
                    if (!row || row.locked || row.identity_locked)
                        throw new Error('split: target locked or inactive');
                    const children = [];
                    for (const frag of action.fragments) {
                        children.push(await saveMemory({
                            text: frag.text, type: frag.type || 'episodic',
                            memType: row.mem_type, category: frag.category || row.category || 'conversation',
                            tags: frag.tags || [], importance: frag.importance ?? 0.5,
                            characterId, project, source: 'reflect_split',
                        }));
                    }
                    if (!children.some(child => child.id === source.id)) {
                        source.db.prepare('UPDATE memory SET is_active = 0 WHERE id = ?').run(source.id);
                        try {
                            source.db.prepare('DELETE FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').run(source.id);
                        }
                        catch { /* optional vectors */ }
                    }
                    receipt.rowsAffected = children.length;
                    result.applied++;
                    result.details.push(`split: 1 → ${children.length}`);
                    break;
                }
                case 'relate': {
                    if (!action.sourceId || !action.targetIdRelate || !action.relationType) {
                        result.errors.push('relate: need sourceId, targetIdRelate, relationType');
                        receipt.status = 'failed';
                        receipt.reason = 'need sourceId, targetIdRelate, relationType';
                        result.receipts.push(receipt);
                        continue;
                    }
                    // 护栏：规范化 relation type
                    const relType = VALID_RELATIONS.has(action.relationType) ? action.relationType : 'related_to';
                    const edgeId = `edge_reflect_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
                    const _relR = memDbFor(action.sourceId, project, db).prepare('INSERT OR IGNORE INTO edges (id, source_id, target_id, relation_type) VALUES (?, ?, ?, ?)')
                        .run(edgeId, action.sourceId, action.targetIdRelate, relType);
                    receipt.rowsAffected = _relR.changes;
                    if (_relR.changes === 0) {
                        receipt.status = 'failed';
                        receipt.reason = `edge exists or node missing: ${action.sourceId}→${action.targetIdRelate}`;
                    }
                    if (receipt.status === 'applied')
                        result.applied++;
                    result.details.push(`relate: ${action.sourceId} → ${action.targetIdRelate} (${relType})`);
                    break;
                }
                case 'reclassify': {
                    // v5.1: 兼容 LLM 可能用的 sourceId 或 targetId
                    const tid = action.targetId || action.sourceId;
                    if (!tid) {
                        result.errors.push('reclassify: need targetId or sourceId');
                        receipt.status = 'failed';
                        receipt.reason = 'need targetId or sourceId';
                        result.receipts.push(receipt);
                        continue;
                    }
                    const updates = [];
                    const values = [];
                    // 护栏：拒绝无效 type/category
                    if (action.newTypeSingle) {
                        if (!VALID_TYPES.has(action.newTypeSingle)) {
                            result.errors.push(`reclassify: invalid type "${action.newTypeSingle}", skipped`);
                            receipt.status = 'failed';
                            receipt.reason = `invalid type "${action.newTypeSingle}"`;
                            result.receipts.push(receipt);
                            continue;
                        }
                        updates.push('type = ?');
                        values.push(action.newTypeSingle);
                    }
                    if (action.newCategorySingle) {
                        if (!safeCategory(action.newCategorySingle)) {
                            result.errors.push(`reclassify: invalid category "${action.newCategorySingle}", skipped`);
                            receipt.status = 'failed';
                            receipt.reason = `invalid category "${action.newCategorySingle}"`;
                            result.receipts.push(receipt);
                            continue;
                        }
                        updates.push('category = ?');
                        values.push(action.newCategorySingle);
                    }
                    if (action.newTags) {
                        const valid = safeTags(action.newTags);
                        if (!valid) {
                            result.errors.push('reclassify: invalid tags (must be string array), skipped');
                            receipt.status = 'failed';
                            receipt.reason = 'invalid tags';
                            result.receipts.push(receipt);
                            continue;
                        }
                        updates.push('tags = ?');
                        values.push(JSON.stringify(valid));
                    }
                    if (action.newMemType) {
                        if (!isMemType(action.newMemType)) {
                            result.errors.push(`reclassify: invalid memType "${action.newMemType}", skipped`);
                            receipt.status = 'failed';
                            receipt.reason = `invalid memType "${action.newMemType}"`;
                            result.receipts.push(receipt);
                            continue;
                        }
                        updates.push('mem_type = ?');
                        values.push(action.newMemType);
                    }
                    // v5.x: reclassify 支持 newText — 文本内容更新(时间规范化等)
                    let textChanged = false;
                    if (action.newText !== undefined && action.newText !== null) {
                        if (typeof action.newText !== 'string' || action.newText.trim().length === 0) {
                            result.errors.push('reclassify: invalid newText (must be non-empty string), skipped');
                            receipt.status = 'failed';
                            receipt.reason = 'invalid newText';
                            result.receipts.push(receipt);
                            continue;
                        }
                        updates.push('text = ?');
                        values.push(action.newText.trim());
                        textChanged = true;
                    }
                    if (updates.length > 0) {
                        // 参数顺序:update 字段值 → updated_at → LIKE 前缀(修复历史错位 bug)
                        const _tdb = memDbFor(tid, project, db);
                        const existing = _tdb.prepare('SELECT * FROM memory WHERE id = ? AND is_active = 1').get(tid);
                        if (!existing || existing.locked || existing.identity_locked)
                            throw new Error('target locked or inactive');
                        const patch = { project };
                        const names = { type: 'type', category: 'category', tags: 'tags', mem_type: 'memType', text: 'text' };
                        updates.forEach((field, i) => {
                            const key = field.split(' = ')[0];
                            patch[names[key]] = key === 'tags' ? JSON.parse(values[i]) : values[i];
                        });
                        const updated = await updateMemory(tid, patch);
                        const _recR = { changes: updated ? 1 : 0 };
                        receipt.rowsAffected = _recR.changes;
                        if (_recR.changes === 0) {
                            receipt.status = 'failed';
                            receipt.reason = `target not found: ${tid}`;
                        }
                        if (receipt.status === 'applied')
                            result.applied++;
                        result.details.push(`reclassify: ${tid}`);
                        // v5.x: text 变更后删除旧向量,下次 batchEmbedPending 重新 embed
                        if (textChanged && _recR.changes > 0) {
                            try {
                                const currentDb = memDbFor(tid, project, db);
                                const _vecRow = currentDb.prepare('SELECT rowid FROM memory WHERE id = ? LIMIT 1').get(tid);
                                if (_vecRow)
                                    currentDb.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(_vecRow.rowid);
                            }
                            catch { /* 静默 */ }
                        }
                    }
                    break;
                }
                case 'extract': {
                    // v5.0: 从源记忆中提取有效信息为新记忆（不删除源）
                    if (!action.sourceId || !action.newText) {
                        result.errors.push('extract: need sourceId and newText');
                        receipt.status = 'failed';
                        receipt.reason = 'need sourceId and newText';
                        result.receipts.push(receipt);
                        continue;
                    }
                    const validType = action.newType && VALID_TYPES.has(action.newType) ? action.newType : 'semantic';
                    const validCat = safeCategory(action.newCategory) || 'general';
                    const validMemType = isMemType(action.newMemType) ? action.newMemType : undefined;
                    const validTags = safeTags(action.newTags) || [];
                    const importance = action.newImportance ?? 0.6;
                    const tier = (action.tier && ['temporary', 'standard', 'critical'].includes(action.tier))
                        ? action.tier : 'standard';
                    // 源文本：既用于 quotes 子串校验，也用于证据附录的兜底
                    const sourceTarget = resolveReflectTarget(action.sourceId, project, true);
                    let sourceText = '';
                    if (sourceTarget) {
                        try {
                            sourceText = sourceTarget.db.prepare('SELECT text FROM memory WHERE id = ?').get(sourceTarget.id)?.text || '';
                        }
                        catch { /* 读不到就跳过校验 */ }
                    }
                    // Graphiti 式引用校验：只有能在原文里子串命中的引用才保留（防模型编造原话）
                    const quoteClean = (q) => String(q).replace(/^[「『"']+|[」』"']+$/g, '').trim();
                    const validQuotes = (Array.isArray(action.quotes) ? action.quotes : [])
                        .map(quoteClean)
                        .filter((q) => q.length >= 4 && (!sourceText || sourceText.includes(q)))
                        .slice(0, 6);
                    const textWithQuotes = validQuotes.length
                        ? `${String(action.newText).trimEnd()}\n\n【原文引用】\n${validQuotes.map((q) => `> ${q}`).join('\n')}`
                        : String(action.newText);
                    const { saveMemory } = await import('./store.js');
                    const extracted = await saveMemory({
                        text: textWithQuotes,
                        type: validType,
                        memType: validMemType,
                        category: validCat,
                        tags: validTags,
                        importance,
                        tier,
                        characterId,
                        project,
                        source: 'reflect_extract',
                        metadata: JSON.stringify({ reflection: { sourceIds: [action.sourceId], project: normalizeProject(project), role: 'leaf', quotes: validQuotes.length } }),
                    });
                    // Exact duplicate extraction can point to several source records.
                    const extractedDb = findDbByMemoryId(extracted.id, project)?.db;
                    if (extractedDb) {
                        const row = extractedDb.prepare('SELECT metadata FROM memory WHERE id = ?').get(extracted.id);
                        let meta = {};
                        try {
                            meta = JSON.parse(row?.metadata || '{}');
                        }
                        catch { /* older free-form metadata */ }
                        meta.reflection = { ...meta.reflection, sourceIds: [...new Set([...(Array.isArray(meta.reflection?.sourceIds) ? meta.reflection.sourceIds : []), action.sourceId])], project: normalizeProject(project) };
                        extractedDb.prepare('UPDATE memory SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), extracted.id);
                        // Parent-Child：leaf 指回对话原文，检索时按 parent_id 回捞整段（llama_index ParentDocumentRetriever）
                        try {
                            extractedDb.prepare('UPDATE memory SET parent_id = ? WHERE id = ?').run(action.sourceId, extracted.id);
                        }
                        catch { /* 旧库未迁移 */ }
                    }
                    // hardFacts 直接进 facts 表（带证据与时间有效性）。这一步替代"把事实写进散文"。
                    if (Array.isArray(action.hardFacts) && action.hardFacts.length) {
                        try {
                            const { saveFacts } = await import('./store.js');
                            // facts 表与 general 库同一 sqlite；extract 若落到 project/user 等分类库，
                            // source_memory_id 跨库会触发 FOREIGN KEY（与 Anima 同一坑）。跨库时不挂来源。
                            const factOwnerMemType = findDbByMemoryId(extracted.id, project)?.memType;
                            const factSourceId = factOwnerMemType === 'general' ? extracted.id : null;
                            const facts = action.hardFacts
                                .filter((f) => f && typeof f === 'object' && f.subject && f.predicate && f.object)
                                .slice(0, 15)
                                .map((f) => ({
                                subject: String(f.subject).trim(),
                                predicate: String(f.predicate).trim(),
                                object: String(f.object).trim(),
                                confidence: Number.isFinite(Number(f.confidence)) ? Math.min(1, Math.max(0, Number(f.confidence))) : 0.7,
                                evidence: typeof f.evidence === 'string' ? f.evidence : undefined,
                                validFrom: typeof f.validFrom === 'string' ? f.validFrom : undefined,
                                validTo: typeof f.validTo === 'string' ? f.validTo : undefined,
                            }));
                            if (facts.length)
                                await saveFacts(facts, factSourceId, characterId, project);
                        }
                        catch (e) {
                            // 事实是"提取之外的富化"：失败只记在回执里，绝不能把整批打回重跑。
                            console.error('[reflect] hardFacts skipped:', e.message);
                            receipt.reason = `facts: ${e.message}`;
                        }
                    }
                    // 同主题/接续：只建链接、不覆盖旧记忆（mem0 linked_memory_ids 思路）
                    for (const linkedId of (Array.isArray(action.linkedMemoryIds) ? action.linkedMemoryIds : []).slice(0, 10)) {
                        if (typeof linkedId !== 'string' || linkedId === action.sourceId)
                            continue;
                        const target = resolveReflectTarget(linkedId, project, false);
                        if (!target)
                            continue;
                        try {
                            const row = target.db.prepare('SELECT metadata, locked, tier FROM memory WHERE id = ?').get(target.id);
                            if (!row || row.locked || row.tier === 'critical')
                                continue;
                            let meta = {};
                            try {
                                meta = JSON.parse(row.metadata || '{}');
                            }
                            catch { /* ignore */ }
                            meta.supersededBy = [...new Set([...(Array.isArray(meta.supersededBy) ? meta.supersededBy : []), extracted.id])];
                            target.db.prepare("UPDATE memory SET metadata = ?, status = 'superseded' WHERE id = ?").run(JSON.stringify(meta), target.id);
                        }
                        catch { /* 链接失败不影响提取 */ }
                    }
                    // 给源记忆 +reference_count（v5.1: LIKE 匹配短ID）
                    const sourceDb = sourceTarget?.db || memDbFor(action.sourceId, project, db);
                    sourceDb.prepare('UPDATE memory SET reference_count = reference_count + 1 WHERE id = ?').run(action.sourceId);
                    if (receipt.status === 'applied')
                        result.applied++;
                    receipt.rowsAffected = 1;
                    result.details.push(`extract: from ${action.sourceId} → ${validType}/${validCat} (${tier}) quotes=${validQuotes.length}`);
                    break;
                }
                case 'identityUpdate': {
                    // v1.15: 身份记忆 CRUD — add/update/remove,幻觉 id 由 applyIdentityActions 白名单校验拒绝
                    if (!action.identityActions) {
                        result.errors.push('identityUpdate: need identityActions');
                        receipt.status = 'failed';
                        receipt.reason = 'need identityActions';
                        result.receipts.push(receipt);
                        continue;
                    }
                    const r = await applyIdentityActions(action.identityActions, project);
                    receipt.rowsAffected = r.applied;
                    if (r.rejected.length > 0) {
                        receipt.status = 'failed';
                        receipt.reason = `rejected: ${r.rejected.join(', ')}`;
                        result.errors.push(`identityUpdate: ${r.rejected.join(', ')}`);
                    }
                    if (receipt.status === 'applied')
                        result.applied++;
                    result.details.push(`identityUpdate: +${r.applied} applied, ${r.rejected.length} rejected`);
                    break;
                }
                case 'delete': {
                    if (protectedReflectionProject(project))
                        throw new Error(`delete is disabled for ${reflectionPolicy(project)} projects`);
                    if (!action.targetId) {
                        result.errors.push('delete: need targetId');
                        receipt.status = 'failed';
                        receipt.reason = 'need targetId';
                        result.receipts.push(receipt);
                        continue;
                    }
                    // v1.23: critical 是"核心记忆"，除手动操作外不得被自动反思删除（Letta read_only 语义）
                    const _delR = memDbFor(action.targetId, project, db).prepare("UPDATE memory SET is_active = 0 WHERE id = ? AND (locked IS NULL OR locked = 0) AND COALESCE(identity_locked, 0) = 0 AND COALESCE(tier, 'standard') <> 'critical'").run(action.targetId);
                    receipt.rowsAffected = _delR.changes;
                    if (_delR.changes === 0) {
                        receipt.status = 'failed';
                        receipt.reason = `target not found or locked: ${action.targetId}`;
                    }
                    if (receipt.status === 'applied')
                        result.applied++;
                    result.details.push(`delete: ${action.targetId}`);
                    break;
                }
                case 'boost': {
                    if (!action.targetId || action.delta === undefined) {
                        result.errors.push('boost: need targetId and delta');
                        receipt.status = 'failed';
                        receipt.reason = 'need targetId and delta';
                        result.receipts.push(receipt);
                        continue;
                    }
                    const _boR = memDbFor(action.targetId, project, db).prepare('UPDATE memory SET importance = MIN(0.95, MAX(0.1, importance + ?)) WHERE id = ? AND (locked IS NULL OR locked = 0) AND COALESCE(identity_locked, 0) = 0')
                        .run(action.delta, action.targetId);
                    receipt.rowsAffected = _boR.changes;
                    if (_boR.changes === 0) {
                        receipt.status = 'failed';
                        receipt.reason = `target not found or locked: ${action.targetId}`;
                    }
                    if (receipt.status === 'applied')
                        result.applied++;
                    result.details.push(`boost: ${action.targetId} += ${action.delta}`);
                    break;
                }
                case 'decay': {
                    if (!action.targetId || action.delta === undefined) {
                        result.errors.push('decay: need targetId and delta');
                        receipt.status = 'failed';
                        receipt.reason = 'need targetId and delta';
                        result.receipts.push(receipt);
                        continue;
                    }
                    const _deR = memDbFor(action.targetId, project, db).prepare('UPDATE memory SET importance = MIN(0.95, MAX(0.1, importance - ?)) WHERE id = ? AND (locked IS NULL OR locked = 0) AND COALESCE(identity_locked, 0) = 0')
                        .run(action.delta, action.targetId);
                    receipt.rowsAffected = _deR.changes;
                    if (_deR.changes === 0) {
                        receipt.status = 'failed';
                        receipt.reason = `target not found or locked: ${action.targetId}`;
                    }
                    if (receipt.status === 'applied')
                        result.applied++;
                    result.details.push(`decay: ${action.targetId} -= ${action.delta}`);
                    break;
                }
                default:
                    result.errors.push(`unknown action: ${action.action}`);
                    receipt.status = 'skipped';
                    receipt.reason = `unknown action: ${action.action}`;
            }
        }
        catch (e) {
            result.errors.push(`${action.action}: ${e.message}`);
            receipt.status = 'failed';
            receipt.reason = e.message;
        }
        if (receipt.status === 'failed' && receipt.reason && !result.errors.some(e => e.includes(receipt.reason))) {
            result.errors.push(`${receipt.action}: ${receipt.reason}`);
        }
        result.receipts.push(receipt);
    }
    // ═══ v5.0: 批量向量化 digest 阶段跳过的记忆(按项目隔离) ═══
    try {
        const batchResult = await batchEmbedPending(characterId, project);
        if (batchResult.embedded > 0) {
            result.details.push(`batch embedded ${batchResult.embedded} pending memories`);
        }
        // Embedding is optional; an unavailable embedder must not turn a successfully
        // persisted reflection into a failed run (which would block the cursor).
        if (batchResult.errors.length > 0 && batchResult.errors.some(e => !e.includes('embedding disabled'))) {
            console.error('[reflect] batch embed (optional):', batchResult.errors.join('; '));
            result.details.push('batch embed warnings: ' + batchResult.errors.join('; '));
        }
    }
    catch (e) {
        console.error('[reflect] batch embed (optional):', e.message);
        result.details.push('batch embed failed: ' + e.message);
    }
    return result;
}
// ═══════════════════════════════════════════════════════════
// 导出别名 — 供 proxy.py / _memory_engine.mjs 调用
// ═══════════════════════════════════════════════════════════
/** 获取所有记忆（别名，供外部调用） */
export function getAllMemories(characterId = 'airi', limit = 200, project) {
    return listAllMemories(characterId, limit, project);
}
/** 获取记忆关联图 */
export function getMemoryGraph(characterId = 'airi', project) {
    const db = DatabaseManager.getInstance(project);
    const proj = normalizeProject(project);
    const nodes = listAllMemories(characterId, 500, proj);
    const nodeIds = new Set(nodes.map((n) => n.id));
    let edgeRows = [];
    if (nodeIds.size > 0) {
        edgeRows = db.prepare(`
      SELECT e.id, e.source_id, e.target_id, e.relation_type,
             m1.text as source_text, m2.text as target_text
      FROM edges e
      LEFT JOIN memory m1 ON e.source_id = m1.id
      LEFT JOIN memory m2 ON e.target_id = m2.id
      WHERE e.source_id IN (${[...nodeIds].map(() => '?').join(',')})
    `).all(...nodeIds);
    }
    const edges = edgeRows.map(r => ({
        id: r.id,
        sourceId: r.source_id,
        targetId: r.target_id,
        relationType: r.relation_type,
        sourceText: r.source_text?.substring(0, 60),
        targetText: r.target_text?.substring(0, 60),
    }));
    return { nodes, edges };
}
/** 编排函数 — 供 proxy.py 通过 _memory_engine.mjs 调用 */
// ═══════════════════════════════════════════════════════════════════
// 统一反思接口 — 大模型一次性输出 summary + facts + insights + actions
// ═══════════════════════════════════════════════════════════════════
const BUILTIN_REFLECT_SYSTEM_PROMPT = `你是记忆反思引擎。你的任务是对 AI 和用户的对话进行深度总结，提取结构化事实，并给出记忆整理建议。

输入：最近 N 轮未分析的对话原文
输出：严格JSON，格式如下：

{
  "summary": "自然语言总结（2-4句话）：概括这段时间用户做了什么、聊了什么、情绪状态如何",
  "highlights": ["关键事件1", "关键事件2"],
  "facts": [
    {"subject": "user", "predicate": "姓名", "object": "示例用户", "confidence": 0.95},
    {"subject": "user", "predicate": "职业", "object": "程序员", "confidence": 0.9}
  ],
  "insights": ["关于用户性格/沟通风格/潜在需求的深层观察"],
  "actions": [
    {"action": "boost", "targetId": "mem_xxx", "delta": 0.2},
    {"action": "merge", "sourceIds": ["id1","id2"], "newText": "合并后的内容", "newImportance": 0.8}
  ]
}

【facts 提取规则】
- subject: "user"（关于用户）/ "agent"（关于AI角色）/ "environment"（关于环境）
- predicate: 使用这些预定义关系或自定义短语：
  姓名 / 年龄 / 职业 / 喜好 / 厌恶 / 技能 / 居住地 / 工作单位 / 项目 / 技术栈 / 习惯 / 目标 / 关系
- object: 事实的值
- confidence: 0(推测)~1.0(明确陈述)
- 如果用户修正了之前提到的事实，标记 "action": "update"
- 不提取情绪/临时状态
- 最多15条

【actions 规则】
- 仅当确实需要整理已有记忆时才产生 actions
- "boost" 用于升级重要记忆
- "merge" 用于合并重复记忆
- 不需要操作时 actions 为空数组 []`;
export const REFLECT_SYSTEM_PROMPT = loadPromptOverride('REFLECT_PROMPT_FILE', BUILTIN_REFLECT_SYSTEM_PROMPT);
/**
 * 应用大模型反思结果
 *
 * 一次性处理：
 *   1. summary → 存入 memory（source='reflect_summary'）
 *   2. facts → 调用 saveFacts() 写入 facts 表（自动去重）
 *   3. insights → 存入 memory（source='reflect_insight'）
 *   4. actions → 调用 applyReflectActions()
 */
export async function applyReflectResult(result, characterId = 'airi', project, options = {}) {
    const out = {
        summaryId: null,
        factsInserted: 0,
        factsUpdated: 0,
        insightsCount: 0,
        actionsApplied: 0,
        applied: 0,
        errors: [],
        warnings: [],
        receipts: [],
    };
    // Apply extraction first. A failed extraction must not produce a misleading
    // successful summary, and the driver will leave its sources pending for retry.
    // v1.23: 落库前先按来源算硬事实覆盖，不达标就把缺失的原句补成"证据附录"。
    attachEvidenceAppendix(result, project, out.warnings);
    const actions = result.actions || [];
    if (actions.length) {
        const ar = await applyReflectActions(actions, characterId, project, options);
        out.actionsApplied = ar.applied;
        out.errors.push(...ar.errors);
        out.receipts = ar.receipts;
        try {
            const dir = process.env.REFLECT_RECEIPT_DIR || path.join(currentMemDir(), 'receipts');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `reflect-receipt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`), JSON.stringify({
                ts: new Date().toISOString(), characterId, project: normalizeProject(project),
                inputIds: options.allowedSourceIds ? [...options.allowedSourceIds] : undefined,
                actionCount: actions.length, applied: ar.applied,
                failed: ar.receipts.filter(r => r.status !== 'applied').length,
                actions, receipts: ar.receipts, errors: ar.errors,
            }, null, 2), 'utf8');
        }
        catch (e) {
            // 回执写盘失败只影响审计副本,不能把已成功应用的动作当成整轮失败(否则游标不推进)。
            console.error('[reflect] receipt write (optional):', e.message);
        }
        if (out.errors.length)
            return out;
    }
    // 1. 存 summary
    // 注意：以下 1~3 都是**提取成功之后的富化**。提取已落库并写了回执，
    // 富化失败若升级成 error，驱动会在 markConversationsReflected 之前 break，
    // 同一批来源永远重跑（2026-10-23 事故：facts 形状不符 → NOT NULL → 无限重复提取）。
    // 所以富化失败只记 warning，绝不阻断游标推进。
    if (result.summary) {
        try {
            const mem = await saveMemory({
                text: result.summary,
                type: 'semantic',
                category: 'knowledge',
                tags: result.highlights || [],
                importance: 0.7,
                characterId,
                project,
                source: 'reflect_summary',
                subject: 'user',
                metadata: JSON.stringify({ reflection: { sourceIds: [...(options.allowedSourceIds || [])], project: normalizeProject(project), role: 'navigation' } }),
            });
            out.summaryId = mem.id;
        }
        catch (e) {
            out.warnings.push(`summary: ${e.message}`);
        }
    }
    // 2. 存 facts（自动去重，confidence 取 MAX）
    // facts 表是 SPO 三元组；模型偶尔给字符串或 {sourceId,text}，saveFacts 不接受。
    // 驱动侧已过滤，这里再做一次兜底，保证非法条目进不来。
    const facts = (result.facts || []).filter((f) => f && typeof f === 'object' && f.subject && f.predicate && f.object);
    if (facts.length > 0) {
        try {
            const fr = await saveFacts(facts, out.summaryId, characterId, project);
            out.factsInserted = fr.inserted;
            out.factsUpdated = fr.updated;
        }
        catch (e) {
            out.warnings.push(`facts: ${e.message}`);
        }
    }
    // 3. 存 insights
    if (result.insights && result.insights.length > 0) {
        for (const insight of result.insights) {
            try {
                await saveMemory({
                    text: insight,
                    type: 'semantic',
                    category: 'knowledge',
                    importance: 0.6,
                    characterId,
                    project,
                    source: 'reflect_insight',
                    subject: 'user',
                });
                out.insightsCount++;
            }
            catch (e) {
                out.warnings.push(`insight: ${e.message}`);
            }
        }
    }
    return out;
}
/** 编排函数 — 供 proxy.py 通过 _memory_engine.mjs 调用 */
export async function reflect(action, params = {}) {
    switch (action) {
        case 'list':
            return listAllMemories(params.characterId || 'airi', params.limit || 200, params.project);
        case 'unanalyzed': {
            // 获取待反思的未分析对话 + prompt
            const conversations = getUnanalyzedConversations(params.characterId || 'airi', params.since, params.limit || 30, params.project);
            const batches = wholeRecordBatches(conversations);
            return {
                conversationCount: conversations.length,
                systemPrompt: reflectionPolicy(params.project) === 'standard' ? REFLECT_SYSTEM_PROMPT : fidelitySystemPrompt(params.project),
                userPrompt: `请分析以下对话，输出反思JSON：\n\n${JSON.stringify(conversations)}`,
                batches,
                conversationIds: conversations.map(c => c.id),
            };
        }
        case 'apply': {
            if (!params.actions || params.actions.length === 0) {
                return { applied: 0, errors: ['no actions to apply'] };
            }
            return applyReflectResult(params, params.characterId || 'airi', params.project);
        }
        case 'merge':
        case 'split':
        case 'relate':
        case 'reclassify':
        case 'delete':
        case 'boost':
        case 'decay':
            return applyReflectActions([{ action, ...params }], params.characterId || 'airi', params.project);
        case 'batch':
            if (!Array.isArray(params.actions)) {
                return { error: 'batch action requires "actions" array' };
            }
            return applyReflectActions(params.actions, params.characterId || 'airi', params.project);
        case 'auto': {
            const allMemories = listAllMemories(params.characterId || 'airi', params.limit || 200, params.project);
            const graph = getMemoryGraph(params.characterId || 'airi', params.project);
            return {
                ready: true,
                memoryCount: allMemories.length,
                edgeCount: graph.edges.length,
                memories: allMemories,
                edges: graph.edges,
                hint: 'Use "batch" action with an "actions" array to apply changes',
            };
        }
        default:
            return { error: `unknown reflect action: "${action}". Valid: list, unanalyzed, apply, merge, split, relate, reclassify, delete, boost, decay, batch, auto` };
    }
}
