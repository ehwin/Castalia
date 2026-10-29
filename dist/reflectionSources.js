/** Original records and explicit processing progress, independent of summaries. */
import { DatabaseManager, listMemTypeDirs } from './db.js';
import { normalizeProject } from './env.js';
function ensureReflectionProgress(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS reflection_progress (
    conversation_id TEXT NOT NULL,
    processed_at TEXT NOT NULL,
    project TEXT NOT NULL,
    PRIMARY KEY (project, conversation_id)
  )`);
    const columns = db.prepare('PRAGMA table_info(reflection_progress)').all();
    if (!columns.some(column => column.name === 'project' && column.pk)) {
        db.transaction(() => {
            db.exec(`ALTER TABLE reflection_progress RENAME TO reflection_progress_legacy;
        CREATE TABLE reflection_progress (conversation_id TEXT NOT NULL, processed_at TEXT NOT NULL, project TEXT NOT NULL, PRIMARY KEY (project, conversation_id));
        INSERT INTO reflection_progress SELECT conversation_id, processed_at, project FROM reflection_progress_legacy;
        DROP TABLE reflection_progress_legacy;`);
        })();
    }
}
export function markConversationsReflected(ids, project) {
    if (!ids.length)
        return;
    const proj = normalizeProject(project);
    const now = new Date().toISOString();
    const db = DatabaseManager.getInstance(proj);
    ensureReflectionProgress(db);
    const stmt = db.prepare('INSERT OR REPLACE INTO reflection_progress (conversation_id, processed_at, project) VALUES (?, ?, ?)');
    db.transaction((values) => values.forEach(id => stmt.run(id, now, proj)))(ids);
}
export function deepReflectionCursor(project, nextId) {
    const db = DatabaseManager.getInstance(project);
    db.exec('CREATE TABLE IF NOT EXISTS reflection_scan (project TEXT PRIMARY KEY, last_id TEXT NOT NULL)');
    const proj = normalizeProject(project);
    if (nextId !== undefined)
        db.prepare('INSERT OR REPLACE INTO reflection_scan (project, last_id) VALUES (?, ?)').run(proj, nextId);
    return db.prepare('SELECT last_id FROM reflection_scan WHERE project = ?').get(proj)?.last_id || '';
}
export function getUnanalyzedConversations(characterId = 'airi', since, // 可选日期筛选，处理进度始终按来源 ID 记录
limit = 30, project) {
    const proj = normalizeProject(project);
    const dbs = listMemTypeDirs(proj).map(mt => DatabaseManager.getInstance(proj, mt));
    // A summary timestamp is not a processing cursor: a failed/partial run may still
    // create a summary and would permanently hide the remaining conversation log.
    const processed = new Set();
    try {
        const progressDb = DatabaseManager.getInstance(proj);
        for (const row of progressDb.prepare('SELECT conversation_id FROM reflection_progress WHERE project = ?').all(proj))
            processed.add(row.conversation_id);
    }
    catch { /* use the per-library fallback below */ }
    for (const db of dbs) {
        try {
            for (const row of db.prepare('SELECT conversation_id FROM reflection_progress WHERE project = ?').all(proj))
                processed.add(row.conversation_id);
        }
        catch { /* older databases are created lazily */ }
    }
    // conversation_log 是审计带，写入时 is_active=0；跨库汇总后再按时间排序并应用全局 limit。
    const all = [];
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
      `).all(proj, since || null, since || null));
        }
        catch { /* 单分类库失败不影响其它库 */ }
    }
    all.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
    const ids = new Set();
    for (const row of all) {
        if (ids.has(row.id))
            throw new Error(`Ambiguous conversation ID across memory types: ${row.id}`);
        ids.add(row.id);
    }
    return all.filter(row => !processed.has(row.id)).slice(0, limit).map(row => ({ id: row.id, text: row.text, createdAt: row.created_at }));
}
//# sourceMappingURL=reflectionSources.js.map