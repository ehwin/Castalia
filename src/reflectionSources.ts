/** Original records and explicit processing progress, independent of summaries. */
import { DatabaseManager, listMemTypeDirs } from './db.js';
import { normalizeProject } from './env.js';

function ensureReflectionProgress(db: any): void {
  db.exec(`CREATE TABLE IF NOT EXISTS reflection_progress (
    conversation_id TEXT NOT NULL,
    processed_at TEXT NOT NULL,
    project TEXT NOT NULL,
    PRIMARY KEY (project, conversation_id)
  )`);
  const columns = db.prepare('PRAGMA table_info(reflection_progress)').all() as any[];
  if (!columns.some(column => column.name === 'project' && column.pk)) {
    db.transaction(() => {
      db.exec(`ALTER TABLE reflection_progress RENAME TO reflection_progress_legacy;
        CREATE TABLE reflection_progress (conversation_id TEXT NOT NULL, processed_at TEXT NOT NULL, project TEXT NOT NULL, PRIMARY KEY (project, conversation_id));
        INSERT INTO reflection_progress SELECT conversation_id, processed_at, project FROM reflection_progress_legacy;
        DROP TABLE reflection_progress_legacy;`);
    })();
  }
}

export function markConversationsReflected(ids: string[], project?: string): void {
  if (!ids.length) return;
  const proj = normalizeProject(project);
  const now = new Date().toISOString();
  const db = DatabaseManager.getInstance(proj);
  ensureReflectionProgress(db);
  const stmt = db.prepare('INSERT OR REPLACE INTO reflection_progress (conversation_id, processed_at, project) VALUES (?, ?, ?)');
  db.transaction((values: string[]) => values.forEach(id => stmt.run(id, now, proj)))(ids);
}

export function deepReflectionCursor(project?: string, nextId?: string): string {
  const db = DatabaseManager.getInstance(project);
  db.exec('CREATE TABLE IF NOT EXISTS reflection_scan (project TEXT PRIMARY KEY, last_id TEXT NOT NULL)');
  const proj = normalizeProject(project);
  if (nextId !== undefined) db.prepare('INSERT OR REPLACE INTO reflection_scan (project, last_id) VALUES (?, ?)').run(proj, nextId);
  return (db.prepare('SELECT last_id FROM reflection_scan WHERE project = ?').get(proj) as any)?.last_id || '';
}

export function getUnanalyzedConversations(
  characterId: string = 'airi',
  since?: string,  // 可选日期筛选，处理进度始终按来源 ID 记录
  limit: number = 30,
  project?: string,  // v1.5: 项目隔离
): { id: string; text: string; createdAt: string }[] {
  const proj = normalizeProject(project);
  const dbs = listMemTypeDirs(proj).map(mt => DatabaseManager.getInstance(proj, mt));

  // A summary timestamp is not a processing cursor: a failed/partial run may still
  // create a summary and would permanently hide the remaining conversation log.
  const processed = new Set<string>();
  try {
    const progressDb = DatabaseManager.getInstance(proj);
    for (const row of progressDb.prepare('SELECT conversation_id FROM reflection_progress WHERE project = ?').all(proj) as any[]) processed.add(row.conversation_id);
  } catch { /* use the per-library fallback below */ }
  for (const db of dbs) {
    try {
      for (const row of db.prepare('SELECT conversation_id FROM reflection_progress WHERE project = ?').all(proj) as any[]) processed.add(row.conversation_id);
    } catch { /* older databases are created lazily */ }
  }

  // conversation_log 是审计带，写入时 is_active=0；跨库汇总后再按时间排序并应用全局 limit。
  const all: any[] = [];
  for (const db of dbs) {
    try {
      all.push(...db.prepare(`
        SELECT id, text, created_at
        FROM memory
        WHERE is_active = 0
          AND source = 'conversation_log'
          AND project = ?
          AND (? IS NULL OR created_at > ?)
        ORDER BY created_at ASC
      `).all(proj, since || null, since || null) as any[]);
    } catch { /* 单分类库失败不影响其它库 */ }
  }
  all.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
  const ids = new Set<string>();
  for (const row of all) {
    if (ids.has(row.id)) throw new Error(`Ambiguous conversation ID across memory types: ${row.id}`);
    ids.add(row.id);
  }
  return all.filter(row => !processed.has(row.id)).slice(0, limit).map(row => ({ id: row.id, text: row.text, createdAt: row.created_at }));
}

/**
 * v1.27 反射输入扫描 —— 按 (created_at, memType, rowid) 全局有序推进。
 *
 * 为什么要换掉原来的 `deepReflectionCursor`（id 字符串比较）：
 *   1. id 是随机串，`m.id > cursor` 与时间顺序无关，轮转会出现"永远轮不到"和"反复轮同一批"；
 *   2. id 比较无法表达"这一条我处理到哪了"，进程中断后只能整批重来；
 *   3. 派生叙述（reflect_summary / reflect_insight）必须排除在输入之外，
 *      否则模型读自己写的摘要再写摘要，就是报告里说的自我强化。
 *
 * rowid 只在单库内可比，所以跨 memType 扫描时用 memType 作为次级键。
 */
export interface ReflectionScanRow {
  id: string;
  text: string;
  createdAt: string;
  rowid: number;
  memType: string;
  type: string;
  category: string;
  tags: string;
  importance: number;
  source: string | null;
  tier: string;
  locked: number;
}

export function listMemoriesForReflection(opts: {
  project?: string;
  after?: { createdAt: string; rowid: number; tag?: string } | null;
  limit?: number;
}): ReflectionScanRow[] {
  const proj = normalizeProject(opts.project);
  const limit = Math.max(1, opts.limit ?? 200);
  const after = opts.after ?? null;
  const out: ReflectionScanRow[] = [];
  for (const mt of listMemTypeDirs(proj)) {
    let db: any;
    try { db = DatabaseManager.getInstance(proj, mt); } catch { continue; }
    const conds = [
      'is_active = 1',
      'project = ?',
      "COALESCE(status, '') NOT IN ('cold', 'superseded')",
      'derived = 0',
    ];
    const params: any[] = [proj];
    if (after) {
      // (created_at, memType, rowid) 严格大于游标
      conds.push('(created_at > ? OR (created_at = ? AND (? > ? OR (? = ? AND rowid > ?))))');
      params.push(after.createdAt, after.createdAt, mt, after.tag ?? '', mt, after.tag ?? '', after.rowid);
    }
    try {
      const rows = db.prepare(`
        SELECT rowid, id, text, type, mem_type, category, tags, importance, source, tier,
               locked, created_at
        FROM memory
        WHERE ${conds.join(' AND ')}
        ORDER BY created_at ASC, rowid ASC
        LIMIT ?
      `).all(...params, limit) as any[];
      for (const r of rows) {
        out.push({
          id: String(r.id), text: String(r.text ?? ''), createdAt: String(r.created_at),
          rowid: Number(r.rowid), memType: mt, type: String(r.type || 'episodic'),
          category: String(r.category || 'general'), tags: String(r.tags || '[]'),
          importance: Number(r.importance ?? 0.5), source: r.source ?? null,
          tier: String(r.tier || 'standard'), locked: Number(r.locked || 0),
        });
      }
    } catch { /* 单分类库失败不影响其它库 */ }
  }
  out.sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.memType.localeCompare(b.memType) || a.rowid - b.rowid);
  return out.slice(0, limit);
}

