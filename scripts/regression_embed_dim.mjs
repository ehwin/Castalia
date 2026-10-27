#!/usr/bin/env node
/**
 * 回归:嵌入维度可配(v1.25)+ vec 表自动重建
 *
 * 覆盖目标(此前都是"改源码才能动"的死结):
 *   1. env EMBEDDING_DIM 决定 vec0 表维度(默认仍 1024,不配即旧行为)。
 *   2. bank 的 config.json 里 `embedding.dim` 经 configLoader 生效(端到端,菜单改的就是这个)。
 *   3. 维度变化时自动重建 vec_memory / vec_facts 并清空 embedding_cache,
 *      memory / facts 的正文与关系**不丢**(只重建索引,向量等下次嵌入时补)。
 *   4. 维度不变时不做无谓重建。
 *
 * 每个场景跑在独立子进程里,因为 vecDim() 在一个进程内缓存首次读到的值
 * (与真实运行一致:一个 server 进程一套库,换维度必须重启/换配置)。
 *
 * 用法:node scripts/regression_embed_dim.mjs [--keep]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DB_ENTRY = pathToFileURL(path.join(ROOT, 'dist', 'db.js')).href;
const LOADER_ENTRY = pathToFileURL(path.join(ROOT, 'dist', 'configLoader.js')).href;
const KEEP = process.argv.includes('--keep');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-dim-'));
const childPath = path.join(tmpRoot, 'child.mjs');
fs.writeFileSync(childPath, `
const dir = process.argv[2];
const dim = process.argv[3];
const seed = process.argv[4] === 'seed';
const dbEntry = process.argv[5];
const configPath = process.argv[6] || '';
const loaderEntry = process.argv[7] || '';
process.env.MEMORY_DB_DIR = dir;
process.env.EMBED_MODE = 'none';
process.env.CHAR_ID = 'airi';
if (dim) process.env.EMBEDDING_DIM = dim;
else delete process.env.EMBEDDING_DIM;
if (configPath) {
  process.env.MEMORY_CONFIG = configPath;
  delete process.env.EMBEDDING_DIM;   // 只让 config.json 提供维度
  await import(loaderEntry);
}
const m = await import(dbEntry);
const db = m.DatabaseManager.getInstance('proj', 'general');
if (seed) {
  const id = m.generateId();
  db.prepare('INSERT INTO memory (id, text, project, character_id) VALUES (?,?,?,?)').run(id, 'hello', 'proj', 'airi');
  const rowid = db.prepare('SELECT rowid FROM memory WHERE id = ?').get(id).rowid;
  db.prepare('INSERT INTO vec_memory (rowid, embedding) VALUES (?,?)').run(BigInt(rowid), new Float32Array(Number(dim || 1024)));
  db.prepare('INSERT INTO embedding_cache (text_hash, embedding) VALUES (?,?)').run('h1', new Float32Array(Number(dim || 1024)));
}
const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get('vec_memory') || {}).sql || '';
const m2 = /float\\[(\\d+)\\]/.exec(sql);
console.log(JSON.stringify({
  dim: m.vecDim(),
  tableDim: m2 ? Number(m2[1]) : 0,
  memory: db.prepare('SELECT COUNT(*) c FROM memory').get().c,
  vec: db.prepare('SELECT COUNT(*) c FROM vec_memory').get().c,
  cache: db.prepare('SELECT COUNT(*) c FROM embedding_cache').get().c,
}));
`);

/** 跑一个场景;返回 {json, stderr} */
function run(dim, { seed = false, configPath = '' } = {}) {
  const env = { ...process.env };
  delete env.EMBEDDING_DIM;
  delete env.VEC_DIM;
  delete env.MEMORY_CONFIG;
  if (dim) env.EMBEDDING_DIM = String(dim);
  const out = execFileSync(process.execPath, [
    childPath, tmpRoot, dim ? String(dim) : '', seed ? 'seed' : 'check', DB_ENTRY, configPath, LOADER_ENTRY,
  ], { encoding: 'utf8', env });
  return { json: JSON.parse(out.trim().split(/\r?\n/).pop()) };
}

console.log(`[embed-dim] 临时库: ${tmpRoot}`);

console.log('\n1) 新库 + EMBEDDING_DIM=4096');
const s1 = run(4096, { seed: true });
check('vecDim() = 4096', s1.json.dim === 4096, `got ${s1.json.dim}`);
check('vec0 表维度 = 4096', s1.json.tableDim === 4096, `got ${s1.json.tableDim}`);
check('种子行写入(1 memory / 1 vec / 1 cache)', s1.json.memory === 1 && s1.json.vec === 1 && s1.json.cache === 1, JSON.stringify(s1.json));

console.log('\n2) 同库改成 1024(模拟换嵌入模型)');
const s2 = run(1024);
check('vecDim() = 1024', s2.json.dim === 1024, `got ${s2.json.dim}`);
check('vec0 表重建为 1024', s2.json.tableDim === 1024, `got ${s2.json.tableDim}`);
check('memory 正文未丢(仍 1 行)', s2.json.memory === 1, `got ${s2.json.memory}`);
check('vec 索引清空待重嵌(0 行)', s2.json.vec === 0, `got ${s2.json.vec}`);
check('embedding_cache 清空', s2.json.cache === 0, `got ${s2.json.cache}`);

console.log('\n3) 维度不变再开一次(不该重建)');
const s3 = run(1024);
check('表维度仍 1024', s3.json.tableDim === 1024, `got ${s3.json.tableDim}`);
check('memory 仍 1 行', s3.json.memory === 1, `got ${s3.json.memory}`);

console.log('\n4) 不配 EMBEDDING_DIM(老行为:默认 1024)');
const s4 = run('');
check('vecDim() 默认 1024', s4.json.dim === 1024, `got ${s4.json.dim}`);
check('vec0 表 1024', s4.json.tableDim === 1024, `got ${s4.json.tableDim}`);

console.log('\n5) 再换到 2048(反方向也要能重建)');
const s5 = run(2048);
check('vec0 表 2048', s5.json.tableDim === 2048, `got ${s5.json.tableDim}`);
check('memory 仍 1 行', s5.json.memory === 1, `got ${s5.json.memory}`);

console.log('\n6) 端到端:库里 config.json 的 embedding.dim=3072 → 生效');
const cfgPath = path.join(tmpRoot, 'bank-config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ embedding: { mode: 'api', api_model: 'x', dim: 3072 }, reflect: {}, triage: {} }));
const s6 = run('', { configPath: cfgPath });
check('configLoader 把 dim 注入(vecDim()=3072)', s6.json.dim === 3072, `got ${s6.json.dim}`);
check('vec0 表 3072', s6.json.tableDim === 3072, `got ${s6.json.tableDim}`);
check('memory 仍 1 行', s6.json.memory === 1, `got ${s6.json.memory}`);

if (!KEEP) {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) {}
}
console.log(`\n[embed-dim] ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
