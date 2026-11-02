/**
 * injectGate 的离线行为回归：不联网、不调模型，只验"判不了的时候不丢记忆"。
 *
 * 线上最危险的失败模式不是判错，而是**闸门把 LLM 故障当成 SKIP**：
 * 一断网就把所有记忆吞掉，调用方看到的是"想不起来"。所以这里锁三条：
 *   1. off 模式零调用、零改动；
 *   2. 未配置通道 → 全部保留 + 一条明确 error（fail-open）；
 *   3. INJECT_GATE 环境变量三态解析，未知值一律 off。
 *
 * 用法：node scripts/test_inject_gate.mjs
 */
process.env.CASTALIA_BACKGROUND_TASKS = '0';

const { adjudicateInjection, gateModeFromEnv } = await import('../dist/injectGate.js');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + String(extra).slice(0, 220) : ''}`); }
};

const cands = [
  { id: 'a', text: '用户讨厌被叫老板' },
  { id: 'b', text: '项目端口 3318' },
];

console.log('\n== 1. off 模式 ==');
const off = await adjudicateInjection({ query: '在吗', candidates: cands, mode: 'off' });
check('off 不产生裁决', off.verdicts.length === 0);
check('off 原样保留全部候选', off.kept.length === 2 && off.dropped.length === 0);
check('off 无错误', off.errors.length === 0);

console.log('\n== 2. 未配置通道时 fail-open（不丢记忆）==');
const saved = process.env.REFLECT_LLM_API_KEY;
process.env.REFLECT_LLM_API_KEY = '';
const on = await adjudicateInjection({ query: '在吗', candidates: cands, mode: 'on' });
check('没有 key 时 on 模式仍保留全部候选', on.kept.length === 2, JSON.stringify(on.kept));
check('并且明确报错（不是静默）', on.errors.length === 1 && /未配置 LLM/.test(on.errors[0]), on.errors[0]);
if (saved) process.env.REFLECT_LLM_API_KEY = saved;

console.log('\n== 3. 环境变量三态 ==');
check('未设置 → off', gateModeFromEnv(undefined) === 'off', String(gateModeFromEnv(undefined)));
check("'shadow' → shadow", gateModeFromEnv('shadow') === 'shadow');
check("'ON' → on（大小写不敏感）", gateModeFromEnv('ON') === 'on');
check("乱填 → off", gateModeFromEnv('yes-please') === 'off');

console.log('\n== 4. 空候选 ==');
const empty = await adjudicateInjection({ query: 'x', candidates: [], mode: 'on' });
check('空候选直接返回空，不调模型', empty.kept.length === 0 && empty.errors.length === 0);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
