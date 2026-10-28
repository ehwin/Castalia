/**
 * 工具事件（A-1）回归：ingest / 去重 / FTS+LIKE 双通道检索 / 统计
 *
 * 用法：../run/Castalia/bin/CastaliaNode.exe scripts/test_events.mjs
 * 全离线（EMBED_MODE=none，不需要 LLM key / 嵌入服务），临时库，跑完自删。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-events-'));
process.env.MEMORY_DB_DIR = TMP;
process.env.MEMORY_CONFIG = path.join(TMP, 'config.json');
process.env.CHAR_ID = 'test';
process.env.CASTALIA_PROJECT = 'ev';
process.env.EMBED_MODE = 'none';
fs.writeFileSync(process.env.MEMORY_CONFIG, JSON.stringify({ embedding: { mode: 'none' } }), 'utf8');

const { DatabaseManager } = await import('../dist/db.js');
const { ingestEvents, searchEvents, eventStats, ensureEventSchema } = await import('../dist/events.js');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + String(extra).slice(0, 300) : ''}`); }
};

const now = new Date().toISOString();
const base = [
  { toolName: 'terminal', callId: 'call_1', argsDigest: 'git status --porcelain && git log --oneline -3', exitCode: 0, status: 'ok', resultChars: 400, sessionId: 's1', at: now },
  { toolName: 'terminal', callId: 'call_2', argsDigest: 'netstat -ano | grep :3316', exitCode: 1, status: 'error', errorHead: 'grep: no match', resultChars: 20, sessionId: 's1', at: now },
  { toolName: 'patch', callId: 'call_3', argsDigest: 'patch src/reflect.ts | old: const mergeAllowedByConsolidation', exitCode: undefined, status: 'ok', resultChars: 200, sessionId: 's1', at: now },
  { toolName: 'events_ingest', callId: 'call_4', argsDigest: '工具事件去重测试：端口 3316 的桥', exitCode: 0, status: 'ok', resultChars: 10, sessionId: 's2', at: now },
  { toolName: 'terminal', callId: 'call_5', argsDigest: 'python -c "print(1)"', exitCode: 0, status: 'ok', resultChars: 3, sessionId: 's2', at: now },
];

console.log('\n== ingest ==');
const r1 = ingestEvents(base, { project: 'ev', characterId: 'test' });
check('首次写入 5 条', r1.inserted === 5, JSON.stringify(r1));
check('FTS5 可用', r1.fts === true, String(r1.fts));

const r2 = ingestEvents([{ ...base[0] }], { project: 'ev' });
check('同一 callId 重复写入被跳过', r2.inserted === 0 && r2.skipped === 1, JSON.stringify(r2));
const total = DatabaseManager.getInstance('ev', 'general').prepare('SELECT COUNT(*) c FROM tool_events').get().c;
check('库里仍是 5 条（没有重复行）', total === 5, String(total));

console.log('\n== 检索 ==');
const s1 = searchEvents('git status', { project: 'ev' });
check('英文命令走 FTS 命中', s1.mode === 'fts' && s1.rows.some(r => r.callId === 'call_1'), JSON.stringify({ mode: s1.mode, n: s1.rows.length }));
const s2 = searchEvents('mergeAllowedByConsolidation', { project: 'ev' });
check('长英文标识符命中 patch 事件', s2.rows.some(r => r.callId === 'call_3'), JSON.stringify(s2.rows.map(r => r.callId)));
const s3 = searchEvents('端口', { project: 'ev' });
check('2 字中文走 LIKE 命中', s3.mode === 'like' && s3.rows.some(r => r.callId === 'call_4'), JSON.stringify({ mode: s3.mode, n: s3.rows.length }));
const s4 = searchEvents('3316', { project: 'ev' });
check('数字短语命中', s4.rows.length >= 1, JSON.stringify(s4.rows.map(r => r.argsDigest)));
const s5 = searchEvents('', { project: 'ev', tool: 'terminal' });
check('空查询 + tool 过滤 = 最近事件', s5.mode === 'recent' && s5.rows.length === 3 && s5.rows.every(r => r.toolName === 'terminal'),
  JSON.stringify(s5.rows.map(r => r.toolName)));
const s6 = searchEvents('', { project: 'ev', sessionId: 's2' });
check('按 session 过滤', s6.rows.length === 2 && s6.rows.every(r => r.sessionId === 's2'), String(s6.rows.length));
const s7 = searchEvents('不存在的关键词zzz', { project: 'ev' });
check('查不到时返回空而不是报错', Array.isArray(s7.rows) && s7.rows.length === 0, JSON.stringify(s7));

console.log('\n== 统计 ==');
const st = eventStats('ev', 7);
check('统计总数 5', st.total === 5, JSON.stringify(st));
check('errorRate = 0.2', Math.abs(st.errorRate - 0.2) < 1e-9, String(st.errorRate));
check('byTool 聚合正确', st.byTool[0].tool === 'terminal' && st.byTool[0].n === 3, JSON.stringify(st.byTool));

console.log('\n== 隔离 ==');
const other = searchEvents('git status', { project: 'other' });
check('别的项目查不到（项目隔离）', other.rows.length === 0);
const dbOther = DatabaseManager.getInstance('other', 'general');
ensureEventSchema(dbOther);
check('另一个项目库是独立空表', dbOther.prepare('SELECT COUNT(*) c FROM tool_events').get().c === 0);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { console.log('（临时库未删除：' + TMP + '）'); }
process.exit(fail === 0 ? 0 : 1);
