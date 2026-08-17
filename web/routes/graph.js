/* routes/graph.js — /api/graph /api/stats /api/status */
import { Router } from 'express';
import { existsSync } from 'fs';
import { DB_DIR, DB_PATH, LEGACY_DB_PATH, CONFIG_PATH, loadConfig, openLibDb, libFiles, currentInstanceLibs, dbDirHasData } from './lib.js';

const router = Router();

/* D1:边强度(server 侧计算,不改引擎 schema)
 *  - similarity 直接用向量余弦相似度
 *  - 关系边按类型给语义默认强度(引擎 edges 表尚无 strength 列) */
const EDGE_TYPE_STRENGTH = {
  part_of: 0.9, same_event: 0.85, causes: 0.7, caused_by: 0.7,
  leads_to: 0.65, sequence: 0.6, context: 0.5, same_subject: 0.5,
  related_to: 0.4, follows: 0.4,
};
function edgeStrength(type, similarity) {
  if (type === 'similarity') return similarity != null ? similarity : 0.7;
  return EDGE_TYPE_STRENGTH[type] != null ? EDGE_TYPE_STRENGTH[type] : 0.5;
}

// ═══ API: GET /api/graph ═══
router.get('/graph', (req, res) => {
  const libs = libFiles();
  const nodes = [];
  const links = [];
  let totalMemories = 0;
  const categoryColors = {
    emotional: '#FF6B6B', milestone: '#FFA726', identity: '#66BB6A',
    relationship: '#42A5F5', mood_snapshot: '#FFD54F', conversation: '#AB47BC',
    knowledge: '#26A69A', preference: '#EC407A', decision: '#FFA726',
    mistake: '#EF5350', general: '#78909C',
  };
  for (const lib of libs) {
    let db = null;
    try {
      db = openLibDb(lib.file);
      if (!db) continue;
      const memories = db.prepare(`
        SELECT id, text, project, type, mem_type, category, subcategory, tags,
               importance, character_id, source,
               subject, tier, expires_at, created_at, accessed_count
        FROM memory WHERE is_active = 1 ORDER BY created_at ASC
      `).all();
      totalMemories += memories.length;

      let edges = [];
      try { edges = db.prepare('SELECT source_id, target_id, relation_type FROM edges').all(); } catch {}

      const libNodes = memories.map(m => {
        let tags = [];
        try { tags = JSON.parse(m.tags || '[]'); } catch {}
        const isTemporary = m.tier === 'temporary';
        const isCritical = m.tier === 'critical';
        return {
          id: `${lib.project}:${m.id}`,
          rawId: m.id,
          lib: lib.project,
          label: m.text.length > 60 ? m.text.slice(0, 60) + '...' : m.text,
          fullText: m.text,
          project: m.project || lib.project,
          type: m.type, memType: m.mem_type || 'general', category: m.category, subcategory: m.subcategory,
          tags, importance: m.importance,
          source: m.source, subject: m.subject, tier: m.tier || 'standard',
          expiresAt: m.expires_at, createdAt: m.created_at, accessedCount: m.accessed_count,
          starred: (m.importance || 0.5) >= 0.9,
          valence: isCritical ? (m.importance * 12 + 5) : isTemporary ? (m.importance * 5 + 2) : (m.importance * 8 + 3),
          color: categoryColors[m.category] || '#90A4AE',
          isTemporary, isCritical,
        };
      });

      const idSet = new Set(libNodes.map(n => n.id));
      for (const e of edges) {
        const s = `${lib.project}:${e.source_id}`, t = `${lib.project}:${e.target_id}`;
        if (idSet.has(s) && idSet.has(t)) {
          links.push({ source: s, target: t, type: e.relation_type, strength: edgeStrength(e.relation_type) });
        }
      }

      // 库内相似度链接(该库 <=100 节点时)
      if (libNodes.length > 0 && libNodes.length <= 100) {
        try {
          const vecRows = db.prepare(`
            SELECT m.id, v.embedding FROM memory m
            JOIN vec_memory v ON m.rowid = v.rowid WHERE m.is_active = 1
          `).all();
          const embeddings = vecRows.map(r => ({
            id: `${lib.project}:${r.id}`,
            vec: Array.from(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)),
          }));
          const cosSim = (a, b) => {
            let dot = 0, ma = 0, mb = 0;
            for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
            return dot / (Math.sqrt(ma) * Math.sqrt(mb));
          };
          const SIM_THRESHOLD = 0.65;
          const existing = new Set(links.map(l => `${l.source}|${l.target}`));
          for (let i = 0; i < embeddings.length; i++) {
            const sims = [];
            for (let j = 0; j < embeddings.length; j++) {
              if (i === j) continue;
              sims.push({ id: embeddings[j].id, sim: cosSim(embeddings[i].vec, embeddings[j].vec) });
            }
            sims.sort((a, b) => b.sim - a.sim);
            for (const s of sims.slice(0, 2)) {
              if (s.sim < SIM_THRESHOLD) break;
              const k1 = `${embeddings[i].id}|${s.id}`, k2 = `${s.id}|${embeddings[i].id}`;
              if (!existing.has(k1) && !existing.has(k2)) {
                links.push({ source: embeddings[i].id, target: s.id, type: 'similarity', similarity: Math.round(s.sim * 100) / 100, strength: edgeStrength('similarity', Math.round(s.sim * 100) / 100) });
                existing.add(k1);
              }
            }
          }
        } catch (e) { console.error('Similarity links failed:', e.message); }
      }

      nodes.push(...libNodes);
    } catch (e) { console.error(`graph lib ${lib.file} failed:`, e.message); }
    finally { if (db) db.close(); }
  }

  const stats = { totalNodes: nodes.length, totalLinks: links.length, byType: {}, byCategory: {}, byTier: {}, byMemType: {} };
  for (const n of nodes) {
    stats.byType[n.type] = (stats.byType[n.type] || 0) + 1;
    stats.byCategory[n.category] = (stats.byCategory[n.category] || 0) + 1;
    stats.byTier[n.tier] = (stats.byTier[n.tier] || 0) + 1;
    stats.byMemType[n.memType] = (stats.byMemType[n.memType] || 0) + 1;
  }
  res.json({ nodes, links, stats });
});

// ═══ API: GET /api/stats ═══
router.get('/stats', (req, res) => {
  const libs = currentInstanceLibs();
  if (!libs.length) return res.json({ total: 0, edges: 0 });
  let total = 0, edges = 0;
  for (const l of libs) {
    try {
      const db = openLibDb(l.file);
      if (!db) continue;
      total += db.prepare('SELECT COUNT(*) as c FROM memory WHERE is_active=1').get().c;
      try { edges += db.prepare('SELECT COUNT(*) as c FROM edges').get().c; } catch {}
      db.close();
    } catch (err) { console.error(`stats lib ${l.file} failed:`, err.message); }
  }
  res.json({ total, edges });
});

// ═══ API: GET /api/status ═══
router.get('/status', (req, res) => {
  const cfg = loadConfig();
  const dbPath = DB_PATH;
  res.json({
    db: LEGACY_DB_PATH ? DB_PATH : DB_DIR,
    dbPath,
    config: CONFIG_PATH,
    dbExists: existsSync(dbPath) || dbDirHasData(DB_DIR),
    embedMode: cfg.embedding?.mode || 'ollama',
    reflectConfigured: !!(cfg.reflect?.api_key),
  });
});

export default router;
