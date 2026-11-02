#!/usr/bin/env node
/**
 * tuning-support.json 契约测试（标准版 · 面板变体）。
 *
 * 断言：
 *  1. 清单里每个键都真的被引擎读（改 env → 打分/下限跟着变）；
 *  2. 清单 default 与不设 env 时的代码常量一致；
 *  3. 清单不含情感侧键（WEIGHT_EMOTION / WEIGHT_DEVIATION / PSYCHE_* / MEMORY_INJECT_*）——
 *     标准版没有这些量，面板应据此隐藏。
 *
 * 用法：node scripts/test_tuning_surface.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tuning-support.json'), 'utf8'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tuning-surface-std-'));
process.env.MEMORY_DB_DIR = TMP;
process.env.MEMORY_CONFIG = path.join(TMP, 'missing.json');
process.env.EMBED_MODE = 'none';
process.env.CASTALIA_PROJECT = 'tuning-surface';

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok    ' + name); }
  catch (e) { failures.push(name + ': ' + e.message); console.log('  FAIL  ' + name + ' — ' + e.message); }
};

let bust = 0;
async function loadFresh(file, env = {}) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  return import(pathToFileURL(path.join(DIST, file)).href + `?t=${++bust}`);
}

const row = {
  id: 'tune-row',
  text: '测试行',
  project: 'tuning-surface',
  character_id: 'default',
  tags: '[]',
  importance: 0.5,
  tier: 'standard',
  accessed_count: 0,
  created_at: new Date(Date.now() - 100 * 3600 * 1000).toISOString(),
  last_accessed_at: new Date(Date.now() - 100 * 3600 * 1000).toISOString(),
};

const keys = Object.values(manifest.groups).flat().map(s => s.key);

// ── 1. 两个权重：同一条记忆、不同权重 → 分数必须变 ─────────────────────
for (const key of ['WEIGHT_CONSISTENCY', 'WEIGHT_TIME']) {
  check(`清单含 ${key}`, () => assert.ok(keys.includes(key)));
  const a = await loadFresh('search.js', { [key]: 0 });
  const b = await loadFresh('search.js', { [key]: 2 });
  const sa = a.computeScore(0.6, { ...row });
  const sb = b.computeScore(0.6, { ...row });
  check(`${key}: 0 → ${sa} vs 2 → ${sb}（分数必须不同）`, () => assert.notEqual(sa, sb));
}

// ── 2. 检索下限：默认值与设置值都要读出来 ─────────────────────────────
{
  const spec = manifest.groups.search.find(s => s.key === 'SEARCH_MIN_SCORE');
  check('清单含 SEARCH_MIN_SCORE', () => assert.ok(spec));
  const off = await loadFresh('search.js', { SEARCH_MIN_SCORE: undefined });
  check(`SEARCH_MIN_SCORE 未设 env 时取默认 ${spec.default}`, () => {
    assert.equal(Number(off.profileMinScore('balanced').toFixed(4)), Number(Number(spec.default).toFixed(4)));
  });
  const on = await loadFresh('search.js', { SEARCH_MIN_SCORE: 0.42 });
  check('SEARCH_MIN_SCORE 设 0.42 后 balanced 档下限跟着变', () => {
    assert.equal(Number(on.profileMinScore('balanced').toFixed(4)), 0.42);
  });
}

// ── 3. 标准版没有的量不能出现在清单里 ─────────────────────────────────
check('清单不含 WEIGHT_EMOTION / WEIGHT_DEVIATION', () => {
  assert.deepEqual(keys.filter(k => k === 'WEIGHT_EMOTION' || k === 'WEIGHT_DEVIATION'), []);
});
check('清单不含 PSYCHE_* / ANIMA_*', () => {
  assert.deepEqual(keys.filter(k => k.startsWith('PSYCHE_') || k.startsWith('ANIMA_')), []);
});
check('清单不含 MEMORY_INJECT_*（标准版无注入门槛）', () => {
  assert.deepEqual(keys.filter(k => k.startsWith('MEMORY_INJECT_')), []);
});
check('清单键总数 = 3', () => assert.equal(keys.length, 3));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n[tuning-surface-std] ${pass} 通过 / ${failures.length} 失败`);
if (failures.length) { for (const f of failures) console.error(' - ' + f); process.exit(1); }
