#!/usr/bin/env node
/**
 * 对级裁决评测：在同一批论文对上跑 injectGate，与论文的部署门 / 裁决基准对比。
 *
 * 用法：
 *   node scripts/eval/inject_gate_eval.mjs --pairs <pairs_v5_gate.json> --ann <标注目录> \
 *        --out <结果.json> [--cells C1_present] [--concurrency 4] [--model deepseek-v4-flash]
 *
 * 注意口径：
 *   - 输入候选是论文那次检索给的（不是标准版自己检索的），所以这里测的是**裁决器本身**；
 *   - 标准版把裁决接到检索上是另一件事（候选集不同），不能拿这里的数字当端到端成绩；
 *   - 本模块按查询批量判，论文的对照是逐对调用 —— 差异在结果里标出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const arg = (k, d = '') => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const PAIRS = path.resolve(arg('pairs'));
const ANN = path.resolve(arg('ann'));
const OUT = path.resolve(arg('out', 'inject_gate_eval.json'));
const CELLS = arg('cells', '').split(',').map(s => s.trim()).filter(Boolean);
const CONC = Math.max(1, parseInt(arg('concurrency', '4'), 10));
const MODEL = arg('model', '');

const ROOT = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))), '..', '..');

// config.json → 环境变量（含密钥）；没有配置文件时按环境变量走
await import(pathToFileURL(path.join(ROOT, 'dist', 'configLoader.js')).href);
if (MODEL) process.env.REFLECT_LLM_MODEL = MODEL;
if (!process.env.REFLECT_LLM_API_KEY) {
  const cfg = process.env.MEMORY_CONFIG || path.join(process.cwd(), 'memory', 'config.json');
  if (fs.existsSync(cfg)) {
    const c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    if (c?.reflect?.api_key) process.env.REFLECT_LLM_API_KEY = c.reflect.api_key;
    if (c?.reflect?.llm_url) process.env.REFLECT_LLM_URL = c.reflect.llm_url;
    if (c?.reflect?.model) process.env.REFLECT_LLM_MODEL = MODEL || c.reflect.model;
  }
}

const { adjudicateInjection } = await import(pathToFileURL(path.join(ROOT, 'dist', 'injectGate.js')).href);

function readJsonl(p) {
  const m = new Map();
  if (!fs.existsSync(p)) return m;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.label) m.set(r.item_id + '|' + r.cand_id, r); } catch { /* 坏行跳过 */ }
  }
  return m;
}
const A = readJsonl(path.join(ANN, 'PA_A_v5.jsonl'));
const B = readJsonl(path.join(ANN, 'PA_B_v5.jsonl'));
const labelled = new Map();
for (const [k, a] of A) {
  const b = B.get(k);
  if (b && b.label === a.label) labelled.set(k, a.label);
}

const data = JSON.parse(fs.readFileSync(PAIRS, 'utf8'));
const items = data.items.filter(it => it.candidates.length > 0 && (!CELLS.length || CELLS.includes(it.cell)));

const decisions = new Map();   // "item|cand" -> label
const errors = [];
let done = 0;

async function runItem(it) {
  const r = await adjudicateInjection({
    query: it.text,
    context: it.context,
    candidates: it.candidates.map(c => ({ id: c.id, text: c.text, similarity: c.sim })),
    mode: 'on',
  });
  for (const v of r.verdicts) decisions.set(it.id + '|' + v.id, v.label);
  if (r.errors.length) errors.push({ item: it.id, errors: r.errors.slice(0, 2) });
  done++;
  if (done % 20 === 0) process.stderr.write(`  …${done}/${items.length}\n`);
}

let cursor = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (cursor < items.length) {
    const it = items[cursor++];
    try { await runItem(it); } catch (e) { errors.push({ item: it.id, errors: [String(e.message || e).slice(0, 120)] }); }
  }
}));

const keys = [...labelled.keys()].filter(k => items.some(it => it.id === k.split('|')[0]));
const injected = keys.filter(k => decisions.get(k) === 'A');
const need = keys.filter(k => labelled.get(k) === 'A');
const tp = need.filter(k => decisions.get(k) === 'A').length;
const precision = injected.length ? 100 * tp / injected.length : null;
const recall = need.length ? 100 * tp / need.length : null;
const f1 = precision && recall ? 2 * precision * recall / (precision + recall) : null;

const byCell = {};
for (const cell of [...new Set(items.map(i => i.cell))]) {
  const ks = keys.filter(k => items.find(i => i.id === k.split('|')[0])?.cell === cell);
  const inj = ks.filter(k => decisions.get(k) === 'A');
  const ned = ks.filter(k => labelled.get(k) === 'A');
  const t = ned.filter(k => decisions.get(k) === 'A').length;
  byCell[cell] = {
    pairs: ks.length, need: ned.length, injected: inj.length, tp: t,
    precision: inj.length ? +(100 * t / inj.length).toFixed(1) : null,
    recall: ned.length ? +(100 * t / ned.length).toFixed(1) : null,
  };
}

const result = {
  _meta: {
    at: new Date().toISOString(), pairs: PAIRS, cells: CELLS.length ? CELLS : 'all',
    queries: items.length, labelledPairs: keys.length, need: need.length,
    model: process.env.REFLECT_LLM_MODEL || '(unset)',
    mode: 'per-query batch adjudication (论文对照是逐对调用)',
    llmErrors: errors.length,
  },
  metrics: {
    injected: injected.length, tp,
    precision: precision?.toFixed(1) ?? null,
    recall: recall?.toFixed(1) ?? null,
    f1: f1?.toFixed(1) ?? null,
    byCell,
  },
  errors: errors.slice(0, 20),
  decisions: [...decisions.entries()].map(([k, label]) => { const [item, cand] = k.split('|'); return { item, cand, label }; }),
};
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
console.log(JSON.stringify({ metrics: result.metrics, meta: result._meta, errors: result.errors.slice(0, 5) }, null, 1));
