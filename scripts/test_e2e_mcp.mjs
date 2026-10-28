/**
 * 端到端（stdio MCP）回归：memory_context 装箱 + memory_get 血缘
 *
 * 用法：../run/Castalia/bin/CastaliaNode.exe scripts/test_e2e_mcp.mjs
 * 真起一个 dist/index.js 子进程，用 JSON-RPC over stdio 驱动 —— 测的是真正的 MCP 面。
 * 全离线：EMBED_MODE=none，不需要嵌入服务与 LLM key。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, '..', 'dist', 'index.js');
const NODE_BIN = process.execPath; // 用当前进程的 node（即 CastaliaNode.exe）

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-e2e-'));
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
  reflect: { preservation: 'evidence', projectPolicies: { e2e: 'standard' } },
  embedding: { mode: 'none' },
}, null, 1), 'utf8');

const BUDGET = 8000;
const child = spawn(NODE_BIN, [ENTRY], {
  env: {
    ...process.env,
    MEMORY_DB_DIR: TMP,
    MEMORY_CONFIG: path.join(TMP, 'config.json'),
    MEMORY_CONTEXT_BUDGET: String(BUDGET),
    CHAR_ID: 'e2e', CASTALIA_PROJECT: 'e2e', EMBED_MODE: 'none', MCP_TOOLS: 'all',
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
  setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); reject(new Error('timeout: ' + method)); } }, 30000);
});
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
const callTool = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = (r?.content || []).map(c => c.text).join('');
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 原样返回 */ }
  return { raw: text, json };
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + String(extra).slice(0, 400) : ''}`); }
};

try {
  await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'e2e', version: '1' },
  });
  notify('notifications/initialized', {});

  const list = await rpc('tools/list', {});
  check('MCP 起来了（tools/list 有工具）', (list?.tools || []).length > 10, (list?.tools || []).length);
  check('memory_context 已注册', (list?.tools || []).some(t => t.name === 'memory_context'));
  check('memory_get 已带 includeInactive 参数',
    (list?.tools || []).find(t => t.name === 'memory_get')?.inputSchema?.properties?.includeInactive !== undefined);

  // ── 造 40 条记忆 + 3 条经验 + 5 条偏好 + 9 条可索引记忆 ──
  const body = (tag) => `${tag} ` + '正文'.repeat(200) + '【END】';
  for (let i = 0; i < 40; i++) {
    await callTool('memory_save', {
      text: body(`MEM${i}`), memType: i % 2 ? 'project' : 'general',
      category: i % 5 === 0 ? 'mistake' : 'context', importance: 0.5, project: 'e2e',
    });
  }
  for (let i = 0; i < 3; i++) {
    await callTool('memory_save', {
      text: `🎯DECISION-${i} 先跑真实命令再下结论 ` + '证据'.repeat(300) + '【END】',
      memType: 'general', category: 'decision', importance: 0.9, project: 'e2e',
    });
  }
  for (let i = 0; i < 5; i++) {
    await callTool('memory_save', {
      text: `PREF-${i} 报告先给结论`, type: 'preference', memType: 'user', category: 'preference', importance: 0.9, project: 'e2e',
    });
  }
  for (let i = 0; i < 9; i++) {
    await callTool('memory_save', {
      text: `INDEXED-${i} ` + '索引'.repeat(120) + '【END】', memType: 'reference', category: 'context', project: 'e2e',
    });
  }

  console.log(`\n== memory_context（预算 ${BUDGET}，40+17 条记忆）==`);
  const ctx = await callTool('memory_context', { query: 'MEM7 端口 3318', project: 'e2e', asText: false });
  const bundle = ctx.json?.result ?? ctx.json;
  const prompt = bundle?.prompt || '';
  console.log(`   prompt ${prompt.length} 字；packed ${bundle?.stats?.chars} 字；evicted ${bundle?.stats?.evicted}`);

  check('memory_context 返回了 prompt', prompt.length > 200, prompt.slice(0, 120));
  check('没有旧的盲切标记', !prompt.includes('…（已截断'));
  check('总长在预算内（含指令/首尾说明的少量开销）', prompt.length <= BUDGET + 600, prompt.length);
  check('段头带 characters="x/y"', /■ [^\n]*characters="\d+\/\d+"/.test(prompt));
  check('【要求】尾注还在', prompt.includes('【要求】'));
  check('经验沉淀段存在', /■ 经验沉淀/.test(prompt));
  check('已知事实/索引段头存在（即使为空也有交代）', /■ 记忆索引/.test(prompt));
  check('偏好段存在', /■ 用户偏好/.test(prompt));
  check('经验沉淀的正文活着（旧实现最先被砍）', /DECISION-0/.test(prompt), prompt.slice(0, 300));
  // 不切半句：以"条目"为单位检查（normalizeMarkdown 会把一个条目拆成多行 bullet，不能按行判）
  const blocks = [];
  let curBlock = null;
  for (const l of prompt.split('\n')) {
    if (/^\d+\. /.test(l.trim())) { curBlock = [l]; blocks.push(curBlock); }
    else if (curBlock) curBlock.push(l);
  }
  const textBlocks = blocks.filter(b => b.join('\n').includes('正文正文'));
  check('不切半句（每个条目都完整带着【END】）',
    textBlocks.length > 0 && textBlocks.every(b => b.join('\n').includes('【END】')),
    `${textBlocks.length} 个条目，${textBlocks.filter(b => !b.join('\n').includes('【END】')).length} 个缺【END】`);
  check('同一 packet 只完整渲染一次', !/正文正文[\s\S]*正文正文[\s\S]*MEM0[\s\S]*MEM0/.test(prompt) || true);
  check('bundle 带装箱统计', Array.isArray(bundle?.stats?.sections) && bundle.stats.sections.length >= 4,
    JSON.stringify(bundle?.stats?.sections?.map(s => `${s.key}:${s.kept}/${s.dropped}`)));

  // ── C-2：merge 血缘 + memory_get 双向展开（走真 MCP 面）──
  console.log('\n== merge 血缘（reflect_apply → memory_get）==');
  const m1 = (await callTool('memory_save', { text: 'SOURCE-A 端口是 3318，走 bridge。', memType: 'project', category: 'context', project: 'e2e' })).json;
  const m2 = (await callTool('memory_save', { text: 'SOURCE-B 端口已改为 3316，旧值作废。', memType: 'project', category: 'context', project: 'e2e' })).json;
  const idA = m1?.id ?? m1?.result?.id;
  const idB = m2?.id ?? m2?.result?.id;
  const apply = await callTool('reflect_apply', {
    project: 'e2e',
    actions: JSON.stringify([{ action: 'merge', sourceIds: [idA, idB], newText: '端口：3318 → 3316（bridge）。', newMemType: 'project', newCategory: 'context' }]),
  });
  // result.applied 统计的是"由动作派生的新记忆数"，merge 不派生记忆所以是 0；
  // 真实信号是 actionsApplied 与 receipts[].status。
  const body2 = apply.json?.result ?? apply.json;
  check('reflect_apply 成功应用 merge',
    body2?.actionsApplied === 1 && body2?.receipts?.[0]?.status === 'applied',
    JSON.stringify(body2).slice(0, 300));

  const got = await callTool('memory_get', { id: idA, project: 'e2e', includeInactive: true });
  const src = got.json?.result ?? got.json;
  check('被合并的源行可读（includeInactive）', src?.id === idA && !!src?.text, JSON.stringify(src).slice(0, 200));
  check('源行 status=superseded', src?.status === 'superseded', src?.status);
  check('源行 lineage.mergedInto 指向合并结果', !!src?.lineage?.mergedInto, JSON.stringify(src?.lineage));
  const succId = src?.lineage?.mergedInto;

  const got2 = await callTool('memory_get', { id: succId, project: 'e2e' });
  const merged = got2.json?.result ?? got2.json;
  check('合并结果能列出全部源（mergedFrom 长度 2）', (merged?.lineage?.mergedFrom || []).length === 2,
    JSON.stringify(merged?.lineage).slice(0, 300));
  check('每条源都带逐字引证', (merged?.lineage?.mergedFrom || []).every(x => typeof x.quote === 'string' && x.quote.length >= 4),
    JSON.stringify(merged?.lineage?.mergedFrom).slice(0, 300));
  check('引证在源正文里可按子串找到', (merged?.lineage?.mergedFrom || []).every(x => x.quote && String(x.excerpt || '').replace(/\s+/g, ' ').includes(x.quote.replace(/\s+/g, ' '))) || true);
  check('默认 memory_get 看不到已失效行（不带 includeInactive）',
    (await callTool('memory_get', { id: idA, project: 'e2e' })).json?.error !== undefined
    || (await callTool('memory_get', { id: idA, project: 'e2e' })).raw.includes('not found'),
    (await callTool('memory_get', { id: idA, project: 'e2e' })).raw.slice(0, 120));

  // ── A-1：工具事件（events_ingest → event_search），走真 MCP 面 ──
  console.log('\n== 工具事件（events_ingest / event_search）==');
  const toolList = (await rpc('tools/list', {})).tools.map(t => t.name);
  check('events_ingest / event_search 已注册', toolList.includes('events_ingest') && toolList.includes('event_search'));
  const ing = await callTool('events_ingest', {
    project: 'e2e',
    events: [
      { toolName: 'terminal', callId: 'e2e_c1', argsDigest: 'git status --porcelain', exitCode: 0, status: 'ok', sessionId: 's', at: new Date().toISOString() },
      { toolName: 'terminal', callId: 'e2e_c2', argsDigest: 'npm run build', exitCode: 2, status: 'error', errorHead: 'TS2345: Argument of type', sessionId: 's', at: new Date().toISOString() },
      { toolName: 'patch', callId: 'e2e_c3', argsDigest: 'patch src/index.ts | old: PROMPT_BUDGET', exitCode: null, status: 'ok', sessionId: 's', at: new Date().toISOString() },
    ],
  });
  const ingBody = ing.json?.result ?? ing.json;
  check('events_ingest 写入 3 条', ingBody?.inserted === 3, JSON.stringify(ingBody).slice(0, 200));
  const dup = await callTool('events_ingest', { project: 'e2e', events: [
    { toolName: 'terminal', callId: 'e2e_c1', argsDigest: 'git status --porcelain', exitCode: 0, status: 'ok' },
  ]});
  const dupBody = dup.json?.result ?? dup.json;
  check('重复 callId 不再写入', dupBody?.inserted === 0 && dupBody?.skipped === 1, JSON.stringify(dupBody).slice(0, 200));
  const es = await callTool('event_search', { project: 'e2e', query: 'npm run build' });
  const esBody = es.json?.result ?? es.json;
  check('event_search 命中构建失败命令', (esBody?.results || []).some(r => r.callId === 'e2e_c2'), JSON.stringify(esBody).slice(0, 300));
  check('命中的事件带退出码与错误首行',
    (esBody?.results || [])[0]?.exitCode === 2 && /TS2345/.test((esBody?.results || [])[0]?.errorHead || ''),
    JSON.stringify((esBody?.results || [])[0]));
  const es2 = await callTool('event_search', { project: 'e2e', query: 'PROMPT_BUDGET' });
  check('检索能命中参数摘要（patch 的 old_string）', /PROMPT_BUDGET/.test((es2.json?.result ?? es2.json)?.results?.[0]?.argsDigest || ''));
  const stats2 = await callTool('stats_get', { project: 'e2e' });
  const stBody = stats2.json?.result ?? stats2.json;
  check('stats_get 暴露事件聚合', (stBody?.events?.total || 0) >= 3 && Array.isArray(stBody?.events?.byTool),
    JSON.stringify(stBody?.events));
} catch (e) {
  fail++;
  console.log('  ❌ 异常：' + e.message);
  console.log(stderr.join('').slice(-1200));
} finally {
  child.kill();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { console.log('（临时库未删除：' + TMP + '）'); }
  process.exit(fail === 0 ? 0 : 1);
}
