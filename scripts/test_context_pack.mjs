/**
 * packContext 单元测试（A-2 的确定性内核）
 *
 * 用法：../run/Castalia/bin/CastaliaNode.exe scripts/test_context_pack.mjs
 * 纯函数测试：不读库、不起服务、不调 LLM。
 *
 * 断言：
 *   1. 总长不超预算，且末尾有"已裁掉 N 条"的交代
 *   2. 每段都有 characters="x/y" 段头；没有任何一段静默消失
 *   3. 高优先段（指令/偏好/会话/相关/近期/经验/事实）的首条必须存活
 *   4. 低优先段（索引/回捞）先被裁
 *   5. 同一 packetKey 只完整渲染一次（高优先段胜出，另一段降级成 ↪）
 *   6. 不切半句：每条正文都以【END】结尾
 */
const { packContext, deriveCaps } = await import('../dist/contextPack.js');
const BUDGET = 12000;
const CAPS = deriveCaps(BUDGET);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
};

// 每条 ~1000 字，带唯一标记与【END】哨兵
const body = (tag) => `${tag} ` + '正文'.repeat(500) + '【END】';
const item = (key, tag) => ({ packetKey: key, lines: [body(tag)] });

const sections = [
  { key: 'instructions', title: '指令(全局→项目,项目约束最高)', priority: 0, cap: 8000,
    items: [{ packetKey: null, lines: ['[项目] 改动必须用真实命令验证。ARTIFACT-INSTRUCTION】'] }] },
  { key: 'prefs', title: '用户偏好(跨会话行为指令,优先遵守)', priority: 1, cap: CAPS['prefs'], items: [item('u1', 'ARTIFACT-PREF')] },
  { key: 'session', title: '会话滚动状态', priority: 2, cap: CAPS['session'], items: [item(null, 'ARTIFACT-SESSION')] },
  { key: 'related', title: '与当前任务相关', priority: 3, cap: CAPS['related'],
    items: Array.from({ length: 6 }, (_, i) => item(`q${i}`, `ARTIFACT-RELATED${i}`)) },
  { key: 'recent', title: '近期重要记忆(近 48 小时)', priority: 4, cap: CAPS['recent'],
    items: Array.from({ length: 6 }, (_, i) => item(`r${i}`, `ARTIFACT-RECENT${i}`)) },
  { key: 'cognitives', title: '经验沉淀(决策/错误/模式)', priority: 5, cap: CAPS['cognitives'],
    items: Array.from({ length: 4 }, (_, i) => ({ packetKey: null, lines: [`${i + 1}. 🎯决策 ARTIFACT-COG${i} ` + '证据'.repeat(300) + '【END】'] })) },
  { key: 'facts', title: '已知事实', priority: 6, cap: CAPS['facts'],
    items: Array.from({ length: 3 }, (_, i) => ({ packetKey: `f${i}`, lines: [`${i + 1}. user — 端口: ARTIFACT-FACT${i}`] })) },
  { key: 'hydrated', title: '原文回捞', priority: 7, cap: CAPS['hydrated'],
    items: Array.from({ length: 4 }, (_, i) => item(`h${i}`, `ARTIFACT-HYDRATED${i}`)) },
  { key: 'index', title: '记忆索引(仅摘要,详情用 memory_get(id) 展开)', priority: 8, cap: CAPS['index'],
    items: Array.from({ length: 10 }, (_, i) => ({ packetKey: `m${i}`, lines: [`${i + 1}. [project] ARTIFACT-INDEX${i} (id: abc${i})`] })) },
];

const inputChars = sections.reduce((n, s) => n + s.items.reduce((m, it) => m + it.lines.join('').length, 0), 0);
const res = packContext(sections, { totalBudget: BUDGET });
const t = res.text;

console.log(`\n== 超预算场景（输入 ${inputChars} 字，预算 12000）==`);
console.log(`   输出 ${res.totalChars} 字，整条裁掉 ${res.evicted} 条`);
console.log('   ' + res.sections.map(s => `${s.key} ${s.chars}B kept=${s.kept} drop=${s.dropped}`).join('\n   '));

check('总长不超预算', res.totalChars <= 12000, String(res.totalChars));
check('末尾交代了裁掉多少条', /已整条裁掉 \d+ 条/.test(t), t.slice(-120));
check('9 段头都在（无静默消失）', (t.match(/■ /g) || []).length === sections.length, String((t.match(/■ /g) || []).length));
check('每段都带 characters="x/y"',
  (t.match(/■ [^\n]*characters="\d+\/\d+"/g) || []).length === sections.length,
  (t.match(/■ [^\n]*/g) || []).join(' | ').slice(0, 300));
check('指令段完整保留', t.includes('ARTIFACT-INSTRUCTION'));
check('偏好段保留', t.includes('ARTIFACT-PREF'));
check('会话状态保留', t.includes('ARTIFACT-SESSION'));
check('相关段首条保留', t.includes('ARTIFACT-RELATED0'));
check('近期段首条保留', t.includes('ARTIFACT-RECENT0'));
check('经验沉淀留了至少 1 条（旧实现在这里先死）', /ARTIFACT-COG\d/.test(t));
check('已知事实留了至少 1 条', /ARTIFACT-FACT\d/.test(t));
check('低优先段先被裁（index/hydrated 有丢条）',
  res.sections.some(s => (s.key === 'index' || s.key === 'hydrated') && s.dropped > 0),
  JSON.stringify(res.sections.map(s => `${s.key}:${s.dropped}`)));
check('低优先段丢得比高优先段多（index/hydrated ≥ related）',
  (res.sections.find(s => s.key === 'index')?.dropped ?? 0) >= (res.sections.find(s => s.key === 'related')?.dropped ?? 0)
  && (res.sections.find(s => s.key === 'hydrated')?.dropped ?? 0) > 0,
  JSON.stringify(res.sections.map(s => `${s.key}:${s.dropped}`)));
check('相关段在借额上限内（cap ≤ chars ≤ 2×cap）且至少留 1 条',
  (() => { const s = res.sections.find(x => x.key === 'related'); return s && s.chars <= s.cap * 2 && s.kept >= 1; })(),
  JSON.stringify(res.sections.find(s => s.key === 'related')));
check('不切半句（所有 正文 行以【END】收尾）',
  t.split('\n').filter(l => l.includes('正文正文')).every(l => l.trimEnd().endsWith('【END】')));
check('预算利用率 ≥ 80%（配额派生后不再空转）', res.totalChars >= BUDGET * 0.8, `${res.totalChars}/${BUDGET}`);
check('totalChars 与实际长度一致', res.totalChars === t.length, `${res.totalChars} vs ${t.length}`);

// ── packet 去重：同一来源跨段只完整渲染一次 ─────────────────
console.log('\n== 同一 packet 跨段去重（authority multiplication）==');
const dup = packContext([
  { key: 'related', title: '与当前任务相关', priority: 3, cap: CAPS['related'], items: [item('P1', 'ARTIFACT-DUP-FULL')] },
  { key: 'hydrated', title: '原文回捞', priority: 7, cap: CAPS['hydrated'], items: [item('P1', 'ARTIFACT-DUP-VIEW')] },
], { totalBudget: 24000 });
check('高优先段保留全文', dup.text.includes('ARTIFACT-DUP-FULL'));
check('低优先段降级成引用行', !dup.text.includes('ARTIFACT-DUP-VIEW') && /↪ 同上/.test(dup.text), dup.text);
check('dereferenced 计数正确', dup.sections.find(s => s.key === 'hydrated')?.dereferenced === 1);

// ── 小输入：预算充足时一条不丢 ─────────────────────────────
console.log('\n== 预算充足场景 ==');
const small = packContext([
  { key: 'instructions', title: '指令', priority: 0, cap: 8000, items: [{ packetKey: null, lines: ['[项目] A'] }] },
  { key: 'related', title: '与当前任务相关', priority: 3, cap: CAPS['related'], items: [item('x1', 'ARTIFACT-SMALL1'), item('x2', 'ARTIFACT-SMALL2')] },
], { totalBudget: 24000 });
check('预算充足时零裁剪', small.evicted === 0 && small.sections.every(s => s.dropped === 0), JSON.stringify(small.sections));
check('预算充足时内容完整', small.text.includes('ARTIFACT-SMALL1') && small.text.includes('ARTIFACT-SMALL2'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
