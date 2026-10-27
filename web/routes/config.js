/* routes/config.js — /api/config GET/POST */
import { Router } from 'express';
import { loadConfig, saveConfig, rawConfig, effectiveVecDim, CONFIG_PATH } from './lib.js';

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
    // 2026-10-27 修复(P2-1,复核提出):维度要在服务端校验。负数/超大/非数字会被
    // 引擎当成"显式维度"(vecDimIsExplicit 只看 env 是否非空)再静默降到 1024 并清缓存,
    // 把 4096 维库变成 float[1024]。前端只有一个裸 input,不该指望它兜住。
    const dimIn = req.body?.embedding?.dim;
    if (dimIn != null && dimIn !== '') {
      const n = Number(dimIn);
      if (!Number.isInteger(n) || n < 1 || n > 65536) {
        res.status(400).json({ error: `embedding.dim 必须是 1..65536 的整数(收到 ${JSON.stringify(dimIn)})` });
        return;
      }
    }
    const cur = loadConfig();
    const next = { ...cur, ...req.body };
    if (next.embedding?.api_key === '****') next.embedding.api_key = cur.embedding?.api_key || '';
    if (next.reflect?.api_key === '****') next.reflect.api_key = cur.reflect?.api_key || '';
    if (next.triage?.api_key === '****') next.triage.api_key = cur.triage?.api_key || '';
    // 2026-10-27 修复(E2):embedding.dim 只在"文件里本来就显式写过"或"用户本次确实改了"时才落盘。
    // GET 会把生效维度物化进返回体(env 优先),UI 原样回传;照单全收就会把默认/环境派生值
    // 写成显式配置,随后引擎据此 DROP vec 表 + 清空 embedding_cache —— 4096 维库被静默降维清空。
    if (next.embedding && next.embedding.dim != null) {
      const storedExplicit = !!(rawConfig()?.embedding
        && Object.prototype.hasOwnProperty.call(rawConfig().embedding, 'dim'));
      const incoming = parseInt(next.embedding.dim, 10);
      if (!storedExplicit && incoming === effectiveVecDim()) delete next.embedding.dim;
    }
    saveConfig(next);
    res.json({ ok: true, path: CONFIG_PATH, note: '已保存。若 MCP server 正在运行,重启后配置生效' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
