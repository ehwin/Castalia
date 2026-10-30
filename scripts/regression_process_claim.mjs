/**
 * 持久游标 + 租约式 claim 回归（v1.27）
 *
 * 用法：node scripts/regression_process_claim.mjs
 * 特性：全离线，临时库，跑完自删；含真实第二进程（child_process）验证跨进程互斥。
 *
 * 断言：
 *   C1 同一批 key 同时只能被一个 owner 取到；同 owner 重试可取回（幂等续期）
 *   C2 完成后释放，另一个 owner 立刻能取到
 *   C3 进程崩溃 → 租约过期 → 下一轮回收（stale reclaim）
 *   C4 真·第二进程抢同一批 key：parent 持有时 child 取不到；parent 释放后 child 取到
 *   C5 游标是 (created_at, memType, rowid) 有序对，可持久、可回放
 *   C6 反射输入扫描排除派生叙述，并严格从游标之后继续（不重不漏）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-claim-'));
process.env.MEMORY_DB_DIR = TMP;
process.env.MEMORY_CONFIG = path.join(TMP, 'config.json');
process.env.CHAR_ID = 'test';
process.env.CASTALIA_PROJECT = 'pc';
process.env.EMBED_MODE = 'none';
process.env.MCP_TOOLS = 'all';

fs.writeFileSync(process.env.MEMORY_CONFIG, JSON.stringify({
  reflect: { preservation: 'standard' },
  embedding: { mode: 'none' },
}, null, 1), 'utf8');

const { saveMemory } = await import('../dist/store.js');
const { applyReflectResult } = await import('../dist/reflect.js');
const {
  claimBatch, completeClaims, releaseClaims, getCursor, setCursor, claimStats,
} = await import('../dist/processClaims.js');
const { listMemoriesForReflection } = await import('../dist/reflectionSources.js');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PROJ = 'pc';
const KIND = 'deep_reflect';
const keys = ['ev-a', 'ev-b', 'ev-c'];

console.log('\n[C1] 互斥与续期');
check('A 取到全部', claimBatch({ project: PROJ, kind: KIND, owner: 'A', keys }).length === 3);
check('B 一个都取不到', claimBatch({ project: PROJ, kind: KIND, owner: 'B', keys }).length === 0);
check('A 重试仍取到（幂等续期）', claimBatch({ project: PROJ, kind: KIND, owner: 'A', keys }).length === 3);
check('只有 3 条 claim 记录', claimStats(PROJ, KIND).active === 3, JSON.stringify(claimStats(PROJ, KIND)));

console.log('\n[C2] 完成即释放');
check('A 完成返回 3', completeClaims({ project: PROJ, kind: KIND, owner: 'A', keys }) === 3);
check('B 立刻能取到', claimBatch({ project: PROJ, kind: KIND, owner: 'B', keys }).length === 3);
releaseClaims({ project: PROJ, kind: KIND, owner: 'B', keys });

console.log('\n[C3] 过期回收（模拟进程被杀）');
claimBatch({ project: PROJ, kind: KIND, owner: 'crashed', keys, ttlMs: 30 });
check('未过期时别人取不到', claimBatch({ project: PROJ, kind: KIND, owner: 'B', keys, ttlMs: 30 }).length === 0);
await sleep(60);
check('过期后下一轮回收成功', claimBatch({ project: PROJ, kind: KIND, owner: 'B', keys, ttlMs: 30 }).length === 3);
const stats = claimStats(PROJ, KIND);
check('回收后没有 stale 残留', stats.stale === 0, JSON.stringify(stats));
releaseClaims({ project: PROJ, kind: KIND, owner: 'B', keys });

console.log('\n[C4] 真·跨进程互斥');
const childPath = path.join(TMP, 'child_claim.mjs');
fs.writeFileSync(childPath, `
import { claimBatch } from ${JSON.stringify(new URL('../dist/processClaims.js', import.meta.url).href)};
const got = claimBatch({ project: 'pc', kind: 'deep_reflect', owner: 'child', keys: ['ev-a','ev-b','ev-c'] });
console.log(JSON.stringify({ got: got.length }));
`, 'utf8');
claimBatch({ project: PROJ, kind: KIND, owner: 'parent', keys });
const childBlocked = JSON.parse(execFileSync(process.execPath, [childPath], { env: process.env, encoding: 'utf8' }).trim());
check('parent 持有时子进程取 0 条', childBlocked.got === 0, JSON.stringify(childBlocked));
completeClaims({ project: PROJ, kind: KIND, owner: 'parent', keys });
const childFree = JSON.parse(execFileSync(process.execPath, [childPath], { env: process.env, encoding: 'utf8' }).trim());
check('parent 释放后子进程取到 3 条', childFree.got === 3, JSON.stringify(childFree));
// 子进程退出即"崩溃"，claim 留着 → 需要过期才回收；这里手动清掉，避免影响后续
for (const k of keys) {
  try {
    const db = (await import('../dist/db.js')).DatabaseManager.getInstance(PROJ);
    db.prepare("DELETE FROM process_claim WHERE project = ? AND kind = ? AND evidence_key = ? AND owner = 'child'").run(PROJ, KIND, k);
  } catch { /* ignore */ }
}

console.log('\n[C5] 游标持久化');
check('初始无游标', getCursor(PROJ, KIND) === null);
setCursor(PROJ, KIND, { createdAt: '2026-10-31T10:00:00.000Z', rowid: 42, tag: 'project' });
const cur = getCursor(PROJ, KIND);
check('游标可读回', cur?.createdAt === '2026-10-31T10:00:00.000Z' && cur.rowid === 42 && cur.tag === 'project', JSON.stringify(cur));
setCursor(PROJ, KIND, { createdAt: '2026-10-31T11:00:00.000Z', rowid: 43, tag: 'user' });
check('游标覆盖（单行 upsert）', getCursor(PROJ, KIND)?.rowid === 43);

console.log('\n[C6] 反射输入扫描');
const ev1 = await saveMemory({ text: '证据一：构建必须通过再报告。', project: PROJ, characterId: 'test', source: 'manual' });
const ev2 = await saveMemory({ text: '证据二：反对常驻进程掩盖停机。', project: PROJ, characterId: 'test', source: 'manual' });
const ev3 = await saveMemory({ text: '证据三：先证明可回取再删除数据。', project: PROJ, characterId: 'test', source: 'manual' });
await applyReflectResult({ summary: '这一段是模型自己写的摘要，不该被再反射。', insights: [], facts: [], actions: [] },
  'test', PROJ, { allowedSourceIds: new Set([ev1.id, ev2.id]) });

const all = listMemoriesForReflection({ project: PROJ, limit: 100 });
check('扫描排除派生叙述', all.every(r => ['manual'].includes(String(r.source))), all.map(r => r.source).join(','));
check('扫描包含 3 条证据', all.filter(r => [ev1.id, ev2.id, ev3.id].includes(r.id)).length === 3, String(all.length));
check('扫描有序（created_at, memType, rowid）', (() => {
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1], b = all[i];
    const cmp = a.createdAt.localeCompare(b.createdAt) || a.memType.localeCompare(b.memType) || a.rowid - b.rowid;
    if (cmp > 0) return false;
  }
  return true;
})());

const first = all.find(r => r.id === ev1.id);
const after = listMemoriesForReflection({ project: PROJ, after: { createdAt: first.createdAt, rowid: first.rowid, tag: first.memType }, limit: 100 });
check('游标严格之后（不重复已处理行）', after.every(r => !(r.createdAt === first.createdAt && r.memType === first.memType && r.rowid <= first.rowid)), after.map(r => r.rowid).join(','));
const union = new Set([first.id, ...after.map(r => r.id)]);
check('游标之后不丢行（首行 + 余下 = 全量）', union.size === all.length && all.every(r => union.has(r.id)), `${union.size} vs ${all.length}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
process.exit(fail === 0 ? 0 : 1);
