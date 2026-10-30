/**
 * MCP 面回归：includeDerived 与 provenance 字段（v1.27）
 *
 * 用法：node scripts/test_provenance_mcp.mjs
 * 真起一个 dist/index.js 子进程，用 JSON-RPC over stdio 驱动。
 * 全离线：EMBED_MODE=none，不需要嵌入服务与 LLM key。
 *
 * 断言：
 *   M1 以 reflect_summary 写入的行，memory_search 默认不返回
 *   M2 includeDerived=true 时返回，且结果带 derived=true / source
 *   M3 memory_get 完整带出 derived / generatedBy / evidenceIds / evidenceKey
 *   M4 stats_get 暴露 derivedCount
 *   M5 memory_list 默认不列派生行，includeDerived=true 才列
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, '..', 'dist', 'index.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-provmcp-'));
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
  reflect: { preservation: 'standard' },
  embedding: { mode: 'none' },
}, null, 1), 'utf8');

const child = spawn(process.execPath, [ENTRY], {
  env: {
    ...process.env,
    MEMORY_DB_DIR: TMP,
    MEMORY_CONFIG: path.join(TMP, 'config.json'),
    CHAR_ID: 'pm', CASTALIA_PROJECT: 'pm', EMBED_MODE: 'none', MCP_TOOLS: 'all',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const waiters = new Map();
let nextId = 1;
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && waiters.has(msg.id)) {
      const { resolve, reject } = waiters.get(msg.id);
      waiters.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  }
});
const stderr = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', c => stderr.push(c));

const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  waiters.set(id, { resolve, reject });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); reject(new Error('timeout: ' + method)); } }, 20000);
});
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
const callTool = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = (r?.content || []).map(c => c.text).join('');
  try { return JSON.parse(text); } catch { return { raw: text }; }
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
};

try {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'provenance-mcp-test', version: '1.0' },
  });
  notify('notifications/initialized', {});

  const evidence = await callTool('memory_save', { text: '证据：用户要求先构建再汇报。', category: 'conversation', source: 'manual', project: 'pm' });
  const evidenceId = evidence.results?.id || evidence.result?.id || evidence.id;
  check('证据写入', !!evidenceId, JSON.stringify(evidence).slice(0, 200));

  const derived = await callTool('memory_save', {
    text: '派生叙述：用户在交付上强调可验证性。',
    category: 'knowledge', source: 'reflect_summary', project: 'pm',
  });
  const derivedId = derived.results?.id || derived.result?.id || derived.id;
  check('派生行写入', !!derivedId, JSON.stringify(derived).slice(0, 200));

  console.log('\n[M1] 默认策略 = demoted');
  const plain = await callTool('memory_search', { query: '强调可验证性', project: 'pm', topK: 10 });
  const hit = (plain.results || []).find(r => r.id === derivedId);
  check('默认 search 仍返回派生行（导航层保留）', !!hit, JSON.stringify((plain.results || []).map(r => r.id)));
  check('结果带 derived=true', hit?.derived === true, JSON.stringify(hit));
  check('结果带 source', hit?.source === 'reflect_summary', JSON.stringify(hit?.source));

  console.log('\n[M2] derivedPolicy');
  const only = await callTool('memory_search', { query: '强调可验证性', project: 'pm', topK: 10, derivedPolicy: 'only' });
  check("only 只回派生行", (only.results || []).length > 0 && (only.results || []).every(r => r.derived === true), JSON.stringify((only.results || []).map(r => r.id)));
  const excluded = await callTool('memory_search', { query: '强调可验证性', project: 'pm', topK: 10, derivedPolicy: 'excluded' });
  check("excluded 完全隐藏", !(excluded.results || []).some(r => r.id === derivedId), JSON.stringify((excluded.results || []).map(r => r.id)));
  const demotedScore = hit?.score;
  const rawScore = (only.results || []).find(r => r.id === derivedId)?.score;
  check('demoted 分数低于不降权', typeof demotedScore === 'number' && typeof rawScore === 'number' && demotedScore < rawScore, `${demotedScore} vs ${rawScore}`);

  console.log('\n[M3] memory_get provenance');
  const got = await callTool('memory_get', { id: derivedId, project: 'pm' });
  const res = got.result || {};
  check('get 返回 derived=true', res.derived === true, JSON.stringify(res.derived));
  check('get 返回 generatedBy', res.generatedBy === 'reflect_summary', JSON.stringify(res.generatedBy));
  check('get 返回 evidenceIds 数组', Array.isArray(res.evidenceIds), JSON.stringify(res.evidenceIds));
  // 无证据集合时没有幂等键（不能拿"空集合"误去重），所以这里是 null 才是对的
  check('get 返回 evidenceKey（无证据 → null）', res.evidenceKey === null, JSON.stringify(res.evidenceKey));

  console.log('\n[M4] stats_get');
  const stats = await callTool('stats_get', { project: 'pm' });
  check('stats 暴露 derivedCount', stats.derivedCount >= 1, JSON.stringify(stats.derivedCount));
  check('total 仍包含派生行（口径不变）', stats.total >= 2, JSON.stringify(stats.total));

  console.log('\n[M5] memory_list');
  const listPlain = await callTool('memory_list', { limit: 50, project: 'pm' });
  const listed = (listPlain.results || []).find(r => r.id === derivedId);
  check('默认 list 列全部并标 derived', !!listed && listed.derived === true, JSON.stringify((listPlain.results || []).map(r => `${r.id.slice(0, 6)}:${r.derived}`)));
  const listExcluded = await callTool('memory_list', { limit: 50, project: 'pm', derivedPolicy: 'excluded' });
  check("excluded 只列证据", !(listExcluded.results || []).some(r => r.id === derivedId), JSON.stringify((listExcluded.results || []).map(r => r.id)));
  const listOnly = await callTool('memory_list', { limit: 50, project: 'pm', derivedPolicy: 'only' });
  check("only 只列叙述", (listOnly.results || []).length > 0 && (listOnly.results || []).every(r => r.derived === true), JSON.stringify((listOnly.results || []).map(r => r.id)));
} catch (e) {
  fail++;
  console.log('  ❌ 异常：' + e.message);
  console.log(stderr.join('').split('\n').slice(-15).join('\n'));
} finally {
  child.kill();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
process.exit(fail === 0 ? 0 : 1);
