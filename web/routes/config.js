/* routes/config.js — /api/config GET/POST */
import { Router } from 'express';
import { loadConfig, saveConfig, CONFIG_PATH } from './lib.js';

const router = Router();

router.get('/config', (req, res) => {
  const cfg = loadConfig();
  const safe = JSON.parse(JSON.stringify(cfg));
  if (safe.embedding?.api_key) safe.embedding.api_key = safe.embedding.api_key ? '****' : '';
  if (safe.reflect?.api_key) safe.reflect.api_key = safe.reflect.api_key ? '****' : '';
  if (safe.triage?.api_key) safe.triage.api_key = safe.triage.api_key ? '****' : '';
  res.json(safe);
});

router.post('/config', (req, res) => {
  try {
    const cur = loadConfig();
    const next = { ...cur, ...req.body };
    if (next.embedding?.api_key === '****') next.embedding.api_key = cur.embedding?.api_key || '';
    if (next.reflect?.api_key === '****') next.reflect.api_key = cur.reflect?.api_key || '';
    if (next.triage?.api_key === '****') next.triage.api_key = cur.triage?.api_key || '';
    saveConfig(next);
    res.json({ ok: true, path: CONFIG_PATH, note: '已保存。若 MCP server 正在运行,重启后配置生效' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
