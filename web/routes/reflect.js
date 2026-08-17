/* routes/reflect.js — /api/reflect/run /api/reflect/history */
import { Router } from 'express';
import { mcpCall, appendReflectHistory, readReflectHistory, historyEntry } from './lib.js';

const router = Router();

// ═══ POST /api/reflect/run ═══
router.post('/reflect/run', async (req, res) => {
  const mode = req.body.mode;
  if (mode === 'all' || mode === 'project') {
    return handleReflectAll(req, res);
  }
  const toolName = mode === 'deep' ? 'reflect_deep' : 'reflect_auto';
  const limit = parseInt(req.body.limit || (toolName === 'reflect_deep' ? '500' : '30'), 10);
  try {
    const result = await mcpCall(toolName, { limit });
    const text = result?.content?.[0]?.text || '{}';
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    res.json(parsed);
  } catch (e) {
    res.status(502).json({ error: '反思调用失败: ' + e.message });
  }
});

// ═══ GET /api/reflect/history ═══
router.get('/reflect/history', (req, res) => {
  const limit = parseInt(req.query.limit || '20', 10);
  res.json({ ok: true, history: readReflectHistory(limit) });
});

/** 跨库总反思:mode='all' / mode='project' → reflect_all → 追加历史 */
async function handleReflectAll(req, res) {
  const body = req.body || {};
  const mode = body.mode === 'project' ? 'project' : 'all';
  const dryRun = body.dryRun === true;
  const projects = Array.isArray(body.projects)
    ? body.projects.map(x => String(x)).filter(Boolean)
    : (body.projects ? [String(body.projects)] : []);
  if (mode === 'project' && projects.length === 0) {
    return res.status(400).json({ ok: false, mode, dryRun, error: 'mode=project 时必须提供 projects 库名(如 ["hermes"])' });
  }

  const args = { dryRun };
  if (mode === 'project') args.projects = projects;
  if (Number.isFinite(Number(body.maxTotal)) && Number(body.maxTotal) > 0) args.maxTotal = Number(body.maxTotal);
  if (Number.isFinite(Number(body.maxPerLib)) && Number(body.maxPerLib) > 0) args.maxPerLib = Number(body.maxPerLib);

  const base = {
    ok: false, mode, dryRun,
    scanned: { libraries: 0, memories: 0 },
    llm: { insights: 0, skipped: 0, saved: 0 },
    errors: [], insightList: [],
  };

  try {
    const result = await mcpCall('reflect_all', args, 300000);
    const text = (result?.content || []).map(c => c.text || '').join('');
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object') {
      base.errors = ['reflect_all 返回无法解析的结果: ' + text.slice(0, 300)];
      appendReflectHistory(historyEntry(base, projects));
      return res.status(502).json(base);
    }

    const out = {
      ok: parsed.ok === true,
      mode, dryRun,
      scanned: parsed.scanned || { libraries: 0, memories: 0 },
      llm: parsed.llm || { insights: 0, skipped: 0, saved: 0 },
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      insightList: Array.isArray(parsed.insightList) ? parsed.insightList : [],
    };
    if (!out.ok && parsed.error?.message) out.errors = [parsed.error.message, ...out.errors];
    if (!out.ok && out.errors.length === 0) out.errors = ['reflect_all 执行失败(无详细错误)'];

    appendReflectHistory(historyEntry(out, projects));
    res.json(out);
  } catch (e) {
    base.errors = ['反思调用失败: ' + e.message];
    appendReflectHistory(historyEntry(base, projects));
    res.status(502).json(base);
  }
}

export default router;
