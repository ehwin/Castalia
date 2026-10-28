/**
 * B-1' 索引摘要回归：去样板 / 去重复标题行 / 就近分句收尾
 *
 * 前置结论（_probes/20261028/index_value_probe.py，761 条活库）：
 *   ≤150 字根本没截断 51.2% · 头部 14 字与别人相同 54.1% · 截断切在句中 98.7%
 *   头损率中位 0%  → 信息没丢，亏在"样板 + 重复 + 断句"，不需要 LLM 描述。
 * 用法：../run/Castalia/bin/CastaliaNode.exe scripts/test_index_summary.mjs
 */
import { summarizeForIndex } from '../dist/memType.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + String(extra).slice(0, 300) : ''}`); }
};

// 真实形状：addTypeHeader 写进去的 `# Label: <首 40 字>` + 空行 + 全文
const body = 'Castalia-Anima 引擎回归基线（2026-10-28 实测）：9 个 scripts/regression_*.mjs 共 305 条断言通过、8/9 脚本 exit 0；唯一失败项是 vitest 在无 tty 下的静默退出。'
  + '复现方式：把 vitest 放进后台进程就会退化，前台跑正常；修复方案是改用 pnpm exec 或显式 --reporter 参数。';
const withHeader = `# Project Context: ${body.slice(0, 40)}\n\n${body}`;
// 正文 offset 120 处才有的一句话 —— 旧实现（先 substr150 再 slice）在第 108 字就断了
const tailPhrase = body.slice(120, 132);

console.log('\n== 去样板与去重复 ==');
const s1 = summarizeForIndex(withHeader, 150);
check('不再以 "# Project Context:" 开头', !s1.includes('# Project Context'), s1.slice(0, 40));
check('正文没被重复渲染两遍', s1.split('Castalia-Anima 引擎回归基线').length - 1 === 1, s1);
check('摘要长度 ≤150', s1.length <= 151, String(s1.length));
check('吃到旧实现够不到的正文（省下的样板字符换来新信息）', s1.includes(tailPhrase), s1.slice(-60));

console.log('\n== 分句收尾 ==');
const long = '第一句讲结论。' + '第二句补充前提与适用边界，'.repeat(12);
const s2 = summarizeForIndex(long, 80);
check('在句读处收尾，不以半个词结尾', /[。；！？，、：;]…$/.test(s2), JSON.stringify(s2.slice(-12)));
check('长度不超过上限 + 省略号', s2.length <= 81, String(s2.length));
const noPunct = 'a'.repeat(300);
const s3 = summarizeForIndex(noPunct, 60);
check('无标点时硬切仍带省略号', s3.length === 61 && s3.endsWith('…'), String(s3.length));

console.log('\n== 不该动的情况 ==');
check('短文本原样返回（不加省略号）', summarizeForIndex('用户偏好简洁汇报。', 150) === '用户偏好简洁汇报。');
check('空输入返回空串', summarizeForIndex('   ', 150) === '' && summarizeForIndex(null, 150) === '');
const titleNotDup = '# Reference: 嵌入模型价格\n\nOpenAI text-embedding-3-small 报价随批次浮动。';
check('标题行不是正文前缀时保留正文（不误删）',
  summarizeForIndex(titleNotDup, 150).startsWith('嵌入模型价格') || summarizeForIndex(titleNotDup, 150).startsWith('OpenAI'),
  summarizeForIndex(titleNotDup, 150));

console.log('\n== 真实活库样本（前 5 条 project 最新）==');
const real = [
  '# Project Context: 2026-10-28 决策：Castalia-Anima 引擎的挥发性估计改为 RoMem（Tencent/RoMem，EMNLP 2026 Main，官方代码存在）同源的常数危险率模型',
  '# Project Context: 2026-10-28 实测确认并修复的真实 bug：SQLite 日期比较不能用字典序。混用老行与新行时字典序把 10:00 排在 09:00 前',
  '# User Profile: 用户偏好简洁、正面的汇报，避免负面措辞；是记忆系统开发者，采用SQLite+向量存储、三通道反思、bufferController模式',
];
for (const r of real) {
  const s = summarizeForIndex(r, 150);
  check(`样板已剥离｜${s.slice(0, 24)}…`, !/^#|Project Context:|User Profile:/.test(s), s.slice(0, 50));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
