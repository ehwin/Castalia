/**
 * 来源分界回归（v1.27 provenance）
 *
 * 用法：node scripts/regression_provenance_isolation.mjs
 * 特性：全离线（EMBED_MODE=none，不需要嵌入服务、不需要 LLM key），临时库，跑完自删。
 *
 * 断言（对应 psyche 审计报告里与记忆体有关、与情感无关的那几条不变量）：
 *   P1 反思摘要/洞察落库时带 derived / generated_by / evidence_ids / evidence_key
 *   P2 派生叙述不进默认检索、不进 recent 注入、不进反思输入；includeDerived=true 才看得到
 *   P3 evidence_key 幂等：同一批证据重跑（哪怕措辞不同）不会多出一条
 *   P4 事实不再挂在摘要上；出处用 evidence_ids + source 表达
 *   P5 历史行回填：库里已有的 reflect_summary 打开库即 derived=1
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-provenance-'));
process.env.MEMORY_DB_DIR = TMP;
process.env.MEMORY_CONFIG = path.join(TMP, 'config.json');
process.env.CHAR_ID = 'test';
process.env.CASTALIA_PROJECT = 'prov';
process.env.EMBED_MODE = 'none';
process.env.MCP_TOOLS = 'all';

fs.writeFileSync(process.env.MEMORY_CONFIG, JSON.stringify({
  reflect: { preservation: 'standard' },
  embedding: { mode: 'none' },
}, null, 1), 'utf8');

const { DatabaseManager } = await import('../dist/db.js');
const { saveMemory } = await import('../dist/store.js');
const { applyReflectResult } = await import('../dist/reflect.js');
const { searchMemory, getRecentMemories } = await import('../dist/search.js');
const { listAllMemories } = await import('../dist/reflect.js');
const { evidenceKeyOf } = await import('../dist/provenance.js');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
};

const PROJ = 'prov';
const rowIn = (id) => {
  for (const mt of DatabaseManager.existingMemTypes(PROJ)) {
    const db = DatabaseManager.getInstance(PROJ, mt);
    const r = db.prepare('SELECT *, mem_type FROM memory WHERE id = ?').get(id);
    if (r) return { row: r, memType: mt, db };
  }
  return null;
};
const countDerived = () => {
  let n = 0;
  for (const mt of DatabaseManager.existingMemTypes(PROJ)) {
    const db = DatabaseManager.getInstance(PROJ, mt);
    n += db.prepare('SELECT COUNT(*) c FROM memory WHERE derived = 1').get().c;
  }
  return n;
};

// ── 证据：两条用户原话（普通记忆，不是 conversation_log，检索可见） ────────────
const ev1 = await saveMemory({
  text: '用户要求所有交付都先跑构建再报告，不要形而上学的说明。',
  project: PROJ, characterId: 'test', category: 'conversation', source: 'manual',
});
const ev2 = await saveMemory({
  text: '用户明确反对用常驻进程掩盖 VM 自停机，要求找设计层面的正确开关。',
  project: PROJ, characterId: 'test', category: 'conversation', source: 'manual',
});

console.log('\n[P1] 派生记录落库带 provenance');
const evidenceIds = [ev1.id, ev2.id];
const r1 = await applyReflectResult({
  summary: '用户偏好：先验证再汇报，反对绕道方案。',
  insights: ['用户会自己跑对照实验并抛回关键线索。'],
  facts: [{ subject: 'user', predicate: '偏好', object: '先构建再报告', confidence: 0.8 }],
  actions: [],
}, 'test', PROJ, { allowedSourceIds: new Set(evidenceIds) });

check('摘要落库并返回 id', !!r1.summaryId, JSON.stringify(r1.errors) + JSON.stringify(r1.warnings));
const sum = rowIn(r1.summaryId);
check('摘要 derived=1', sum?.row?.derived === 1, JSON.stringify(sum?.row ?? null));
check('摘要 generated_by=reflect_summary', sum?.row?.generated_by === 'reflect_summary');
const sumEvidence = JSON.parse(String(sum?.row?.evidence_ids || '[]'));
check('摘要 evidence_ids = 本批证据', sumEvidence.length === 2 && sumEvidence.includes(ev1.id) && sumEvidence.includes(ev2.id), String(sum?.row?.evidence_ids));
check('摘要 evidence_key 与证据集合对应',
  sum?.row?.evidence_key === evidenceKeyOf('reflect_summary', evidenceIds), String(sum?.row?.evidence_key));
check('evidence_key 唯一索引已建立', !!sum.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ux_memory_evidence_key'").get());
check('重复 evidence_key 直接被库拒绝', (() => {
  try {
    sum.db.prepare(`INSERT INTO memory (id, text, project, source, subject, derived, evidence_key) VALUES (?, ?, ?, 'reflect_summary', 'user', 1, ?)`)
      .run('dup-evidence-key-test', '重复键', PROJ, evidenceKeyOf('reflect_summary', evidenceIds));
    return false;
  } catch (e) { return /UNIQUE/i.test(String(e.message)); }
})(), 'unique index 未生效');
const insightRows = DatabaseManager.getInstance(PROJ).prepare("SELECT * FROM memory WHERE source = 'reflect_insight'").all();
check('洞察 derived=1 且带 evidence_ids', insightRows.length === 1 && insightRows[0].derived === 1 && insightRows[0].evidence_ids, JSON.stringify(insightRows.map(r => r.derived)));

console.log('\n[P2] 检索保留（降权），证据链硬排除');
const q = '先验证再汇报';      // 只出现在摘要里
const qEvidence = '常驻进程';   // 只出现在证据（ev2）里
const plain = await searchMemory({ query: q, project: PROJ, topK: 10, characterId: 'test' });
const plainSum = plain.find(r => r.source === 'reflect_summary');
check('默认检索能拿到摘要（导航层不被拆掉）', !!plainSum && plainSum.derived === true, plain.map(r => r.source).join(','));
const undemoted = await searchMemory({ query: q, project: PROJ, topK: 10, characterId: 'test', derivedPolicy: 'only' });
const onlySum = undemoted.find(r => r.source === 'reflect_summary');
check("derivedPolicy='only' 只看叙述", undemoted.length > 0 && undemoted.every(r => r.derived === true), undemoted.map(r => r.source).join(','));
check('demoted 的分数低于不降权（同一行同一查询）',
  !!plainSum && !!onlySum && plainSum.score < onlySum.score,
  `demoted=${plainSum?.score} raw=${onlySum?.score}`);
const excluded = await searchMemory({ query: q, project: PROJ, topK: 10, characterId: 'test', derivedPolicy: 'excluded' });
check("derivedPolicy='excluded' 完全隐藏", excluded.every(r => r.source !== 'reflect_summary'), excluded.map(r => r.source).join(','));
// 反证：excluded 不能靠"SQL 报错返回空"通过 —— 换个只命中证据的查询，必须还有结果
const excludedEv = await searchMemory({ query: qEvidence, project: PROJ, topK: 10, characterId: 'test', derivedPolicy: 'excluded' });
check("excluded 下证据仍可检索（过滤不是整条通道挂掉）", excludedEv.some(r => r.id === ev2.id), excludedEv.map(r => r.id).join(','));
const evHit = await searchMemory({ query: qEvidence, project: PROJ, topK: 10, characterId: 'test' });
check('默认检索仍能拿到证据（分界没有误伤内容）', evHit.some(r => r.id === ev2.id), evHit.map(r => r.id).join(','));

const recent = getRecentMemories('test', 20, 24, PROJ);
check('recent 注入不含摘要', recent.every(r => r.source !== 'reflect_summary'), recent.map(r => r.source).join(','));

const inputs = listAllMemories('test', 200, PROJ);
check('反思输入不含摘要/洞察',
  inputs.every(m => m.source !== 'reflect_summary' && m.source !== 'reflect_insight'),
  inputs.map(m => m.source).join(','));
const inputsAll = listAllMemories('test', 200, PROJ, 'demoted');
check('listAllMemories(includeDerived) 能看到派生行',
  inputsAll.some(m => m.source === 'reflect_summary'), inputsAll.map(m => m.source).join(','));

console.log('\n[P3] evidence_key 幂等');
const derivedBefore = countDerived();
const r2 = await applyReflectResult({
  summary: '改写后的另一段措辞：用户讨厌形而上学，要求实测。',
  insights: [],
  facts: [],
  actions: [],
}, 'test', PROJ, { allowedSourceIds: new Set([ev2.id, ev1.id]) });
check('同证据重跑复用同一摘要行', r2.summaryId === r1.summaryId, `${r2.summaryId} vs ${r1.summaryId}`);
check('派生行数未增加', countDerived() === derivedBefore, `${countDerived()} vs ${derivedBefore}`);

console.log('\n[P4] 事实出处');
const factRows = DatabaseManager.getInstance(PROJ).prepare('SELECT * FROM facts').all();
check('事实已落库', factRows.length === 1, String(factRows.length));
check('事实不再挂摘要 id', factRows[0]?.source_memory_id == null, String(factRows[0]?.source_memory_id));
check('事实记录了证据 ids', (() => {
  try { return JSON.parse(factRows[0].evidence_ids).length === 2; } catch { return false; }
})(), String(factRows[0]?.evidence_ids));

console.log('\n[P5] 历史行回填');
// 手工造一条“旧库”形态的行：derived 缺省 0 但 source 是 reflect_summary
const gdb = DatabaseManager.getInstance(PROJ);
gdb.prepare(`INSERT INTO memory (id, text, project, type, mem_type, category, tags, importance, character_id, source, subject, tier, is_active, created_at, updated_at, last_accessed_at, derived)
  VALUES ('legacy-summary-1', '历史摘要：旧版本写入的行', ?, 'semantic', 'general', 'knowledge', '[]', 0.6, 'test', 'reflect_summary', 'user', 'standard', 1, ?, ?, ?, 0)`)
  .run(PROJ, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
gdb.prepare("DELETE FROM _provenance_meta WHERE k = 'derived_backfill'").run();
const { backfillDerivedFlag } = await import('../dist/provenance.js');
backfillDerivedFlag(gdb);
const legacy = gdb.prepare("SELECT derived, generated_by FROM memory WHERE id = 'legacy-summary-1'").get();
check('历史 summary 回填 derived=1', legacy.derived === 1, JSON.stringify(legacy));
check('回填同时补 generated_by', legacy.generated_by === 'reflect_summary', JSON.stringify(legacy));
const legacySearch = await searchMemory({ query: '历史摘要', project: PROJ, topK: 10, characterId: 'test' });
const legacyHit = legacySearch.find(r => r.id === 'legacy-summary-1');
check('回填后历史 summary 仍可检索但已标 derived', !!legacyHit && legacyHit.derived === true, legacySearch.map(r => r.id).join(','));
const legacyInputs = listAllMemories('test', 200, PROJ);
check('回填后历史 summary 不再进反思输入', legacyInputs.every(m => m.id !== 'legacy-summary-1'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
process.exit(fail === 0 ? 0 : 1);
