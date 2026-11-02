#!/usr/bin/env node
/**
 * 对级评测：标准版的检索门槛在论文同一批 880 共识对上的读数。
 *
 * 每个臂跑一份独立库副本（检索会写 accessed_count，共用副本会污染后续臂）。
 * 指标口径对齐论文 33_pairs_analysis_v5.cjs：只统计两标注器一致的对，
 * 注入 = 该候选出现在检索结果里，NEED = label "A"。
 *
 * 用法：node scripts/eval/std_gate_eval.mjs \
 *          --bank <MEMORY_DB_DIR 指向的 airi 副本父目录> \
 *          --pairs <pairs_v5_gate.json> --ann <标注目录> \
 *          --floors 0,0.15 --out <结果.json>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const arg = (k, d = '') => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const BANK = path.resolve(arg('bank'));
const PAIRS = path.resolve(arg('pairs'));
const ANN = path.resolve(arg('ann'));
const OUT = path.resolve(arg('out', 'std_gate_eval.json'));
const FLOORS = arg('floors', '0,0.15').split(',').map(Number);
const TOPK = arg('topk', '3');
const PROJECT = arg('project', 'airi');

const HERE = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
const ARM = path.join(HERE, 'std_gate_arm.mjs');

// ── 标注：两标注器一致才计入（与论文同一口径）
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

const labelled = new Map();   // "item|cand" -> {cell, label}
for (const [k, a] of A) {
  const b = B.get(k);
  if (b && b.label === a.label) labelled.set(k, { cell: a.cell, label: a.label });
}

const pairsData = JSON.parse(fs.readFileSync(PAIRS, 'utf8'));
const cellOf = new Map();
for (const it of pairsData.items) for (const c of it.candidates) cellOf.set(it.id + '|' + c.id, it.cell);

const arms = [];
for (const floor of FLOORS) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `std-arm-${floor}-`));
  fs.cpSync(BANK, tmp, { recursive: true });
  const r = spawnSync(process.execPath, [ARM, '--bank', tmp, '--pairs', PAIRS, '--project', PROJECT,
    '--floor', String(floor), '--topk', TOPK], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 文件锁 */ }
  if (r.status !== 0) { console.error(`arm floor=${floor} 失败:`, r.stderr?.slice(0, 400)); process.exit(1); }
  arms.push(JSON.parse(r.stdout));
}

function metrics(arm) {
  const injected = new Set();
  let fired = 0;
  for (const it of arm.items) {
    if (it.cands.some(c => c.id)) fired++;
    for (const c of it.cands) if (c.id) { const k = it.id + '|' + c.id; if (labelled.has(k)) injected.add(k); }
  }
  const all = [...labelled.entries()];
  const need = all.filter(([, v]) => v.label === 'A').map(([k]) => k);
  const tp = need.filter(k => injected.has(k)).length;
  const precision = injected.size ? 100 * tp / injected.size : null;
  const recall = need.length ? 100 * tp / need.length : null;
  const f1 = precision != null && recall != null && (precision + recall) > 0
    ? 2 * precision * recall / (precision + recall) : null;

  const byCell = {};
  for (const cell of ['C1_present', 'C2_absent', 'C3_C4_nonreferential']) {
    const inj = [...injected].filter(k => (labelled.get(k)?.cell || cellOf.get(k)) === cell);
    const ned = need.filter(k => (labelled.get(k)?.cell || cellOf.get(k)) === cell);
    const t = inj.filter(k => labelled.get(k).label === 'A').length;
    byCell[cell] = {
      injected: inj.length, need: ned.length, tp: t,
      precision: inj.length ? +(100 * t / inj.length).toFixed(1) : null,
    };
  }
  return {
    firedQueries: fired, queries: arm.items.length,
    pairs: labelled.size, need: need.length, injected: injected.size, tp,
    precision: precision?.toFixed(1) ?? null, recall: recall?.toFixed(1) ?? null, f1: f1?.toFixed(1) ?? null,
    byCell,
  };
}

const result = {
  _meta: {
    at: new Date().toISOString(),
    bank: BANK, pairs: PAIRS, ann: ANN,
    floors: FLOORS, topK: +TOPK,
    labelledPairs: labelled.size, needPairs: [...labelled.values()].filter(v => v.label === 'A').length,
    note: '只统计两标注器一致的对；注入=候选出现在检索结果里；标准版无 per-type floors/证据门',
  },
  arms: arms.map(a => ({ floor: a.floor, ...metrics(a) })),
};
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
