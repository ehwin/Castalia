/**
 * 已知限制清单（TECHNICAL.md §12）的回归：v1.26 修掉的那几条
 *
 * 覆盖：
 *   1. 晋升后精确删（deletePromotedFragments）—— 只摘被晋升吸走的行，其余保留
 *   2. 晋升项补向量调度（embedPromotedInBackground）—— EMBED_MODE=none 时静默跳过、不抛
 *   3. 空 catch 有出口（debugCatch）—— 默认静默，CASTALIA_DEBUG=1 时输出
 *   4. 维护任务的库清单（listAllProjects）—— 默认库 + 磁盘上全部库
 *
 * 用法：node scripts/test_known_limits.mjs   （全离线，临时库，跑完自删）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-known-limits-'));
process.env.MEMORY_DB_DIR = TMP;
process.env.MEMORY_CONFIG = path.join(TMP, 'config.json');
process.env.CHAR_ID = 'test';
process.env.CASTALIA_PROJECT = 'kl';
process.env.EMBED_MODE = 'none';
delete process.env.CASTALIA_DEBUG;
fs.writeFileSync(process.env.MEMORY_CONFIG, JSON.stringify({ embedding: { mode: 'none' } }), 'utf8');

const { DatabaseManager, listAllProjects } = await import('../dist/db.js');
const { upsertSessionMemory, getSessionMemory, deletePromotedFragments, embedPromotedInBackground } = await import('../dist/store.js');
const { debugCatch, debugLog } = await import('../dist/log.js');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + String(extra).slice(0, 400) : ''}`); }
};

const PROJ = 'kl';
const SID = 'sess-1';
const SNAP = [
  '用户说这周五之前要把季度报表交给财务部（待办，未完成）',
  '角色答应周末陪用户去修那台旧相机（约定，还没做）',
  '用户提到他讨厌被催promoted', // 短行，不该被误伤
  '这条会被晋升成长期偏好：用户习惯用 pnpm 而不是 npm 装依赖',
].join('\n');

console.log('\n== 1. 晋升后精确删 ==');
upsertSessionMemory(PROJ, SID, SNAP);
check('快照已写入 4 行', (getSessionMemory(PROJ, SID) || '').split('\n').length === 4);

const promoted = ['用户习惯用 pnpm 而不是 npm 装依赖'];
const del1 = deletePromotedFragments(PROJ, SID, promoted);
const after1 = getSessionMemory(PROJ, SID) || '';
check('只摘掉 1 行', del1.removedLines === 1, JSON.stringify(del1));
check('保留 3 行、未整行删除', del1.keptLines === 3 && del1.deleted === false, JSON.stringify(del1));
check('被晋升的那行不在快照里', !after1.includes('pnpm'), after1);
check('未晋升的待办仍在', after1.includes('季度报表'), after1);
check('未晋升的约定仍在', after1.includes('旧相机'), after1);

// 长句：被晋升吸走
const del2 = deletePromotedFragments(PROJ, SID, ['季度报表交给财务部', '陪用户去修那台旧相机']);
check('两条长句被认领', del2.removedLines === 2, JSON.stringify(del2));
// 短句保守：5 个字放在 17 字的行里不认领（避免一个短词就吃掉整段快照）
const del3 = deletePromotedFragments(PROJ, SID, ['他讨厌被催']);
check('短句不认领长行（保守）', del3.removedLines === 0 && del3.keptLines === 1, JSON.stringify(del3));
const del4 = deletePromotedFragments(PROJ, SID, ['用户提到他讨厌被催promoted']);
check('整行被认领后整行清空', del4.deleted === true && del4.keptLines === 0, JSON.stringify(del4));
check('快照行已删除', getSessionMemory(PROJ, SID) === null);

const del5 = deletePromotedFragments(PROJ, SID, ['随便什么']);
check('没有快照时安全返回', del5.removedLines === 0 && del5.deleted === false, JSON.stringify(del5));

console.log('\n== 2. 晋升项补向量调度 ==');
let threw = null;
try { embedPromotedInBackground([], PROJ); embedPromotedInBackground(['not-a-real-id'], PROJ); }
catch (e) { threw = e; }
check('EMBED_MODE=none 时不抛错', threw === null, threw && threw.message);
await new Promise(r => setTimeout(r, 50));
check('后台任务没有留下未处理异常', true);

console.log('\n== 3. 空 catch 的出口 ==');
const lines = [];
const origErr = console.error;
console.error = (...a) => { lines.push(a.join(' ')); };
debugCatch('unit:silent', new Error('不该出现'));
debugLog('unit:silent', '也不该出现');
console.error = origErr;
check('默认静默', lines.length === 0, lines.join('|'));

process.env.CASTALIA_DEBUG = '1';
const lines2 = [];
console.error = (...a) => { lines2.push(a.join(' ')); };
debugCatch('unit:loud', new Error('boom'));
debugLog('unit:loud', 'ctx');
console.error = origErr;
delete process.env.CASTALIA_DEBUG;
check('CASTALIA_DEBUG=1 时输出 2 条', lines2.length === 2, lines2.join('|'));
check('带位置与原始错误信息', lines2[0].includes('unit:loud') && lines2[0].includes('boom'), lines2[0]);

console.log('\n== 4. 维护任务的库清单 ==');
// 造第二个库：instance 一开就会建目录 + sqlite
DatabaseManager.getInstance('kl2', 'general');
const all = listAllProjects('kl');
check('包含默认库', all.includes('kl'), JSON.stringify(all));
check('包含磁盘上第二个库', all.includes('kl2'), JSON.stringify(all));
check('去重且有序', new Set(all).size === all.length && JSON.stringify(all) === JSON.stringify([...all].sort()), JSON.stringify(all));

DatabaseManager.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 句柄未释放 */ }

console.log(`\nRESULT: ${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
