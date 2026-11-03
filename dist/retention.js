import { DatabaseManager, listAllProjects } from './db.js';
import { listMemTypeDirs } from './db.js';
import { normalizeProject } from './env.js';
import { debugCatch } from './log.js';
import crypto from 'node:crypto';
function ensureTombstone(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_tombstone (
    id TEXT PRIMARY KEY,
    project TEXT,
    mem_type TEXT,
    source TEXT,
    content_hash TEXT,
    chars INTEGER,
    created_at TEXT,
    reaped_at TEXT NOT NULL,
    reason TEXT
  )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tombstone_reaped ON memory_tombstone(reaped_at)');
}
/** 收集"被引用"的 id：edges 端点 + facts 出处 + 活跃行的合并链 */
function collectReferenced(db) {
    const refs = new Set();
    const add = (v) => { if (typeof v === 'string' && v)
        refs.add(v); };
    try {
        for (const r of db.prepare('SELECT source_id, target_id FROM edges').all()) {
            add(r.source_id);
            add(r.target_id);
        }
    }
    catch (e) {
        debugCatch('retention:edges', e);
    }
    try {
        for (const r of db.prepare('SELECT source_memory_id FROM facts WHERE source_memory_id IS NOT NULL').all()) {
            add(r.source_memory_id);
        }
    }
    catch (e) {
        debugCatch('retention:facts', e);
    }
    try {
        for (const r of db.prepare(`SELECT merged_into, parent_id, merged_from FROM memory WHERE is_active = 1`).all()) {
            add(r.merged_into);
            add(r.parent_id);
            if (r.merged_from) {
                try {
                    const arr = JSON.parse(String(r.merged_from));
                    if (Array.isArray(arr))
                        arr.forEach(add);
                }
                catch { /* 非 JSON 就忽略 */ }
            }
        }
    }
    catch (e) {
        debugCatch('retention:merged', e);
    }
    return refs;
}
function reapOneLibrary(db, project, memType, opts) {
    const stat = { project, memType, scanned: 0, candidates: 0, reaped: 0, keptReferenced: 0, bytes: 0 };
    const cutoffMs = Date.now() - opts.olderThanDays * 24 * 3600 * 1000;
    let rows = [];
    try {
        rows = db.prepare(`
      SELECT rowid, id, text, source, created_at FROM memory
      WHERE is_active = 0 AND project = ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(project, opts.maxPerLibrary);
    }
    catch (e) {
        debugCatch('retention:select', e);
        return stat;
    }
    stat.scanned = rows.length;
    if (!rows.length)
        return stat;
    const refs = collectReferenced(db);
    const picked = [];
    for (const r of rows) {
        const ts = Date.parse(r.created_at || '');
        if (!Number.isFinite(ts) || ts > cutoffMs)
            continue; // 龄期不够或时间戳坏 → 不碰
        if (refs.has(r.id)) {
            stat.keptReferenced++;
            continue;
        }
        picked.push(r);
    }
    stat.candidates = picked.length;
    if (!picked.length || opts.dryRun) {
        stat.bytes = picked.reduce((n, r) => n + String(r.text || '').length, 0);
        return stat;
    }
    ensureTombstone(db);
    const nowIso = new Date().toISOString();
    const insTomb = db.prepare(`INSERT OR REPLACE INTO memory_tombstone
    (id, project, mem_type, source, content_hash, chars, created_at, reaped_at, reason)
    VALUES (?,?,?,?,?,?,?,?,'expired-inactive')`);
    const delVec = (() => { try {
        return db.prepare('DELETE FROM vec_memory WHERE rowid = ?');
    }
    catch {
        return null;
    } })();
    const delRow = db.prepare('DELETE FROM memory WHERE id = ?');
    const tx = db.transaction((items) => {
        for (const r of items) {
            const text = String(r.text || '');
            const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
            insTomb.run(r.id, project, memType, r.source ?? null, hash, text.length, r.created_at ?? null, nowIso);
            try {
                delVec?.run(r.rowid);
            }
            catch (e) {
                debugCatch('retention:vec', e);
            }
            delRow.run(r.id); // memory_fts 由 AFTER DELETE 触发器同步
            stat.reaped++;
            stat.bytes += text.length;
        }
    });
    try {
        tx(picked);
    }
    catch (e) {
        debugCatch('retention:tx', e);
    }
    return stat;
}
/** 清理一批库里的过期死行 */
export function reapDeadRows(opts = {}) {
    const dryRun = opts.dryRun !== false; // 默认 dry-run：必须显式关掉才真删
    const olderThanDays = Number.isFinite(Number(opts.olderThanDays)) ? Math.max(1, Number(opts.olderThanDays)) : 30;
    const maxPerLibrary = Number.isFinite(Number(opts.maxPerLibrary)) ? Math.max(1, Number(opts.maxPerLibrary)) : 20000;
    const projects = opts.project ? [normalizeProject(opts.project)] : listAllProjects();
    const result = { dryRun, olderThanDays, totalReaped: 0, totalBytes: 0, libraries: [], errors: [] };
    for (const proj of projects) {
        for (const mt of listMemTypeDirs(proj)) {
            try {
                const db = DatabaseManager.getInstance(proj, mt);
                const stat = reapOneLibrary(db, proj, mt, { olderThanDays, dryRun, maxPerLibrary });
                if (stat.scanned || stat.candidates)
                    result.libraries.push(stat);
                result.totalReaped += stat.reaped;
                result.totalBytes += stat.bytes;
            }
            catch (e) {
                result.errors.push(`[${proj}/${mt}] ${e?.message ?? e}`);
            }
        }
    }
    return result;
}
