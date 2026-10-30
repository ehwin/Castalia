/**
 * facts provenance 回归（v1.27）
 *
 * 用法：node scripts/regression_facts_provenance.mjs
 * 全离线（EMBED_MODE=none），临时库，跑完自删。
 *
 * 断言：
 *   F1 跨 memType 的证据不再丢出处：source_memory_id 不挂（跨库外键本来就错），
 *      但 source / mem_type / evidence_ids 一定落库
 *   F2 同库（general）证据照旧挂 source_memory_id
 *   F3 派生叙述（摘要/洞察）不能当事实出处
 *   F4 同一 SPO 重复写入走 update，出处用 COALESCE 补，不产生重复行
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-facts-'));
process.env.MEMORY_DB_DIR = TMP;
process.env.MEMORY_CONFIG = path.join(TMP, 'config.json');
process.env.CHAR_ID = 'test';
process.env.CASTALIA_PROJECT = 'fp';
process.env.EMBED_MODE = 'none';
process.env.MCP_TOOLS = 'all';

fs.writeFileSync(process.env.MEMORY_CONFIG, JSON.stringify({
  reflect: { preservation: 'standard' },
  embedding: { mode: 'none' },
}, null, 1), 'utf8');

const { DatabaseManager } = await import('../dist/db.js');
const { saveMemory, saveFacts, findDbByMemoryId } = await import('../dist/store.js');
const { applyReflectResult } = await import('../dist/reflect.js');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
};
const factsDb = () => DatabaseManager.getInstance('fp');
const fact = (spo) => factsDb().prepare('SELECT * FROM facts WHERE subject=? AND predicate=? AND object=?').get(...spo);

console.log('\n[F1] 跨 memType 出处');
const projMem = await saveMemory({
  text: '项目约定：评测集必须按时间留出，不能同一对话泄漏。',
  project: 'fp', characterId: 'test', memType: 'project', source: 'reflect_extract',
});
check('证据落在 project 分类库', findDbByMemoryId(projMem.id, 'fp')?.memType === 'project', findDbByMemoryId(projMem.id, 'fp')?.memType);
await saveFacts(
  [{ subject: 'user', predicate: '评测规范', object: '按时间留出', confidence: 0.9 }],
  projMem.id, 'test', 'fp',
  { source: 'reflect_extract', memType: 'project', evidenceIds: [projMem.id] },
);
const f1 = fact(['user', '评测规范', '按时间留出']);
check('事实已写入', !!f1);
check('跨库不挂本地外键', f1?.source_memory_id == null, String(f1?.source_memory_id));
check('出处来源落库（不再丢成 NULL）', f1?.source_memory_source === 'reflect_extract', String(f1?.source_memory_source));
check('出处 mem_type 落库', f1?.source_memory_mem_type === 'project', String(f1?.source_memory_mem_type));
check('证据 ids 落库', (() => { try { return JSON.parse(f1.evidence_ids).includes(projMem.id); } catch { return false; } })(), String(f1?.evidence_ids));

console.log('\n[F2] 同库出处');
const genMem = await saveMemory({
  text: '用户说他不喜欢形而上学式的交付说明。', project: 'fp', characterId: 'test', source: 'manual',
});
await saveFacts(
  [{ subject: 'user', predicate: '交付偏好', object: '要能跑能测', confidence: 0.8 }],
  genMem.id, 'test', 'fp', { source: 'manual', evidenceIds: [genMem.id] },
);
const f2 = fact(['user', '交付偏好', '要能跑能测']);
check('同库仍挂 source_memory_id', f2?.source_memory_id === genMem.id, String(f2?.source_memory_id));
check('mem_type=general', f2?.source_memory_mem_type === 'general', String(f2?.source_memory_mem_type));

console.log('\n[F3] 派生叙述不能当出处');
const r = await applyReflectResult({
  summary: '模型自述：用户偏好实测优先。', insights: [], facts: [], actions: [],
}, 'test', 'fp', { allowedSourceIds: new Set([genMem.id]) });
check('摘要落库', !!r.summaryId);
await saveFacts(
  [{ subject: 'user', predicate: '自述证据', object: '不该成立', confidence: 0.9 }],
  r.summaryId, 'test', 'fp', { source: 'reflect_summary', evidenceIds: [r.summaryId] },
);
const f3 = fact(['user', '自述证据', '不该成立']);
check('派生来源不挂外键', f3?.source_memory_id == null, String(f3?.source_memory_id));
check('派生来源不写 mem_type（出处被拒）', f3?.source_memory_mem_type == null, String(f3?.source_memory_mem_type));

console.log('\n[F4] 重复 SPO 走 update');
const before = factsDb().prepare('SELECT COUNT(*) c FROM facts').get().c;
await saveFacts(
  [{ subject: 'user', predicate: '评测规范', object: '按时间留出', confidence: 0.95, evidence: '按时间留出' }],
  genMem.id, 'test', 'fp', { source: 'manual', evidenceIds: [genMem.id] },
);
const after = factsDb().prepare('SELECT COUNT(*) c FROM facts').get().c;
const f4 = fact(['user', '评测规范', '按时间留出']);
check('没有新增行', before === after, `${before} → ${after}`);
check('confidence 取 MAX', f4?.confidence === 0.95, String(f4?.confidence));
check('evidence 补写', f4?.evidence === '按时间留出', String(f4?.evidence));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
process.exit(fail === 0 ? 0 : 1);
