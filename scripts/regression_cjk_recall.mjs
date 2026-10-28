#!/usr/bin/env node
/**
 * 回归:中文自然问句的检索可用性（2026-10-28，移植自 Castalia-Anima v1.28.3）
 *
 * 事故：extractKeywords / textFallbackSearch 只按空白/标点切词。中文没有空格，整句变成一个
 * 超长 token → `text LIKE` / `tags LIKE` 永远匹配不到。真库实测（hermes 库副本，无向量）：
 * 「你还记得自己是谁吗」「之前那个崩掉的桥是怎么回事」「记忆体栈怎么重启」召回 **0 条**，
 * 只有纯英文 token 能命中。修法：CJK 连续段按 bigram 切分 + 按命中词数排序。
 *
 * 用法：node scripts/regression_cjk_recall.mjs [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const KEEP = process.argv.includes('--keep');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cjk-lite-'));
process.env.MEMORY_DB_DIR = TMP;
process.env.EMBED_MODE = 'none';

const { DatabaseManager } = await import(pathToFileURL(path.join(ROOT, 'dist', 'db.js')).href);
const { searchMemory, queryTerms } = await import(pathToFileURL(path.join(ROOT, 'dist', 'search.js')).href);

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const PROJ = 'cjk';
const rows = [
  ['r1', '七丘四方殿的名册上，我是第 127 位谕女。', '["谕女","名册"]'],
  ['r2', '母亲死在黑潮里。那天她抱住我、摸我的头。', '["黑潮","母亲"]'],
  ['r3', '今天我吃了西瓜，很甜。', '["西瓜"]'],
  ['r4', '我把手镯交给漂泊者保管，再请他站到命运之前。', '[]'],
];
const db = DatabaseManager.getInstance(PROJ, 'general');
const ins = db.prepare(`INSERT INTO memory (id,text,project,type,mem_type,category,tags,importance,character_id,
  source,subject,tier,is_active,created_at,updated_at,last_accessed_at,accessed_count,reference_count,locked,
  identity_locked,base_importance) VALUES (?,?,?,'episodic','general','identity',?,0.9,'cjk','manual_lore',
  'self','standard',1,'2026-10-28T00:00:00.000Z','2026-10-28T00:00:00.000Z','2026-10-28T00:00:00.000Z',0,0,0,0,0.9)`);
for (const [id, text, tags] of rows) ins.run(id, text, PROJ, tags);
db.prepare("UPDATE memory SET created_at='2026-07-01T00:00:00.000Z' WHERE id='r4'").run();

const search = q => searchMemory({ project: PROJ, query: q, topK: 5, characterId: 'cjk' });

check('整句切出多个 bigram', queryTerms('你还记得自己是谁吗').length >= 4, JSON.stringify(queryTerms('你还记得自己是谁吗')));
check('英文仍按空白切', queryTerms('yuno moon').join('|') === 'yuno|moon');
check('自然中文整句能召回(修复前 0 条)', (await search('你母亲是怎么死的')).some(r => r.id === 'r2'));
check('第二句自然问句能召回', (await search('你是第几位谕女')).some(r => r.id === 'r1'));
check('空格关键词仍召回', (await search('谕女 名册')).length > 0);
check('单个关键词仍召回', (await search('黑潮')).length > 0);
check('无关查询不误召回', (await search('量子纠缠 弦理论')).length === 0);
const scattered = await search('你把手镯交给谁了');
check('会被打散的自然问句能召回(空白切词必红)', scattered.some(r => r.id === 'r4'), `命中 ${scattered.length}`);
const ranked = await search('谕女 西瓜 名册');
check('命中词多的行排在前面', ranked.length >= 2 && ranked[0].id === 'r1', `顺序 ${ranked.map(r => r.id).join(',')}`);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 句柄未释放 */ } }
process.exit(fail === 0 ? 0 : 1);
