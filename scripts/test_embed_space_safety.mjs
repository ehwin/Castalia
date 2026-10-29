/**
 * 嵌入空间安全规则回归(2026-10-29)
 *
 * 事故背景:宿主 cwd 下没有 memory/config.json、只给了 MEMORY_DB_DIR 时,引擎整份 bank
 * 配置被静默忽略 → 嵌入模型回落到内置默认 yuan-embedding-2.0-zh → ensureEmbedSpace
 * 判定"空间变化"→ 清空 vec_memory/embedding_cache → 重嵌全部 fetch failed。
 * 实测后果:hermes 库 817 条记忆的向量被清成 0。四条规则要钉住:
 *
 *   R1 configLoader 必须能从 MEMORY_DB_DIR/config.json 读到 bank 配置(显式 MEMORY_CONFIG 优先)
 *   R2 模型**未显式配置**时,库内模型优先,绝不清向量索引(与 reconcileVecDim 的 E2 同构)
 *   R3 显式换模型时仍然清空重嵌(该规则不能被 R2 破坏)
 *   R4 EMBED_MODE=api 但拿不到 key(清空后无法重嵌)时不清
 *
 * 判据:破坏性分支一定会打 `[db] 嵌入空间变化: … 清空向量索引与嵌入缓存`;
 * 断言"这行有没有出现"比数向量行更稳(不必造 1024 维向量)。
 *
 * 用法:../run/Castalia/bin/CastaliaNode.exe scripts/test_embed_space_safety.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const SELF = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const WIPE = '清空向量索引与嵌入缓存';
const TEST_KEY = 'test-key-not-used';

/** 子进程:按给定 env 打开一次库,打印一行 CHILD {...} */
if (process.argv[2] === '--child') {
  const dir = process.argv[3];
  process.env.MEMORY_DB_DIR = dir;      // 唯一的"这进程用哪个库"声明
  delete process.env.MEMORY_CONFIG;      // 关键:模拟宿主没有 memory/config.json
  process.env.CHAR_ID = 'test';
  process.env.CASTALIA_PROJECT = 'seed';
  await import('../dist/configLoader.js');
  const dbm = await import('../dist/db.js');
  const db = dbm.DatabaseManager.getInstance('seed', 'general');
  const one = (sql) => { try { return db.prepare(sql).get(); } catch (e) { return { err: e.message }; } };
  console.log('CHILD ' + JSON.stringify({
    envModel: process.env.EMBEDDING_MODEL || null,
    envMode: process.env.EMBED_MODE || null,
    keyLen: (process.env.EMBEDDING_API_KEY || '').length,
    model: dbm.embedModelName(),
    space: one('select model from _embed_space where id=1'),
    memRows: one('select count(*) c from memory'),
  }));
  process.exit(0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-embspace-'));
const BGE = crypto.createHash('sha256').update('BAAI/bge-m3|1024').digest('hex');

/** 造一个 bank:config 决定它能读到什么;库里预置"bge-m3 空间"指纹 + 1 条记忆 */
function makeBank(name, config) {
  const bank = path.join(TMP, name);
  const proj = path.join(bank, 'seed', 'general');
  fs.mkdirSync(proj, { recursive: true });
  if (config) fs.writeFileSync(path.join(bank, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  const db = new Database(path.join(proj, 'memory.sqlite'));
  sqliteVec.load(db);      // vec0 虚表需要扩展(CastaliaNode 内建;系统 node 没有)
  db.exec('CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, is_active INTEGER DEFAULT 1)');
  db.exec('CREATE TABLE IF NOT EXISTS _embed_space (id INTEGER PRIMARY KEY CHECK (id = 1), model TEXT, dim INTEGER, space_hash TEXT, updated_at TEXT)');
  db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding float[1024])');
  db.prepare('INSERT OR REPLACE INTO memory (id, is_active) VALUES (?, 1)').run('probe-1');
  db.prepare('INSERT OR REPLACE INTO _embed_space (id, model, dim, space_hash, updated_at) VALUES (1,?,?,?,?)')
    .run('BAAI/bge-m3', 1024, BGE, new Date().toISOString());
  db.close();
  return bank;
}

const bankApi = (apiKey) => ({
  embedding: {
    mode: 'api',
    api_url: 'https://api.siliconflow.cn/v1',
    api_model: 'BAAI/bge-m3',
    model: 'yuan-embedding-2.0-zh',
    api_key: apiKey,
    dim: 1024,
  },
});

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + String(extra).slice(0, 300) : ''}`); }
};

const run = (bank, env) => {
  const r = spawnSync(process.execPath, [SELF, '--child', bank], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('CHILD '));
  return { val: line ? JSON.parse(line.slice(6)) : null, wiped: out.includes(WIPE), out };
};

// ── R1:只给 MEMORY_DB_DIR,配置必须被读到
const bankA = makeBank('withconfig', bankApi(TEST_KEY));
console.log('R1 configLoader 读 MEMORY_DB_DIR/config.json');
{
  const { val, wiped } = run(bankA, { EMBEDDING_MODEL: '', EMBED_MODE: '' });
  check('EMBED_MODE 来自 bank config(api)', val?.envMode === 'api', val?.envMode);
  check('EMBEDDING_MODEL 来自 api_model(BAAI/bge-m3)', val?.model === 'BAAI/bge-m3', val?.model);
  check('key 从 config.json 注入', val?.keyLen > 0, val?.keyLen);
  check('空间指纹与库内一致 → 不清空索引', !wiped, val && JSON.stringify(val.space));
}

// ── R2:没有 config.json(只能拿到内置默认模型)时,沿用库内模型,不清索引
const bankB = makeBank('noconfig', null);
console.log('R2 未显式配置模型 → 沿用库内模型,不清索引');
{
  const { val, wiped } = run(bankB, { EMBED_MODE: 'api', EMBEDDING_API_KEY: TEST_KEY, EMBEDDING_MODEL: '' });
  check('沿用库内模型 BAAI/bge-m3', val?.model === 'BAAI/bge-m3', val?.model);
  check('没有走破坏性分支(未清向量)', !wiped, val && JSON.stringify(val.space));
  check('_embed_space 仍是 bge-m3', val?.space?.model === 'BAAI/bge-m3', JSON.stringify(val?.space));
}

// ── R3:显式换模型 → 仍然清空重嵌(规则不能被 R2 破坏)
console.log('R3 显式换模型 → 仍然清空重嵌');
{
  const { val, wiped } = run(bankB, { EMBED_MODE: 'api', EMBEDDING_API_KEY: TEST_KEY, EMBEDDING_MODEL: 'some-other-model' });
  check('模型切到 some-other-model', val?.model === 'some-other-model', val?.model);
  check('走了破坏性分支(清空旧空间索引)', wiped);
  check('_embed_space 记录新模型', val?.space?.model === 'some-other-model', JSON.stringify(val?.space));
}

// ── R4:显式换模型但拿不到 key(清空后无法重嵌)→ 不清
const bankC = makeBank('nokey', bankApi(''));
console.log('R4 EMBED_MODE=api 但没 key → 不清(清了无法重嵌)');
{
  const { val, wiped } = run(bankC, { EMBED_MODE: 'api', EMBEDDING_MODEL: 'some-other-model', EMBEDDING_API_KEY: '' });
  check('没有走破坏性分支(未清向量)', !wiped, val && JSON.stringify(val.space));
  check('_embed_space 未被改写', val?.space?.model === 'BAAI/bge-m3', JSON.stringify(val?.space));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
