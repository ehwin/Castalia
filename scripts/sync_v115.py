# v1.15 LobeHub 精细化吸收 — 同源仓库锚点同步(ai-memory 全量版)
# 用法: python scripts/sync_v115.py <target_src_dir>
# 锚点找不到 → 打印 SKIP,不静默;成功后人工 build 验证
import sys, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# ── db.ts ─────────────────────────────────────────────
DB_1_OLD = """  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_mem_type ON memory(mem_type, is_active)`); } catch (_e) {}"""
DB_1_NEW = """  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_mem_type ON memory(mem_type, is_active)`); } catch (_e) {}

  // v1.15: LobeHub 精细化吸收 — 四维评分/元数据/身份 CRUD 维护
  try { db.exec(`ALTER TABLE memory ADD COLUMN metadata TEXT`); } catch (_e) { /* already exists */ }
  try { db.exec(`ALTER TABLE memory ADD COLUMN title TEXT`); } catch (_e) { /* already exists */ }
  try { db.exec(`ALTER TABLE memory ADD COLUMN status TEXT`); } catch (_e) { /* already exists */ }
  try { db.exec(`ALTER TABLE memory ADD COLUMN score_confidence REAL`); } catch (_e) { /* already exists */ }
  try { db.exec(`ALTER TABLE memory ADD COLUMN score_impact REAL`); } catch (_e) { /* already exists */ }
  try { db.exec(`ALTER TABLE memory ADD COLUMN score_priority REAL`); } catch (_e) { /* already exists */ }
  try { db.exec(`ALTER TABLE memory ADD COLUMN score_urgency REAL`); } catch (_e) { /* already exists */ }
  try { db.exec(`ALTER TABLE memory ADD COLUMN identity_locked INTEGER DEFAULT 0`); } catch (_e) { /* already exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type, is_active)`); } catch (_e) {}"""

# ── store.ts ──────────────────────────────────────────
STORE_PARAMS_OLD = """  tier?: 'temporary' | 'standard' | 'critical';
  expiresAt?: string;
  skipEmbed?: boolean;  // v5.0: digest 暂不向量化
}"""
STORE_PARAMS_NEW = """  tier?: 'temporary' | 'standard' | 'critical';
  expiresAt?: string;
  skipEmbed?: boolean;  // v5.0: digest 暂不向量化
  // v1.15: LobeHub 精细化吸收 — 评分/元数据/身份维护
  metadata?: string;            // JSON:各层专属字段(触发条件/S-R-A-O/状态等)
  title?: string;               // 短标题(展示/检索)
  status?: 'active' | 'completed' | 'cancelled' | 'on_hold';  // 活动/情境状态机
  scoreConfidence?: number;     // 0-1 置信度
  scoreImpact?: number;         // 0-1 影响
  scorePriority?: number;       // 0-1 优先级(偏好层:指令权重)
  scoreUrgency?: number;        // 0-1 紧急度(情境层)
  identityLocked?: boolean;     // 身份 CRUD 保护:true=禁止 LLM 自动删改
}"""

STORE_RECORD_OLD = """  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessedCount: number;
}"""
STORE_RECORD_NEW = """  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessedCount: number;
  // v1.15: LobeHub 精细化吸收
  metadata: string | null;
  title: string | null;
  status: string | null;
  scoreConfidence: number | null;
  scoreImpact: number | null;
  scorePriority: number | null;
  scoreUrgency: number | null;
  identityLocked: boolean;
}"""

STORE_DUP_OLD = """      isActive: true,
      createdAt: now, updatedAt: now, lastAccessedAt: now, accessedCount: 0,
    } as MemoryRecord;
    }"""
STORE_DUP_NEW = """      isActive: true,
      createdAt: now, updatedAt: now, lastAccessedAt: now, accessedCount: 0,
      metadata: params.metadata ?? null, title: params.title ?? null, status: params.status ?? null,
      scoreConfidence: params.scoreConfidence ?? null, scoreImpact: params.scoreImpact ?? null,
      scorePriority: params.scorePriority ?? null, scoreUrgency: params.scoreUrgency ?? null,
      identityLocked: params.identityLocked === true,
    } as MemoryRecord;
    }"""

STORE_RECORD_BLK_OLD = """    isActive: true,
    createdAt: now, updatedAt: now, lastAccessedAt: now, accessedCount: 0,
  };

  const storeTx = db.transaction(() => {
    db.prepare(`
      INSERT INTO memory (id, text, project, session_id, type, mem_type, category, subcategory, tags, importance, character_id, source, subject, tier, expires_at, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.text, record.project, record.sessionId, record.type, record.memType, record.category, record.subcategory,
      JSON.stringify(record.tags), record.importance,
      record.characterId, record.source, record.subject,
      record.tier, record.expiresAt, 1,
      record.createdAt, record.updatedAt, record.lastAccessedAt, 0, 0
    );"""
STORE_RECORD_BLK_NEW = """    isActive: true,
    createdAt: now, updatedAt: now, lastAccessedAt: now, accessedCount: 0,
    metadata: params.metadata ?? null, title: params.title ?? null, status: params.status ?? null,
    scoreConfidence: params.scoreConfidence ?? null, scoreImpact: params.scoreImpact ?? null,
    scorePriority: params.scorePriority ?? null, scoreUrgency: params.scoreUrgency ?? null,
    identityLocked: params.identityLocked === true,
  };

  const storeTx = db.transaction(() => {
    db.prepare(`
      INSERT INTO memory (id, text, project, session_id, type, mem_type, category, subcategory, tags, importance, character_id, source, subject, tier, expires_at, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count, locked, metadata, title, status, score_confidence, score_impact, score_priority, score_urgency, identity_locked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.text, record.project, record.sessionId, record.type, record.memType, record.category, record.subcategory,
      JSON.stringify(record.tags), record.importance,
      record.characterId, record.source, record.subject,
      record.tier, record.expiresAt, 1,
      record.createdAt, record.updatedAt, record.lastAccessedAt, 0, 0,
      0,
      record.metadata, record.title, record.status,
      record.scoreConfidence, record.scoreImpact, record.scorePriority, record.scoreUrgency,
      record.identityLocked ? 1 : 0
    );"""

STORE_FORGET_OLD = """export function forgetMemory(id: string, project?: string): boolean {
  const found = findDbByMemoryId(id, project);
  if (!found) return false;
  return found.db.prepare('UPDATE memory SET is_active = 0 WHERE id = ?').run(id).changes > 0;
}"""
STORE_FORGET_NEW = """export function forgetMemory(id: string, project?: string): boolean {
  const found = findDbByMemoryId(id, project);
  if (!found) return false;
  // v1.15: identity_locked=1 的身份记忆禁止自动软删(LLM 提取的 remove 会被拦,人工可先解锁)
  const row = found.db.prepare('SELECT identity_locked FROM memory WHERE id = ? AND is_active = 1').get(id) as any;
  if (row && row.identity_locked === 1) return false;
  return found.db.prepare('UPDATE memory SET is_active = 0 WHERE id = ?').run(id).changes > 0;
}"""

STORE_MOVE_OLD = """    newDb.prepare(`
      INSERT OR REPLACE INTO memory (id, text, project, session_id, type, mem_type, category, subcategory, tags, importance, character_id, source, subject, tier, expires_at, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count, locked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      text,
      proj,
      existing.session_id,
      updates.type !== undefined ? updates.type : existing.type,
      newMt,
      updates.category !== undefined ? updates.category : existing.category,
      updates.subcategory !== undefined ? updates.subcategory : existing.subcategory,
      tags,
      updates.importance !== undefined ? updates.importance : existing.importance,
      updates.characterId !== undefined ? updates.characterId : existing.character_id,
      updates.source !== undefined ? updates.source : existing.source,
      updates.subject !== undefined ? updates.subject : existing.subject,
      updates.tier !== undefined ? updates.tier : existing.tier,
      existing.expires_at ?? null,
      existing.created_at, now, now,
      existing.accessed_count, existing.reference_count ?? 0,
      existing.locked ?? 0,
    );"""
STORE_MOVE_NEW = """    newDb.prepare(`
      INSERT OR REPLACE INTO memory (id, text, project, session_id, type, mem_type, category, subcategory, tags, importance, character_id, source, subject, tier, expires_at, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count, locked, metadata, title, status, score_confidence, score_impact, score_priority, score_urgency, identity_locked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      text,
      proj,
      existing.session_id,
      updates.type !== undefined ? updates.type : existing.type,
      newMt,
      updates.category !== undefined ? updates.category : existing.category,
      updates.subcategory !== undefined ? updates.subcategory : existing.subcategory,
      tags,
      updates.importance !== undefined ? updates.importance : existing.importance,
      updates.characterId !== undefined ? updates.characterId : existing.character_id,
      updates.source !== undefined ? updates.source : existing.source,
      updates.subject !== undefined ? updates.subject : existing.subject,
      updates.tier !== undefined ? updates.tier : existing.tier,
      existing.expires_at ?? null,
      existing.created_at, now, now,
      existing.accessed_count, existing.reference_count ?? 0,
      existing.locked ?? 0,
      updates.metadata !== undefined ? updates.metadata : (existing.metadata ?? null),
      updates.title !== undefined ? updates.title : (existing.title ?? null),
      updates.status !== undefined ? updates.status : (existing.status ?? null),
      updates.scoreConfidence !== undefined ? updates.scoreConfidence : (existing.score_confidence ?? null),
      updates.scoreImpact !== undefined ? updates.scoreImpact : (existing.score_impact ?? null),
      updates.scorePriority !== undefined ? updates.scorePriority : (existing.score_priority ?? null),
      updates.scoreUrgency !== undefined ? updates.scoreUrgency : (existing.score_urgency ?? null),
      updates.identityLocked !== undefined ? (updates.identityLocked ? 1 : 0) : (existing.identity_locked ?? 0),
    );"""

STORE_FIELDS_OLD = """  if (updates.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(updates.tags)); }
  if (updates.importance !== undefined) { fields.push('importance = ?'); values.push(updates.importance); }"""
STORE_FIELDS_NEW = """  if (updates.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(updates.tags)); }
  if (updates.importance !== undefined) { fields.push('importance = ?'); values.push(updates.importance); }
  // v1.15: LobeHub 精细化吸收
  if (updates.metadata !== undefined) { fields.push('metadata = ?'); values.push(updates.metadata); }
  if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.scoreConfidence !== undefined) { fields.push('score_confidence = ?'); values.push(updates.scoreConfidence); }
  if (updates.scoreImpact !== undefined) { fields.push('score_impact = ?'); values.push(updates.scoreImpact); }
  if (updates.scorePriority !== undefined) { fields.push('score_priority = ?'); values.push(updates.scorePriority); }
  if (updates.scoreUrgency !== undefined) { fields.push('score_urgency = ?'); values.push(updates.scoreUrgency); }
  if (updates.identityLocked !== undefined) { fields.push('identity_locked = ?'); values.push(updates.identityLocked ? 1 : 0); }"""

# 文件末尾追加 applyIdentityActions(锚点 = deleteSessionFragments 结尾,所有版本同源)
STORE_APPEND_OLD = """export function deleteSessionFragments(project: string, sessionId: string): number {
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);
  const r = db.prepare(`
    DELETE FROM memory
    WHERE project = ? AND session_id = ? AND source = 'session_memory' AND is_active = 1
  `).run(proj, sessionId);
  return r.changes;
}"""
STORE_APPEND_NEW = """export function deleteSessionFragments(project: string, sessionId: string): number {
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);
  const r = db.prepare(`
    DELETE FROM memory
    WHERE project = ? AND session_id = ? AND source = 'session_memory' AND is_active = 1
  `).run(proj, sessionId);
  return r.changes;
}

// ═══════════════════════════════════════════════════════════════════
// v1.15: LobeHub 精细化吸收 — 身份记忆 CRUD(防身份膨胀/重复)
//  - add    → saveMemory(type=entity)
//  - update → updateMemory,id 必须真实存在且 type=entity;merge=字段级合并 / replace=整体替换
//  - remove → forgetMemory 软删;identity_locked=1 拒绝
// 幻觉 id(不在库中/非 entity)→ rejected 数组,不静默
// ═══════════════════════════════════════════════════════════════════
export interface IdentityActionAdd { text: string; tags?: string[]; title?: string; importance?: number; metadata?: string; scoreConfidence?: number; scoreImpact?: number; scorePriority?: number; scoreUrgency?: number; }
export interface IdentityActionUpdate { id: string; mergeStrategy: 'merge' | 'replace'; set: Partial<StoreParams>; }
export interface IdentityActionRemove { id: string; reason?: string; }
export interface IdentityActions {
  add?: IdentityActionAdd[];
  update?: IdentityActionUpdate[];
  remove?: IdentityActionRemove[];
}

export async function applyIdentityActions(
  actions: IdentityActions,
  project?: string,
): Promise<{ applied: number; rejected: string[] }> {
  const rejected: string[] = [];
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
    if (!found) { rejected.push(`update:unknown-id:${u.id}`); continue; }
    const existing = found.db.prepare('SELECT * FROM memory WHERE id = ? AND is_active = 1').get(u.id) as any;
    if (!existing) { rejected.push(`update:inactive:${u.id}`); continue; }
    if (existing.type !== 'entity') { rejected.push(`update:not-entity:${u.id}`); continue; }

    if (u.mergeStrategy === 'replace') {
      await updateMemory(u.id, { ...u.set, project, type: 'entity' });
    } else {
      // merge:tags 合并去重、metadata 对象级 merge,其余字段由 set 覆盖
      const merged: Partial<StoreParams> = { ...u.set, project, type: 'entity' };
      if (u.set.tags && existing.tags) {
        try { merged.tags = [...new Set([...JSON.parse(existing.tags), ...u.set.tags])]; } catch { /* 保持 set */ }
      }
      if (u.set.metadata && existing.metadata) {
        try {
          merged.metadata = JSON.stringify({ ...JSON.parse(existing.metadata), ...JSON.parse(u.set.metadata) });
        } catch { /* 保持 set */ }
      }
      await updateMemory(u.id, merged);
    }
    applied++;
  }

  // remove:白名单校验 + identity_locked 保护(forgetMemory 内二次校验)
  for (const r of actions.remove ?? []) {
    const found = findDbByMemoryId(r.id, project);
    if (!found) { rejected.push(`remove:unknown-id:${r.id}`); continue; }
    const existing = found.db.prepare('SELECT * FROM memory WHERE id = ? AND is_active = 1').get(r.id) as any;
    if (!existing) { rejected.push(`remove:inactive:${r.id}`); continue; }
    if (existing.type !== 'entity') { rejected.push(`remove:not-entity:${r.id}`); continue; }
    if (existing.identity_locked === 1) { rejected.push(`remove:locked:${r.id}`); continue; }
    if (forgetMemory(r.id, project)) applied++;
    else rejected.push(`remove:failed:${r.id}`);
  }

  return { applied, rejected };
}"""

# ── reflect.ts ────────────────────────────────────────
REFLECT_IMPORT_OLD = "import { saveFacts, saveMemory, reEmbedMemory, batchEmbedPending } from './store.js';"
REFLECT_IMPORT_NEW = "import { saveFacts, saveMemory, reEmbedMemory, batchEmbedPending, applyIdentityActions, type IdentityActions } from './store.js';"

REFLECT_ACTION_OLD = "  action: 'merge' | 'split' | 'relate' | 'reclassify' | 'delete' | 'boost' | 'decay' | 'extract';"
REFLECT_ACTION_NEW = "  action: 'merge' | 'split' | 'relate' | 'reclassify' | 'delete' | 'boost' | 'decay' | 'extract' | 'identityUpdate';"

REFLECT_FIELD_OLD = """  tier?: string;
  newMemType?: string;  // v1.8: 提取时分类到 4 种封闭类型(user/feedback/project/reference)"""
REFLECT_FIELD_NEW = """  tier?: string;
  newMemType?: string;  // v1.8: 提取时分类到 4 种封闭类型(user/feedback/project/reference)
  // v1.15: 身份记忆 CRUD(add/update/remove,id 白名单校验在 applyIdentityActions)
  identityActions?: IdentityActions;"""

REFLECT_CASE_OLD = """          if (receipt.status === 'applied') result.applied++;
          result.details.push(`extract: from ${action.sourceId} → ${validType}/${validCat} (${tier})`);
          break;
        }

        case 'delete': {"""
REFLECT_CASE_NEW = """          if (receipt.status === 'applied') result.applied++;
          result.details.push(`extract: from ${action.sourceId} → ${validType}/${validCat} (${tier})`);
          break;
        }

        case 'identityUpdate': {
          // v1.15: 身份记忆 CRUD — add/update/remove,幻觉 id 由 applyIdentityActions 白名单校验拒绝
          if (!action.identityActions) {
            result.errors.push('identityUpdate: need identityActions');
            receipt.status = 'failed'; receipt.reason = 'need identityActions';
            continue;
          }
          const r = await applyIdentityActions(action.identityActions, project);
          receipt.rowsAffected = r.applied;
          if (r.rejected.length > 0) {
            receipt.status = 'failed';
            receipt.reason = `rejected: ${r.rejected.join(', ')}`;
            result.errors.push(`identityUpdate: ${r.rejected.join(', ')}`);
          }
          if (receipt.status === 'applied') result.applied++;
          result.details.push(`identityUpdate: +${r.applied} applied, ${r.rejected.length} rejected`);
          break;
        }

        case 'delete': {"""

# ── triage.ts ─────────────────────────────────────────
TRIAGE_IMPORT_OLD = "import { getSessionMemory, upsertSessionMemory, promoteToProject, deleteSessionFragments } from './store.js';"
TRIAGE_IMPORT_NEW = "import { getSessionMemory, upsertSessionMemory, promoteToProject, deleteSessionFragments, applyIdentityActions, saveMemory } from './store.js';"

TRIAGE_PROMPT_OLD = """【输出】只返回严格 JSON 对象,不要代码围栏,不要任何其他文字:
{
  "sessionMemory": "更新后的滚动状态(无变化可省略此字段)",
  "promoted": [
    {"memType": "user", "text": "长效记忆内容"}
  ]
}
- promoted 允许空数组 [];memType 必须属于 user/feedback/project/reference
- sessionMemory 字段可选,省略则不更新会话状态`;"""
TRIAGE_PROMPT_NEW = """【任务3:身份维护(identity)】— 仅当对话涉及用户身份/关系/属性/角色变化时才输出。
【既有身份列表】(update/remove 的 id 必须从下面选择,禁止发明新 id;找不到对应 → 用 add):
{{identityList}}
- add:全新身份事实(列表没有的)→ text 自包含、无代词
- update:既有条目精化/角色变化 → id 必须来自列表;mergeStrategy=merge(字段级合并,保留未变字段)/replace(整体替换);set 只放变化的字段
- remove:条目已错误/过时/重复 → id 必须来自列表 + reason
输出格式(无动作给空数组):
"identity": {"add":[{"text":"...","tags":[],"scoreConfidence":0.8}],
             "update":[{"id":"<真实id>","mergeStrategy":"merge","set":{"text":"..."}}],
             "remove":[{"id":"<真实id>","reason":"..."}]}

【任务4:偏好提取(preferences)】— 仅当对话含跨会话持久偏好(always/never/from now on/我更喜欢/以后都...等明确跨会话意图)时才输出:
{"text":"...","metadata":{"originContext":{"trigger":"触发条件","applicableWhen":"适用场景","notApplicableWhen":"不适用场景"}},"score":{"priority":0.8}}
- 单次任务要求、一次性指令、本任务产出约束(如"这个logo要简洁")不是偏好,不要提取
- 偏好必须是"无论什么对话主题都该遵守的行为指令"

【输出】只返回严格 JSON 对象,不要代码围栏,不要任何其他文字:
{
  "sessionMemory": "更新后的滚动状态(无变化可省略此字段)",
  "promoted": [
    {"memType": "user", "text": "长效记忆内容"}
  ],
  "identity": {"add": [], "update": [], "remove": []},
  "preferences": []
}
- promoted 允许空数组 [];memType 必须属于 user/feedback/project/reference
- sessionMemory 字段可选,省略则不更新会话状态
- identity/preferences 字段可选,省略则不做身份/偏好维护`;"""

TRIAGE_PARSE_OLD = "function parseIncrementalReflection(raw: string): { sessionMemory?: string; promoted?: any[] } | null {"
TRIAGE_PARSE_NEW = "function parseIncrementalReflection(raw: string): { sessionMemory?: string; promoted?: any[]; identity?: any; preferences?: any[] } | null {"

TRIAGE_IDLIST_OLD = """    const userPrompt = `[Session ID] ${sessionId}
[Existing session snapshot] ${oldSnapshot ?? '(none)'}
<transcript>
${lines}
</transcript>`;

    const llm = await callLlm(INCREMENTAL_REFLECT_PROMPT, userPrompt, channel);"""
TRIAGE_IDLIST_NEW = """    // v1.15: 注入既有身份列表(update/remove 的 id 白名单,防 LLM 幻觉 id)
    let identityList = '(无既有身份记忆)';
    try {
      const idb = DatabaseManager.getInstance(proj);
      const rows = idb.prepare(
        `SELECT id, substr(text,1,120) AS t FROM memory WHERE type='entity' AND is_active = 1 AND project = ? ORDER BY importance DESC LIMIT 30`,
      ).all(proj) as any[];
      if (rows.length > 0) identityList = rows.map(r => `- ${r.id} | ${r.t}`).join('\\n');
    } catch { /* 注入失败不影响反思 */ }

    const userPrompt = `[Session ID] ${sessionId}
[Existing session snapshot] ${oldSnapshot ?? '(none)'}
<transcript>
${lines}
</transcript>`;
    const promptWithIdentity = INCREMENTAL_REFLECT_PROMPT.replace('{{identityList}}', identityList);

    const llm = await callLlm(promptWithIdentity, userPrompt, channel);"""

TRIAGE_APPLY_OLD = """    return { ok: true, sessionMemoryUpdated, promoted: promotedCount, errors: [] };
  } catch (e: any) {
    return { ...base, errors: [e.message] };
  }
}"""
TRIAGE_APPLY_NEW = """    if (idResult.rejected.length > 0 || idResult.applied > 0 || prefCount > 0) {
      console.log(`[reflect-incremental] 身份: +${idResult.applied} (拒 ${idResult.rejected.length});偏好: +${prefCount}`);
    }

    return { ok: true, sessionMemoryUpdated, promoted: promotedCount, errors: [] };
  } catch (e: any) {
    return { ...base, errors: [e.message] };
  }
}

// v1.15: 身份维护 + 偏好提取的应用逻辑(在 runIncrementalReflection 内联,见上方 ③④ 段)"""

# 真正的身份/偏好应用逻辑插在 sessionMemory 段之后;锚点:
TRIAGE_APPLY2_OLD = """    // ② sessionMemory 滚动覆盖(upsert 同 session_id)
    let sessionMemoryUpdated = false;
    if (sessionMemory) {
      try {
        upsertSessionMemory(proj, sessionId, sessionMemory);
        sessionMemoryUpdated = true;
      } catch (e: any) {
        console.error('[reflect-incremental] 会话滚动覆盖失败:', e.message);
      }
    }

    return { ok: true, sessionMemoryUpdated, promoted: promotedCount, errors: [] };"""
TRIAGE_APPLY2_NEW = """    // ② sessionMemory 滚动覆盖(upsert 同 session_id)
    let sessionMemoryUpdated = false;
    if (sessionMemory) {
      try {
        upsertSessionMemory(proj, sessionId, sessionMemory);
        sessionMemoryUpdated = true;
      } catch (e: any) {
        console.error('[reflect-incremental] 会话滚动覆盖失败:', e.message);
      }
    }

    // ③ v1.15: 身份维护(identity CRUD,白名单校验在 applyIdentityActions)
    const idResult = parsed.identity && typeof parsed.identity === 'object'
      ? await (async () => {
          const ida = parsed.identity as any;
          try {
            const r = await applyIdentityActions({
              add: Array.isArray(ida.add) ? ida.add.map((a: any) => ({
                text: String(a?.text ?? '').trim(),
                tags: Array.isArray(a?.tags) ? a.tags : undefined,
                title: typeof a?.title === 'string' ? a.title : undefined,
                scoreConfidence: typeof a?.scoreConfidence === 'number' ? a.scoreConfidence : undefined,
                scoreImpact: typeof a?.scoreImpact === 'number' ? a.scoreImpact : undefined,
                scorePriority: typeof a?.scorePriority === 'number' ? a.scorePriority : undefined,
                scoreUrgency: typeof a?.scoreUrgency === 'number' ? a.scoreUrgency : undefined,
                metadata: a?.metadata && typeof a.metadata === 'object' ? JSON.stringify(a.metadata) : undefined,
              })).filter((x: any) => x.text) : undefined,
              update: Array.isArray(ida.update) ? ida.update.map((u: any) => ({
                id: String(u?.id ?? ''),
                mergeStrategy: u?.mergeStrategy === 'replace' ? 'replace' as const : 'merge' as const,
                set: {
                  text: typeof u?.set?.text === 'string' ? u.set.text : undefined,
                  tags: Array.isArray(u?.set?.tags) ? u.set.tags : undefined,
                  title: typeof u?.set?.title === 'string' ? u.set.title : undefined,
                  status: u?.set?.status,
                  scoreConfidence: typeof u?.set?.scoreConfidence === 'number' ? u.set.scoreConfidence : undefined,
                  scorePriority: typeof u?.set?.scorePriority === 'number' ? u.set.scorePriority : undefined,
                  metadata: u?.set?.metadata && typeof u.set.metadata === 'object' ? JSON.stringify(u.set.metadata) : undefined,
                },
              })).filter((x: any) => x.id) : undefined,
              remove: Array.isArray(ida.remove) ? ida.remove.map((rm: any) => ({
                id: String(rm?.id ?? ''), reason: typeof rm?.reason === 'string' ? rm.reason : undefined,
              })).filter((x: any) => x.id) : undefined,
            }, proj);
            if (r.rejected.length > 0) console.log(`[reflect-incremental] 身份动作拒绝: ${r.rejected.join(', ')}`);
            return r;
          } catch (e: any) {
            console.error('[reflect-incremental] 身份维护失败:', e.message);
            return { applied: 0, rejected: [] };
          }
        })()
      : { applied: 0, rejected: [] };

    // ④ v1.15: 偏好提取(type=preference + 触发条件 metadata + 优先级评分)
    let prefCount = 0;
    if (Array.isArray(parsed.preferences)) {
      for (const p of parsed.preferences) {
        if (!p || typeof p !== 'object') continue;
        const text = typeof (p as any).text === 'string' ? (p as any).text.trim() : '';
        if (!text) continue;
        if (await isDuplicate(proj, text, 'user')) continue;
        const meta = (p as any).metadata && typeof (p as any).metadata === 'object'
          ? JSON.stringify((p as any).metadata) : undefined;
        const sc = (p as any).score || {};
        try {
          await saveMemory({
            text: normalizeMarkdown(text, 'user'), type: 'preference', memType: 'user',
            metadata: meta,
            scorePriority: typeof sc.priority === 'number' ? sc.priority : undefined,
            importance: 0.75, project: proj, source: 'reflect_preference',
          });
          prefCount++;
        } catch (e: any) { console.error('[reflect-incremental] 偏好落库失败:', e.message); }
      }
    }

    return { ok: true, sessionMemoryUpdated, promoted: promotedCount, errors: [] };"""

# ── search.ts ─────────────────────────────────────────
SEARCH_SORT_OLD = """  topK?: number;
  minScore?: number;
  profile?: 'quick' | 'balanced' | 'deep';
}"""
SEARCH_SORT_NEW = """  topK?: number;
  minScore?: number;
  profile?: 'quick' | 'balanced' | 'deep';
  // v1.15: LobeHub 精细化吸收 — 评分排序
  sort?: 'default' | 'priority' | 'urgency';  // priority=score_priority 优先,urgency=score_urgency 优先
}"""

SEARCH_ORDER_OLD = """    ORDER BY m.importance DESC, m.created_at DESC
    LIMIT ?"""
SEARCH_ORDER_NEW = """    ORDER BY ${options.sort === 'priority'
      ? 'COALESCE(m.score_priority, 0) DESC, m.importance DESC, m.created_at DESC'
      : options.sort === 'urgency'
        ? 'COALESCE(m.score_urgency, 0) DESC, m.importance DESC, m.created_at DESC'
        : 'm.importance DESC, m.created_at DESC'}
    LIMIT ?"""

# ── index.ts ──────────────────────────────────────────
IDX_PREF_OLD = """      sections.push(`【当前记忆上下文】总记忆 ${stats.c} 条。请优先参考以下记忆,它们是之前会话沉淀的事实与经验:`);

      if (recent.length > 0) {"""
IDX_PREF_NEW = """      sections.push(`【当前记忆上下文】总记忆 ${stats.c} 条。请优先参考以下记忆,它们是之前会话沉淀的事实与经验:`);

      // v1.15: 用户偏好段(带触发条件,score_priority 排序,最先展示)
      const prefs = db.prepare(`
        SELECT text, metadata, score_priority FROM memory
        WHERE is_active = 1 AND project = ? AND type = 'preference' AND mem_type = 'user'
        ORDER BY COALESCE(score_priority, 0) DESC, importance DESC LIMIT 8
      `).all(proj) as any[];
      if (prefs.length > 0) {
        sections.push(`\\n■ 用户偏好(跨会话行为指令,优先遵守):`);
        prefs.forEach((p: any, i: number) => {
          let ctxLine = '';
          try {
            const meta = JSON.parse(p.metadata || '{}');
            const oc = meta.originContext;
            if (oc) {
              const parts: string[] = [];
              if (oc.trigger) parts.push(`触发:${oc.trigger}`);
              if (oc.applicableWhen) parts.push(`适用:${oc.applicableWhen}`);
              if (oc.notApplicableWhen) parts.push(`不适用:${oc.notApplicableWhen}`);
              if (parts.length) ctxLine = ` (${parts.join(';')})`;
            }
          } catch { /* metadata 非 JSON 忽略 */ }
          sections.push(`${i + 1}. ${String(p.text || '').replace(/^# .*\\n/, '')}${ctxLine}`);
        });
      }

      if (recent.length > 0) {"""

PATCHES = {
  'db.ts': [(DB_1_OLD, DB_1_NEW)],
  'store.ts': [
    (STORE_PARAMS_OLD, STORE_PARAMS_NEW),
    (STORE_RECORD_OLD, STORE_RECORD_NEW),
    (STORE_DUP_OLD, STORE_DUP_NEW),
    (STORE_RECORD_BLK_OLD, STORE_RECORD_BLK_NEW),
    (STORE_FORGET_OLD, STORE_FORGET_NEW),
    (STORE_MOVE_OLD, STORE_MOVE_NEW),
    (STORE_FIELDS_OLD, STORE_FIELDS_NEW),
    (STORE_APPEND_OLD, STORE_APPEND_NEW),
  ],
  'reflect.ts': [
    (REFLECT_IMPORT_OLD, REFLECT_IMPORT_NEW),
    (REFLECT_ACTION_OLD, REFLECT_ACTION_NEW),
    (REFLECT_FIELD_OLD, REFLECT_FIELD_NEW),
    (REFLECT_CASE_OLD, REFLECT_CASE_NEW),
  ],
  'triage.ts': [
    (TRIAGE_IMPORT_OLD, TRIAGE_IMPORT_NEW),
    (TRIAGE_PROMPT_OLD, TRIAGE_PROMPT_NEW),
    (TRIAGE_PARSE_OLD, TRIAGE_PARSE_NEW),
    (TRIAGE_IDLIST_OLD, TRIAGE_IDLIST_NEW),
    (TRIAGE_APPLY2_OLD, TRIAGE_APPLY2_NEW),
  ],
  'search.ts': [
    (SEARCH_SORT_OLD, SEARCH_SORT_NEW),
    (SEARCH_ORDER_OLD, SEARCH_ORDER_NEW),
  ],
  'index.ts': [(IDX_PREF_OLD, IDX_PREF_NEW)],
}

def apply(target_dir):
    total_ok = total_skip = 0
    for fname, pairs in PATCHES.items():
        path = f'{target_dir}/{fname}'
        try:
            with open(path, encoding='utf-8') as f:
                content = f.read()
        except FileNotFoundError:
            print(f'  [MISS] {fname} 不存在')
            continue
        for i, (old, new) in enumerate(pairs):
            if old in content:
                content = content.replace(old, new, 1)
                total_ok += 1
            else:
                print(f'  [SKIP] {fname} 锚点#{i+1}: {old[:70].splitlines()[0]}...')
                total_skip += 1
        with open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(content)
    print(f'  → {target_dir}: {total_ok} 处替换, {total_skip} 处跳过')
    return total_skip

if __name__ == '__main__':
    target = sys.argv[1]
    print(f'同步 {target}')
    skips = apply(target)
    if skips > 0:
        print(f'⚠️ 有 {skips} 处锚点未命中,需人工处理')
    else:
        print('✅ 全部锚点命中')
