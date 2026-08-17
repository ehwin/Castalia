/* routes/memory.js — /api/memory CRUD /move /toggle_important /update */
import { Router } from 'express';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import {
  openDb, openLibDb, openDbByProject, currentInstanceLibs, findLib, resolveSourceFile,
  ensureLibSchema, libFilePath,
} from './lib.js';

const router = Router();

function safeTags(raw) {
  try { const p = JSON.parse(raw || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
}

// ═══ GET /api/memory:聚合当前实例全部分类库,按时间倒序 ═══
router.get('/memory', (req, res) => {
  const libs = currentInstanceLibs();
  if (!libs.length) return res.json([]);
  try {
    const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);
    const q = req.query.q ? `%${req.query.q}%` : null;
    const rows = [];
    for (const l of libs) {
      try {
        const db = openLibDb(l.file);
        if (!db) continue;
        const rs = q
          ? db.prepare(`SELECT * FROM memory WHERE is_active=1 AND text LIKE ? ORDER BY created_at DESC LIMIT ?`).all(q, limit)
          : db.prepare('SELECT * FROM memory WHERE is_active=1 ORDER BY created_at DESC LIMIT ?').all(limit);
        db.close();
        for (const r of rs) rows.push({ ...r, memType: l.memType || 'general', project: l.project, tags: safeTags(r.tags) });
      } catch (e) { console.error(`memory lib ${l.file} failed:`, e.message); }
    }
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    res.json(rows.slice(0, limit));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ POST /api/memory/delete ═══
router.post('/memory/delete', (req, res) => {
  const db = openDbByProject(req.body.project, false, req.body.id);
  if (!db) return res.json({ deleted: false });
  try {
    const r = db.prepare('UPDATE memory SET is_active = 0 WHERE id = ?').run(req.body.id);
    try { db.prepare('DELETE FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').run(req.body.id); } catch {}
    db.close();
    res.json({ deleted: r.changes > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ POST /api/memory/toggle_important ═══
router.post('/memory/toggle_important', (req, res) => {
  try {
    const id = req.body && req.body.id;
    if (!id) return res.json({ ok: false, error: 'id 必填' });
    const db = openDbByProject(req.body.project, false, req.body.id);
    if (!db) return res.json({ ok: false, error: 'db not found' });
    const row = db.prepare('SELECT importance FROM memory WHERE id = ?').get(id);
    if (!row) { db.close(); return res.json({ ok: false, error: 'memory not found' }); }
    const starred = (row.importance || 0) < 0.9;
    const nextImportance = starred ? 1.0 : 0.5;
    db.prepare('UPDATE memory SET importance = ?, updated_at = ? WHERE id = ?').run(nextImportance, new Date().toISOString(), id);
    db.close();
    res.json({ ok: true, id, importance: nextImportance, starred });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ POST /api/memory/update ═══
router.post('/memory/update', (req, res) => {
  try {
    const { id, fields } = req.body;
    const allowed = ['text', 'category', 'tags', 'importance', 'tier'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (fields[k] !== undefined) {
        sets.push(`${k === 'tags' ? 'tags' : k} = ?`);
        vals.push(k === 'tags' ? JSON.stringify(fields[k]) : fields[k]);
      }
    }
    if (sets.length === 0) return res.json({ updated: false });
    sets.push('updated_at = ?');
    vals.push(new Date().toISOString());
    vals.push(id);
    const db = openDbByProject(req.body.project, false, req.body.id);
    if (!db) return res.json({ updated: false });
    const r = db.prepare(`UPDATE memory SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    db.close();
    res.json({ updated: r.changes > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ POST /api/memory/move:跨库移动记忆 ═══
router.post('/memory/move', (req, res) => {
  try {
    const body = req.body || {};
    const ids = Array.isArray(body.ids) ? body.ids.map(x => String(x)) : null;
    const toProject = String(body.toProject || '').trim();
    if (!ids || ids.length === 0) return res.json({ ok: false, error: 'ids 必填(非空数组)', moved: 0, failed: [] });
    if (!toProject) return res.json({ ok: false, error: 'toProject 必填', moved: 0, failed: [] });
    const fromProject = body.fromProject ? String(body.fromProject).trim() : '';
    const fromInstance = body.fromInstance ? String(body.fromInstance).trim() : '';

    const moved = [];
    const failed = [];
    const skipped = [];

    for (const id of ids) {
      if (!id) { failed.push({ id, error: 'empty id' }); continue; }
      let srcDb = null, dstDb = null;
      try {
        const srcFile = resolveSourceFile(id, fromInstance, fromProject);
        if (!srcFile) { failed.push({ id, error: 'not found in any library' }); continue; }

        srcDb = openLibDb(srcFile, false);
        if (!srcDb) { failed.push({ id, error: 'open source failed' }); continue; }

        const srcMem = srcDb.prepare('SELECT rowid, * FROM memory WHERE id = ?').get(id);
        if (!srcMem) { failed.push({ id, error: 'source row missing' }); continue; }

        const targetFile = libFilePath(toProject, srcMem.mem_type);
        if (srcFile === targetFile) { skipped.push({ id, error: 'same library (toProject == fromProject)' }); continue; }

        if (!existsSync(targetFile)) {
          mkdirSync(dirname(targetFile), { recursive: true });
          dstDb = new Database(targetFile);
          try { sqliteVec.load(dstDb); } catch {}
          ensureLibSchema(dstDb);
        } else {
          dstDb = openLibDb(targetFile, false);
          if (!dstDb) dstDb = new Database(targetFile);
        }

        if (dstDb.prepare('SELECT 1 FROM memory WHERE id = ?').get(id)) { skipped.push({ id, error: 'already exists in target' }); continue; }

        let vecBuf = null;
        try {
          const vr = srcDb.prepare('SELECT embedding FROM vec_memory WHERE rowid = ?').get(BigInt(srcMem.rowid));
          if (vr && vr.embedding) vecBuf = vr.embedding;
        } catch {}

        const COLS = ['id','text','project','session_id','type','mem_type','category','subcategory','tags','importance','character_id','source','subject','tier','expires_at','is_active','created_at','updated_at','last_accessed_at','accessed_count','reference_count','locked'];
        const vals = COLS.map(c => c === 'project' ? toProject : (srcMem[c] === undefined ? null : srcMem[c]));
        const insertTx = dstDb.transaction(() => {
          const info = dstDb.prepare(`INSERT INTO memory (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`).run(...vals);
          if (vecBuf) dstDb.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?, ?)').run(BigInt(info.lastInsertRowid), vecBuf);
        });
        insertTx();

        const delTx = srcDb.transaction(() => {
          try { srcDb.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(BigInt(srcMem.rowid)); } catch {}
          try { srcDb.prepare('DELETE FROM edges WHERE source_id = ? OR target_id = ?').run(id, id); } catch {}
          srcDb.prepare('DELETE FROM memory WHERE id = ?').run(id);
        });
        delTx();

        moved.push({ id, fromProject: srcMem.project ?? null, toProject });
      } catch (e) {
        failed.push({ id, error: String(e.message).slice(0, 200) });
      } finally {
        if (srcDb) { try { srcDb.close(); } catch {} }
        if (dstDb) { try { dstDb.close(); } catch {} }
      }
    }

    res.json({ ok: true, moved: moved.length, skipped: skipped.length, movedIds: moved, failed, skipped });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message), moved: 0, failed: [] });
  }
});

export default router;
