#!/usr/bin/env node
/**
 * 回归：死行收割（v1.29）—— 只删证明过没人用的行，其余一律保留。
 *
 * 锁定契约：
 *   A. 默认 dry-run：只统计不落库，也不建墓碑表
 *   B. 龄期闸：未满 N 天的死行不动
 *   C. 引用闸：edges 端点 / facts 出处 / 活跃行的 merged_into 指向的行 一律保留
 *   D. apply 后：行被删、墓碑留 id+哈希+长度+来源、FTS 同步消失、向量行清除、其余行完好
 *   E. 幂等：再跑一次 reaped=0
 *
 * 用法：node scripts/test_retention_reap.mjs [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const KEEP = process.argv.includes('--keep');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'));
process.env.MEMORY_DB_DIR = TMP;
process.env.MEMORY_CONFIG = path.join(TMP, 'config.json');
process.env.EMBED_MODE = 'api';
process.env.CHAR_ID = 'test';
process.env.CASTALIA_PROJECT = 'rp';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); } };

const { DatabaseManager } = await import(pathToFileURL(path.join(ROOT, 'dist', 'db.js')).href);
const { reapDeadRows } = await import(pathToFileURL(path.join(ROOT, 'dist', 'retention.js')).href);

const PROJ = 'rp';
const db = DatabaseManager.getInstance(PROJ, 'general');
const ins = db.prepare(`INSERT INTO memory (id,text,project,type,mem_type,category,tags,importance,
    character_id,source,subject,tier,is_active,created_at,updated_at,last_accessed_at,accessed_count,
    reference_count,locked,identity_locked,base_importance,merged_into)
  VALUES (?,?,?,'episodic','general','general','[]',0.4,'t','manual','user','standard',?,?,?,?,0,0,0,0,0.4,?)`);
const oldIso = '2025-01-01T00:00:00.000Z';
const newIso = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
const add = (id, text, active, createdAt, mergedInto = null) =>
  ins.run(id, text, PROJ, active ? 1 : 0, createdAt, createdAt, createdAt, mergedInto);

add('dead-1', '孤儿文案：这条判死且无人引用，应当被收割。', 0, oldIso);
add('dead-ref-fact', '被事实引用：这条虽然判死，但 facts 指向它。', 0, oldIso);
add('dead-ref-merge', '被合并链引用：活跃行 merged_into 指向它。', 0, oldIso);
add('dead-ref-edge', '被边引用：edges 端点指向它。', 0, oldIso);
add('dead-recent', '还没到期：5 天前判死，30 天闸内不动。', 0, newIso);
add('alive-1', '活着的一条：不该被碰。', 1, oldIso, 'dead-ref-merge');

db.prepare(`INSERT INTO facts (id,subject,predicate,object,project,confidence,source_memory_id,is_active)
  VALUES ('f1','u','p','o',?,0.9,'dead-ref-fact',1)`).run(PROJ);
try {
  db.prepare(`INSERT INTO edges (id,source_id,target_id,relation_type) VALUES ('e1','alive-1','dead-ref-edge','refers')`).run();
} catch (e) { console.log('  (edges 插入跳过:', e.message, ')'); }

// 给 dead-1 塞一条向量，验证收割时一起清掉
let vecOk = false;
try {
  db.prepare('INSERT INTO vec_memory(rowid, embedding) VALUES (?, ?)')
    .run(BigInt(db.prepare("SELECT rowid FROM memory WHERE id='dead-1'").get().rowid), new Float32Array(1024));
  vecOk = true;
} catch (e) { console.log('  (向量插入跳过:', e.message, ')'); }

const count = () => db.prepare('select count(*) c from memory').get().c;
const before = count();

console.log('== A. 默认 dry-run ==');
let r = reapDeadRows({ project: PROJ });
check('探测到 1 条可收割', r.totalReaped === 0 && r.libraries.some(l => l.candidates === 1),
  JSON.stringify(r.libraries.map(l => ({ c: l.candidates, s: l.scanned }))));
check('dry-run 不落库', count() === before);
check('dry-run 不建墓碑表', !db.prepare("select name from sqlite_master where name='memory_tombstone'").get());

console.log('== D. apply ==');
r = reapDeadRows({ project: PROJ, dryRun: false });
check('收割 1 条', r.totalReaped === 1, `reaped=${r.totalReaped} errors=${JSON.stringify(r.errors)}`);
check('行数减 1', count() === before - 1);
const tomb = db.prepare("select * from memory_tombstone where id='dead-1'").get();
check('墓碑记录 id/哈希/长度/来源', !!tomb && tomb.content_hash?.length === 32 && tomb.chars > 10 && tomb.source === 'manual',
  JSON.stringify(tomb));
check('正文未复制进墓碑（只留哈希）', tomb && !('text' in tomb));

console.log('== C. 引用闸 ==');
for (const id of ['dead-ref-fact', 'dead-ref-merge', 'dead-ref-edge', 'dead-recent', 'alive-1']) {
  check(`${id} 保留`, !!db.prepare('select 1 from memory where id=?').get(id));
}

console.log('== FTS / 向量同步 ==');
const ftsHit = db.prepare("select count(*) c from memory_fts where memory_fts match ?").get('孤儿文案');
check('FTS 已不再命中被收割的文案', ftsHit.c === 0, `hits=${ftsHit.c}`);
const stillHit = db.prepare("select count(*) c from memory_fts where memory_fts match ?").get('活着的一条');
check('FTS 仍能命中保留的行', stillHit.c === 1, `hits=${stillHit.c}`);
if (vecOk) {
  const v = db.prepare('select count(*) c from vec_memory where rowid not in (select rowid from memory)').get();
  check('向量表无孤儿行', v.c === 0, `orphans=${v.c}`);
}

console.log('== E. 幂等 ==');
r = reapDeadRows({ project: PROJ, dryRun: false });
check('再跑一次收割 0 条', r.totalReaped === 0, `reaped=${r.totalReaped}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
else console.log(`（保留临时目录：${TMP}）`);
process.exit(fail ? 1 : 0);
