/**
 * Memory Search — 中性通用检索
 *
 * 策略：
 *   1. 标签搜索(0 向量调用)→ 不够回退向量 KNN
 *   2. 评分：语义一致性为主(60%)，时间衰减(30%)，情绪标记弱化(10%)
 *
 * 权重全部可经环境变量调整，适用于通用 agent 记忆场景。
 */
import { DatabaseManager, listProjectNames, listMemTypeDirs } from './db.js';
import { embed } from './ollama.js';
import { normalizeProject, isEmbedEnabled } from './env.js';
import { MemType, normalizeMemType } from './memType.js';
import type Database from 'better-sqlite3';

// 中性评分权重(可配)
const WEIGHT_CONSISTENCY = parseFloat(process.env.WEIGHT_CONSISTENCY || '0.65');  // 语义/标签匹配
const WEIGHT_TIME        = parseFloat(process.env.WEIGHT_TIME || '0.35');         // 时间衰减

// 时间衰减半衰期(小时),默认 30 天
const HALF_LIFE_HOURS = parseFloat(process.env.HALF_LIFE_HOURS || (30 * 24).toString());

export interface SearchOptions {
  query: string;
  project?: string;  // v1.5: 项目隔离 — 默认 PROJECT_ID
  type?: string;
  memType?: MemType;  // v1.8: 用途维度过滤(user/feedback/project/reference/general)
  category?: string;
  tags?: string[];
  characterId?: string;
  subject?: string;
  topK?: number;
  minScore?: number;
  profile?: 'quick' | 'balanced' | 'deep';
  // v1.15: LobeHub 精细化吸收 — 评分排序
  sort?: 'default' | 'priority' | 'urgency';  // priority=score_priority 优先,urgency=score_urgency 优先
}

// minScore 阈值可配;harness 可用 SEARCH_MIN_SCORE 覆盖
const SEARCH_PROFILES: Record<string, { topK: number; minScore: number }> = {
  quick: { topK: 3, minScore: 0.6 },
  balanced: { topK: 5, minScore: parseFloat(process.env.SEARCH_MIN_SCORE || '0.15') },
  deep: { topK: 10, minScore: 0.1 },
};

export interface SearchResult {
  id: string;
  text: string;
  project: string;
  type: string;
  memType: string;
  category: string;
  subcategory: string | null;
  tags: string[];
  importance: number;
  characterId: string | null;
  source: string | null;
  subject: string;
  tier: string;
  score: number;
  similarity: number;
  createdAt: string;
  lastAccessedAt: string;
  accessedCount: number;
}

/** 指数时间衰减:30 天半衰期 */
function timeDecay(hoursSinceCreated: number): number {
  if (hoursSinceCreated <= 0) return 1;
  return Math.pow(0.5, hoursSinceCreated / HALF_LIFE_HOURS);
}

// 时效类内容(对话/会话记录)半衰期缩短,自然沉底(可配,默认 10 天)
const EPHEMERAL_HALF_LIFE_HOURS = parseFloat(process.env.EPHEMERAL_HALF_LIFE_HOURS || (10 * 24).toString());
const EPHEMERAL_CATEGORIES = new Set(
  (process.env.EPHEMERAL_CATEGORIES || 'conversation,session,context').split(',').map(s => s.trim()).filter(Boolean));

/**
 * 分级时间衰减:
 * - critical 权威结论/身份/里程碑 → 时间不衰减(永葆可检索)
 * - 时效类(对话/会话记录)→ 短半衰期,自然沉底(可配 EPHEMERAL_CATEGORIES)
 * - 其余(standard 画像等)→ 默认 30 天半衰期
 */
function decayFor(row: any, hoursSinceCreated: number): number {
  if (hoursSinceCreated <= 0) return 1;
  if (row.tier === 'critical') return 1;  // 权威结论不随时间衰减
  const cat = row.category || '';
  const src = row.source || '';
  if (EPHEMERAL_CATEGORIES.has(cat) || src === 'conversation_log' || src === 'session_memory') {
    return Math.pow(0.5, hoursSinceCreated / EPHEMERAL_HALF_LIFE_HOURS);
  }
  return timeDecay(hoursSinceCreated);
}

/** 统一评分:一致性 + 情绪(弱) + 时间 */
function computeScore(similarity: number, row: any): number {
  const consistency = Math.min(Math.max(similarity, 0), 0.85);
  const hoursSinceCreated = (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60);
  const decay = decayFor(row, hoursSinceCreated);

  const tierBoost = row.tier === 'critical' ? 2.0 : (row.tier === 'temporary' ? 0.5 : 1.0);
  const importanceMult = 0.5 + (row.importance || 0.5);
  const accessBoost = 1 + Math.min(0.5, Math.log2(1 + (row.accessed_count || 0)) * 0.1);

  const rawScore = WEIGHT_CONSISTENCY * consistency
                 + WEIGHT_TIME * decay;
  return Math.round(rawScore * importanceMult * tierBoost * accessBoost * 1000) / 1000;
}

/**
 * 标签优先搜索 → 不足时回退向量 KNN
 */
export async function searchMemory(options: SearchOptions): Promise<SearchResult[]> {
  const proj = normalizeProject(options.project);
  const topK = options.topK ?? 10;
  // memdir:memType 指定 → 单分类库;未指定 → 聚合项目全部分类库
  const mtFilter = options.memType ? normalizeMemType(options.memType) : null;
  const dirs = mtFilter ? [mtFilter] : listMemTypeDirs(proj);
  const all: SearchResult[] = [];
  for (const mt of dirs) {
    try {
      const db = DatabaseManager.getInstance(proj, mt);
      const r = await searchInDb(db, { ...options, project: proj });
      all.push(...r);
    } catch { /* 单分类库失败不影响其他 */ }
  }
  all.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const r of all) {
    if (!seen.has(r.id)) { seen.add(r.id); unique.push(r); }
    if (unique.length >= topK) break;
  }
  return unique.slice(0, topK);
}

/** 单库搜索主体(标签 → 向量 KNN → 文本回退),按分类库调用 */
async function searchInDb(db: Database.Database, options: SearchOptions): Promise<SearchResult[]> {
  const profile = options.profile ? SEARCH_PROFILES[options.profile] : null;
  const topK = options.topK ?? profile?.topK ?? 10;
  const minScore = options.minScore ?? profile?.minScore ?? 0;

  // ═══ Phase 1: 标签搜索(0 次向量调用) ═══
  const tagResults = tagSearch(db, options);

  // 标签结果足够好 → 直接返回
  if (tagResults.length >= topK && tagResults[0].score >= 0.5) {
    updateAccessed(db, tagResults.slice(0, topK));
    return tagResults.slice(0, topK);
  }

  // ═══ Phase 2: 标签不够 → 向量 KNN 补充(EMBED_MODE=none 时跳过,纯文本回退) ═══
  const existingIds = new Set(tagResults.map(r => r.id));
  let vectorResults: SearchResult[] = [];

  if (isEmbedEnabled()) {
    try {
      const queryVector = await embed(options.query, options.project);
      const floatQuery = new Float32Array(queryVector);
      vectorResults = vectorKnnSearch(db, options, floatQuery, existingIds, topK, minScore);
    } catch {
      // 向量搜索失败 → 文本回退
      vectorResults = textFallbackSearch(db, options, existingIds, topK, minScore);
    }
  } else {
    // 纯本地模式:标签结果不足时直接文本回退
    vectorResults = textFallbackSearch(db, options, existingIds, topK, minScore);
  }

  // 合并 + 去重 + 排序
  const merged = [...tagResults, ...vectorResults];
  merged.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const r of merged) {
    if (!seen.has(r.id)) { seen.add(r.id); unique.push(r); }
    if (unique.length >= topK) break;
  }

  updateAccessed(db, unique.slice(0, topK));
  return unique.slice(0, topK);
}

/**
 * 跨库搜索(多项目合并,2026-08-16) — 显式语义:
 * 调用方明确指定要搜哪些库(projects),引擎不做隐式合并/共享魔法;
 * 互通规则由上层决定(接口先行)。结果按 score 降序,每行 project 标注来源库。
 * projects=['*'] 或 ['all'] → 本实例全部库(扫描 memory 目录)。
 */

// ═══════════════════════════════════════════════════════════════════
// 标签搜索 — 从 query 提取关键词，SQL tag LIKE 匹配
// ═══════════════════════════════════════════════════════════════════

/** 从中文/英文 query 中提取关键词 */
function extractKeywords(query: string): string[] {
  const stopWords = new Set(['的', '了', '是', '我', '你', '他', '她', '吗', '呢', '吧', '啊',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'of', 'and', 'or',
    '有', '在', '不', '要', '会', '能', '就', '都', '也', '还', '和', '与', '这', '那', '什么', '怎么']);
  const tokens = query.split(/[\s,，。！？、；：""''（）()\[\]【】\-\/\\|]+/);
  return [...new Set(tokens.filter(t => t.length >= 2 && !stopWords.has(t.toLowerCase())))];
}

/** SQL 标签搜索：匹配 memory.tags JSON 数组 */
function tagSearch(db: any, options: SearchOptions): SearchResult[] {
  const keywords = extractKeywords(options.query);
  if (keywords.length === 0) return [];

  const profile = options.profile ? SEARCH_PROFILES[options.profile] : null;
  const topK = options.topK ?? profile?.topK ?? 10;
  const project = normalizeProject(options.project);

  const tagCond = keywords.map(() => `m.tags LIKE ?`).join(' OR ');
  const tagParams = keywords.map(k => `%"${k}"%`);
  const looseCond = keywords.map(() => `m.tags LIKE ?`).join(' OR ');
  const looseParams = keywords.map(k => `%${k}%`);

  const conditions: string[] = ['m.is_active = 1', 'm.project = ?'];
  const params: any[] = [project];

  conditions.push(`((${tagCond}) OR (${looseCond}))`);
  params.push(...tagParams, ...looseParams);

  if (options.type) { conditions.push('m.type = ?'); params.push(options.type); }
  if (options.memType) { conditions.push('m.mem_type = ?'); params.push(options.memType); }
  if (options.category) { conditions.push('m.category = ?'); params.push(options.category); }
  if (options.characterId) { conditions.push('m.character_id = ?'); params.push(options.characterId); }
  if (options.subject) { conditions.push('m.subject = ?'); params.push(options.subject); }

  const rows = db.prepare(`
    SELECT m.id, m.text, m.project, m.type, m.mem_type, m.category, m.subcategory, m.tags,
      m.importance, m.character_id, m.source,
      m.subject, m.tier,
      m.created_at, m.last_accessed_at, m.accessed_count
    FROM memory m
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${options.sort === 'priority'
      ? 'COALESCE(m.score_priority, 0) DESC, m.importance DESC, m.created_at DESC'
      : options.sort === 'urgency'
        ? 'COALESCE(m.score_urgency, 0) DESC, m.importance DESC, m.created_at DESC'
        : 'm.importance DESC, m.created_at DESC'}
    LIMIT ?
  `).all(...params, topK * 3) as any[];

  return rows.map(row => {
    const memTags = JSON.parse(row.tags || '[]');
    const matchedTags = keywords.filter(k =>
      memTags.some((t: string) => t.toLowerCase().includes(k.toLowerCase()))
    ).length;
    const tagScore = Math.min(1.0, matchedTags / Math.max(1, keywords.length));

    return {
      id: row.id, text: row.text, project: row.project || 'default', type: row.type, memType: row.mem_type || 'general', category: row.category,
      subcategory: row.subcategory, tags: memTags,
      importance: row.importance,
      characterId: row.character_id, source: row.source,
      subject: row.subject || 'user', tier: row.tier || 'standard',
      score: computeScore(tagScore, row), similarity: Math.round(tagScore * 1000) / 1000,
      createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
      accessedCount: row.accessed_count,
    };
  });
}

/** 向量 KNN 搜索 */
function vectorKnnSearch(
  db: any, options: SearchOptions, floatQuery: Float32Array,
  excludeIds: Set<string>, topK: number, minScore: number
): SearchResult[] {
  // v1.5: vec0 虚拟表禁止 JOIN(KNN 必须在 vec0 上 LIMIT),项目过滤放在第二段 memory 查询
  // 候选集放大(全库 KNN)保证单项目召回;隔离语义由 memory 查询的 project=? 保证
  const knnLimit = Math.min(topK * 8, 60);
  const project = normalizeProject(options.project);
  let knnRows: any[];

  try {
    knnRows = db.prepare(`
      SELECT rowid, distance FROM vec_memory
      WHERE embedding MATCH ? ORDER BY distance LIMIT ?
    `).all(floatQuery, knnLimit) as any[];
  } catch {
    return [];
  }

  if (knnRows.length === 0) return [];

  const rowidMap = new Map<number, number>();
  for (const r of knnRows) rowidMap.set(Number(r.rowid), r.distance);

  const rowidPlaceholders = knnRows.map(() => '?').join(',');
  const rowidParams = knnRows.map(r => Number(r.rowid));
  const conditions: string[] = [`m.rowid IN (${rowidPlaceholders})`, 'm.is_active = 1', 'm.project = ?'];
  const params: any[] = [...rowidParams, project];

  if (options.type) { conditions.push('m.type = ?'); params.push(options.type); }
  if (options.memType) { conditions.push('m.mem_type = ?'); params.push(options.memType); }
  if (options.category) { conditions.push('m.category = ?'); params.push(options.category); }
  if (options.characterId) { conditions.push('m.character_id = ?'); params.push(options.characterId); }

  const rows = db.prepare(`
    SELECT m.id, m.text, m.project, m.type, m.mem_type, m.category, m.subcategory, m.tags,
      m.importance, m.character_id, m.source,
      m.subject, m.tier,
      m.created_at, m.last_accessed_at, m.accessed_count, m.rowid
    FROM memory m WHERE ${conditions.join(' AND ')}
  `).all(...params) as any[];

  const results: SearchResult[] = [];
  for (const row of rows) {
    if (excludeIds.has(row.id)) continue;
    const dist = rowidMap.get(row.rowid) ?? 1.0;
    const similarity = Math.max(0, 1.0 - dist);
    const score = computeScore(similarity, row);
    if (score >= minScore) {
      results.push({
        id: row.id, text: row.text, project: row.project || 'default', type: row.type, memType: row.mem_type || 'general', category: row.category,
        subcategory: row.subcategory, tags: JSON.parse(row.tags || '[]'),
        importance: row.importance,
        characterId: row.character_id, source: row.source,
        subject: row.subject || 'user', tier: row.tier || 'standard',
        score, similarity: Math.round(similarity * 1000) / 1000,
        createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
        accessedCount: row.accessed_count,
      });
    }
  }
  return results;
}

/** 文本回退搜索(向量不可用时) */
function textFallbackSearch(
  db: any, options: SearchOptions, excludeIds: Set<string>,
  topK: number, minScore: number
): SearchResult[] {
  const terms = options.query.split(/\s+/).filter(t => t.length > 0);
  if (terms.length === 0) return [];
  const project = normalizeProject(options.project);

  const likeConditions = terms.map(() => 'm.text LIKE ?').join(' OR ');
  const likeParams = terms.map(t => `%${t}%`);

  const conds: string[] = [`m.is_active = 1`, `m.project = ?`, `(${likeConditions})`];
  const params: any[] = [project, ...likeParams];
  if (options.memType) { conds.push('m.mem_type = ?'); params.push(options.memType); }
  if (options.type) { conds.push('m.type = ?'); params.push(options.type); }
  if (options.category) { conds.push('m.category = ?'); params.push(options.category); }
  if (options.characterId) { conds.push('m.character_id = ?'); params.push(options.characterId); }
  if (options.subject) { conds.push('m.subject = ?'); params.push(options.subject); }

  const rows = db.prepare(`
    SELECT m.id, m.text, m.project, m.type, m.mem_type, m.category, m.subcategory, m.tags,
      m.importance, m.character_id, m.source,
      m.subject, m.tier,
      m.created_at, m.last_accessed_at, m.accessed_count
    FROM memory m
    WHERE ${conds.join(' AND ')}
    ORDER BY m.created_at DESC LIMIT ?
  `).all(...params, topK * 2) as any[];

  return rows
    .filter(row => !excludeIds.has(row.id))
    .map(row => ({
      id: row.id, text: row.text, project: row.project || 'default', type: row.type, memType: row.mem_type || 'general', category: row.category,
      subcategory: row.subcategory, tags: JSON.parse(row.tags || '[]'),
      importance: row.importance,
      characterId: row.character_id, source: row.source,
      subject: row.subject || 'user', tier: row.tier || 'standard',
      score: computeScore(0.3, row), similarity: 0.3,
      createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
      accessedCount: row.accessed_count,
    }));
}

/** 更新记忆访问计数 */
function updateAccessed(db: any, results: SearchResult[]) {
  if (results.length === 0) return;
  try {
    const stmt = db.prepare('UPDATE memory SET accessed_count = accessed_count + 1, last_accessed_at = ? WHERE id = ?');
    const now = new Date().toISOString();
    const tx = db.transaction((ids: string[]) => { for (const id of ids) stmt.run(now, id); });
    tx(results.map(r => r.id));
  } catch {}
}

/**
 * 快速获取近期重要记忆(用于请求前注入，<5ms)
 * 不做向量搜索，直接按时间+importance 捞
 */
export function getRecentMemories(characterId: string, limit: number = 5, hoursBack: number = 24, project?: string, memType?: MemType): SearchResult[] {
  const proj = normalizeProject(project);
  // memdir:memType 指定 → 单分类库;未指定 → 聚合项目全部分类库
  const dirs = memType ? [normalizeMemType(memType)] : listMemTypeDirs(proj);
  const all: SearchResult[] = [];
  const since = new Date(Date.now() - hoursBack * 3600000).toISOString();
  for (const mt of dirs) {
    try {
      const db = DatabaseManager.getInstance(proj, mt);
      const conds: string[] = ['is_active = 1', 'character_id = ?', 'project = ?', 'created_at > ?'];
      const params: any[] = [characterId, proj, since];
      if (memType) { conds.push('mem_type = ?'); params.push(memType); }
      params.push(limit);
      const rows = db.prepare(`
        SELECT id, text, project, type, mem_type, category, subcategory, tags,
               importance, character_id, source, subject, tier,
               created_at, last_accessed_at, accessed_count
        FROM memory
        WHERE ${conds.join(' AND ')}
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `).all(...params) as any[];
      all.push(...rows.map(row => ({
        id: row.id, text: row.text, project: row.project || 'default', type: row.type, memType: row.mem_type || 'general', category: row.category,
        subcategory: row.subcategory, tags: JSON.parse(row.tags || '[]'),
        importance: row.importance,
        characterId: row.character_id, source: row.source, subject: row.subject || 'user',
        tier: row.tier || 'standard',
        score: row.importance, similarity: 0,
        createdAt: row.created_at, lastAccessedAt: row.last_accessed_at,
        accessedCount: row.accessed_count,
      })));
    } catch { /* 单分类库失败不影响其他 */ }
  }
  all.sort((a, b) => (b.importance - a.importance) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return all.slice(0, limit);
}

// ═══════════════════════════════════════════════════════════════════
// Fact Search — 语义搜索三元组事实
// ═══════════════════════════════════════════════════════════════════

export interface FactSearchResult {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  similarity: number;
  sourceMemoryId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 语义搜索事实
 * 将查询文本做 embedding，在 vec_facts 中 KNN 搜索。
 */
export async function searchFacts(
  query: string,
  options: {
    project?: string;
    subject?: string;
    topK?: number;
    minConfidence?: number;
  } = {},
): Promise<FactSearchResult[]> {
  const db = DatabaseManager.getInstance(options.project);
  const topK = options.topK ?? 10;
  const minConfidence = options.minConfidence ?? 0.3;
  const proj = normalizeProject(options.project);

  if (!isEmbedEnabled()) {
    return []; // 纯本地模式:facts 无向量可查
  }

  const queryVector = await embed(query, options.project);
  const floatQuery = new Float32Array(queryVector);

  const knnLimit = Math.min(topK * 8, 60);

  let knnRows: any[];
  try {
    knnRows = db.prepare(`
      SELECT rowid, distance
      FROM vec_facts
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(floatQuery, knnLimit) as any[];
  } catch {
    return [];
  }

  if (knnRows.length === 0) return [];

  const rowidMap = new Map<number, number>();
  for (const r of knnRows) {
    rowidMap.set(Number(r.rowid), r.distance);
  }

  const conditions = ['f.is_active = 1', 'f.project = ?', `f.rowid IN (${knnRows.map(() => '?').join(',')})`];
  const params: any[] = [proj, ...knnRows.map(r => Number(r.rowid))];
  if (options.subject) { conditions.push('f.subject = ?'); params.push(options.subject); }

  const rows = db.prepare(`
    SELECT f.rowid, f.id, f.subject, f.predicate, f.object, f.confidence,
           f.source_memory_id, f.created_at, f.updated_at
    FROM facts f
    WHERE ${conditions.join(' AND ')}
    ORDER BY f.confidence DESC
  `).all(...params) as any[];

  const results: FactSearchResult[] = [];

  for (const row of rows) {
    const dist = rowidMap.get(row.rowid) ?? 1.0;
    const similarity = Math.max(0, 1.0 - dist);
    const confidence = row.confidence;

    if (confidence < minConfidence) continue;

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
      const tx = db.transaction((ids: string[]) => { for (const id of ids) update.run(now, id); });
      tx(results.map(r => r.id));
    } catch {}
  }

  return results;
}
