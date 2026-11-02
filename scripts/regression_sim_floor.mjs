/**
 * v1.28 检索进入门槛回归（simFloor + 通道口径）
 *
 * 事故：门槛 minScore 比的是 computeScore 的结果，而 computeScore 含 `0.35 × 时间衰减`。
 * 相似度 0、刚写入的行就有 0.35 分 → balanced(0.15) 对 30 天内任何行都不成立，
 * "这里没有够格的候选"在引擎里无法表达。同时 FTS 通道的 similarity 是**名次**（首位 0.88），
 * 与覆盖率不是同一个量，门槛对它没有意义。
 *
 * 本脚本锁定三件事：
 *   1. 进入门槛作用在 similarity 上，时间项不能单独让一条无关记忆过关；
 *   2. FTS 的 similarity 是 IDF 加权覆盖率，不是名次；
 *   3. textFallbackSearch 的 minScore 形参不再是死参数。
 * 以及一条**已知限制**：单 term 查询的覆盖率恒为 1.0（占比饱和），门槛挡不住，
 * 只能靠裁决层 —— 这条断言故意写成"仍然会发生"，防止有人以为改门槛就修好了。
 *
 * 用法：node scripts/regression_sim_floor.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-simfloor-'));
process.env.MEMORY_DB_DIR = TMP;
process.env.MEMORY_CONFIG = path.join(TMP, 'config.json');
process.env.CHAR_ID = 'test';
process.env.CASTALIA_PROJECT = 'sf';
process.env.EMBED_MODE = 'none';
fs.writeFileSync(process.env.MEMORY_CONFIG, JSON.stringify({ embedding: { mode: 'none' } }), 'utf8');

const { DatabaseManager } = await import('../dist/db.js');
const { saveMemory } = await import('../dist/store.js');
const { searchMemory, computeScore, profileSimFloor, profileMinScore } = await import('../dist/search.js');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + String(extra).slice(0, 300) : ''}`); }
};

// 一条只含"母亲"的行，importance 低，且 40 天前写入
const old = await saveMemory({ text: '母亲那天把镯子塞给我，什么也没说。', project: 'sf', memType: 'general', category: 'misc', importance: 0.3 });
const dbG = DatabaseManager.getInstance('sf', 'general');
dbG.prepare("UPDATE memory SET created_at = ?, last_accessed_at = ? WHERE id = ?")
  .run(new Date(Date.now() - 40 * 864e5).toISOString(), new Date(Date.now() - 40 * 864e5).toISOString(), old.id);

// 8 个查询词，行只命中 1 个 → 覆盖率 1/8 = 0.125
const EIGHT = '母亲 黑潮 名册 谕女 手镯 漂泊者 千夜 天穹';

console.log('\n== 1. 进入门槛作用在 similarity（时间项不能单独过关）==');
check('默认不改变行为：balanced/deep simFloor = 0，quick = 0.45',
  profileSimFloor('balanced') === 0 && profileSimFloor('deep') === 0 && profileSimFloor('quick') === 0.45,
  `${profileSimFloor('balanced')} / ${profileSimFloor('deep')} / ${profileSimFloor('quick')}`);

const nowRes = await searchMemory({ query: EIGHT, project: 'sf', profile: 'balanced', topK: 5, simFloor: 0.15 });
check('8 词查询只命中 1 词 → 显式 simFloor=0.15 时返回 0 条', nowRes.length === 0, JSON.stringify(nowRes.map(r => [r.similarity, r.score])));

const oldRes = await searchMemory({ query: EIGHT, project: 'sf', profile: 'balanced', topK: 5, simFloor: 0 });
check('同一条连同 simFloor=0（现状默认）会返回 1 条', oldRes.length === 1, JSON.stringify(oldRes.map(r => [r.similarity, r.score])));
check('旧行为下分数确实靠时间项过关（score > minScore 但 similarity 极低）',
  oldRes.length === 1 && oldRes[0].score > profileMinScore('balanced') && oldRes[0].similarity < 0.15,
  oldRes.length === 1 ? `score=${oldRes[0].score} sim=${oldRes[0].similarity}` : 'n/a');
check('算术对照：相似度 0 + 刚写入 = 0.35 分（门槛 0.15 的 2.3 倍）',
  computeScore(0, { created_at: new Date().toISOString(), tier: 'standard', importance: 0.5, accessed_count: 0 }) === 0.35);

console.log('\n== 2. FTS 通道：similarity 是覆盖率，不是名次 ==');
await saveMemory({ text: 'Kubernetes 集群 3318 端口 桥接进程 需要重启', project: 'sf', memType: 'project', category: 'debug', importance: 0.6 });
const fts = await searchMemory({ query: 'Kubernetes 3318 完全不存在的词', project: 'sf', profile: 'balanced', topK: 5 });
const hit = fts.find(r => r.text.includes('Kubernetes'));
check('FTS 命中行仍在结果里', !!hit, JSON.stringify(fts.map(r => r.similarity)));
check('覆盖率约 2/3（命中 2 个词），不是 0.88 的名次分',
  !!hit && hit.similarity > 0.3 && hit.similarity < 0.85 && hit.similarity !== 0.88,
  hit ? `sim=${hit.similarity}` : 'n/a');

console.log('\n== 3. textFallbackSearch 的 minScore 不再是死参数 ==');
const gated = await searchMemory({ query: EIGHT, project: 'sf', minScore: 0.5, simFloor: 0, topK: 5 });
check('minScore=0.5 + simFloor=0 → 低分行被挡', gated.length === 0, JSON.stringify(gated.map(r => r.score)));
const ungated = await searchMemory({ query: EIGHT, project: 'sf', minScore: 0, simFloor: 0, topK: 5 });
check('minScore=0 + simFloor=0 → 同一条能出来', ungated.length === 1, JSON.stringify(ungated.map(r => r.score)));

console.log('\n== 4. 已知限制：单 term 的占比饱和（门槛挡不住，必须靠裁决层）==');
await saveMemory({ text: '昨天助手问他为什么不回消息，他说明天再说。', project: 'sf', memType: 'general', category: 'misc', importance: 0.4 });
const why = await searchMemory({ query: '为什么', project: 'sf', profile: 'balanced', topK: 5 });
// "为什么" 的一条 bigram 是"什么"，于是**任何**含"什么"的记忆都被召回（这里是"什么也没说"）。
// 这条断言故意写成"仍然会发生"：门槛修不了占比饱和，只能靠 injectGate 的对级裁决。
check('无实指的两字查询仍然注入（记录在案的限制，不是回归）',
  why.length >= 1 && why.some(r => r.similarity >= 0.99),
  JSON.stringify(why.map(r => [r.similarity, r.score, r.text.slice(0, 18)])));
check('被召回的不止真命中：含"什么"的无关行也进来（"母亲…什么也没说"）',
  why.some(r => r.text.includes('什么也没说')),
  JSON.stringify(why.map(r => r.text.slice(0, 14))));

console.log('\n== 5. 标签早退路径仍正常（加了 simFloor 后不能把正常命中挡掉）==');
for (let i = 0; i < 5; i++) {
  await saveMemory({ text: `测评记录 ${i}：端口扫描与桥接压测`, project: 'sf', memType: 'general', category: 'misc', tags: ['测评'], importance: 0.5 });
}
const tag = await searchMemory({ query: '测评', project: 'sf', profile: 'balanced', topK: 5 });
check('标签命中 5 条全部返回', tag.length === 5, `got ${tag.length}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 文件锁：临时目录留给系统清理 */ }
process.exit(fail === 0 ? 0 : 1);
