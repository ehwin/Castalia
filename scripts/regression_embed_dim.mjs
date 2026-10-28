#!/usr/bin/env node
/**
 * 回归:嵌入维度可配(v1.25)+ vec 表重建,以及**两条安全规则**(2026-10-27 P2-2 / v1.28-fix)
 *
 * 覆盖目标:
 *   1. env EMBEDDING_DIM 决定 vec0 表维度(默认 1024)。
 *   2. bank 的 config.json 里 `embedding.dim` 经 configLoader 生效(端到端,菜单改的就是这个)。
 *   3. 维度变化 + 嵌入可用时,自动重建 vec_memory / vec_facts 并清空 embedding_cache,
 *      memory / facts 的正文与关系**不丢**。
 *   4. 【安全规则 A / P2-2】EMBED_MODE=none 时**拒绝**重建 —— 清了也没法重嵌,
 *      只会把可用索引变成空索引,与 ensureEmbedSpace 的 none 语义自相矛盾。
 *   5. 【安全规则 B / v1.28-fix 移植自 Lite 修 E2】目标维度只是**内置默认值**(既无 env
 *      也无 config.json 的 embedding.dim)时,绝不因它与库内不同就销毁索引,而沿用库内维度。
 *      起因:控制台把注入的默认 dim=1024 写回 config.json,曾让 4096 维库被静默降维 +
 *      DROP 索引 + 清空 embedding_cache。
 *
 * 每个场景跑在独立子进程里,因为 vecDim() 在一个进程内缓存首次读到的值
 * (与真实运行一致:一个 server 进程一套库,换维度必须重启/换配置)。
 *
 * 重建后 vec 表是**被 DROP 掉的**(落到下次开库重建),所以断言写"旧维度已消失",
 * 下一次开库才断言"新维度的表已建好";表不存在时计数返回 -1。
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
process.env.EMBED_MODE = process.env.EMBED_MODE || 'none';   // 父进程给 api 才会走重建分支
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
const count = (t) => { try { return db.prepare('SELECT COUNT(*) c FROM ' + t).get().c; } catch (_e) { return -1; } };
// L2→余弦换算(sqlite-vec vec0 默认 L2 距离,代码按 1-d 当余弦用过 —— v1.28.7 修)
const sm = await import(dbEntry.replace(/db\.js$/, 'search.js'));
console.log(JSON.stringify({
  dim: m.vecDim(),
  tableDim: m2 ? Number(m2[1]) : 0,
  memory: count('memory'),
  vec: count('vec_memory'),
  cache: count('embedding_cache'),
  cos_hit: sm.l2ToCosine(0.6683),
  cos_same: sm.l2ToCosine(0),
  cos_orth: sm.l2ToCosine(Math.SQRT2),
  cos_far: sm.l2ToCosine(2),
}));
`);

/** 跑一个场景;mode='api' 表示嵌入可用(指向必然拒绝的本地端口,不产生外网流量) */
function run(dim, { seed = false, configPath = '', mode = 'none' } = {}) {
  const env = { ...process.env };
  delete env.EMBEDDING_DIM;
  delete env.VEC_DIM;
  delete env.MEMORY_CONFIG;
  env.EMBED_MODE = mode;
  if (mode !== 'none') {
    env.OLLAMA_URL = 'http://127.0.0.1:1';
    env.EMBEDDING_API_KEY = 'regression-only';
  }
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
// L2→余弦换算:单位向量下 d²=2-2cos ⟹ cos=1-d²/2。旧算法 1-d 会把真实命中(d=0.6683,
// 真实余弦 0.7767)算成 0.33 → 低于注入门槛 0.5,向量召回全被丢弃。
check('l2ToCosine(同向量 0)=1', Math.abs(s1.json.cos_same - 1) < 1e-9, `got ${s1.json.cos_same}`);
check('l2ToCosine(0.6683)≈0.7767', Math.abs(s1.json.cos_hit - 0.7767) < 0.002, `got ${s1.json.cos_hit}`);
check('l2ToCosine(√2)=0(正交)', Math.abs(s1.json.cos_orth) < 1e-9, `got ${s1.json.cos_orth}`);
check('l2ToCosine(2)=0(不出现负数)', s1.json.cos_far === 0, `got ${s1.json.cos_far}`);
check('vec0 表维度 = 4096', s1.json.tableDim === 4096, `got ${s1.json.tableDim}`);
check('种子行写入(1 memory / 1 vec / 1 cache)', s1.json.memory === 1 && s1.json.vec === 1 && s1.json.cache === 1, JSON.stringify(s1.json));

console.log('\n2) 安全规则 B:不配维度 → 沿用库内 4096,不销毁索引');
const s2 = run('');
check('vecDim() 沿用库内 4096', s2.json.dim === 4096, `got ${s2.json.dim}`);
check('vec0 表仍 4096(没被内置默认 1024 降维)', s2.json.tableDim === 4096, `got ${s2.json.tableDim}`);
check('vec 索引仍在(1 行)', s2.json.vec === 1, `got ${s2.json.vec}`);
check('embedding_cache 仍在(1 行)', s2.json.cache === 1, `got ${s2.json.cache}`);
check('memory 仍在(1 行)', s2.json.memory === 1, `got ${s2.json.memory}`);

console.log('\n3) 安全规则 A:EMBED_MODE=none 时改成 1024 → 拒绝重建,保住可用索引');
const s3 = run(1024, { mode: 'none' });
check('vecDim() = 1024(配置读到了)', s3.json.dim === 1024, `got ${s3.json.dim}`);
check('vec0 表没被重建(仍 4096)', s3.json.tableDim === 4096, `got ${s3.json.tableDim}`);
check('vec 索引未被清空(1 行)', s3.json.vec === 1, `got ${s3.json.vec}`);
check('embedding_cache 未被清空(1 行)', s3.json.cache === 1, `got ${s3.json.cache}`);
check('memory 仍在(1 行)', s3.json.memory === 1, `got ${s3.json.memory}`);

console.log('\n4) 嵌入可用(EMBED_MODE=api)+ 改成 1024 → 真的重建');
const s4 = run(1024, { mode: 'api' });
check('vecDim() = 1024', s4.json.dim === 1024, `got ${s4.json.dim}`);
check('旧 4096 索引已消失(表被 DROP,等重开)', s4.json.tableDim !== 4096, `got ${s4.json.tableDim}`);
check('embedding_cache 已清空(0 行)', s4.json.cache === 0, `got ${s4.json.cache}`);
check('memory 正文未丢(仍 1 行)', s4.json.memory === 1, `got ${s4.json.memory}`);

console.log('\n5) 重开(同维度):表按新维度建好,不再重建');
const s5 = run(1024, { mode: 'api' });
check('vec0 表 1024', s5.json.tableDim === 1024, `got ${s5.json.tableDim}`);
check('memory 仍 1 行', s5.json.memory === 1, `got ${s5.json.memory}`);

console.log('\n6) 再换到 2048(反方向也要能重建)');
const s6 = run(2048, { mode: 'api' });
check('旧 1024 索引已消失', s6.json.tableDim !== 1024, `got ${s6.json.tableDim}`);
check('memory 仍 1 行', s6.json.memory === 1, `got ${s6.json.memory}`);
const s6b = run(2048, { mode: 'api' });
check('重开后 vec0 表 2048', s6b.json.tableDim === 2048, `got ${s6b.json.tableDim}`);

console.log('\n7) 端到端:库里 config.json 的 embedding.dim=3072 → 生效');
const cfgPath = path.join(tmpRoot, 'bank-config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ embedding: { mode: 'api', api_model: 'x', dim: 3072 }, reflect: {}, triage: {} }));
const s7 = run('', { configPath: cfgPath, mode: 'api' });
check('configLoader 把 dim 注入(vecDim()=3072)', s7.json.dim === 3072, `got ${s7.json.dim}`);
check('旧 2048 索引已消失', s7.json.tableDim !== 2048, `got ${s7.json.tableDim}`);
check('memory 仍 1 行', s7.json.memory === 1, `got ${s7.json.memory}`);
const s7b = run('', { configPath: cfgPath, mode: 'api' });
check('重开后 vec0 表 3072', s7b.json.tableDim === 3072, `got ${s7b.json.tableDim}`);

if (!KEEP) {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) {}
}
console.log(`\n[embed-dim] ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
