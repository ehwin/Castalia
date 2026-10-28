/**
 * v1.24 词法通道（FTS5 trigram + BM25）回归
 *
 * 覆盖：外部内容表 + 触发器同步、精确短语命中、superseded 过滤、
 *       短词回落 LIKE、项目隔离、更新/删除后索引跟随。
 * 用法：../run/Castalia/bin/CastaliaNode.exe scripts/test_lexical.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-lex-'));
process.env.MEMORY_DB_DIR = TMP;
process.env.MEMORY_CONFIG = path.join(TMP, 'config.json');
process.env.CHAR_ID = 'test';
process.env.CASTALIA_PROJECT = 'lex';
process.env.EMBED_MODE = 'none';
fs.writeFileSync(process.env.MEMORY_CONFIG, JSON.stringify({ embedding: { mode: 'none' } }), 'utf8');

const { DatabaseManager } = await import('../dist/db.js');
const { saveMemory, updateMemory, forgetMemory } = await import('../dist/store.js');
const { searchMemory } = await import('../dist/search.js');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + String(extra).slice(0, 260) : ''}`); }
};

const src = `乾卦九五：飞龙在天，利见大人。`;
const a = await saveMemory({ text: src + '（《周易》乾卦，九五爻辞，断语取"圣人作而万物睹"）', project: 'lex', memType: 'reference', category: '经典', tags: ['易经', '乾卦'], importance: 0.9 });
const b = await saveMemory({ text: '构建失败：TS2345 Argument of type PROMPT_BUDGET is not assignable', project: 'lex', memType: 'project', category: 'debug', tags: ['构建'], importance: 0.6 });
const c = await saveMemory({ text: '无关记录：今天天气不错，适合出门散步。', project: 'lex', memType: 'general', category: 'misc', tags: ['日常'], importance: 0.3 });
const d = await saveMemory({ text: src + '（旧版已作废的重复条目）', project: 'lex', memType: 'general', category: 'misc', tags: ['易经'], importance: 0.4 });
await saveMemory({ text: src + '（别的项目：不该被 lex 搜到）', project: 'obra', memType: 'general', category: 'misc', tags: ['易经'] });

const db = DatabaseManager.getInstance('lex', 'reference');
console.log('\n== 索引存在性 ==');
check('memory_fts 已建', !!db.prepare("SELECT name FROM sqlite_master WHERE name='memory_fts'").get());
const trigs = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_memory_fts%'").all().map(r => r.name);
check('三个同步触发器都在', ['trg_memory_fts_ai', 'trg_memory_fts_au', 'trg_memory_fts_ad'].every(t => trigs.includes(t)), trigs.join(','));

// 把 d 标成 superseded（模拟被合并/取代）
const dbG = DatabaseManager.getInstance('lex', 'general');
dbG.prepare("UPDATE memory SET status='superseded', is_active=0 WHERE id=?").run(d.id);

console.log('\n== 精确短语（FTS 通道）==');
const r1 = await searchMemory({ query: '飞龙在天', project: 'lex', topK: 5 });
check('4 字原文命中', r1.some(r => r.id === a.id), JSON.stringify(r1.map(r => [r.id.slice(0, 6), r.similarity])));
check('命中的是 reference 库那条、相似度 ≥0.8', r1[0]?.id === a.id && r1[0].similarity >= 0.8, JSON.stringify(r1[0] && { id: r1[0].id, sim: r1[0].similarity, mt: r1[0].memType }));
const r1b = await searchMemory({ query: '飞龙在天', project: 'lex', topK: 5, memType: 'general' });
check('superseded 行被过滤（general 库只剩 c）', !r1b.some(r => r.id === d.id) && r1b.every(r => r.id !== a.id), JSON.stringify(r1b.map(r => r.id)));

const r2 = await searchMemory({ query: 'PROMPT_BUDGET', project: 'lex', topK: 5 });
check('错误码/标识符命中', r2[0]?.id === b.id, JSON.stringify(r2.map(r => [r.id.slice(0, 6), r.similarity])));

console.log('\n== 短词回落 ==');
const r3 = await searchMemory({ query: '飞龙', project: 'lex', topK: 5 });
check('2 字中文不走 FTS 但由 LIKE 兜住', r3.some(r => r.id === a.id), JSON.stringify(r3.map(r => [r.id.slice(0, 6), r.similarity])));

console.log('\n== 项目隔离 ==');
const r4 = await searchMemory({ query: '飞龙在天', project: 'obra', topK: 5 });
check('别的项目只能看到自己的那条', r4.length === 1 && r4[0].id !== a.id && r4[0].project === 'obra', JSON.stringify(r4.map(r => [r.id.slice(0, 6), r.project])));

console.log('\n== 触发器跟随更新 ==');
await updateMemory(a.id, { text: '坤卦六二：直方大，不习无不利。（已替换原文）' });
const r5 = await searchMemory({ query: '飞龙在天', project: 'lex', topK: 5 });
check('改正文后旧短语不再命中该行', !r5.some(r => r.id === a.id), JSON.stringify(r5.map(r => r.id.slice(0, 6))));
const r6 = await searchMemory({ query: '不习无不利', project: 'lex', topK: 5 });
check('改正文后新短语立刻命中（FTS 增量同步）', r6.some(r => r.id === a.id), JSON.stringify(r6.map(r => r.id.slice(0, 6))));

console.log('\n== 软删与硬删 ==');
forgetMemory(b.id, 'lex');
const r7 = await searchMemory({ query: 'PROMPT_BUDGET', project: 'lex', topK: 5 });
check('软删后不再出现在结果里', !r7.some(r => r.id === b.id), JSON.stringify(r7.map(r => r.id.slice(0, 6))));
dbG.prepare('DELETE FROM memory WHERE id=?').run(c.id);
const r8 = await searchMemory({ query: '天气不错', project: 'lex', topK: 5 });
check('硬删后索引跟着删（查不到、也不报错）', Array.isArray(r8) && !r8.some(r => r.id === c.id), JSON.stringify(r8.map(r => r.id.slice(0, 6))));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { console.log('（临时库未删除：' + TMP + '）'); }
process.exit(fail === 0 ? 0 : 1);
