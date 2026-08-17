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

import { DatabaseManager, listMemTypeDirs } from './db.js';
import { getEmbeddingCached } from './ollama.js';
import { saveFacts, saveMemory, reEmbedMemory, batchEmbedPending } from './store.js';
import { normalizeProject } from './env.js';
import { MemType, isMemType, MEM_TYPES } from './memType.js';
import fs from 'node:fs';
import path from 'node:path';

export interface ReflectMemory {
  id: string;
  text: string;
  type: string;
  memType: string;
  category: string;
  tags: string[];
  importance: number;
  subject: string;
  source: string;
  tier: string;
  expiresAt: string | null;
  createdAt: string;
  lastAccessedAt: string;
  accessedCount: number;
  referenceCount: number;
}

export interface ReflectReceipt {
  action: string;
  status: 'applied' | 'failed' | 'skipped';
  targetId: string | null;
  reason: string;
  rowsAffected: number;
}

export interface ReflectAction {
  action: 'merge' | 'split' | 'relate' | 'reclassify' | 'delete' | 'boost' | 'decay' | 'extract';
  // merge: 把多个记忆合并成一个
  sourceIds?: string[];
  newText?: string;
  newType?: string;
  newCategory?: string;
  newTags?: string[];
  newImportance?: number;
  // split: 把一个记忆拆成多个
  targetId?: string;
  fragments?: { text: string; type?: string; category?: string; tags?: string[]; importance?: number }[];
  // relate: 建立关联
  sourceId?: string;
  targetIdRelate?: string;
  relationType?: string;
  // reclassify: 重新分类
  newTypeSingle?: string;
  newCategorySingle?: string;
  // extract: 从源记忆中提取新记忆（不删除源）
  // 使用 sourceId + newText/newType/newCategory/newTags/newImportance/tier/newMemType
  tier?: string;
  newMemType?: string;  // v1.8: 提取时分类到 4 种封闭类型(user/feedback/project/reference)
  // delete: 软删除
  // boost/decay: 调整 importance
  delta?: number;
}

/**
 * 获取所有记忆（供大模型分析）
 */
export function listAllMemories(characterId: string = 'airi', limit: number = 200, project?: string): ReflectMemory[] {
  const proj = normalizeProject(project);
  // memdir:聚合项目全部分类库
  const dirs = listMemTypeDirs(proj);
  const all: any[] = [];
  for (const mt of dirs) {
    try {
      const db = DatabaseManager.getInstance(proj, mt);
      const rows = db.prepare(`
        SELECT id, text, type, mem_type, category, tags, importance,
               subject, source, tier, expires_at, created_at, last_accessed_at, accessed_count, reference_count, locked
        FROM memory
        WHERE is_active = 1 AND project = ?
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `).all(proj, limit) as any[];
      all.push(...rows);
    } catch { /* 单分类库失败不影响其他 */ }
  }
  all.sort((a: any, b: any) => (b.importance - a.importance) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const rows = all.slice(0, limit);

  return rows.map(r => {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(r.tags || '[]');
      tags = Array.isArray(parsed) ? parsed : [];
    } catch { tags = []; }

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
  });}

/**
 * 应用大模型的重构指令
 */
// ═════════════════════════════════════════════════
// 护栏：拒绝明显无效的值，防止大模型幻觉污染数据库
// ═════════════════════════════════════════════════
const VALID_TYPES = new Set(['episodic', 'semantic', 'entity', 'preference']);
const VALID_MEM_TYPES = new Set<string>(MEM_TYPES);  // v1.8: 4 种封闭类型 + general
const VALID_CATEGORIES = new Set(['conversation', 'milestone', 'identity', 'relationship', 'knowledge', 'preference', 'general']);
const VALID_RELATIONS = new Set(['caused_by', 'part_of', 'follows', 'related_to', 'same_subject', 'causes', 'leads_to', 'sequence']);

function safeTags(raw: any): string[] | null {
  if (!raw) return null;
  if (!Array.isArray(raw)) return null;
  const filtered = raw.filter(t => typeof t === 'string' && t.length > 0 && t.length < 50);
  return filtered.length > 0 ? filtered : null;
}

export async function applyReflectActions(actions: ReflectAction[], characterId: string = 'airi', project?: string): Promise<{
  applied: number;
  errors: string[];
  details: string[];
  receipts: ReflectReceipt[];
}> {
  const db = DatabaseManager.getInstance(project);
  const result = { applied: 0, errors: [] as string[], details: [] as string[], receipts: [] as ReflectReceipt[] };

  for (const action of actions) {
    const receipt: ReflectReceipt = {
      action: action.action,
      status: 'applied',
      targetId: (action as any).targetId || (action as any).sourceId || null,
      reason: '',
      rowsAffected: 0,
    };
    try {
      switch (action.action) {
        case 'merge': {
          // 合并多个记忆为一个
          if (!action.sourceIds || action.sourceIds.length < 2 || !action.newText) {
            result.errors.push('merge: need sourceIds and newText');
            receipt.status = 'failed'; receipt.reason = 'need sourceIds and newText';
            continue;
          }
          const tx = db.transaction(() => {
            // 旧记忆全部软删除 + 删向量
            // v5.1: LLM 可能返回短ID前缀，用 LIKE 匹配
            // locked=1 永久锁定记忆绝不软删(护栏在代码层兜底,防止 LLM 幻觉破坏锁定记忆)
            for (const id of action.sourceIds!) {
              const src = db.prepare('SELECT id FROM memory WHERE id LIKE ? AND (locked IS NULL OR locked = 0)').get(id + '%') as any;
              if (src) receipt.rowsAffected++;
              else { receipt.status = 'failed'; receipt.reason = `source not found or locked: ${id}`; }
              db.prepare('UPDATE memory SET is_active = 0 WHERE id LIKE ? AND (locked IS NULL OR locked = 0)').run(id + '%');
              try {
                db.prepare('DELETE FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id LIKE ? AND (locked IS NULL OR locked = 0))').run(id + '%');
              } catch {}
            }
          });
          tx();

          // saveMemory 是 async，在 transaction 外调
          // v5.0: reflect 阶段正常 embed（不 skip）
          const { saveMemory } = await import('./store.js');
          await saveMemory({
            text: action.newText,
            type: (action.newType || 'semantic') as any,
            // v1.10: merge 支持 newMemType — 记忆整合输出保持 4 种封闭类型之一
            memType: isMemType(action.newMemType) ? action.newMemType as MemType : undefined,
            category: action.newCategory || 'general',
            tags: action.newTags || [],
            importance: action.newImportance || 0.7,
            characterId,
            project,
            source: 'reflect_merge',
          });
          if (receipt.status === 'failed') { result.errors.push(`merge: ${receipt.reason}`); continue; }
          if (receipt.status === 'applied') result.applied++;
          result.details.push(`merge: ${action.sourceIds.length} → 1`);
          break;
        }

        case 'split': {
          // 拆分一个记忆为多个
          if (!action.targetId || !action.fragments) {
            result.errors.push('split: need targetId and fragments');
            receipt.status = 'failed'; receipt.reason = 'need targetId and fragments';
            continue;
          }
          // 软删除旧记忆（v5.1: LIKE 匹配短ID;locked=1 永久锁定不删）
          const _splitSrc = db.prepare('SELECT id FROM memory WHERE id LIKE ? AND (locked IS NULL OR locked = 0)').get(action.targetId + '%') as any;
          if (!_splitSrc) { receipt.status = 'failed'; receipt.reason = `target not found or locked: ${action.targetId}`; }
          db.prepare('UPDATE memory SET is_active = 0 WHERE id LIKE ? AND (locked IS NULL OR locked = 0)').run(action.targetId + '%');
          // 插入碎片
          const { saveMemory } = await import('./store.js');
          for (const frag of action.fragments) {
            await saveMemory({
              text: frag.text,
              type: (frag.type as any) || 'episodic',
              category: frag.category || 'conversation',
              tags: frag.tags || [],
              importance: frag.importance || 0.5,
              characterId,
              project,
              source: 'reflect_split',
            });
          }
          if (receipt.status === 'applied') result.applied++;
          result.details.push(`split: 1 → ${action.fragments.length}`);
          break;
        }

        case 'relate': {
          if (!action.sourceId || !action.targetIdRelate || !action.relationType) {
            result.errors.push('relate: need sourceId, targetIdRelate, relationType');
            receipt.status = 'failed'; receipt.reason = 'need sourceId, targetIdRelate, relationType';
            continue;
          }
          // 护栏：规范化 relation type
          const relType = VALID_RELATIONS.has(action.relationType) ? action.relationType : 'related_to';
          const edgeId = `edge_reflect_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
          const _relR = db.prepare('INSERT OR IGNORE INTO edges (id, source_id, target_id, relation_type) VALUES (?, ?, ?, ?)')
            .run(edgeId, action.sourceId, action.targetIdRelate, relType);
          receipt.rowsAffected = _relR.changes;
          if (_relR.changes === 0) { receipt.status = 'failed'; receipt.reason = `edge exists or node missing: ${action.sourceId}→${action.targetIdRelate}`; }
          if (receipt.status === 'applied') result.applied++;
          result.details.push(`relate: ${action.sourceId} → ${action.targetIdRelate} (${relType})`);
          break;
        }

        case 'reclassify': {
          // v5.1: 兼容 LLM 可能用的 sourceId 或 targetId
          const tid = action.targetId || (action as any).sourceId;
          if (!tid) {
            result.errors.push('reclassify: need targetId or sourceId');
            receipt.status = 'failed'; receipt.reason = 'need targetId or sourceId';
            continue;
          }
          const updates: string[] = [];
          const values: any[] = [];
          // 护栏：拒绝无效 type/category
          if (action.newTypeSingle) {
            if (!VALID_TYPES.has(action.newTypeSingle)) {
              result.errors.push(`reclassify: invalid type "${action.newTypeSingle}", skipped`);
              receipt.status = 'failed'; receipt.reason = `invalid type "${action.newTypeSingle}"`;
              continue;
            }
            updates.push('type = ?'); values.push(action.newTypeSingle);
          }
          if (action.newCategorySingle) {
            if (!VALID_CATEGORIES.has(action.newCategorySingle)) {
              result.errors.push(`reclassify: invalid category "${action.newCategorySingle}", skipped`);
              receipt.status = 'failed'; receipt.reason = `invalid category "${action.newCategorySingle}"`;
              continue;
            }
            updates.push('category = ?'); values.push(action.newCategorySingle);
          }
          if (action.newTags) {
            const valid = safeTags(action.newTags);
            if (!valid) {
              result.errors.push('reclassify: invalid tags (must be string array), skipped');
              receipt.status = 'failed'; receipt.reason = 'invalid tags';
              continue;
            }
            updates.push('tags = ?'); values.push(JSON.stringify(valid));
          }
          if (action.newMemType) {
            if (!isMemType(action.newMemType)) {
              result.errors.push(`reclassify: invalid memType "${action.newMemType}", skipped`);
              receipt.status = 'failed'; receipt.reason = `invalid memType "${action.newMemType}"`;
              continue;
            }
            updates.push('mem_type = ?'); values.push(action.newMemType as MemType);
          }
          // v5.x: reclassify 支持 newText — 文本内容更新(时间规范化等)
          let textChanged = false;
          if (action.newText !== undefined && action.newText !== null) {
            if (typeof action.newText !== 'string' || action.newText.trim().length === 0) {
              result.errors.push('reclassify: invalid newText (must be non-empty string), skipped');
              receipt.status = 'failed'; receipt.reason = 'invalid newText';
              continue;
            }
            updates.push('text = ?');
            values.push(action.newText.trim());
            textChanged = true;
          }
          if (updates.length > 0) {
            // 参数顺序:update 字段值 → updated_at → LIKE 前缀(修复历史错位 bug)
            const _recR = db.prepare(`UPDATE memory SET ${updates.join(', ')}, updated_at = ? WHERE id LIKE ? AND (locked IS NULL OR locked = 0)`)
              .run(...values, new Date().toISOString(), tid + '%');
            receipt.rowsAffected = _recR.changes;
            if (_recR.changes === 0) { receipt.status = 'failed'; receipt.reason = `target not found: ${tid}`; }
            if (receipt.status === 'applied') result.applied++;
            result.details.push(`reclassify: ${tid}`);
            // v5.x: text 变更后删除旧向量,下次 batchEmbedPending 重新 embed
            if (textChanged && _recR.changes > 0) {
              try {
                const _vecRow = db.prepare('SELECT rowid FROM memory WHERE id LIKE ? LIMIT 1').get(tid + '%') as any;
                if (_vecRow) db.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(_vecRow.rowid);
              } catch { /* 静默 */ }
            }
          }
          break;
        }

        case 'extract': {
          // v5.0: 从源记忆中提取有效信息为新记忆（不删除源）
          if (!action.sourceId || !action.newText) {
            result.errors.push('extract: need sourceId and newText');
            receipt.status = 'failed'; receipt.reason = 'need sourceId and newText';
            continue;
          }
          const validType = action.newType && VALID_TYPES.has(action.newType) ? action.newType : 'semantic';
          const validCat = action.newCategory && VALID_CATEGORIES.has(action.newCategory) ? action.newCategory : 'general';
          const validMemType = isMemType(action.newMemType) ? action.newMemType as MemType : undefined;
          const validTags = safeTags(action.newTags) || [];
          const importance = action.newImportance ?? 0.6;
          const tier = (action.tier && ['temporary','standard','critical'].includes(action.tier))
            ? action.tier as 'temporary'|'standard'|'critical' : 'standard';

          const { saveMemory } = await import('./store.js');
          await saveMemory({
            text: action.newText,
            type: validType as any,
            memType: validMemType,
            category: validCat,
            tags: validTags,
            importance,
            tier,
            characterId,
            project,
            source: 'reflect_extract',
          });

          // 给源记忆 +reference_count（v5.1: LIKE 匹配短ID）
          db.prepare('UPDATE memory SET reference_count = reference_count + 1 WHERE id LIKE ?').run(action.sourceId + '%');

          if (receipt.status === 'applied') result.applied++;
          result.details.push(`extract: from ${action.sourceId} → ${validType}/${validCat} (${tier})`);
          break;
        }

        case 'delete': {
          if (!action.targetId) {
            result.errors.push('delete: need targetId');
            receipt.status = 'failed'; receipt.reason = 'need targetId';
            continue;
          }
          const _delR = db.prepare('UPDATE memory SET is_active = 0 WHERE id LIKE ? AND (locked IS NULL OR locked = 0)').run(action.targetId + '%');
          receipt.rowsAffected = _delR.changes;
          if (_delR.changes === 0) { receipt.status = 'failed'; receipt.reason = `target not found or locked: ${action.targetId}`; }
          if (receipt.status === 'applied') result.applied++;
          result.details.push(`delete: ${action.targetId}`);
          break;
        }

        case 'boost': {
          if (!action.targetId || action.delta === undefined) {
            result.errors.push('boost: need targetId and delta');
            receipt.status = 'failed'; receipt.reason = 'need targetId and delta';
            continue;
          }
          const _boR = db.prepare('UPDATE memory SET importance = MIN(0.95, MAX(0.1, importance + ?)) WHERE id LIKE ? AND (locked IS NULL OR locked = 0)')
            .run(action.delta, action.targetId + '%');
          receipt.rowsAffected = _boR.changes;
          if (_boR.changes === 0) { receipt.status = 'failed'; receipt.reason = `target not found or locked: ${action.targetId}`; }
          if (receipt.status === 'applied') result.applied++;
          result.details.push(`boost: ${action.targetId} += ${action.delta}`);
          break;
        }

        case 'decay': {
          if (!action.targetId || action.delta === undefined) {
            result.errors.push('decay: need targetId and delta');
            receipt.status = 'failed'; receipt.reason = 'need targetId and delta';
            continue;
          }
          const _deR = db.prepare('UPDATE memory SET importance = MIN(0.95, MAX(0.1, importance - ?)) WHERE id LIKE ? AND (locked IS NULL OR locked = 0)')
            .run(action.delta, action.targetId + '%');
          receipt.rowsAffected = _deR.changes;
          if (_deR.changes === 0) { receipt.status = 'failed'; receipt.reason = `target not found or locked: ${action.targetId}`; }
          if (receipt.status === 'applied') result.applied++;
          result.details.push(`decay: ${action.targetId} -= ${action.delta}`);
          break;
        }

        default:
          result.errors.push(`unknown action: ${action.action}`);
          receipt.status = 'skipped'; receipt.reason = `unknown action: ${action.action}`;
      }
    } catch (e: any) {
      result.errors.push(`${action.action}: ${e.message}`);
      receipt.status = 'failed'; receipt.reason = e.message;
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
    if (batchResult.errors.length > 0) {
      result.errors.push(...batchResult.errors);
    }
  } catch (e: any) {
    result.errors.push(`batch embed: ${e.message}`);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════
// 导出别名 — 供 proxy.py / _memory_engine.mjs 调用
// ═══════════════════════════════════════════════════════════

/** 获取所有记忆（别名，供外部调用） */
export function getAllMemories(characterId: string = 'airi', limit: number = 200, project?: string): ReflectMemory[] {
  return listAllMemories(characterId, limit, project);
}

/** 获取记忆关联图 */
export function getMemoryGraph(characterId: string = 'airi', project?: string): { nodes: any[]; edges: any[] } {
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);
  const nodes = listAllMemories(characterId, 500, proj);
  const nodeIds = new Set(nodes.map((n: any) => n.id));
  let edgeRows: any[] = [];
  if (nodeIds.size > 0) {
    edgeRows = db.prepare(`
      SELECT e.id, e.source_id, e.target_id, e.relation_type,
             m1.text as source_text, m2.text as target_text
      FROM edges e
      LEFT JOIN memory m1 ON e.source_id = m1.id
      LEFT JOIN memory m2 ON e.target_id = m2.id
      WHERE e.source_id IN (${[...nodeIds].map(() => '?').join(',')})
    `).all(...nodeIds) as any[];
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

export const REFLECT_SYSTEM_PROMPT = `你是记忆反思引擎。你的任务是对 AI 和用户的对话进行深度总结，提取结构化事实，并给出记忆整理建议。

输入：最近 N 轮未分析的对话原文
输出：严格JSON，格式如下：

{
  "summary": "自然语言总结（2-4句话）：概括这段时间用户做了什么、聊了什么、情绪状态如何",
  "highlights": ["关键事件1", "关键事件2"],
  "facts": [
    {"subject": "user", "predicate": "姓名", "object": "小托", "confidence": 0.95},
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

/**
 * 获取待反思的未分析对话
 */
export function getUnanalyzedConversations(
  characterId: string = 'airi',
  since?: string,  // ISO datetime，不传则取上次 reflect 之后
  limit: number = 30,
  project?: string,  // v1.5: 项目隔离
): { id: string; text: string; createdAt: string }[] {
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);

  // 找到上次反思时间（最近一次 source='reflect_summary' 的创建时间）
  if (!since) {
    const lastReflect = db.prepare(`
      SELECT created_at FROM memory
      WHERE source = 'reflect_summary' AND project = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(proj) as any;
    since = lastReflect?.created_at || new Date(0).toISOString();
  }

  return db.prepare(`
    SELECT id, text, created_at
    FROM memory
    WHERE is_active = 1
      AND source = 'conversation_log'
      AND project = ?
      AND created_at > ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(proj, since, limit) as any[];
}

export interface ReflectResult {
  summary: string;
  highlights: string[];
  facts: { subject: string; predicate: string; object: string; confidence: number }[];
  insights: string[];
  actions?: ReflectAction[];
}

/**
 * 应用大模型反思结果
 *
 * 一次性处理：
 *   1. summary → 存入 memory（source='reflect_summary'）
 *   2. facts → 调用 saveFacts() 写入 facts 表（自动去重）
 *   3. insights → 存入 memory（source='reflect_insight'）
 *   4. actions → 调用 applyReflectActions()
 */
export async function applyReflectResult(
  result: ReflectResult,
  characterId: string = 'airi',
  project?: string,
): Promise<{
  summaryId: string | null;
  factsInserted: number;
  factsUpdated: number;
  insightsCount: number;
  actionsApplied: number;
  errors: string[];
  receipts: ReflectReceipt[];
}> {
  const out = {
    summaryId: null as string | null,
    factsInserted: 0,
    factsUpdated: 0,
    insightsCount: 0,
    actionsApplied: 0,
    applied: 0,
    errors: [] as string[],
    receipts: [] as ReflectReceipt[],
  };

  // 1. 存 summary
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
      });
      out.summaryId = mem.id;
    } catch (e: any) {
      out.errors.push(`summary: ${e.message}`);
    }
  }

  // 2. 存 facts（自动去重，confidence 取 MAX）
  if (result.facts && result.facts.length > 0) {
    try {
      const fr = await saveFacts(result.facts, out.summaryId, characterId, project);
      out.factsInserted = fr.inserted;
      out.factsUpdated = fr.updated;
    } catch (e: any) {
      out.errors.push(`facts: ${e.message}`);
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
      } catch (e: any) {
        out.errors.push(`insight: ${e.message}`);
      }
    }
  }

  // 4. 应用记忆整理 actions + 逐动作回执落盘
  if (result.actions && result.actions.length > 0) {
    try {
      const ar = await applyReflectActions(result.actions, characterId, project);
      out.actionsApplied = ar.applied;
      out.errors.push(...ar.errors);
      out.receipts = ar.receipts;
      // ═══ v1.3: 回执落盘 — 失败动作原文存档,事后可人工修正 ═══
      try {
        const dir = process.env.REFLECT_RECEIPT_DIR || path.join(process.cwd(), 'memory', 'receipts');
        fs.mkdirSync(dir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(
          path.join(dir, `reflect-receipt-${ts}.json`),
          JSON.stringify({
            ts: new Date().toISOString(),
            characterId,
            actionCount: result.actions.length,
            applied: ar.applied,
            failed: ar.receipts.filter(r => r.status !== 'applied').length,
            actions: result.actions,
            receipts: ar.receipts,
            errors: ar.errors,
          }, null, 2),
          'utf-8',
        );
      } catch (e: any) {
        out.errors.push(`receipt write: ${e.message}`);
      }
    } catch (e: any) {
      out.errors.push(`actions: ${e.message}`);
    }
  }

  return out;
}

/** 编排函数 — 供 proxy.py 通过 _memory_engine.mjs 调用 */
export async function reflect(action: string, params: Record<string, any> = {}): Promise<any> {
  switch (action) {
    case 'list':
      return listAllMemories(params.characterId || 'airi', params.limit || 200, params.project);

    case 'unanalyzed': {
      // 获取待反思的未分析对话 + prompt
      const conversations = getUnanalyzedConversations(
        params.characterId || 'airi',
        params.since,
        params.limit || 30,
        params.project,
      );
      const prompt = conversations.map(c => c.text).join('\n---\n');
      return {
        conversationCount: conversations.length,
        systemPrompt: REFLECT_SYSTEM_PROMPT,
        userPrompt: `请分析以下对话，输出反思JSON：\n\n${prompt.substring(0, 30000)}`,
        conversationIds: conversations.map(c => c.id),
      };
    }

    case 'apply': {
      if (!params.actions || params.actions.length === 0) {
        return { applied: 0, errors: ['no actions to apply'] };
      }
      return applyReflectResult(params as ReflectResult, params.characterId || 'airi', params.project);
    }

    case 'merge':
    case 'split':
    case 'relate':
    case 'reclassify':
    case 'delete':
    case 'boost':
    case 'decay':
      return applyReflectActions([{ action, ...params } as ReflectAction], params.characterId || 'airi', params.project);

    case 'batch':
      if (!Array.isArray(params.actions)) {
        return { error: 'batch action requires "actions" array' };
      }
      return applyReflectActions(params.actions as ReflectAction[], params.characterId || 'airi', params.project);

    case 'auto': {
      const allMemories = listAllMemories(params.characterId || 'airi', params.limit || 200);
      const graph = getMemoryGraph(params.characterId || 'airi');
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
