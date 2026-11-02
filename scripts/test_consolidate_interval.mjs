#!/usr/bin/env node
/**
 * 加速测试：整合「自适应间隔」——不等 6 小时、不花一个 token。
 *
 * 事故：活库日志 `[consolidate] 跳过：距上次整合 4.4h,未到最小间隔 6h`，
 * 而那一轮已经拿到 50 对候选。旧闸把「有活可干」的轮次一起挡掉。
 *
 * 修完之后要成立：
 *   A. 决策表：输入变了就别管时间；输入没变仍按 7 天；上次失败按 floor 冷却；非自适应时退回纯时间闸
 *   B. 端到端：候选非空 + 上次 1h 前 → 真的调用 LLM（回归点，旧版这里会跳过）
 *   C. 端到端：紧接着再跑一次（输入没变）→ 跳过且不再调 LLM
 *   D. 端到端：上次 ok=false 且 1h 前 → 冷却跳过
 *   E. 端到端：没有候选 → 不调 LLM（省 token 的原意没被破坏）
 *
 * 用法：node scripts/test_consolidate_interval.mjs [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const KEEP = process.argv.includes('--keep');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cons-interval-'));

process.env.MEMORY_DB_DIR = TMP;
process.env.MEMORY_CONFIG = path.join(TMP, 'config.json');
process.env.EMBED_MODE = 'api';
process.env.CHAR_ID = 'test';
process.env.CASTALIA_PROJECT = 'iv';
process.env.REFLECT_LLM_API_KEY = 'test-key';      // isReflectConfigured() 需要非空；实际不会联网
process.env.CONSOLIDATE_BUCKET_PAIRS = '5';
process.env.CONSOLIDATE_BUCKET_RESERVE = '0';
process.env.CONSOLIDATE_MIN_INTERVAL_HOURS = '6';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const { DatabaseManager } = await import(pathToFileURL(path.join(ROOT, 'dist', 'db.js')).href);
const { runConsolidate, decideConsolidateRun } = await import(pathToFileURL(path.join(ROOT, 'dist', 'reflectDriver.js')).href);

const PROJ = 'iv';
const db = DatabaseManager.getInstance(PROJ, 'general');
const ins = db.prepare(`INSERT INTO memory (id,text,project,type,mem_type,category,tags,importance,
    character_id,source,subject,tier,is_active,created_at,updated_at,last_accessed_at,accessed_count,
    reference_count,locked,identity_locked,base_importance)
  VALUES (?,?,?,'episodic','general','general','[]',0.6,'t','manual','user','standard',1,?,?,?,0,0,0,0,0.5)`);
for (let i = 0; i < 6; i++) {
  ins.run(`d${i}`, `# Legacy Note\n- 同一段结论第 ${i} 份，内容一致。`, PROJ,
    '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
}
const STATE = path.join(TMP, `consolidate-state-${PROJ}.json`);
const writeState = (obj) => fs.writeFileSync(STATE, JSON.stringify(obj), 'utf8');
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

// ── A. 决策表（纯函数，毫秒级）──────────────────────────────────
console.log('== A. decideConsolidateRun 决策表 ==');
const floor = 6 * 3600 * 1000;
check('首次运行（无状态）→ 跑',
  decideConsolidateRun(null, 'fp', 10).run === true);
check('输入变了 + 1h 前 + 有候选 → 跑（自适应）',
  decideConsolidateRun({ ok: true, at: hoursAgo(1), fingerprint: 'old' }, 'new', 10).run === true);
check('输入没变 + 1h 前 → 跳过（7 天 TTL）',
  decideConsolidateRun({ ok: true, at: hoursAgo(1), fingerprint: 'same' }, 'same', 10).run === false);
check('上次失败 + 1h 前 + 同输入 → 冷却跳过',
  decideConsolidateRun({ ok: false, at: hoursAgo(1), fingerprint: 'same' }, 'same', 10).run === false);
check('关掉自适应 + 1h 前 → 退回纯时间闸',
  decideConsolidateRun({ ok: true, at: hoursAgo(1), fingerprint: 'old' }, 'new', 10, Date.now(), floor, false).run === false);
check('无候选 + 1h 前 → 跳过',
  decideConsolidateRun({ ok: true, at: hoursAgo(1), fingerprint: 'old' }, 'new', 0).run === false);

// ── 端到端：用 fake LLM 记录调用次数 ────────────────────────────
let llmCalls = 0;
const fakeLlm = async () => { llmCalls++; return { content: '[]', reasoning: '', finishReason: 'stop' }; };
const run = () => runConsolidate('test', PROJ, 0.88, 20, { llm: fakeLlm });

console.log('== B. 候选非空 + 上次 1h 前 → 必须调 LLM ==');
writeState({ ok: true, at: hoursAgo(1), fingerprint: 'stale-from-other-window', merged: 0, scanned: 500, candidates: 6 });
llmCalls = 0;
let r = await run();
check('没有被 6h 间隔挡住', llmCalls === 1, `llmCalls=${llmCalls} skipped=${!!r.skipped} errors=${JSON.stringify(r.errors)}`);
check('本轮确实有候选', (r.candidates ?? 0) > 0, JSON.stringify(r.candidates));

console.log('== C. 紧接着再跑（输入未变）→ 跳过 ==');
llmCalls = 0;
r = await run();
check('第二次跳过且不调 LLM', llmCalls === 0 && r.skipped === true, `llmCalls=${llmCalls} skipped=${r.skipped}`);

console.log('== D. 上次失败 + 1h 前 → 冷却 ==');
writeState({ ok: false, at: hoursAgo(1), fingerprint: 'whatever', merged: 0, scanned: 500, candidates: 6 });
llmCalls = 0;
r = await run();
check('失败冷却生效', llmCalls === 0 && r.skipped === true, `llmCalls=${llmCalls}`);

console.log('== E. 没有候选 → 不调 LLM ==');
db.prepare("DELETE FROM memory WHERE id LIKE 'd%'").run();
ins.run('solo', `# Unique Head\n- 只有这一条，没有重复。`, PROJ,
  '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
writeState({ ok: true, at: hoursAgo(1), fingerprint: 'x', merged: 0, scanned: 500, candidates: 0 });
llmCalls = 0;
r = await run();
check('无候选直接返回', llmCalls === 0, `llmCalls=${llmCalls}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
else console.log(`（保留临时目录：${TMP}）`);
process.exit(fail ? 1 : 0);
