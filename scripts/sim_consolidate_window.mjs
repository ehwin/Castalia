#!/usr/bin/env node
/**
 * 加速测试：用活库副本把「整合窗口轮转」按轮跑完，不调 LLM、不等待 6h 间隔。
 *
 * 目的：证明修完之后
 *   ① 窗口能在一轮周期内覆盖全库（旧实现永远只有同一批 500 条）
 *   ② 每轮候选对不再被下游裁掉（旧实现 48 → 6）
 *   ③ 游标确实推进且到表尾收敛
 *
 * 用法：node scripts/sim_consolidate_window.mjs [--bank D:/castalia/memory-banks/hermes] [--project hermes] [--rounds 12]
 * 只读：先把库 sqlite-backup 到临时目录，再在副本上跑。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const BANK = arg('--bank', 'D:/castalia/memory-banks/hermes');
const PROJ = arg('--project', 'hermes');
const MAX_ROUNDS = Number(arg('--rounds', '12'));

// ── 1. 复制活库（sqlite backup，避免 WAL 撕裂）──────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cons-sim-'));
const py = `
import sqlite3, os, glob, sys
src, dst = sys.argv[1], sys.argv[2]
n = 0
for db in glob.glob(os.path.join(src, '**', '*.sqlite'), recursive=True):
    rel = os.path.relpath(db, src)
    if rel.startswith('_') or '.search-index' in rel: continue
    out = os.path.join(dst, rel); os.makedirs(os.path.dirname(out), exist_ok=True)
    s = sqlite3.connect('file:%s?mode=ro' % db.replace('\\\\','/'), uri=True); d = sqlite3.connect(out)
    s.backup(d); d.close(); s.close(); n += 1
print(n)
`;
const copied = execFileSync('python', ['-c', py, BANK, TMP], { encoding: 'utf8' }).trim();
console.log(`[copy] ${copied} 个库 → ${TMP}`);

process.env.MEMORY_DB_DIR = TMP;
process.env.MEMORY_CONFIG = path.join(TMP, 'config.json');
process.env.EMBED_MODE = 'api';           // 只读本地向量，不联网
const { DatabaseManager, listMemTypeDirs } = await import(pathToFileURL(path.join(ROOT, 'dist', 'db.js')).href);
const { buildConsolidateWindow } = await import(pathToFileURL(path.join(ROOT, 'dist', 'reflectDriver.js')).href);
const { findSimilarCandidates } = await import(pathToFileURL(path.join(ROOT, 'dist', 'consolidate.js')).href);

// ── 2. 基线：全库 active 行数 & 旧窗口（重要度300 + 最久200，无游标）──
const dirs = listMemTypeDirs(PROJ);
let active = 0;
for (const mt of dirs) {
  const db = DatabaseManager.getInstance(PROJ, mt);
  active += db.prepare("select count(*) c from memory where is_active=1 and project=? and coalesce(tier,'standard')<>'critical'").get(PROJ).c;
}
function oldWindowIds() {
  const ids = new Set();
  const top = [], oldest = [];
  for (const mt of dirs) {
    const db = DatabaseManager.getInstance(PROJ, mt);
    const where = `is_active=1 AND project=? AND (locked IS NULL OR locked=0)
      AND COALESCE(tier,'standard') <> 'critical' AND COALESCE(status,'') <> 'cold'`;
    top.push(...db.prepare(`select id from memory where ${where} order by importance desc, created_at desc limit 300`).all(PROJ));
    oldest.push(...db.prepare(`select id from memory where ${where} order by coalesce(updated_at, created_at) asc limit 200`).all(PROJ));
  }
  for (const r of top.slice(0, 300)) ids.add(r.id);
  for (const r of oldest) { if (ids.size >= 500) break; ids.add(r.id); }
  return ids;
}

console.log(`\n=== 基线 ===`);
console.log(`active 行（非 critical）：${active}`);
const oldIds = oldWindowIds();
console.log(`旧窗口固定覆盖：${oldIds.size} 条（每轮都是这一批）`);

// ── 3. 新窗口：按游标连续跑，统计覆盖与候选 ─────────────────────
console.log(`\n=== 新实现：游标连续 ${MAX_ROUNDS} 轮 ===`);
const seenAll = new Set();
let cursor = null, rounds = 0, totalPairs = 0, totalTrimmed = 0;
const rowsOut = [];
while (rounds < MAX_ROUNDS) {
  const w = await buildConsolidateWindow(PROJ, { cursor });
  rounds++;
  const ids = new Set(w.mems.map(m => m.id));
  for (const id of ids) seenAll.add(id);

  // 每轮真实候选（限定窗口内）
  const pairsNew = await findSimilarCandidates(PROJ, 0.88, 50, { windowIds: ids });
  // 旧口径：全库找候选（锚点=最新500），再按窗口过滤 → 被裁掉的量
  const pairsOld = await findSimilarCandidates(PROJ, 0.88, 50);
  const kept = pairsOld.filter(p => ids.has(p.idA) && ids.has(p.idB)).length;
  totalPairs += pairsNew.length;
  totalTrimmed += pairsOld.length - kept;

  rowsOut.push({
    round: rounds, window: ids.size, newPairs: pairsNew.length,
    oldPairs: pairsOld.length, oldKept: kept, trimmed: pairsOld.length - kept,
    cursor: w.nextCursor ? w.nextCursor.k.slice(0, 10) : null,
  });
  if (!w.nextCursor) break;
  cursor = w.nextCursor;
}

console.log('轮次 | 窗口 | 新候选 | 旧候选 | 旧口径保留 | 被裁掉 | 游标日期');
for (const r of rowsOut) {
  console.log(`${String(r.round).padStart(4)} | ${String(r.window).padStart(4)} | ${String(r.newPairs).padStart(6)} | ${String(r.oldPairs).padStart(6)} | ${String(r.oldKept).padStart(9)} | ${String(r.trimmed).padStart(6)} | ${r.cursor ?? '结束'}`);
}
console.log(`\n覆盖：${seenAll.size}/${active} active 行（${(100 * seenAll.size / active).toFixed(1)}%），${rounds} 轮`);
console.log(`候选：新口径累计 ${totalPairs} 对；旧口径在同样轮次里被裁掉 ${totalTrimmed} 对`);
console.log(`旧窗口在 ${rounds} 轮里只能看到 ${oldIds.size} 条（循环重复），覆盖率固定 ${(100 * oldIds.size / active).toFixed(1)}%`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
