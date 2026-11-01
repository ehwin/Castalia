#!/usr/bin/env node
/**
 * 端到端：标准版的检索 → injectGate 裁决 → 指标。
 *
 * 与 inject_gate_eval.mjs 的区别：那里的候选是论文那次检索给的（只测裁决器）；
 * 这里候选由标准版自己检索出来，因此同时暴露两件事：
 *   1. 标准版检索给出的候选里有多少能被标注覆盖（覆盖不到的不进指标）；
 *   2. 检索 + 裁决串联后的真实精确率/召回。
 *
 * 用法：node scripts/eval/std_gate_shadow.mjs --bank <airi 副本父目录> --pairs ... --ann ... \
 *        --floor 0.15 --out <结果.json>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const arg = (k, d = '') => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))), '..', '..');

const BANK = path.resolve(arg('bank'));
const PAIRS = path.resolve(arg('pairs'));
const ANN = path.resolve(arg('ann'));
const OUT = path.resolve(arg('out', 'std_gate_shadow.json'));
const FLOOR = parseFloat(arg('floor', '0.15'));
const CONC = Math.max(1, parseInt(arg('concurrency', '5'), 10));

// 1) 检索臂（独立库副本）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'std-shadow-'));
fs.cpSync(BANK, tmp, { recursive: true });
const armRun = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'eval', 'std_gate_arm.mjs'),
  '--bank', tmp, '--pairs', PAIRS, '--project', arg('project', 'airi'), '--floor', String(FLOOR), '--topk', '3'],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 文件锁 */ }
if (armRun.status !== 0) { console.error('检索臂失败:', armRun.stderr?.slice(0, 400)); process.exit(1); }
const arm = JSON.parse(armRun.stdout);

// 2) 裁决
await import(pathToFileURL(path.join(ROOT, 'dist', 'configLoader.js')).href);
const { adjudicateInjection } = await import(pathToFileURL(path.join(ROOT, 'dist', 'injectGate.js')).href);

const data = JSON.parse(fs.readFileSync(PAIRS, 'utf8'));
const byId = new Map(data.items.map(it => [it.id, it]));
const texts = new Map();   // "item|cand" -> text
for (const it of data.items) for (const c of it.candidates) texts.set(it.id + '|' + c.id, c.text);

function readJsonl(p) {
  const m = new Map();
  if (!fs.existsSync(p)) return m;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.label) m.set(r.item_id + '|' + r.cand_id, r.label); } catch { /* 坏行 */ }
  }
  return m;
}
const A = readJsonl(path.join(ANN, 'PA_A_v5.jsonl'));
const B = readJsonl(path.join(ANN, 'PA_B_v5.jsonl'));
const label = new Map();
for (const [k, a] of A) if (B.get(k) === a) label.set(k, a);

const decisions = new Map();
let cursor = 0, done = 0;
const items = arm.items.filter(it => it.cands.some(c => c.id));

async function one(it) {
  const cands = it.cands.filter(c => c.id).map(c => ({ id: c.id, text: texts.get(it.id + '|' + c.id) || '', similarity: c.sim }));
  const r = await adjudicateInjection({ query: byId.get(it.id)?.text || '', context: byId.get(it.id)?.context, candidates: cands, mode: 'on' });
  for (const v of r.verdicts) decisions.set(it.id + '|' + v.id, v.label);
  if (++done % 25 === 0) process.stderr.write(`  …${done}/${items.length}\n`);
}

await Promise.all(Array.from({ length: CONC }, async () => {
  while (cursor < items.length) { const it = items[cursor++]; try { await one(it); } catch { /* 单条失败不中断 */ } }
}));

function score(sel) {
  const keys = sel.filter(k => label.has(k));
  const inj = keys.filter(k => decisions.get(k) === 'A');
  const need = keys.filter(k => label.get(k) === 'A');
  const tp = need.filter(k => decisions.get(k) === 'A').length;
  const p = inj.length ? 100 * tp / inj.length : null;
  const r = need.length ? 100 * tp / need.length : null;
  return { pairs: keys.length, needed: need.length, injected: inj.length, tp,
    precision: p?.toFixed(1) ?? null, recall: r?.toFixed(1) ?? null,
    f1: p && r ? (2 * p * r / (p + r)).toFixed(1) : null };
}

const all = arm.items.filter(it => it.cands.some(c => c.id));
const allKeys = all.flatMap(it => it.cands.filter(c => c.id).map(c => it.id + '|' + c.id));
const byCell = {};
for (const cell of [...new Set(all.map(i => i.cell))]) {
  byCell[cell] = score(allKeys.filter(k => all.find(i => i.id === k.split('|')[0])?.cell === cell));
}

const result = {
  _meta: { at: new Date().toISOString(), floor: FLOOR, queries: items.length,
    retrievedCandidates: allKeys.length, labelledCandidates: allKeys.filter(k => label.has(k)).length,
    mode: 'std retrieval → per-query batch adjudication' },
  before: score(allKeys),          // 检索直接注入（无裁决）
  after: score(allKeys),           // 占位，下面覆盖
  byCell,
};
// before：检索结果全部算注入
{
  const keys = allKeys.filter(k => label.has(k));
  const need = keys.filter(k => label.get(k) === 'A');
  const tp = need.length;
  const p = keys.length ? 100 * tp / keys.length : null;
  const r = need.length ? 100 * tp / need.length : null;
  result.before = { pairs: keys.length, needed: need.length, injected: keys.length, tp,
    precision: p?.toFixed(1) ?? null, recall: r?.toFixed(1) ?? null, f1: p && r ? (2 * p * r / (p + r)).toFixed(1) : null };
}
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
