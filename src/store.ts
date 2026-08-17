/**
 * Memory Store — 原文秒存，去重软抑制
 *
 * v5.0: skipEmbed 参数 — digest 暂不向量化，reflect 后统一 embed
 * v4.0: 去重不再丢弃，SQLite 持久化 embedding 缓存
 */
import { DatabaseManager, generateId, listMemTypeDirs } from './db.js';
import type Database from 'better-sqlite3';
import { embed, getEmbeddingCached } from './ollama.js';
import { PROJECT_ID, CHAR_ID, normalizeProject, isEmbedEnabled } from './env.js';
import { MemType, isClosedMemType, normalizeMarkdown, normalizeMemType } from './memType.js';

let saveCount = 0;
const CONSOLIDATE_INTERVAL = 50;

export interface StoreParams {
  text: string;
  project?: string;  // v1.5: 项目隔离 — 默认 PROJECT_ID(env CASTALIA_PROJECT)
  sessionId?: string;  // v1.11: 会话标识 — 落 session_id 列(会话级记忆,暂不参与检索)
  type?: 'episodic' | 'semantic' | 'entity' | 'preference';
  memType?: MemType;  // v1.8: 用途维度(user/feedback/project/reference/general),默认 general
  category?: string;
  subcategory?: string;
  tags?: string[];
  importance?: number;
  characterId?: string;
  source?: string;
  subject?: 'user' | 'self' | 'environment';
  tier?: 'temporary' | 'standard' | 'critical';
  expiresAt?: string;
  skipEmbed?: boolean;  // v5.0: digest 暂不向量化
}

export interface MemoryRecord {
  id: string;
  text: string;
  project: string;
  sessionId: string | null;
  type: string;
  memType: MemType;
  category: string;
  subcategory: string | null;
  tags: string[];
  importance: number;
  characterId: string | null;
  source: string | null;
  subject: string;
  tier: string;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessedCount: number;
}

export async function saveMemory(params: StoreParams): Promise<MemoryRecord> {
  if (!params.text || !params.text.trim()) throw new Error('memory text must not be empty');
  // memdir 路由:按 memType 落对应分类库(memory/<project>/<memType>/memory.sqlite)
  const db = DatabaseManager.getInstance(params.project, params.memType);
  const now = new Date().toISOString();
  const skipEmbed = params.skipEmbed === true;
  const project = normalizeProject(params.project);
  const memType = normalizeMemType(params.memType);
  // v1.8: 4 种封闭类型(memType≠general)且 text 非 Markdown 时,自动规范化包装(加标题行+转列表)
  const text = normalizeMarkdown(params.text, memType);

  // ═══ 精确去重：完全相同的文本不重复存(仅限同项目) ═══
  const exactDup = db.prepare(`
    SELECT id FROM memory
    WHERE is_active = 1 AND project = ? AND LOWER(TRIM(text)) = LOWER(TRIM(?))
    LIMIT 1
  `).get(project, text?.trim() || '') as any;

  if (exactDup) {
    db.prepare('UPDATE memory SET reference_count = reference_count + 1 WHERE id = ?').run(exactDup.id);
    return {
      id: exactDup.id, text, project,
      sessionId: null,
      type: params.type ?? 'episodic', memType, category: params.category ?? 'general',
      subcategory: params.subcategory ?? null, tags: params.tags ?? [],
      importance: params.importance ?? 0.5,
      characterId: params.characterId ?? null, source: params.source ?? null,
      subject: params.subject ?? 'user',
      tier: params.tier ?? 'standard', expiresAt: null,
      isActive: true,
      createdAt: now, updatedAt: now, lastAccessedAt: now, accessedCount: 0,
    } as MemoryRecord;
    }

    // ═══ 向量去重：仅当不跳过 embed 且嵌入可用时执行(仅限同项目) ═══
  let vector: number[] | null = null;
  let isNearDup = false;
  let dupId: string | null = null;

  if (!skipEmbed && isEmbedEnabled()) {
    try {
      vector = await getEmbeddingCached(text, project);
      const floatVec = new Float32Array(vector);
      const knn = db.prepare(`
        SELECT rowid, distance FROM vec_memory
        WHERE embedding MATCH ? ORDER BY distance LIMIT 10
      `).all(floatVec) as any[];

      if (knn.length > 0 && knn[0].distance < 0.05) {
        // v1.5: 项目隔离 — 仅当最近邻属于同项目才算重复
        const dupRow = db.prepare('SELECT id FROM memory WHERE rowid = ? AND project = ?').get(Number(knn[0].rowid), project) as any;
        if (dupRow) {
          dupId = dupRow.id;
          isNearDup = true;
          db.prepare('UPDATE memory SET reference_count = reference_count + 1 WHERE id = ?').run(dupId);
        }
      }
    } catch {
      // KNN 不可用，跳过去重检查
    }
  }

  // ═══ 存入新记忆（不管是否近重复，都存） ═══
  const id = generateId();

  // tier + expires_at 计算:显式 expiresAt 优先;否则 temporary 默认 3 天 TTL,standard/critical 永不过期
  const tier = params.tier || 'standard';
  const expiresAt = params.expiresAt || (
    tier === 'temporary'
      ? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() // 3天TTL
      : null // standard/critical 永不过期
  );

  const record: MemoryRecord = {
    id, text, project,
    sessionId: params.sessionId ?? null,
    type: params.type ?? 'episodic',
    memType,
    category: params.category ?? 'general',
    subcategory: params.subcategory ?? null,
    tags: params.tags ?? [],
    importance: params.importance ?? 0.5,
    characterId: params.characterId ?? null,
    source: params.source ?? null,
    subject: params.subject ?? 'user',
    tier,
    expiresAt,
    isActive: true,
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
    );

    // v5.0: 仅在非 skipEmbed 时写入向量
    if (!skipEmbed && vector) {
      const info = db.prepare('SELECT rowid FROM memory WHERE id = ?').get(record.id) as any;
      const rowid = BigInt(info.rowid);
      db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(rowid, new Float32Array(vector));
    }
  });
  storeTx();

  // 定期整理
  saveCount++;
  if (saveCount >= CONSOLIDATE_INTERVAL) {
    saveCount = 0;
    try {
      const { consolidate } = await import('./consolidate.js');
      consolidate().catch(() => {});
    } catch {}
  }

  return record;
}

/** 按 id 定位记忆所在分类库(memdir 遍历),返回库连接+分类;找不到返回 null */
function findDbByMemoryId(id: string, project?: string): { db: Database.Database; memType: string } | null {
  const proj = normalizeProject(project);
  for (const mt of listMemTypeDirs(proj)) {
    const db = DatabaseManager.getInstance(proj, mt);
    if (db.prepare('SELECT id FROM memory WHERE id = ?').get(id)) return { db, memType: mt };
  }
  return null;
}

export function forgetMemory(id: string, project?: string): boolean {
  const found = findDbByMemoryId(id, project);
  if (!found) return false;
  return found.db.prepare('UPDATE memory SET is_active = 0 WHERE id = ?').run(id).changes > 0;
}

export function restoreMemory(id: string, project?: string): boolean {
  const found = findDbByMemoryId(id, project);
  if (!found) return false;
  return found.db.prepare('UPDATE memory SET is_active = 1 WHERE id = ?').run(id).changes > 0;
}

export async function updateMemory(id: string, updates: Partial<StoreParams>): Promise<MemoryRecord | null> {
  const found = findDbByMemoryId(id, updates.project);
  if (!found) return null;
  let db = found.db;
  const existing = db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as any;
  if (!existing) return null;

  // memdir 跨分类移动:memType 变更 → 复制到新分类库 + 软删原库
  const newMt = updates.memType !== undefined ? normalizeMemType(updates.memType) : found.memType;
  if (newMt !== found.memType) {
    const proj = normalizeProject(updates.project);
    const newDb = DatabaseManager.getInstance(proj, newMt);
    const text = updates.text !== undefined ? normalizeMarkdown(updates.text, newMt) : existing.text;
    const tags = updates.tags !== undefined ? JSON.stringify(updates.tags) : (existing.tags ?? '[]');
    const now = new Date().toISOString();
    newDb.prepare(`
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
    );
    // 向量一并搬移(若有)
    try {
      const srcVec = db.prepare('SELECT embedding FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').get(id) as any;
      if (srcVec) {
        newDb.prepare('DELETE FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').run(id);
        const rowInfo = newDb.prepare('SELECT rowid FROM memory WHERE id = ?').get(id) as any;
        newDb.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(BigInt(rowInfo.rowid), srcVec.embedding);
      }
    } catch { /* 无向量/损坏忽略 */ }
    db.prepare('UPDATE memory SET is_active = 0 WHERE id = ?').run(id);
    db = newDb;
    // 已处理 memType 变更,移除以免重复 SET
    if (updates.memType !== undefined) delete (updates as any).memType;
    return db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as any;
  }

  const fields: string[] = [];
  const values: any[] = [];
  let text: string | undefined;
  if (updates.text !== undefined) {
    // v1.8: memType 为 4 种封闭类型时,更新 text 同样规范化包装
    text = normalizeMarkdown(updates.text, updates.memType);
    fields.push('text = ?'); values.push(text);
  }
  if (updates.memType !== undefined) { fields.push('mem_type = ?'); values.push(normalizeMemType(updates.memType)); }
  if (updates.type !== undefined) { fields.push('type = ?'); values.push(updates.type); }
  if (updates.category !== undefined) { fields.push('category = ?'); values.push(updates.category); }
  if (updates.subcategory !== undefined) { fields.push('subcategory = ?'); values.push(updates.subcategory); }
  if (updates.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(updates.tags)); }
  if (updates.importance !== undefined) { fields.push('importance = ?'); values.push(updates.importance); }

  if (fields.length === 0) return existing;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE memory SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  if (updates.text !== undefined && isEmbedEnabled()) {
    const newVec = await getEmbeddingCached(text!, updates.project);
    db.prepare('DELETE FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').run(id);
    const rowInfo = db.prepare('SELECT rowid FROM memory WHERE id = ?').get(id) as any;
    db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(
      BigInt(rowInfo.rowid),
      new Float32Array(newVec)
    );
  }

  return db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as any;
}

/**
 * 存储对话原文（轻量，不做分析，不做向量化）
 * v5.0: 对话原文永不 embed — digest 分拣后再由 reflect 统一向量化
 */
export async function saveConversationTurn(
  userMsg: string,
  assistantMsg: string,
  characterId: string = 'airi',
  moodValue?: number,
  moodReason?: string,
  project?: string,  // v1.5: 项目隔离
): Promise<any> {
  const db = DatabaseManager.getInstance(project);
  const now = new Date().toISOString();
  const id = generateId();
  const proj = normalizeProject(project);

  let moodPrefix = '';
  if (moodValue !== undefined) {
    moodPrefix = `[mood: ${moodValue}`;
    if (moodReason) moodPrefix += `, "${moodReason}"`;
    moodPrefix += ']\n';
  }

  const text = `${moodPrefix}用户: ${userMsg}\n尤诺: ${assistantMsg}`;

  db.prepare(`
    INSERT INTO memory (id, text, project, type, category, tags, importance, character_id, source, subject, tier, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count)
    VALUES (?, ?, ?, 'episodic', 'conversation', '[]', 0.5, ?, 'conversation_log', 'user', 'standard', 1, ?, ?, ?, 0, 0)
  `).run(id, text, proj, characterId, now, now, now);

  return { id, ok: true };
}

/**
 * 清理过期的临时记忆 (tier='temporary', expires_at < now)
 * 返回清理数量
 */
// ═══ v1.3: 热度升格 — 常被访问的记忆自动变强(UPSP 热度思想) ═══
// 访问次数 ≥ HEAT_PROMOTE_THRESHOLD 的 temporary 记忆自动升 standard(免清理)
const HEAT_PROMOTE_THRESHOLD = parseInt(process.env.HEAT_PROMOTE_THRESHOLD || '5', 10);

export function promoteByAccess(project?: string): number {
  const proj = normalizeProject(project);
  const now = new Date().toISOString();
  let total = 0;
  // memdir:遍历项目全部分类库(临时记忆可能落在任意 memType 分类库)
  for (const mt of listMemTypeDirs(proj)) {
    const db = DatabaseManager.getInstance(proj, mt);
    const r = db.prepare(`
      UPDATE memory SET tier = 'standard', updated_at = ?
      WHERE tier = 'temporary' AND accessed_count >= ? AND is_active = 1
    `).run(now, HEAT_PROMOTE_THRESHOLD);
    total += r.changes;
  }
  if (total > 0) console.error(`[memory] heat promote: ${total} temporary → standard`);
  return total;
}

export function cleanupExpiredMemories(project?: string): number {
  const proj = normalizeProject(project);
  const now = new Date().toISOString();
  // 先升格再清理:被反复访问的 temporary 不该被清
  promoteByAccess(project);
  let total = 0;
  // memdir:遍历项目全部分类库清理过期 temporary(避免只清 general 漏掉 user/feedback/project/reference)
  for (const mt of listMemTypeDirs(proj)) {
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
export async function reEmbedMemory(id: string): Promise<boolean> {
  const db = DatabaseManager.getInstance();
  const mem = db.prepare('SELECT rowid, text FROM memory WHERE id = ? AND is_active = 1').get(id) as any;
  if (!mem) return false;

  try {
    const vec = new Float32Array(await embed(mem.text));
    db.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(BigInt(mem.rowid));
    db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(BigInt(mem.rowid), vec);
    return true;
  } catch (e: any) {
    console.error(`[store] reEmbedMemory failed for ${id}: ${e.message}`);
    return false;
  }
}

/**
 * v5.0: 批量向量化 — reflect 后一次性处理所有未嵌入记忆
 * v1.5: 支持按项目隔离 — 传 project 只处理该项目;不传则默认项目
 * 扫描 is_active=1 但 vec_memory 中无对应向量的记录
 */
export async function batchEmbedPending(characterId: string = 'airi', project?: string): Promise<{ embedded: number; errors: string[] }> {
  if (!isEmbedEnabled()) return { embedded: 0, errors: ['embedding disabled (EMBED_MODE=none)'] };
  const proj = normalizeProject(project);
  let embedded = 0;
  const errors: string[] = [];
  // memdir:遍历项目全部分类库补嵌入
  for (const mt of listMemTypeDirs(proj)) {
    const db = DatabaseManager.getInstance(proj, mt);

  // 找所有有记忆但无向量的记录(source 为 NULL 也算,修复 NULL != 'x' 恒假的坑)
  // characterId='any' 时不按角色过滤(跨库产物如 reflect 库 character_id 为 NULL 也能补嵌入)
  const conditions = [
    'm.is_active = 1',
    'm.rowid NOT IN (SELECT rowid FROM vec_memory)',
  ];
  const params: any[] = [];
  if (characterId !== 'any') {
    conditions.push('m.character_id = ?');
    params.push(characterId);
  }
  conditions.push("COALESCE(m.source, '') != 'conversation_log'");
  if (project) {
    conditions.push('m.project = ?');
    params.push(proj);
  }
  const pending = db.prepare(`
    SELECT m.id, m.text, m.rowid FROM memory m
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.created_at ASC
    LIMIT 200
  `).all(...params) as any[];

  for (const row of pending) {
    try {
      const vec = new Float32Array(await embed(row.text, project));
      db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(BigInt(row.rowid), vec);
      embedded++;
    } catch (e: any) {
      errors.push(`${row.id}: ${e.message}`);
    }
  }
  }
  return { embedded, errors };
}

// ═══════════════════════════════════════════════════════════════════
// Facts: Subject-Predicate-Object 三元组存储
// ═══════════════════════════════════════════════════════════════════

export interface FactRecord {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  sourceMemoryId: string | null;
  characterId: string | null;
  isActive: boolean;
  accessedCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 批量存储事实 — 自动处理去重（subject+predicate+object 唯一）
 *
 * 去重策略：
 *   - 同一 S-P-O → 更新 confidence 为 MAX(old, new)，不重复插入
 *   - 不同 S-P-O → 正常插入
 */
export async function saveFacts(
  facts: { subject: string; predicate: string; object: string; confidence: number }[],
  sourceMemoryId: string | null = null,
  characterId: string = 'airi',
  project?: string,  // v1.5: 项目隔离
): Promise<{ inserted: number; updated: number }> {
  if (!facts || facts.length === 0) return { inserted: 0, updated: 0 };

  const db = DatabaseManager.getInstance(project);
  const now = new Date().toISOString();
  const proj = normalizeProject(project);
  let inserted = 0;
  let updated = 0;

  const upsert = db.prepare(`
    INSERT INTO facts (id, subject, predicate, object, project, confidence, source_memory_id, character_id, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(subject, predicate, object, project) DO UPDATE SET
      confidence = MAX(confidence, excluded.confidence),
      updated_at = excluded.updated_at,
      is_active = 1,
      accessed_count = facts.accessed_count
  `);

  for (const f of facts) {
    const id = generateId();
    const before = db.prepare(
      'SELECT id, confidence FROM facts WHERE subject=? AND predicate=? AND object=? AND project=?'
    ).get(f.subject, f.predicate, f.object, proj) as any;

    upsert.run(id, f.subject, f.predicate, f.object, proj, f.confidence, sourceMemoryId, characterId, now, now);

    if (before) {
      updated++;
    } else {
      inserted++;
    }
  }

  // 为新增 / 更新的事实生成 embedding 并写入 vec_facts
  if (!isEmbedEnabled()) return { inserted, updated };
  try {
    const allFacts = db.prepare(`
      SELECT rowid, subject, predicate, object FROM facts
      WHERE project = ? AND subject || ' ' || predicate || ' ' || object IN (
        ${facts.map(() => '?').join(',')}
      )
    `).all(proj, ...facts.map(f => `${f.subject} ${f.predicate} ${f.object}`)) as any[];

    for (const row of allFacts) {
      const factText = `${row.subject} ${row.predicate} ${row.object}`;
      try {
        const vec = new Float32Array(await getEmbeddingCached(factText, proj));
        // upsert: delete old + insert new
        db.prepare('DELETE FROM vec_facts WHERE rowid = ?').run(BigInt(row.rowid));
        db.prepare('INSERT INTO vec_facts (rowid, embedding) VALUES (?, ?)').run(BigInt(row.rowid), vec);
      } catch {}
    }
  } catch {}

  return { inserted, updated };
}

/**
 * 查询某个主体的所有活跃事实
 */
export function getFactsBySubject(subject: string, characterId?: string, project?: string): FactRecord[] {
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);
  let query = 'SELECT * FROM facts WHERE subject = ? AND is_active = 1 AND project = ?';
  const params: any[] = [subject, proj];
  if (characterId) {
    query += ' AND character_id = ?';
    params.push(characterId);
  }
  query += ' ORDER BY confidence DESC, updated_at DESC LIMIT 50';
  return db.prepare(query).all(...params) as FactRecord[];
}

// ═══════════════════════════════════════════════════════════════════
// v1.11 Part2: 会话记忆数据层 — 渐进式临时反思
//   getSessionMemory      : 读会话滚动快照(source=session_memory)
//   upsertSessionMemory   : 会话滚动状态滚动覆盖(同 session_id 单行 upsert)
//   promoteToProject      : 长效干货晋升到项目级(session_id=NULL, 4 类强制 Markdown)
//   deleteSessionFragments: 晋升即删(清空该会话已晋升的 session_memory 碎片)
// ═══════════════════════════════════════════════════════════════════

/** 读取某会话当前滚动记忆快照(source=session_memory,最新一条) */
export function getSessionMemory(project: string, sessionId: string): string | null {
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);
  const row = db.prepare(`
    SELECT text FROM memory
    WHERE project = ? AND session_id = ? AND source = 'session_memory' AND is_active = 1
    ORDER BY updated_at DESC LIMIT 1
  `).get(proj, sessionId) as any;
  return row?.text ?? null;
}

/**
 * 会话滚动状态覆盖:按 (project, session_id) 查同会话已有 session_memory
 * → 有则 UPDATE text(覆盖),无则 INSERT(session_id 非空, source=session_memory,
 *   memType=general 或 LLM 给的, category=session)。
 * 单会话单行,实现"滚动覆盖"而非碎片堆积。
 */
export function upsertSessionMemory(
  project: string,
  sessionId: string,
  content: string,
  memType?: MemType,
): { id: string; updated: boolean } {
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);
  const now = new Date().toISOString();
  const existing = db.prepare(`
    SELECT id FROM memory
    WHERE project = ? AND session_id = ? AND source = 'session_memory' AND is_active = 1
    ORDER BY updated_at DESC LIMIT 1
  `).get(proj, sessionId) as any;
  if (existing) {
    db.prepare('UPDATE memory SET text = ?, updated_at = ? WHERE id = ?').run(content, now, existing.id);
    return { id: existing.id, updated: true };
  }
  const id = generateId();
  db.prepare(`
    INSERT INTO memory (id, text, project, session_id, type, mem_type, category, tags, importance, source, subject, tier, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count)
    VALUES (?, ?, ?, ?, 'episodic', ?, 'session', '[]', 0.5, 'session_memory', 'user', 'standard', 1, ?, ?, ?, 0, 0)
  `).run(id, content, proj, sessionId, normalizeMemType(memType), now, now, now);
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
export function promoteToProject(
  project: string,
  items: { memType: MemType; text: string }[],
  characterId?: string,
): string[] {
  const cid = characterId || CHAR_ID;
  const proj = normalizeProject(project);
  const now = new Date().toISOString();
  const ids: string[] = [];
  for (const item of items || []) {
    const mt = isClosedMemType(item.memType) ? item.memType : undefined;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!mt || !text) continue;
    // memdir 路由:反思晋升产物按 memType 落对应分类库
    const db = DatabaseManager.getInstance(proj, mt);
    const md = normalizeMarkdown(text, mt);
    const dup = db.prepare(`
      SELECT id FROM memory
      WHERE is_active = 1 AND project = ? AND session_id IS NULL AND LOWER(TRIM(text)) = LOWER(TRIM(?))
      LIMIT 1
    `).get(proj, md) as any;
    if (dup) { ids.push(dup.id); continue; }
    const id = generateId();
    db.prepare(`
      INSERT INTO memory (id, text, project, session_id, type, mem_type, category, tags, importance, character_id, source, subject, tier, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count)
      VALUES (?, ?, ?, NULL, 'semantic', ?, 'session_promoted', '[]', 0.6, ?, 'session_promoted', 'user', 'standard', 1, ?, ?, ?, 0, 0)
    `).run(id, md, proj, mt, cid, now, now, now);
    ids.push(id);
  }
  return ids;
}

/**
 * 晋升即删(吸收 Claude cleaner.onPromoted):晋升成功后清空该会话
 * source=session_memory 的已晋升碎片。硬删(内部家计行,不嵌向量)。
 */
export function deleteSessionFragments(project: string, sessionId: string): number {
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);
  const r = db.prepare(`
    DELETE FROM memory
    WHERE project = ? AND session_id = ? AND source = 'session_memory' AND is_active = 1
  `).run(proj, sessionId);
  return r.changes;
}
