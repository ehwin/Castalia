/**
 * Reflect Driver — LLM reflection driver (bundled into the MCP server)
 *
 * Ported from the original reflect design: fetch memories → call LLM → parse actions → apply
 * - reflect_auto: unanalyzed conversations → daily digest / memory extraction
 * - reflect_deep: all memories → dedup / profile / graph
 *
 * Env config:
 *   REFLECT_LLM_URL       default https://api.deepseek.com/v1 (OpenAI-compatible)
 *   REFLECT_LLM_API_KEY   required; skipped when unset
 *   REFLECT_LLM_MODEL     default deepseek-chat
 *   REFLECT_FACT_EXTRACTION auto | off  (default auto) — off 时 prompt 不要求 facts,也不落 facts
 *   REFLECT_MAX_FACTS     每轮最多提取 facts 条数 (default 15)
 *   REFLECT_INTERVAL_HOURS auto-reflect interval (hours), 0 = off, default 0
 */
import { getUnanalyzedConversations, listAllMemories, applyReflectResult, applyReflectActions, markConversationsReflected, deepReflectionCursor } from './reflect.js';
import { DatabaseManager, listMemTypeDirs, currentMemDir } from './db.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeProject, isEmbedEnabled } from './env.js';
import { isMemType } from './memType.js';
import { findSimilarCandidates, CONSOLIDATE_SIMILARITY, CONSOLIDATE_MAX_PAIRS } from './consolidate.js';
import { getRecentConversations } from './digest.js';
import { loadPromptOverride } from './promptFile.js';
import { makeLlmChannel, callLlm, parseJsonRobust, REFLECT_DEEP_MAX_TOKENS } from './reflectionLlm.js';
export { makeLlmChannel, callLlm, parseJsonRobust, REFLECT_DEEP_MAX_TOKENS } from './reflectionLlm.js';
import { fidelitySystemPrompt, reflectionPolicy, reflectionFidelityPrompt, wholeRecordBatches } from './reflectionFidelity.js';
const FACT_EXTRACTION = (process.env.REFLECT_FACT_EXTRACTION || 'auto').trim().toLowerCase();
const MAX_FACTS = parseInt(process.env.REFLECT_MAX_FACTS || '15', 10) || 15;
// 启动自动反思触发阈值(条件达成后,下次启动 server 时自动执行一次)
const MIN_GAP_HOURS = (() => { const v = parseFloat(process.env.REFLECT_MIN_GAP_HOURS || '24'); return Number.isFinite(v) && v > 0 ? v : 24; })();
const MIN_UNANALYZED = (() => { const v = parseInt(process.env.REFLECT_MIN_UNANALYZED || '5', 10); return Number.isFinite(v) && v >= 0 ? v : 5; })();
// v1.10: 启动自动整合触发阈值(active 记忆条数 > 该值 → 下次启动自动整合一次)
const CONSOLIDATE_MIN_MEMORIES = (() => { const v = parseInt(process.env.CONSOLIDATE_MIN_MEMORIES || '15', 10); return Number.isFinite(v) && v >= 0 ? v : 15; })();
// 2026-10-23 审计:整合一次 ≈ 2.7 万 prompt + 1.2 万输出、多数 merged=0,而"记忆条数超过 15"这个
// 门槛永远成立,导致每次桥启动(含重启风暴里每 25 秒一次)都重跑一遍。最小间隔 = 硬闸。
const CONSOLIDATE_MIN_INTERVAL_HOURS = (() => { const v = parseFloat(process.env.CONSOLIDATE_MIN_INTERVAL_HOURS || '6'); return Number.isFinite(v) && v >= 0 ? v : 6; })();
/**
 * v1.23.1: 反思失败退避。反思失败不会写 reflect_summary，于是 24h 闸门永远"已到时间"，
 * 每次桥重启都会立刻重试同一批（content_filter/超时/超大 prompt 时尤其明显）。
 * 失败后至少隔这么久才允许下一次**自动**尝试；显式调用工具（reflect_auto）不受限制。
 */
const REFLECT_FAIL_BACKOFF_HOURS = (() => { const v = parseFloat(process.env.REFLECT_FAIL_BACKOFF_HOURS || '1'); return Number.isFinite(v) && v >= 0 ? v : 1; })();
function reflectStatePath(proj) {
    return path.join(currentMemDir(), `reflect-state-${proj}.json`);
}
function readReflectState(proj) {
    try {
        return JSON.parse(fs.readFileSync(reflectStatePath(proj), 'utf8'));
    }
    catch {
        return null;
    }
}
/** 只记"真正发起过 LLM 尝试"的一轮；跳过（无积压/未配置）不写状态。 */
function recordReflectAttempt(proj, ok, errors = [], processed = 0) {
    try {
        fs.mkdirSync(path.dirname(reflectStatePath(proj)), { recursive: true });
        fs.writeFileSync(reflectStatePath(proj), JSON.stringify({
            at: new Date().toISOString(), ok, processed, errors: errors.slice(0, 5),
        }), 'utf8');
    }
    catch { /* 状态写失败不影响主流程 */ }
}
/**
 * v1.23: 单轮自动反思消费的对话条数。默认 30（原行为）。
 * 背景：24h 闸门 + 30 条/轮 在积压 200+ 的库上是"越追越多"（实测 dsh 217 条、每天新增 8~16 条）。
 * 想追平时把 REFLECT_BATCH_LIMIT 调到 90~120；代价是单轮多次 LLM 调用、启动后跑得更久。
 */
export const AUTO_REFLECT_LIMIT = (() => {
    const v = parseInt(process.env.REFLECT_BATCH_LIMIT || '30', 10);
    return Number.isFinite(v) && v > 0 ? v : 30;
})();
/**
 * 进度游标契约:所有反思提示词(内置 / 自定义 / 证据 / 逐字)都必须要求模型返回
 * processedSourceIds。缺了它,驱动无法区分“整批处理完”和“只处理了一部分”,
 * 旧逻辑会整批标记 → 未处理内容被永久跳过(2026-10-17 修)。
 */
const SOURCE_CURSOR_SPEC = `

【进度游标(必须)】输出 JSON 必须包含 "processedSourceIds": ["本轮已完整审阅且其有价值信息均已提取的来源 ID"]。
- 只列真正处理完的来源;没处理完/没来得及看的来源不要列,留待下一轮。
- 不能只写 summary 就确认来源;没有长效信息的来源,完整读过后也可以列入。`;
/**
 * v1.11: LLM 通道 — 三通道架构(LLM1 triage / 向量模型 / LLM2 reflect)。
 * 构造 `${PREFIX}_LLM_URL / ${PREFIX}_LLM_API_KEY / ${PREFIX}_LLM_MODEL` 配置:
 *   优先取前缀通道自身值;缺省回退 REFLECT_*(旧单通道);再回退内置默认。
 *   供 triage(LLM1) 与 reflect(LLM2) 复用。
 */
export function isReflectConfigured() {
    return !!makeLlmChannel('reflect').apiKey;
}
export function isFactExtractionEnabled() {
    return FACT_EXTRACTION !== 'off';
}
/**
 * 启动自动反思条件检查(两个同时满足才反思):
 *   a. REFLECT_LLM_API_KEY 已配置
 *   b. 距上次反思 ≥ REFLECT_MIN_GAP_HOURS(默认 24h;从未反思 → 视为超时,满足)
 *   c. 未分析对话数 > REFLECT_MIN_UNANALYZED(默认 5)
 * 按 project 维度查询(默认项目用 charId + normalizeProject)。
 */
export function shouldAutoReflect(charId = 'airi', project) {
    if (!isReflectConfigured()) {
        return { should: false, reason: 'REFLECT_LLM_API_KEY 未配置' };
    }
    const proj = normalizeProject(project);
    // v1.23.1: 失败退避放在最前 —— 上次尝试失败时，即便时间/积压都满足也不自动重试。
    const attempt = readReflectState(proj);
    if (attempt?.ok === false && attempt.at) {
        const ageMs = Date.now() - Date.parse(attempt.at);
        const floorMs = REFLECT_FAIL_BACKOFF_HOURS * 3600 * 1000;
        if (Number.isFinite(ageMs) && ageMs >= 0 && floorMs > 0 && ageMs < floorMs) {
            const first = attempt.errors?.[0] ? `：${String(attempt.errors[0]).slice(0, 80)}` : '';
            return { should: false, reason: `上次反思失败${first}；退避中 ${(ageMs / 3600000).toFixed(1)}h < ${REFLECT_FAIL_BACKOFF_HOURS}h` };
        }
    }
    const dbs = listMemTypeDirs(proj).map(mt => DatabaseManager.getInstance(proj, mt));
    // 最近一次反思时间：跨所有 memType 取最新摘要
    const lastTimes = dbs.flatMap(db => {
        try {
            return db.prepare(`
        SELECT created_at FROM memory
        WHERE source = 'reflect_summary' AND project = ?
        ORDER BY created_at DESC LIMIT 1
      `).all(proj).map(r => r.created_at);
        }
        catch {
            return [];
        }
    });
    const lastTime = lastTimes.length ? Math.max(...lastTimes.map(t => new Date(t).getTime()).filter(Number.isFinite)) : NaN;
    const hoursSince = Number.isFinite(lastTime)
        ? (Date.now() - lastTime) / 3600000
        : Number.POSITIVE_INFINITY;
    const timeOk = hoursSince >= MIN_GAP_HOURS;
    const gapLabel = Number.isFinite(lastTime) ? `${Math.floor(hoursSince * 10) / 10}` : '∞';
    if (!timeOk) {
        return { should: false, reason: `距上次反思 ${gapLabel} 小时,未到 ${MIN_GAP_HOURS}h` };
    }
    const count = getUnanalyzedConversations(charId, undefined, MIN_UNANALYZED + 1, proj).length;
    if (count <= MIN_UNANALYZED) {
        return { should: false, reason: `未分析对话 ${count} 条,未超 ${MIN_UNANALYZED}` };
    }
    return { should: true, reason: `距上次反思 ${gapLabel}h 且未分析对话 ${count} 条` };
}
/**
 * v1.10: 启动自动整合条件检查 — active 记忆条数 > CONSOLIDATE_MIN_MEMORIES(默认 15)即达成。
 * 注意:整合只需记忆足够多,不依赖 REFLECT_LLM_API_KEY(无 key 时 runConsolidate 会报错跳过)。
 */
export function shouldAutoConsolidate(project) {
    const proj = normalizeProject(project);
    let count = 0;
    for (const mt of listMemTypeDirs(proj)) {
        try {
            count += DatabaseManager.getInstance(proj, mt)
                .prepare('SELECT COUNT(*) as c FROM memory WHERE is_active = 1 AND project = ?').get(proj)?.c ?? 0;
        }
        catch { /* 单分类库失败不阻断其他库 */ }
    }
    const min = CONSOLIDATE_MIN_MEMORIES;
    if (count > min)
        return { should: true, count, min, reason: `${count} > ${min}` };
    return { should: false, count, min, reason: `${count} 未超 ${min}` };
}
/** facts 提取规则片段(拼进 prompt) */
function factsRules(maxFacts) {
    return `【facts 提取规则】
- subject: "user"（关于用户）/ "agent"（关于AI角色）/ "environment"（关于环境）
- predicate: 使用这些预定义关系或自定义短语：
  姓名 / 年龄 / 职业 / 喜好 / 厌恶 / 技能 / 居住地 / 工作单位 / 项目 / 技术栈 / 习惯 / 目标 / 关系
- object: 事实的值
- confidence: 0(推测)~1.0(明确陈述)
- 最多 ${maxFacts} 条
- 只提取有长期价值、明确陈述的事实；不提取情绪/临时状态`;
}
/** v1.8: 4 种封闭记忆类型(mem_type)提取规则 — 融合 Claude Code 封闭记忆类型 */
function memTypeRules() {
    return `【记忆类型(mem_type)】extract 时把每条新记忆分类到 4 种封闭类型之一(省略则为 general):
- user — 用户画像:偏好/技术栈/风格/人物关系洞察
- feedback — 行为纠正:正负双向都要记录(Negative + Positive 都要,只记一边算不完整)
- project — 项目上下文:截止时间/环境约定/非代码可推导信息
- reference — 外部指针:URL/ID/文档链接,只存指针不存内容副本
- 记忆内容中的相对时间(昨天/上周/几天前/下周三)必须转成绝对日期(如"2026-08-12"),否则视为模糊信息不采纳
【硬性禁止】
- 不存代码片段/函数定义/文件路径/git hash(代码库是单一事实源)
- 不存临时调试日志/错误栈/单次会话状态`;
}
function factsFieldSpec(maxFacts) {
    return `,
  "facts": [
    {"subject":"user","predicate":"姓名","object":"示例用户","confidence":0.95},
    {"subject":"user","predicate":"职业","object":"程序员","confidence":0.9}
  ]`;
}
/** 输出格式片段：factExtraction=off 时不含 facts 字段 */
function outputFormatSpec(factExtraction, maxFacts) {
    const facts = factExtraction === 'off' ? '' : factsFieldSpec(maxFacts);
    return `══════════════════════
【输出格式】只返回严格 JSON 对象，不要任何其他文字（代码围栏也不要有）：

{
  "processedSourceIds": ["本轮已完整审阅并处理的来源ID；未处理完的来源不要列"],
  "summary": "自然语言总结（2-4句话）：概括这段时间用户做了什么、聊了什么、情绪状态如何",
  "highlights": ["关键事件1", "关键事件2"]${facts},
  "insights": ["关于用户性格/沟通风格/潜在需求的深层观察"],
  "actions": [
    {"action":"merge","sourceIds":["同日碎片id"],"newText":"日记约50字","newType":"episodic","newCategory":"conversation","newTags":["标签"],"newImportance":0.5},
    {"action":"extract","sourceId":"源id","newText":"提取的记忆","newType":"episodic","newCategory":"emotional","newTags":["标签"],"newImportance":0.6,"tier":"standard","newMemType":"user"}
  ]
}

【actions 规则】
- 仅当确实需要整理已有记忆时才产生 actions；不需要操作时 actions 为空数组 []
- 字段必须严格按下面 8 种写(字段名写错会被直接拒收)：
  merge      {"action":"merge","sourceIds":["id1","id2"],"newText":"合并后的文本","newType":"episodic","newCategory":"conversation","newTags":["标签"],"newImportance":0.5}
  extract    {"action":"extract","sourceId":"id","newText":"提取的文本","newType":"semantic","newCategory":"identity","newTags":["标签"],"newImportance":0.9,"tier":"critical","newMemType":"user"}
  split      {"action":"split","targetId":"id","fragments":[{"text":"片段1"},{"text":"片段2"}]}
  relate     {"action":"relate","sourceId":"id","targetIdRelate":"id2","relationType":"sequence"}
  reclassify {"action":"reclassify","targetId":"id","newText":"改写后的文本","newCategory":"milestone"}
  delete     {"action":"delete","targetId":"id"}
  boost      {"action":"boost","targetId":"id","delta":0.2}
  decay      {"action":"decay","targetId":"id","delta":-0.2}
- 禁止省略 targetId / sourceId；禁止自造字段名(如 id / ids / target / targetIdRelate 写成 target)
【长度纪律】一次最多输出 12 条 action(按重要性排序,宁少勿滥)；
JSON 必须完整闭合——内容多时先减少 action 条数、facts 条数，绝不允许写到一半断掉。
${memTypeRules()}
${factExtraction === 'off'
        ? '【facts】本轮不提取 facts。'
        : factsRules(maxFacts)}`;
}
/** Daily-reflection prompt builder (digest + extraction, model-neutral) */
export function buildReflectSystemPrompt(factExtraction = FACT_EXTRACTION, maxFacts = MAX_FACTS) {
    return loadPromptOverride('REFLECT_PROMPT_FILE', builtinReflectSystemPrompt(factExtraction, maxFacts)) + SOURCE_CURSOR_SPEC;
}
function builtinReflectSystemPrompt(factExtraction, maxFacts) {
    return `You are a memory organization engine. Each entry has a "date" field (YYYY-MM-DD).

══════════════════════
【按日期处理】
1. 先找出所有不同的 date 值
2. 对每个日期单独处理：该日所有记忆 → 浓缩为 1-3 条日记
3. merge 的 sourceIds 必须全部来自同一日期，严禁跨日期合并
4. 同一天内的对话碎片才能融合

══════════════════════
【任务1：日记浓缩】按日期将同日碎片浓缩为日记
- 每条日记约 50 字，口语化自然
- 区分"用户"和"agent"
- 每天最多 3 条日记
- 只处理 source 为 conversation_log / daily_digest / auto_process 的对话类记忆
- identity / milestone / relationship 等已有结构化记忆 → 保留原样，不合并
- locked = 1 的记忆是**永久锁定**的，绝对不要修改、合并、删除、reclassify 它们

【任务1.5：纠正错标记忆】
检查 category='emotional' 的记忆：
- 如果是角色背景故事/经历/回忆 → 用 reclassify 改为 identity
- 如果是里程碑事件 → 改为 milestone
- 只有真正的深层情感洞察（用户性格、情绪模式）→ 保留为 emotional

【任务2：记忆提取】从对话中筛出有长期价值的信息

2a. 身份与设定（identity）→ newType=semantic newCategory=identity tier=critical
  用户/角色的核心信息：我是XX师、生日是X月X日、毕业于XX、我的名字是、我住在
  别名/代号绑定：用户在游戏/故事中叫XX、笔名是XX、外号是XX

2b. 偏好（preference）→ newType=preference newCategory=preference
  用户明确表达的好恶：喜欢/讨厌/习惯/不习惯XX

2c. 里程碑（milestone）→ newType=episodic newCategory=milestone tier=critical
  重要节点：第一次、终于、入职、拿到offer、生日确认、重要决定

2d. 关系与约定（relationship）→ newType=entity newCategory=relationship tier=critical
  约定、承诺、说好了、不许忘、纪念日

2e. 情感积淀（emotional）→ newType=episodic newCategory=emotional tier=standard
  从对话中提炼用户的深层情感模式、性格洞察、长期情绪倾向
  示例："用户面对技术难题时反而兴奋，有挑战型人格"
  这不是临时情绪（mood_snapshot），而是有长期参考价值的情感画像

2f. 知识点（knowledge）→ newType=semantic newCategory=knowledge
  用户学到的、讨论到的有价值知识

【任务3：标签】每条结果 1-3 个中文标签

分类对照：identity=语义身份, preference=偏好, milestone=里程碑, relationship=关系, emotional=情感积淀, knowledge=知识

${outputFormatSpec(factExtraction, maxFacts)}

不确定不操作。`;
}
/** Deep-calibration prompt builder (full-memory analysis) */
export function buildDeepReflectPrompt(factExtraction = FACT_EXTRACTION, maxFacts = MAX_FACTS) {
    return loadPromptOverride('REFLECT_DEEP_PROMPT_FILE', builtinDeepReflectPrompt(factExtraction, maxFacts));
}
function builtinDeepReflectPrompt(factExtraction, maxFacts) {
    return `你是记忆深度校准引擎。对全部记忆执行长时分析。

══════════════════════
【目标】从所有记忆中提炼长期模式，清理冗余，生成用户画像

【任务1：去重合并】
- 找出语义重复的记忆（同一件事被记录了多次）→ merge
- 找出过时的信息（已被新信息覆盖）→ delete 或 decay
- locked=1 的记忆仅供上下文参考，绝不修改

【任务2：用户画像】
从所有非 locked 记忆中提取用户的长期特征：
- 性格特质：用户是什么样的人（从对话模式、情绪倾向推断）
- 核心偏好：反复出现的喜好/厌恶
- 关键关系：用户与 agent 的关系动态
- 成长轨迹：用户技能、知识、心态的变化

每个画像以 extract 形式输出：
{"action":"extract","sourceId":"代表性记忆id","newText":"用户画像描述","newType":"semantic","newCategory":"preference","newTags":["用户画像","性格"],"newImportance":0.9,"tier":"critical"}

【任务3：知识图谱】
- 找出可以建立关联的记忆 → relate
- 相关事件组成序列 → relate (relationType: "sequence" 或 "follows")

【任务4：降噪】
- importance < 0.3 且无 tags 的陈旧记忆 → delete
- 已被覆盖的临时信息 → decay

【任务:时间规范化检查】
- 扫描存量记忆文本:含相对时间(昨天/上周/几天前/下周三/上个月/去年等)的记忆 → 用 reclassify 更新文本(newText 用绝对日期替换,如 2026-08-12)
- 推断依据:该记忆的 date(created_at)字段;推断不出(如"很久以前")标"约 <年份>"或保持原文
- 只改含相对时间的记忆;已用绝对日期的跳过;拿不准的不动;locked=1 的跳过

══════════════════════
锁规则：locked=1 的记忆仅供理解上下文，绝对不修改/删除/合并
${outputFormatSpec(factExtraction, maxFacts)}
不确定不操作。`;
}
/** 向后兼容：默认配置下的 prompt（外部可能仍引用这两个常量） */
export const REFLECT_SYSTEM_PROMPT = buildReflectSystemPrompt();
export const DEEP_REFLECT_PROMPT = buildDeepReflectPrompt();
/**
 * facts 必须是 SPO 三元组对象。证据/逐字/情感策略的提示词只给了 `facts: []` 的形状，
 * 没有字段契约，模型经常写成字符串或 {sourceId,text}；这些条目进 facts 表会
 * NOT NULL 崩掉整批。这里按形状过滤：宁可少存事实，也不能让整轮反思作废。
 */
function coerceFacts(raw, max) {
    if (!Array.isArray(raw))
        return { facts: [], dropped: 0 };
    const text = (v) => (typeof v === 'string' ? v.trim() : '');
    const facts = [];
    let dropped = 0;
    for (const item of raw) {
        if (!item || typeof item !== 'object') {
            dropped++;
            continue;
        }
        const subject = text(item.subject);
        const predicate = text(item.predicate);
        const object = text(item.object);
        if (!subject || !predicate || !object) {
            dropped++;
            continue;
        }
        const rawConfidence = Number(item.confidence);
        facts.push({
            subject,
            predicate,
            object,
            confidence: Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0.6,
        });
        if (facts.length >= max)
            break;
    }
    return { facts, dropped };
}
/** 把 parseJsonRobust 结果规范化为 applyReflectResult 期望的 ReflectResult */
function normalizeReflectResult(parsed) {
    const out = { ...parsed };
    out.actions = Array.isArray(parsed.actions) ? parsed.actions : [];
    if (FACT_EXTRACTION === 'off') {
        out.facts = [];
        out.factsDropped = 0;
    }
    else {
        const { facts, dropped } = coerceFacts(parsed.facts, MAX_FACTS);
        out.facts = facts;
        out.factsDropped = dropped;
    }
    return out;
}
/** 日常反思:未分析对话 → 日记浓缩/提取 */
export async function runAutoReflect(charId, limit = 30, project) {
    const base = { ok: false, mode: 'auto', actions: 0, applied: 0, errors: [] };
    if (!isReflectConfigured()) {
        return { ...base, skipped: true, errors: ['REFLECT_LLM_API_KEY 未配置,跳过反思'] };
    }
    try {
        const conversations = getUnanalyzedConversations(charId, undefined, limit, project);
        if (conversations.length === 0) {
            return { ...base, ok: true, conversationCount: 0, skipped: true, errors: ['无未分析对话'] };
        }
        const records = conversations.map(c => ({ id: c.id, createdAt: c.createdAt, date: c.createdAt?.slice(0, 10), text: c.text }));
        const batches = wholeRecordBatches(records);
        const out = { ...base, conversationCount: records.length, processedCount: 0, deferredCount: records.length, receipts: [] };
        const policy = reflectionPolicy(project);
        const fidelity = fidelitySystemPrompt(project);
        const customPrompt = loadPromptOverride('REFLECT_PROMPT_FILE', '');
        const systemPrompt = policy === 'standard'
            ? buildReflectSystemPrompt() + '\n' + reflectionFidelityPrompt(project)
            : ((customPrompt ? customPrompt + '\n' : '') + fidelity) + SOURCE_CURSOR_SPEC;
        for (const batch of batches) {
            const llm = await callLlm(systemPrompt, `请逐条分析以下完整记录，输出反思JSON：\n${JSON.stringify(batch)}`, undefined, REFLECT_DEEP_MAX_TOKENS);
            if (!llm || llm.finishReason === 'length') {
                out.errors.push(!llm ? 'LLM 调用失败；本批保留待重试' : 'LLM 输出被截断；本批未应用，保留待重试');
                break;
            }
            const parsed = parseJsonRobust(llm.content, false);
            if (!parsed || !Array.isArray(parsed.actions)) {
                // 失败必须可诊断：空响应常是服务端内容过滤(finish=content_filter)，
                // 记下 finish/chars/头部，省得下次只能看到“未返回完整 JSON”再猜。
                const head = llm.content ? `, head=${JSON.stringify(llm.content.slice(0, 160))}` : '';
                out.errors.push(`未返回完整反思 JSON 和 actions；本批保留待重试（finish=${llm.finishReason || 'n/a'}, chars=${llm.content.length}${head}）`);
                break;
            }
            const result = normalizeReflectResult(parsed);
            const allowed = new Set(batch.map(x => x.id));
            // 模型没给游标时,只认 actions 实际引用过的来源;绝不再整批标记(旧逻辑会丢内容)。
            const fromActions = (Array.isArray(result.actions) ? result.actions : [])
                .flatMap((a) => [a.sourceId, a.targetId])
                .filter((id) => typeof id === 'string' && allowed.has(id));
            const processedIds = Array.isArray(result.processedSourceIds) && result.processedSourceIds.length
                ? result.processedSourceIds
                : [...new Set(fromActions)];
            if (!processedIds.length || new Set(processedIds).size !== processedIds.length || processedIds.some(id => typeof id !== 'string' || !allowed.has(id))) {
                out.errors.push('未明确确认已完整处理的来源 ID；本批未应用，保留待重试');
                break;
            }
            const r = await applyReflectResult(result, charId, project, { allowedSourceIds: new Set(batch.map(x => x.id)), automatic: true });
            out.actions += (result.actions || []).length;
            out.applied += r.actionsApplied;
            out.receipts.push(...r.receipts);
            out.factsInserted = (out.factsInserted || 0) + r.factsInserted;
            out.factsUpdated = (out.factsUpdated || 0) + r.factsUpdated;
            if (result.factsDropped) {
                (out.warnings ||= []).push(`丢弃 ${result.factsDropped} 条形状不符的 facts（需 subject/predicate/object）`);
            }
            for (const w of r.warnings || []) {
                (out.warnings ||= []).push(w);
                console.error('[reflect] warning:', w);
            }
            out.errors.push(...r.errors);
            if (r.errors.length)
                break;
            markConversationsReflected(processedIds, project);
            out.processedCount += processedIds.length;
            out.deferredCount -= processedIds.length;
            if (processedIds.length < batch.length) {
                out.errors.push('本批仅部分来源完成；未完成来源保留待重试');
                break;
            }
        }
        out.ok = out.errors.length === 0;
        // v1.23.1: 记录本轮尝试（成功清除退避；失败触发 ≥1h 退避）
        recordReflectAttempt(normalizeProject(project), out.ok, out.errors, out.processedCount);
        return out;
    }
    catch (e) {
        recordReflectAttempt(normalizeProject(project), false, [e.message]);
        return { ...base, errors: [e.message] };
    }
}
/**
 * 深度校准:全量记忆 → 去重/画像/图谱
 * v1.20: 分批送模型(默认每批 12 条,单次最多 4 批)。一次性塞 30+ 条会让模型输出超过
 * max_tokens 被截断,JSON 解析失败反而整轮丢弃;分批后每批输出小、必闭合,代价是多次调用。
 * 可用 REFLECT_DEEP_CHUNK / REFLECT_DEEP_MAXCALLS 调参。
 */
export async function runDeepReflect(charId, limit = 500, project) {
    const base = { ok: false, mode: 'deep', actions: 0, applied: 0, errors: [] };
    if (!isReflectConfigured()) {
        return { ...base, skipped: true, errors: ['REFLECT_LLM_API_KEY 未配置,跳过反思'] };
    }
    try {
        const memories = listAllMemories(charId, limit, project);
        memories.sort((a, b) => a.id.localeCompare(b.id));
        const cursor = deepReflectionCursor(project);
        const nextIndex = memories.findIndex(m => m.id > cursor);
        if (nextIndex > 0)
            memories.push(...memories.splice(0, nextIndex));
        if (memories.length === 0) {
            return { ...base, ok: true, memoryCount: 0, skipped: true, errors: ['库为空'] };
        }
        const slim = memories.map(m => ({
            id: m.id,
            text: m.text || '',
            type: m.type, memType: m.memType || 'general', category: m.category,
            tags: m.tags || [], importance: m.importance ?? 0.5,
            emotionalImpact: m.emotionalImpact ?? 0, tier: m.tier || 'standard',
            locked: m.locked || 0, source: m.source || '',
            date: (m.createdAt || '').slice(0, 10),
        }));
        const chunk = Math.max(4, Number(process.env.REFLECT_DEEP_CHUNK || 12));
        const maxCalls = Math.max(1, Number(process.env.REFLECT_DEEP_MAXCALLS || 4));
        const batches = wholeRecordBatches(slim, 30000, chunk);
        const out = {
            ok: true, mode: 'deep', memoryCount: memories.length,
            actions: 0, applied: 0, factsInserted: 0, factsUpdated: 0, errors: [], receipts: [],
        };
        let okBatches = 0;
        for (const batch of batches.slice(0, maxCalls)) {
            const userPrompt = `记忆列表(${batch.length} 条)：\n\n${JSON.stringify(batch, null, 1)}\n\n请深度分析本批记忆，返回 JSON 操作对象。`;
            const systemPrompt = reflectionPolicy(project) === 'standard' ? buildDeepReflectPrompt() + '\n' + reflectionFidelityPrompt(project) : fidelitySystemPrompt(project);
            const llm = await callLlm(systemPrompt, userPrompt, undefined, REFLECT_DEEP_MAX_TOKENS);
            if (!llm) {
                out.errors.push('LLM 调用失败');
                break;
            }
            if (llm.finishReason === 'length') {
                out.errors.push('本批输出被截断，已保留未处理；下次重试');
                break;
            }
            const parsed = parseJsonRobust(llm.content, false);
            if (!parsed || !Array.isArray(parsed.actions)) {
                out.errors.push(`未找到有效 JSON actions 结果（finish=${llm.finishReason || 'n/a'}, chars=${llm.content.length}）`);
                break;
            }
            const result = normalizeReflectResult(parsed);
            const r = await applyReflectResult(result, charId, project, { allowedSourceIds: new Set(batch.map(x => x.id)), automatic: true });
            if (r.errors.length === 0) {
                okBatches++;
                deepReflectionCursor(project, batch[batch.length - 1].id);
                out.processedCount = (out.processedCount || 0) + batch.length;
            }
            out.actions += (result.actions || []).length;
            out.applied += r.actionsApplied;
            out.factsInserted = (out.factsInserted || 0) + (r.factsInserted || 0);
            out.factsUpdated = (out.factsUpdated || 0) + (r.factsUpdated || 0);
            out.receipts = [...(out.receipts || []), ...(r.receipts || [])];
            out.errors.push(...(r.errors || []));
            if (r.errors.length)
                break;
        }
        if (okBatches === 0 || out.errors.length)
            out.ok = false;
        if (batches.length > maxCalls) {
            out.errors.push(`本轮只处理 ${maxCalls}/${batches.length} 批(其余留待下轮)`);
        }
        out.deferredCount = memories.length - (out.processedCount || 0);
        return out;
    }
    catch (e) {
        return { ...base, errors: [e.message] };
    }
}
// ═══════════════════════════════════════════════════════════════════
// v1.10: 记忆整合子进程(Memory Consolidator)
// 忠实还原 Claude Code MEMORY_CONSOLIDATION_PROMPT 精神(用户确认,不自定义改动):
//   - CONFLICT RESOLUTION:矛盾时 ALWAYS 偏最新用户决定;被撤销/取代的规则 REMOVE
//   - DEDUPLICATION & MERGING:同主题碎片归并,输出严格保持 4 种封闭类型之一
//   - PRUNING & COMPRESSION:删临时调试/错误日志/误存代码;相对日期转绝对日期
//   - NEVER invent new facts(铁律):保持用户偏好原样
// 执行:先读后写,原子完成。
// ═══════════════════════════════════════════════════════════════════
export function buildConsolidationPrompt() {
    return loadPromptOverride('CONSOLIDATE_PROMPT_FILE', builtinConsolidationPrompt());
}
function builtinConsolidationPrompt() {
    return `你是记忆整合引擎(Memory Consolidator)。输入:
1. 候选记忆(带 id/memType/text/createdAt)
2. 候选相似对(向量预筛结果,可能为空)
3. 近期对话转录(捕捉最新用户决定)

任务是全量"去重 + 矛盾消解 + 主题归并"。先读后写,原子完成。

══════════════════════
【CONFLICT RESOLUTION(矛盾消解)】
- 记忆互相矛盾时,ALWAYS prefer the most recent user decision(以最近一次用户决定为准)。
- 规则被撤销/取代 → REMOVE 过时记忆(用 delete)。
- 用户偏好保持原样,不擅自改写。

【DEDUPLICATION & MERGING(去重归并)】
- 同主题碎片合并为一条整合后的 Markdown 文本(用 merge)。
- merge 输出的 newMemType 必须严格是 4 种封闭类型之一:user / feedback / project / reference。
- 不相关的主题不要合并。

【PRUNING & COMPRESSION(剪枝压缩)】
- 删除临时调试步骤/错误日志/误存的代码片段。
- 相对日期转成绝对日期(如 "yesterday" → 今天日期,见输入顶部)。
- 唯一无重复的记忆 → keep 保留。

【NEVER invent new facts(铁律)】
- 绝不虚构输入中不存在的事实;用户偏好原文保留,不添加不存在的细节。

══════════════════════
【输出】只返回严格 JSON 数组,不要代码围栏,不要任何其他文字:
[
  {"action":"merge","sourceIds":["a","b"],"newText":"整合后的 Markdown 文本","newMemType":"feedback"},
  {"action":"delete","id":"c","reason":"被最新用户决定取代"},
  {"action":"invalidate","factId":"f1","reason":"这条事实已被新记忆明确推翻"},
  {"action":"keep","id":"d","reason":"唯一无重复"}
]
- merge 的 newMemType 必须属于 4 种封闭类型;不需要操作时返回 []。
- 只允许 merge / delete / invalidate / keep 四种 action。**不要输出 relate、boost、reclassify、split、extract 等其它动作**——执行器不认,会整条丢弃,白花 token。
- 只有"现有事实"里明确被推翻的条目才 invalidate（用给定 id），拿不准就 keep。`;
}
export const MEMORY_CONSOLIDATION_PROMPT = buildConsolidationPrompt();
/** 把整合 LLM 输出的动作规范化为 applyReflectActions 认识的 ReflectAction(keep 不落地,只计数) */
function normalizeConsolidationActions(raw) {
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.actions) ? raw.actions : []);
    const actions = [];
    const invalidate = [];
    let kept = 0;
    const errors = [];
    for (const a of list) {
        const action = a?.action;
        if (action === 'merge') {
            const ids = Array.isArray(a.sourceIds) ? a.sourceIds.filter((x) => typeof x === 'string' && x.length > 0) : [];
            if (ids.length >= 2 && typeof a.newText === 'string' && a.newText.trim().length > 0) {
                actions.push({ action: 'merge', sourceIds: ids, newText: a.newText, newMemType: isMemType(a.newMemType) ? a.newMemType : undefined });
            }
            else {
                errors.push('merge: need sourceIds(≥2) and newText, skipped');
            }
        }
        else if (action === 'delete') {
            if (typeof a.id === 'string' && a.id.length > 0)
                actions.push({ action: 'delete', targetId: a.id });
            else
                errors.push('delete: need id, skipped');
        }
        else if (action === 'keep') {
            if (typeof a.id === 'string' && a.id.length > 0)
                kept++;
            else
                errors.push('keep: need id, skipped');
        }
        else if (action === 'invalidate') {
            // v1.23 非功能性冲突：新记忆明确推翻旧事实 → 旧事实只打 valid_to，保留历史
            if (typeof a.factId === 'string' && a.factId.length > 0)
                invalidate.push(a.factId);
            else
                errors.push('invalidate: need factId, skipped');
        }
        else if (action === 'extract') {
            // v1.23-fix: 整合不是重新提取。以前这里放行 extract，配合"保真提示词"会把整合变成逐条
            // 重摘要（净增记忆、merged 恒 0）。现在明确拒绝，让提示词/解析不一致立刻暴露。
            errors.push('extract 不属于整合动作（整合只允许 merge/delete/invalidate/keep），skipped');
        }
        else {
            errors.push(`unknown consolidation action: ${action || '(missing)'}, skipped`);
        }
    }
    return { actions, kept, invalidate, errors };
}
/**
 * v1.10: 记忆整合主流程 — 向量预筛 → LLM 整合 → applyReflectActions 原子执行。
 * - EMBED_MODE=none:预筛返回空 → LLM 全量扫兜底
 * - 有向量但无相似候选 → 直接返回空结果,不再调 LLM(省 token)
 */
export async function runConsolidate(charId = 'default', project, threshold, limit, opts = {}) {
    const base = { ok: false, scanned: 0, candidates: 0, merged: 0, deleted: 0, kept: 0, actions: 0, applied: 0, errors: [] };
    if (!isReflectConfigured()) {
        return { ...base, skipped: true, errors: ['REFLECT_LLM_API_KEY 未配置,跳过整合'] };
    }
    const proj = normalizeProject(project);
    const force = opts.force === true;
    // v1.11.2 memdir:逐 memType 库扫描并合并 —— 旧版只读 general:候选即便从别库产生,也会在下面
    // 的 `mems.filter(...)`(按候选 id 过滤)里被丢掉,等于白算。这里把各库并起来再按重要度截断。
    // v1.23: critical(核心记忆)与 cold(冷存)一律不进入整合窗口 —— 这是"哪些不参加新沉淀"的唯一入口。
    // v1.23 轮转：窗口 = "重要度前 300" + "最久未更新 200"。只取重要度会让低分老记忆永远轮不到，
    // 加上"最久未更新"这一片，等于让沉睡的记忆每轮都有一批被轮到（不需要额外游标）。
    // v1.23-fix：两片必须各自保底。原实现把「前 300 + 最久 200」合成一个数组后按 importance
    // 截到 500，结果低分老记忆被整片裁掉 —— 轮转等于没发生。现在先锁 top300，再用"最久 200"
    // 补到 500，保证每轮都有老记忆被轮到。
    const topSlice = [];
    const oldestSlice = [];
    const seenTop = new Set();
    const seenOldest = new Set();
    const pushRows = (rows, target, seen) => {
        for (const r of rows) {
            if (seen.has(r.id))
                continue;
            seen.add(r.id);
            target.push(r);
        }
    };
    const windowWhere = `is_active = 1 AND project = ? AND (locked IS NULL OR locked = 0)
        AND COALESCE(tier, 'standard') <> 'critical'
        AND COALESCE(status, '') <> 'cold'`;
    for (const mt of listMemTypeDirs(proj)) {
        try {
            const db = DatabaseManager.getInstance(project, mt);
            pushRows(db.prepare(`
        SELECT id, mem_type, text, created_at, importance FROM memory
        WHERE ${windowWhere}
        ORDER BY importance DESC, created_at DESC
        LIMIT 300
      `).all(proj), topSlice, seenTop);
            pushRows(db.prepare(`
        SELECT id, mem_type, text, created_at, importance FROM memory
        WHERE ${windowWhere}
        ORDER BY COALESCE(updated_at, created_at) ASC
        LIMIT 200
      `).all(proj), oldestSlice, seenOldest);
        }
        catch { /* 单个库读不到不影响其它库 */ }
    }
    topSlice.sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0));
    const mems = topSlice.slice(0, 300);
    const windowSeen = new Set(mems.map((m) => m.id));
    for (const r of oldestSlice) {
        if (mems.length >= 500)
            break;
        if (windowSeen.has(r.id))
            continue;
        windowSeen.add(r.id);
        mems.push(r);
    }
    const scanned = mems.length;
    if (scanned < 2) {
        return { ...base, ok: true, scanned, skipped: true, errors: ['active 记忆不足 2 条,无需整合'] };
    }
    const windowIds = new Set(mems.map((m) => m.id));
    // 1. 向量预筛(EMBED_MODE=none 返回空 → 全量扫兜底)
    let candidates = [];
    if (isEmbedEnabled()) {
        candidates = await findSimilarCandidates(proj, threshold ?? CONSOLIDATE_SIMILARITY, limit ?? CONSOLIDATE_MAX_PAIRS);
        // v1.23: 候选对必须两端都在本次窗口内 —— 否则模型会拿到窗口外的 id，动作必被
        // `allowedSourceIds` 拒绝（现网 "target is outside the current reflection input" 的根因）。
        const before = candidates.length;
        candidates = candidates.filter(p => windowIds.has(p.idA) && windowIds.has(p.idB));
        if (candidates.length !== before) {
            console.error(`[consolidate] 候选对裁剪：${before} → ${candidates.length}（窗口外 ${before - candidates.length} 对）`);
        }
        if (candidates.length === 0) {
            // 有向量但窗口内确实无相似对 → 不再调 LLM,省 token
            return { ...base, ok: true, scanned, skipped: true, errors: ['无相似候选,无需整合'] };
        }
    }
    // 2. 组装 LLM 输入:向量模式 → 候选涉及的记忆;全量模式 → 全部记忆
    const candidateIds = new Set();
    for (const p of candidates) {
        candidateIds.add(p.idA);
        candidateIds.add(p.idB);
    }
    const inputMems = candidates.length > 0 ? mems.filter(m => candidateIds.has(m.id)) : mems;
    const today = new Date().toISOString().slice(0, 10);
    const itemsJson = JSON.stringify(inputMems.map(m => ({
        id: m.id,
        memType: m.mem_type || 'general',
        text: m.text || '',
        createdAt: (m.created_at || '').slice(0, 10),
    })), null, 1);
    const pairsJson = JSON.stringify(candidates, null, 1);
    // 3. 最近对话转录(conversation_log,捕捉最新用户修正)
    let transcript = '';
    try {
        const convs = getRecentConversations(charId, 24 * 7, 20, proj);
        transcript = JSON.stringify(convs.map(c => ({ id: c.id, text: c.text, createdAt: c.created_at })), null, 2);
    }
    catch {
        transcript = '';
    }
    // 3.5 现有事实（用于非功能性冲突裁决）：同一 subject 下互斥的旧事实打 valid_to，不删除。
    //     只取高置信度、上限 80 条，避免把 prompt 撑大。
    let factRows = [];
    try {
        factRows = DatabaseManager.getInstance(proj).prepare(`
      SELECT id, subject, predicate, object, confidence FROM facts
      WHERE is_active = 1 AND project = ? AND confidence >= 0.6
        AND (valid_to IS NULL OR valid_to = '')
      ORDER BY updated_at DESC LIMIT 80
    `).all(proj);
    }
    catch { /* facts 表不存在时忽略 */ }
    const factsJson = JSON.stringify(factRows.map(f => ({ id: f.id, s: f.subject, p: f.predicate, o: f.object })), null, 1);
    // 4. 输入指纹门：整合是"每次启动跑一次整库"的重活（2026-10-23 审计：一次 ≈ 2.7 万 prompt +
    // 最多 3.2 万输出，多数 merged=0，dsh 上甚至整轮撞 max_tokens 被截断）。输入没变时重复调用
    // 纯属烧 token，所以按"候选对 + 涉及记忆原文"做指纹：相同则成功结果复用 7 天、失败复用 1 小时，
    // 重启风暴里不会每 25 秒重烧一遍。
    const fingerprint = crypto.createHash('sha1')
        .update((candidates.length
        ? candidates.map(p => `${p.idA}|${p.idB}`).sort().join(',')
        : `all:${scanned}`) + '#' + inputMems.map(m => `${m.id}:${m.text || ''}`).join('\u0001')
        + '#' + factRows.map(f => `${f.id}:${f.object}`).join('|'))
        .digest('hex');
    const statePath = path.join(currentMemDir(), `consolidate-state-${proj}.json`);
    const readState = () => { try {
        return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
    catch {
        return null;
    } };
    const writeState = (ok, merged) => {
        try {
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify({ fingerprint, at: new Date().toISOString(), ok, merged, scanned, candidates: candidates.length }), 'utf8');
        }
        catch { /* 状态写失败不影响主流程 */ }
    };
    const prevState = readState();
    if (!force && prevState) {
        const age = Date.now() - Date.parse(prevState.at);
        if (Number.isFinite(age) && age >= 0) {
            const sameInput = prevState.fingerprint === fingerprint;
            const unchangedTtl = prevState.ok && sameInput ? 7 * 24 * 3600 * 1000 : 0;
            const floorMs = CONSOLIDATE_MIN_INTERVAL_HOURS * 3600 * 1000;
            let reason = '';
            if (unchangedTtl && age < unchangedTtl) {
                reason = `输入未变（上次 ${(age / 3600000).toFixed(1)}h 前, merged=${prevState.merged ?? 0}）`;
            }
            else if (age < floorMs) {
                reason = `距上次整合 ${(age / 3600000).toFixed(1)}h,未到最小间隔 ${CONSOLIDATE_MIN_INTERVAL_HOURS}h`;
            }
            if (reason) {
                console.error(`[consolidate] 跳过：${reason}`);
                return { ...base, ok: true, scanned, candidates: candidates.length, skipped: true, errors: [] };
            }
        }
    }
    const userPrompt = `今天是 ${today}(相对日期转绝对日期时以此为准)。
请整合以下候选记忆,输出整合 JSON 数组。

【候选记忆】
${itemsJson}

【候选相似对】
${pairsJson}

【现有事实（判断矛盾用；新记忆明确推翻某条时，输出 {"action":"invalidate","factId":"事实id","reason":"…"}）】
${factsJson}

【近期对话转录】
${transcript || '无近期对话转录'}`;
    // v1.23-fix: 整合的系统提示词以前在 evidence/verbatim 库会被整段替换成"保真提取提示词"，
    // 而后者明令「禁止 merge/delete」、只给 extract 的输出格式 —— 于是整合退化成逐条重新摘要，
    // 每跑一次净增 N 条记忆、merged 永远 0（实测 hermes 一轮写 18 条、lobehub 12 条）。
    // 正确做法：任务永远是"整合"，保真策略只作为约束追加在后面。
    const systemPrompt = buildConsolidationPrompt() + '\n' + reflectionFidelityPrompt(proj);
    const llm = await callLlm(systemPrompt, userPrompt, undefined, REFLECT_DEEP_MAX_TOKENS);
    if (!llm) {
        writeState(false, 0);
        return { ...base, scanned, candidates: candidates.length, errors: ['LLM 调用失败'] };
    }
    if (llm.finishReason === 'length') {
        writeState(false, 0);
        return { ...base, scanned, candidates: candidates.length, errors: ['LLM 输出被截断，未应用整合'] };
    }
    const parsed = parseJsonRobust(llm.content, false);
    if (!parsed) {
        writeState(false, 0);
        return { ...base, scanned, candidates: candidates.length, errors: ['未找到有效 JSON 结果'] };
    }
    // 5. 规范化 + 原子执行(keep 不落地;merge/delete 复用 applyReflectActions)
    const norm = normalizeConsolidationActions(parsed);
    // v1.23-fix: 保真库里 delete/merge 的破坏性不同 —— 证据库只允许 merge、逐字库两者都不允许。
    // 提示词是通用的，模型可能仍输出 delete；这里按策略先过滤，避免整批被 applyReflectActions 拒绝。
    {
        const policy = reflectionPolicy(proj);
        const blocked = policy === 'verbatim' ? ['delete', 'merge'] : policy === 'evidence' ? ['delete'] : [];
        if (blocked.length) {
            const before = norm.actions.length;
            norm.actions = norm.actions.filter(a => !blocked.includes(a.action));
            const dropped = before - norm.actions.length;
            if (dropped > 0)
                console.error(`[consolidate] 保真策略(${policy})丢弃 ${dropped} 条 ${blocked.join('/')} 动作（只保留可回查的合并）`);
        }
    }
    // v1.23-fix: 现网出现"completion 1.5 万 token、merged=0、errors=0"的黑箱。零动作时必须留下
    // 形状与内容头，否则无法判断是模型返回空数组、还是解析器把动作吞了。
    if (norm.actions.length === 0 && norm.kept === 0) {
        const shape = Array.isArray(parsed) ? `array(${parsed.length})` : `object(${Object.keys(parsed || {}).join(',')})`;
        const head = String(llm.content || '').replace(/\s+/g, ' ').slice(0, 200);
        console.error(`[consolidate] 零动作：parsed=${shape} chars=${String(llm.content || '').length} head=${JSON.stringify(head)}`);
    }
    let r = { applied: 0, errors: [], receipts: [] };
    if (norm.actions.length > 0) {
        try {
            const inputIds = new Set(inputMems.map(m => m.id));
            r = await applyReflectActions(norm.actions, charId, proj, { allowedSourceIds: inputIds, automatic: true, consolidation: true });
        }
        catch (e) {
            norm.errors.push(e.message);
        }
    }
    const merged = r.receipts.filter(x => x.action === 'merge' && x.status === 'applied').length;
    const deleted = r.receipts.filter(x => x.action === 'delete' && x.status === 'applied').length;
    // v1.23 失效旧事实（不删除）：只对明确被推翻的 factId 打 valid_to
    let invalidated = 0;
    if (norm.invalidate.length > 0) {
        try {
            const now = new Date().toISOString();
            const db = DatabaseManager.getInstance(proj);
            const stmt = db.prepare("UPDATE facts SET valid_to = ?, updated_at = ? WHERE id = ? AND is_active = 1 AND (valid_to IS NULL OR valid_to = '')");
            for (const fid of norm.invalidate.slice(0, 50))
                invalidated += stmt.run(now, now, fid).changes;
        }
        catch (e) {
            norm.errors.push(`invalidate: ${e.message}`);
        }
    }
    const ok = norm.errors.length === 0 && r.errors.length === 0;
    writeState(ok, merged);
    return {
        ok,
        scanned,
        candidates: candidates.length,
        merged,
        deleted,
        kept: norm.kept,
        actions: norm.actions.length,
        applied: r.applied,
        invalidated,
        errors: [...norm.errors, ...r.errors],
        receipts: r.receipts,
    };
}
