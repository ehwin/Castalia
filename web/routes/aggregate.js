/* routes/aggregate.js — /api/aggregate/* /api/manage/* */
import { Router } from 'express';
import {
  AGGREGATE_DIRS, libFiles, openLibDb, findLib, mcpCall,
} from './lib.js';

const router = Router();

// ═══ /api/aggregate/overview ═══
router.get('/aggregate/overview', (req, res) => {
  const libs = libFiles().map(l => {
    let db = null;
    try {
      db = openLibDb(l.file);
      if (!db) return { ...l, memories: 0, facts: 0, lastActivity: null, error: 'open_failed' };
      const mem = db.prepare('SELECT COUNT(*) c FROM memory WHERE is_active=1').get();
      const facts = db.prepare('SELECT COUNT(*) c FROM facts WHERE is_active=1').get();
      const last = db.prepare('SELECT MAX(created_at) m FROM memory').get();
      return { ...l, memories: mem.c, facts: facts.c, lastActivity: last.m };
    } catch (e) {
      return { ...l, memories: 0, facts: 0, lastActivity: null, error: String(e.message).slice(0, 100) };
    } finally { if (db) db.close(); }
  });
  const totals = libs.reduce((a, l) => ({ memories: a.memories + (l.memories || 0), facts: a.facts + (l.facts || 0) }), { memories: 0, facts: 0 });
  res.json({ ok: true, libraries: libs, totals });
});

// ═══ /api/aggregate/graph ═══
router.get('/aggregate/graph', (req, res) => {
  const instTotal = {};
  const projTotal = {};
  const links = [];
  for (const l of libFiles()) {
    let db = null;
    let count = 0;
    try {
      db = openLibDb(l.file);
      if (db) count = db.prepare('SELECT COUNT(*) c FROM memory WHERE is_active=1').get().c;
    } catch { count = 0; }
    finally { if (db) db.close(); }
    instTotal[l.instance] = (instTotal[l.instance] || 0) + count;
    projTotal[l.project] = (projTotal[l.project] || 0) + count;
    links.push({ source: `software:${l.instance}`, target: `library:${l.project}`, value: count });
  }
  const nodes = [
    ...AGGREGATE_DIRS.map(c => ({ id: `software:${c.name}`, group: 'software', label: c.name, value: instTotal[c.name] || 0 })),
    ...Object.keys(projTotal).sort().map(p => ({ id: `library:${p}`, group: 'library', label: p, value: projTotal[p] })),
  ];
  res.json({ ok: true, nodes, links });
});

// ═══ /api/aggregate/search ═══
router.get('/aggregate/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const topK = Math.min(50, parseInt(req.query.topK || '10', 10) || 10);
  if (!q) return res.json({ ok: false, error: 'q 必填' });
  const terms = q.split(/[\s,，。！？、；：]+/).filter(t => t.length >= 2);
  const hits = [];
  for (const l of libFiles()) {
    let db = null;
    try {
      db = openLibDb(l.file);
      if (!db) continue;
      let rows;
      if (terms.length === 0) {
        rows = db.prepare('SELECT id, text, created_at FROM memory WHERE is_active=1 ORDER BY created_at DESC LIMIT ?').all(topK);
      } else {
        const conds = terms.map(() => 'text LIKE ?').join(' OR ');
        rows = db.prepare(`SELECT id, text, created_at FROM memory WHERE is_active=1 AND (${conds}) ORDER BY created_at DESC LIMIT ?`).all(...terms.map(t => `%${t}%`), topK);
      }
      for (const r of rows) {
        const hit = terms.filter(t => String(r.text).includes(t)).length;
        hits.push({
          instance: l.instance, project: l.project, id: r.id,
          text: String(r.text).length > 200 ? String(r.text).slice(0, 200) + '…' : String(r.text),
          score: terms.length ? Math.round(hit / terms.length * 1000) / 1000 : 0.1,
          createdAt: r.created_at,
        });
      }
    } catch {} finally { if (db) db.close(); }
  }
  hits.sort((a, b) => b.score - a.score || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json({ ok: true, query: q, count: hits.length, results: hits.slice(0, topK * 4) });
});

// ═══ /api/aggregate/recent ═══
router.get('/aggregate/recent', (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit || '30', 10) || 30);
  const rows = [];
  for (const l of libFiles()) {
    let db = null;
    try {
      db = openLibDb(l.file);
      if (!db) continue;
      const rs = db.prepare('SELECT id, text, mem_type, created_at FROM memory WHERE is_active=1 ORDER BY created_at DESC LIMIT ?').all(limit);
      for (const r of rs) rows.push({ instance: l.instance, project: l.project, id: r.id, text: String(r.text).slice(0, 150), memType: r.mem_type, createdAt: r.created_at });
    } catch {} finally { if (db) db.close(); }
  }
  rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json({ ok: true, count: rows.length, results: rows.slice(0, limit) });
});

// ═══ POST /api/aggregate/projects ═══
router.post('/aggregate/projects', async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.json({ ok: false, error: 'name 必填' });
  try {
    const r = await mcpCall('project_create', { name });
    const text = (r.content || []).map(c => c.text || '').join('');
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { ok: false, error: text.slice(0, 200) }; }
    res.json(parsed);
  } catch (e) {
    res.json({ ok: false, error: '建库失败: ' + e.message });
  }
});

// ═══ /api/manage/libraries ═══
router.get('/manage/libraries', (req, res) => {
  const libs = libFiles().map(l => {
    let db = null;
    try {
      db = openLibDb(l.file);
      if (!db) return { project: l.project, instance: l.instance, file: l.file, active: 0, total: 0, error: 'open_failed' };
      const active = db.prepare('SELECT COUNT(*) c FROM memory WHERE is_active=1').get().c;
      const total = db.prepare('SELECT COUNT(*) c FROM memory').get().c;
      return { project: l.project, instance: l.instance, file: l.file, active, total };
    } catch (e) {
      return { project: l.project, instance: l.instance, file: l.file, active: 0, total: 0, error: String(e.message).slice(0, 100) };
    } finally { if (db) { try { db.close(); } catch {} } }
  });
  res.json({ ok: true, libraries: libs });
});

// ═══ /api/manage/memories ═══
router.get('/manage/memories', (req, res) => {
  const instance = String(req.query.instance || '');
  const project = String(req.query.project || '');
  const q = String(req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 2000);
  const lib = findLib(instance, project);
  if (!lib) return res.json({ ok: false, error: '库不存在(instance/project 未匹配)', memories: [] });
  let db = null;
  try {
    db = openLibDb(lib.file);
    if (!db) return res.json({ ok: false, error: 'open_failed', memories: [] });
    const base = `SELECT id, substr(text,1,600) AS text, length(text) AS textLen, type, mem_type, category, tier, importance, source, created_at, updated_at FROM memory`;
    let rows;
    if (q) {
      const like = `%${q}%`;
      rows = db.prepare(`${base} WHERE is_active=1 AND (text LIKE ? OR mem_type LIKE ? OR category LIKE ? OR type LIKE ?) ORDER BY created_at DESC LIMIT ?`)
        .all(like, like, like, like, limit);
    } else {
      rows = db.prepare(`${base} WHERE is_active=1 ORDER BY created_at DESC LIMIT ?`).all(limit);
    }
    db.close();
    res.json({
      ok: true, count: rows.length,
      memories: rows.map(r => ({
        id: r.id,
        text: String(r.text || ''),
        textTruncated: (r.textLen || 0) > 600,
        type: r.type,
        memType: r.mem_type || 'general',
        category: r.category,
        tier: r.tier || 'standard',
        importance: r.importance,
        source: r.source,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (e) {
    if (db) { try { db.close(); } catch {} }
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

// ═══ POST /api/manage/memory/update ═══
router.post('/manage/memory/update', (req, res) => {
  try {
    const { instance, project, id, memType, category, tier, importance } = req.body || {};
    if (!id) return res.json({ ok: false, error: 'id 必填' });
    const lib = findLib(String(instance || ''), String(project || ''));
    if (!lib) return res.json({ ok: false, error: '库不存在' });
    const db = openLibDb(lib.file, false);
    if (!db) return res.json({ ok: false, error: 'open_failed' });
    const sets = [], vals = [];
    if (memType !== undefined && memType !== null) { sets.push('mem_type = ?'); vals.push(String(memType)); }
    if (category !== undefined && category !== null) { sets.push('category = ?'); vals.push(String(category)); }
    if (tier !== undefined && tier !== null) { sets.push('tier = ?'); vals.push(String(tier)); }
    if (importance !== undefined && importance !== null) { sets.push('importance = ?'); vals.push(Number(importance)); }
    if (sets.length === 0) { db.close(); return res.json({ ok: false, error: '无可更新字段' }); }
    sets.push('updated_at = ?'); vals.push(new Date().toISOString());
    vals.push(id);
    const r = db.prepare(`UPDATE memory SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    db.close();
    res.json({ ok: true, updated: r.changes > 0, id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

// ═══ POST /api/manage/memory/delete ═══
router.post('/manage/memory/delete', (req, res) => {
  try {
    const { instance, project, id } = req.body || {};
    if (!id) return res.json({ ok: false, error: 'id 必填' });
    const lib = findLib(String(instance || ''), String(project || ''));
    if (!lib) return res.json({ ok: false, error: '库不存在' });
    const db = openLibDb(lib.file, false);
    if (!db) return res.json({ ok: false, error: 'open_failed' });
    const r = db.prepare('UPDATE memory SET is_active = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    try { db.prepare('DELETE FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').run(id); } catch {}
    db.close();
    res.json({ ok: true, deleted: r.changes > 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

export default router;
