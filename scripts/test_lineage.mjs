/**
 * 血缘与保真策略回归（C-1 / C-2）
 *
 * 用法：../run/Castalia/bin/CastaliaNode.exe scripts/test_lineage.mjs
 * 特性：全离线（EMBED_MODE=none，不需要嵌入服务、不需要 LLM key），临时库，跑完自删。
 *
 * 断言：
 *   C-1  evidence 库 + automatic（=consolidate_deep 的调用形态）必须拒绝 merge
 *   C-2  merge 结果写 merged_from / merged_quotes / valid_at；源行 superseded + expired_at + merged_into；
 *        引证能在源正文里按子串找到；源行向量不被删除
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-lineage-'));
process.env.MEMORY_DB_DIR = TMP;
process.env.MEMORY_CONFIG = path.join(TMP, 'config.json');
process.env.CHAR_ID = 'test';
process.env.CASTALIA_PROJECT = 'p_std';
process.env.EMBED_MODE = 'none';
process.env.MCP_TOOLS = 'all';

fs.writeFileSync(process.env.MEMORY_CONFIG, JSON.stringify({
  reflect: { preservation: 'evidence', projectPolicies: { p_std: 'standard', p_verb: 'verbatim' } },
  embedding: { mode: 'none' },
}, null, 1), 'utf8');

const { DatabaseManager } = await import('../dist/db.js');
const { saveMemory } = await import('../dist/store.js');
const { applyReflectActions } = await import('../dist/reflect.js');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
};
const row = (project, memType, id) =>
  DatabaseManager.getInstance(project, memType).prepare('SELECT * FROM memory WHERE id = ?').get(id);

/** 造一条假向量，用来验证 merge 不再 DELETE 源行向量 */
function seedVec(project, memType, id) {
  const db = DatabaseManager.getInstance(project, memType);
  const r = db.prepare('SELECT rowid FROM memory WHERE id = ?').get(id);
  if (!r) return false;
  const dim = (() => {
    try { return DatabaseManager.getInstance(project, memType).prepare("SELECT sql FROM sqlite_master WHERE name='vec_memory'").get()?.sql.match(/float\[(\d+)\]/)?.[1]; } catch { return null; }
  })();
  const n = Number(dim) || 1024;
  const v = new Float32Array(n);
  v[0] = 1;
  // sqlite-vec 的 vec0 主键只接受 INT64（BigInt）；传 Number 会报
  // "Only integers are allows for primary key values"。
  try { db.prepare('INSERT INTO vec_memory(rowid, embedding) VALUES (?, ?)').run(BigInt(r.rowid), v); return true; }
  catch (e) { console.log('    (seedVec 跳过:', e.message, ')'); return false; }
}
const hasVec = (project, memType, id) => {
  const db = DatabaseManager.getInstance(project, memType);
  const r = db.prepare('SELECT rowid FROM memory WHERE id = ?').get(id);
  if (!r) return false;
  try { return !!db.prepare('SELECT rowid FROM vec_memory WHERE rowid = ?').get(BigInt(r.rowid)); } catch { return false; }
};

console.log(`\n== C-1：保真契约分层（verbatim 全拒 / evidence 只拒不可追回的动作）==`);
{
  const t1 = '用户偏好：报告先给结论，再给过程，不要铺垫。';
  const t2 = '用户偏好：改动必须以真实命令输出为证据，不接受"看起来对"。';
  const a = await saveMemory({ text: t1, memType: 'user', category: 'preference', project: 'p_ev', characterId: 'test' });
  const b = await saveMemory({ text: t2, memType: 'user', category: 'preference', project: 'p_ev', characterId: 'test' });

  // (1) verbatim：任何路径都不得改写
  const av = await saveMemory({ text: t1, memType: 'user', project: 'p_verb', characterId: 'test' });
  const bv = await saveMemory({ text: t2, memType: 'user', project: 'p_verb', characterId: 'test' });
  const rv = await applyReflectActions(
    [{ action: 'merge', sourceIds: [av.id, bv.id], newText: '被压缩过的版本', newMemType: 'user' }],
    'test', 'p_verb', { automatic: true, consolidation: true },
  );
  check('verbatim 库 merge 被拒', rv.receipts?.[0]?.status === 'failed', JSON.stringify(rv.receipts));
  check('verbatim 拒绝原因提到 preservation policy',
    (rv.errors || []).some(e => String(e).includes('preservation policy')), JSON.stringify(rv.errors));
  check('verbatim 两条源仍 active', !!row('p_verb', 'user', av.id)?.is_active && !!row('p_verb', 'user', bv.id)?.is_active);

  // (2) evidence + 自动路径：delete 仍被拒（不可追回）
  const rd = await applyReflectActions(
    [{ action: 'delete', targetId: a.id, reason: '自动整合想删' }],
    'test', 'p_ev', { automatic: true, consolidation: true },
  );
  check('evidence 自动路径 delete 仍被拒', rd.receipts?.[0]?.status === 'failed', JSON.stringify(rd.receipts));
  check('evidence 两条源仍 active（delete 未生效）',
    !!row('p_ev', 'user', a.id)?.is_active && !!row('p_ev', 'user', b.id)?.is_active);

  // (3) evidence + 自动路径：merge 放行，但必须留痕（这是 v1.23-fix 与 C-1 的收敛点）
  const rm = await applyReflectActions(
    [{ action: 'merge', sourceIds: [a.id, b.id], newText: '用户要求：先结论后过程；改动须有真实命令证据。', newMemType: 'user', newCategory: 'preference' }],
    'test', 'p_ev', { automatic: true, consolidation: true },
  );
  check('evidence 自动路径 merge 放行（否则整合退化成逐条重摘要）',
    rm.receipts?.[0]?.status === 'applied', JSON.stringify(rm.receipts));
  const mergedEv = DatabaseManager.getInstance('p_ev', 'user')
    .prepare("SELECT * FROM memory WHERE source='reflect_merge' ORDER BY created_at DESC LIMIT 1").get();
  const evFrom = (() => { try { return JSON.parse(mergedEv?.merged_from || '[]'); } catch { return []; } })();
  check('放行的 merge 写了 merged_from（2 条源）', evFrom.length === 2, mergedEv?.merged_from);
  const srcA = row('p_ev', 'user', a.id);
  check('源行不再是 active、状态 superseded', srcA && Number(srcA.is_active) === 0 && srcA.status === 'superseded',
    JSON.stringify({ a: srcA?.is_active, s: srcA?.status }));
  check('源行指回合并结果（merged_into）', srcA?.merged_into === mergedEv?.id, `${srcA?.merged_into} vs ${mergedEv?.id}`);
}

console.log('\n== C-2：standard 库 merge 必须留痕 ==');
{
  const t1 = 'Castalia 的 search.ts 用 tags LIKE 做标签召回，向量 KNN 走 vec_memory 虚表。';
  const t2 = 'Castalia 的 search.ts 缺 BM25 词法通道，精确短语只能靠 LIKE 兜底。';
  const a = await saveMemory({ text: t1, memType: 'project', category: 'context', project: 'p_std', characterId: 'test' });
  const b = await saveMemory({ text: t2, memType: 'project', category: 'context', project: 'p_std', characterId: 'test' });
  const vecSeeded = seedVec('p_std', 'project', a.id) && seedVec('p_std', 'project', b.id);
  const res = await applyReflectActions(
    [{ action: 'merge', sourceIds: [a.id, b.id], newText: 'Castalia 检索：标签走 LIKE、向量走 vec_memory，缺 BM25 词法通道。', newMemType: 'project', newCategory: 'context' }],
    'test', 'p_std', { automatic: true },
  );
  check('standard 库 merge 成功', res.receipts?.[0]?.status === 'applied', JSON.stringify(res.receipts));
  const merged = DatabaseManager.getInstance('p_std', 'project')
    .prepare("SELECT * FROM memory WHERE source='reflect_merge' ORDER BY created_at DESC LIMIT 1").get();
  check('产生 merged_from（2 条源）', (() => {
    try { return JSON.parse(merged?.merged_from || '[]').length === 2; } catch { return false; }
  })(), merged?.merged_from);
  check('merged_from 精确等于源 id', (() => {
    try { return JSON.stringify(JSON.parse(merged.merged_from).sort()) === JSON.stringify([a.id, b.id].sort()); } catch { return false; }
  })());
  const quotes = (() => { try { return JSON.parse(merged?.merged_quotes || '[]'); } catch { return []; } })();
  check('merged_quotes 至少 1 条', quotes.length >= 1, JSON.stringify(quotes));
  check('每条引证都能在对应源正文里按子串找到', quotes.length > 0 && quotes.every(q => {
    const src = [a.id, b.id].includes(q.id) ? row('p_std', 'project', q.id) : null;
    return !!src && String(src.text).replace(/\s+/g, ' ').includes(q.q);
  }));
  check('merged 行有 valid_at', !!merged?.valid_at, merged?.valid_at);

  const sa = row('p_std', 'project', a.id);
  const sb = row('p_std', 'project', b.id);
  check('源行 is_active=0', sa?.is_active === 0 && sb?.is_active === 0);
  check('源行 status=superseded', sa?.status === 'superseded' && sb?.status === 'superseded', `${sa?.status}/${sb?.status}`);
  check('源行 expired_at 非空', !!sa?.expired_at && !!sb?.expired_at);
  check('源行 merged_into 指向结果', sa?.merged_into === merged.id && sb?.merged_into === merged.id);
  check('源行仍然存在（行没被删）', !!sa?.text && !!sb?.text);
  if (vecSeeded) {
    check('源行向量被保留（旧实现会 DELETE）', hasVec('p_std', 'project', a.id) && hasVec('p_std', 'project', b.id));
  } else {
    console.log('  ⚠️ seedVec 不可用，跳过向量保留断言');
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
try { DatabaseManager.closeAll?.(); } catch { /* 旧版无此方法 */ }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { console.log('（临时库未删除：' + TMP + '）'); }
process.exit(fail === 0 ? 0 : 1);
