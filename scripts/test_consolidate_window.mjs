#!/usr/bin/env node
/**
 * 回归：整合窗口的「轮转覆盖」与「候选只在窗口内」（v1.28，2026-11-01）
 *
 * 事故（活库实测日志）：
 *   [consolidate] 候选对裁剪：48 → 6（窗口外 42 对）
 * 根因不是数值调参，而是三处口径不一致：
 *   1. 候选生成（scanVectorPairs / scanStructPairs）各自 `ORDER BY created_at DESC LIMIT 500`，
 *      与窗口构建（importance 前 300 + `updated_at ASC` 最久 200）用的是**两套排序**；
 *      两端不在同一窗口的候选对必被下游 `allowedSourceIds` 拒掉，白算还挤占名额。
 *   2. 「最久 200」没有游标：每轮拿到的都是同一批最老的 200 条，中间的活跃度区间永远轮不到。
 *   3. 候选生成先全库扫再过滤，随库增大线性变贵，而实际只有 ≤500 条能进 LLM。
 *
 * 本测试锁定修完之后的契约：
 *   A. buildConsolidateWindow 带游标：连续多次调用能覆盖全部 active 行，且一轮内不重复
 *   B. findSimilarCandidates 接受 windowIds：候选两端都在窗口内（旧实现里老重复永远进不来）
 *   C. 不传 windowIds 时行为与旧版一致（向后兼容，老调用点零改动）
 *
 * 用法：node scripts/test_consolidate_window.mjs [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const KEEP = process.argv.includes('--keep');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cons-window-'));
process.env.MEMORY_DB_DIR = TMP;
process.env.MEMORY_CONFIG = path.join(TMP, 'config.json');
process.env.EMBED_MODE = 'api';           // 只走结构兜底：候选生成不调用嵌入服务（vec 表为空即跳过）
process.env.EMBED_DIM = '1024';
process.env.CHAR_ID = 'test';
process.env.CASTALIA_PROJECT = 'kl';
process.env.CONSOLIDATE_BUCKET_PAIRS = '3';
process.env.CONSOLIDATE_BUCKET_RESERVE = '0';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const { DatabaseManager } = await import(pathToFileURL(path.join(ROOT, 'dist', 'db.js')).href);
const { findSimilarCandidates } = await import(pathToFileURL(path.join(ROOT, 'dist', 'consolidate.js')).href);
const { buildConsolidateWindow } = await import(pathToFileURL(path.join(ROOT, 'dist', 'reflectDriver.js')).href);

const PROJ = 'kl';
const db = DatabaseManager.getInstance(PROJ, 'general');
const ins = db.prepare(`INSERT INTO memory (id,text,project,type,mem_type,category,tags,importance,
    character_id,source,subject,tier,is_active,created_at,updated_at,last_accessed_at,accessed_count,
    reference_count,locked,identity_locked,base_importance)
  VALUES (?,?,?,'episodic','general','general','[]',?,'t','manual','user','standard',1,?,?,?,0,0,0,0,0.5)`);

// 520 条新记忆（表头各不相同）+ 10 条老记忆（同一表头，彼此重复）
const NEW = 520, OLD = 10;
const oldIds = [];
for (let i = 0; i < NEW; i++) {
  ins.run(`n${i}`, `# Topic ${i}\n- 新记忆正文 ${i}，${'填充'.repeat(3)}`, PROJ, 0.6,
    '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
}
for (let i = 0; i < OLD; i++) {
  const id = `o${i}`;
  oldIds.push(id);
  ins.run(id, `# Legacy Note\n- 同一段老结论第 ${i} 份副本，内容一致。`, PROJ, 0.2,
    '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z');
}

// ── A. 窗口游标：能覆盖全部 active 行，一轮内不重复 ──────────────
console.log('== A. buildConsolidateWindow 轮转覆盖 ==');
check('buildConsolidateWindow 已导出', typeof buildConsolidateWindow === 'function');
if (typeof buildConsolidateWindow === 'function') {
  const seenAll = new Set();
  let cursor = null, rounds = 0, dupInPass = 0;
  while (rounds < 20) {
    const w = await buildConsolidateWindow(PROJ, { topN: 0, rotateN: 100, cursor });
    rounds++;
    for (const m of w.mems) {
      if (seenAll.has(m.id)) dupInPass++;
      seenAll.add(m.id);
    }
    if (!w.nextCursor || w.wrapped) break;
    cursor = w.nextCursor;
  }
  check('多轮覆盖到全部 530 条', seenAll.size >= NEW + OLD, `覆盖 ${seenAll.size}/${NEW + OLD}`);
  check('一轮之内不重复返回同一条', dupInPass === 0, `重复 ${dupInPass} 次`);
  check('轮次数量与分片大小相符', rounds >= 5 && rounds <= 12, `rounds=${rounds}`);
}

// ── B. 候选必须两端都在窗口内（老重复能被抓到）─────────────────
console.log('== B. windowIds 限定下的候选 ==');
const oldWindow = new Set(oldIds);
const pB = await findSimilarCandidates(PROJ, 0.88, 50, { windowIds: oldWindow });
check('窗口内老重复被找出', pB.length > 0, `candidates=${pB.length}`);
check('候选两端都在窗口内', pB.every(p => oldWindow.has(p.idA) && oldWindow.has(p.idB)),
  JSON.stringify(pB.slice(0, 3)));

// 旧行为对照：不传 windowIds 时，候选来自"最新 500"，老行（created 2026-01）进不来
console.log('== B2. 向后兼容（不传 windowIds）==');
const pAll = await findSimilarCandidates(PROJ, 0.88, 50);
check('不传 windowIds 时仍返回候选或空数组而不抛错', Array.isArray(pAll));
check('不传 windowIds 时不含老行（旧口径的最小复现）', pAll.every(p => !oldIds.includes(p.idA) && !oldIds.includes(p.idB)),
  JSON.stringify(pAll.slice(0, 3)));

// ── C. 不变式：候选不得指向窗口外 ────────────────────────────────
console.log('== C. 不变式 ==');
const mixed = new Set([...oldIds.slice(0, 3), 'n0', 'n1']);
const pC = await findSimilarCandidates(PROJ, 0.88, 50, { windowIds: mixed });
check('混合窗口下候选严格在窗口内', pC.every(p => mixed.has(p.idA) && mixed.has(p.idB)),
  JSON.stringify(pC.slice(0, 3)));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
else console.log(`（保留临时目录：${TMP}）`);
process.exit(fail ? 1 : 0);
