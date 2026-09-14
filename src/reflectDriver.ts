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
import { getUnanalyzedConversations, listAllMemories, applyReflectResult, applyReflectActions, ReflectAction, ReflectReceipt, ReflectResult } from './reflect.js';
import { DatabaseManager } from './db.js';
import { normalizeProject, isEmbedEnabled } from './env.js';
import { isMemType } from './memType.js';
import { findSimilarCandidates, SimilarCandidate, CONSOLIDATE_SIMILARITY, CONSOLIDATE_MAX_PAIRS } from './consolidate.js';
import { getRecentConversations } from './digest.js';

const FACT_EXTRACTION = (process.env.REFLECT_FACT_EXTRACTION || 'auto').trim().toLowerCase();
const MAX_FACTS = parseInt(process.env.REFLECT_MAX_FACTS || '15', 10) || 15;

// 启动自动反思触发阈值(条件达成后,下次启动 server 时自动执行一次)
const MIN_GAP_HOURS = (() => { const v = parseFloat(process.env.REFLECT_MIN_GAP_HOURS || '24'); return Number.isFinite(v) && v > 0 ? v : 24; })();
const MIN_UNANALYZED = (() => { const v = parseInt(process.env.REFLECT_MIN_UNANALYZED || '5', 10); return Number.isFinite(v) && v >= 0 ? v : 5; })();

// v1.10: 启动自动整合触发阈值(active 记忆条数 > 该值 → 下次启动自动整合一次)
const CONSOLIDATE_MIN_MEMORIES = (() => { const v = parseInt(process.env.CONSOLIDATE_MIN_MEMORIES || '15', 10); return Number.isFinite(v) && v >= 0 ? v : 15; })();

/**
 * v1.11: LLM 通道 — 三通道架构(LLM1 triage / 向量模型 / LLM2 reflect)。
 * 构造 `${PREFIX}_LLM_URL / ${PREFIX}_LLM_API_KEY / ${PREFIX}_LLM_MODEL` 配置:
 *   优先取前缀通道自身值;缺省回退 REFLECT_*(旧单通道);再回退内置默认。
 *   供 triage(LLM1) 与 reflect(LLM2) 复用。
 */
export interface LlmChannel {
  url: string;
  apiKey: string;
  model: string;
}

export function makeLlmChannel(prefix: string): LlmChannel {
  const get = (suffix: string, fallback: string): string => {
    const v = process.env[`${prefix}_${suffix}`];
    return v && v.trim().length > 0 ? v.trim() : fallback;
  };
  return {
    url: get('LLM_URL', process.env.REFLECT_LLM_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey: get('LLM_API_KEY', process.env.REFLECT_LLM_API_KEY || ''),
    model: get('LLM_MODEL', process.env.REFLECT_LLM_MODEL || 'deepseek-chat'),
  };
}

export function isReflectConfigured(): boolean {
  return !!makeLlmChannel('reflect').apiKey;
}

export function isFactExtractionEnabled(): boolean {
  return FACT_EXTRACTION !== 'off';
}

export interface ReflectCondition {
  should: boolean;
  reason: string;
}

/**
 * 启动自动反思条件检查(两个同时满足才反思):
 *   a. REFLECT_LLM_API_KEY 已配置
 *   b. 距上次反思 ≥ REFLECT_MIN_GAP_HOURS(默认 24h;从未反思 → 视为超时,满足)
 *   c. 未分析对话数 > REFLECT_MIN_UNANALYZED(默认 5)
 * 按 project 维度查询(默认项目用 charId + normalizeProject)。
 */
export function shouldAutoReflect(charId: string = 'airi', project?: string): ReflectCondition {
  if (!isReflectConfigured()) {
    return { should: false, reason: 'REFLECT_LLM_API_KEY 未配置' };
  }
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);

  // 最近一次反思时间(source='reflect_summary',按 project 过滤)
  const last = db.prepare(`
    SELECT created_at FROM memory
    WHERE source = 'reflect_summary' AND project = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(proj) as any;
  const lastTime = last?.created_at ? new Date(last.created_at).getTime() : null;

  const hoursSince = lastTime === null
    ? Number.POSITIVE_INFINITY  // 从未反思 → 视为超时,满足时间条件
    : (Date.now() - lastTime) / 3600000;
  const timeOk = hoursSince >= MIN_GAP_HOURS;
  const gapLabel = lastTime === null ? '∞' : `${Math.floor(hoursSince * 10) / 10}`;

  if (!timeOk) {
    return { should: false, reason: `距上次反思 ${gapLabel} 小时,未到 ${MIN_GAP_HOURS}h` };
  }

  // 未分析对话数(与 getUnanalyzedConversations 同口径:conversation_log、created_at > 上次反思)
  const since = last?.created_at || new Date(0).toISOString();
  const cnt = db.prepare(`
    SELECT COUNT(*) as c FROM memory
    WHERE is_active = 1 AND source = 'conversation_log'
      AND project = ? AND created_at > ?
  `).get(proj, since) as any;
  const count = cnt?.c ?? 0;

  if (count <= MIN_UNANALYZED) {
    return { should: false, reason: `未分析对话 ${count} 条,未超 ${MIN_UNANALYZED}` };
  }

  return { should: true, reason: `距上次反思 ${gapLabel}h 且未分析对话 ${count} 条` };
}

/**
 * v1.10: 启动自动整合条件检查 — active 记忆条数 > CONSOLIDATE_MIN_MEMORIES(默认 15)即达成。
 * 注意:整合只需记忆足够多,不依赖 REFLECT_LLM_API_KEY(无 key 时 runConsolidate 会报错跳过)。
 */
export function shouldAutoConsolidate(project?: string): { should: boolean; count: number; min: number; reason: string } {
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);
  const count = (db.prepare('SELECT COUNT(*) as c FROM memory WHERE is_active = 1 AND project = ?').get(proj) as any)?.c ?? 0;
  const min = CONSOLIDATE_MIN_MEMORIES;
  if (count > min) return { should: true, count, min, reason: `${count} > ${min}` };
  return { should: false, count, min, reason: `${count} 未超 ${min}` };
}

/** facts 提取规则片段(拼进 prompt) */
function factsRules(maxFacts: number): string {
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
function memTypeRules(): string {
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

function factsFieldSpec(maxFacts: number): string {
  return `,
  "facts": [
    {"subject":"user","predicate":"姓名","object":"小托","confidence":0.95},
    {"subject":"user","predicate":"职业","object":"程序员","confidence":0.9}
  ]`;
}

/** 输出格式片段：factExtraction=off 时不含 facts 字段 */
function outputFormatSpec(factExtraction: string, maxFacts: number): string {
  const facts = factExtraction === 'off' ? '' : factsFieldSpec(maxFacts);
  return `══════════════════════
【输出格式】只返回严格 JSON 对象，不要任何其他文字（代码围栏也不要有）：

{
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
export function buildReflectSystemPrompt(factExtraction: string = FACT_EXTRACTION, maxFacts: number = MAX_FACTS): string {
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
export function buildDeepReflectPrompt(factExtraction: string = FACT_EXTRACTION, maxFacts: number = MAX_FACTS): string {
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
export const REFLECT_SYSTEM_PROMPT: string = buildReflectSystemPrompt();
export const DEEP_REFLECT_PROMPT: string = buildDeepReflectPrompt();

/**
 * 按当前解析状态补全未闭合的括号与字符串(用于截断救济)
 * 只做词法扫描,不解析语义:字符串内的括号不计数,被截断的字符串补引号,左括号逐个补右括号。
 */
function closeBrackets(x: string): string {
  let inStr = false, esc = false;
  const stack: string[] = [];
  for (const ch of x) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = x;
  if (inStr) out += '"';
  while (stack.length) out += (stack.pop() === '[' ? ']' : '}');
  return out;
}

/** 常见坏 JSON 修补:尾随逗号 / 裸控制字符 / 非法反斜杠转义(LLM 写 Windows 路径 `D:\AI\x` 时必犯) */
function repairJson(x: string): string {
  return x
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/[\x00-\x1f]+/g, ' ')
    .replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
}

/** 判断末尾是否停在未闭合的字符串字面量里(截断的典型特征) */
function endsInsideString(x: string): boolean {
  let inStr = false, esc = false;
  for (const ch of x) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; }
  }
  return inStr;
}

/**
 * 截断救济:LLM 输出被 max_tokens 截断时(常见:action 条数多),
 * 从尾部逐级回退到最后一个完整元素的收尾符,丢弃残缺元素后补全括号再解析。
 * 宁可少应用几条 action,也不要整轮丢弃。
 */
function salvageTruncatedJson(body: string): any | null {
  const accept = (x: string): any | null => {
    try {
      const r = JSON.parse(repairJson(x));
      if (Array.isArray(r)) return { actions: r };
      if (r && typeof r === 'object') return r as any;
    } catch { /* keep trimming */ }
    return null;
  };
  let cut = body.length;
  // 末尾停在未闭合字符串 → 最后一条元素残缺:回退到"上一个完整元素的收尾符"再补括号,
  // 不能退到元素内部的逗号(那会把残缺元素补成半个对象,如 {action:"merge"})
  if (endsInsideString(body)) {
    const next = Math.max(body.lastIndexOf('}', cut - 1), body.lastIndexOf(']', cut - 1));
    if (next > 1) cut = next;
  }
  for (let i = 0; i < 80 && cut > 1; i++) {
    const cand = body.slice(0, cut).replace(/[,\s]+$/, '');
    const r = accept(closeBrackets(cand));
    if (r) return r;
    const next = Math.max(
      body.lastIndexOf(',', cut - 1),
      body.lastIndexOf('}', cut - 1),
      body.lastIndexOf(']', cut - 1),
    );
    if (next <= 1) break;
    cut = next;
  }
  return null;
}

/**
 * 多策略解析 LLM 返回的 JSON(容忍常见错误)
 * 支持 [...] 数组和 {...} 对象,以及 markdown 代码围栏包裹:
 *   - 数组 → 包成 { actions: [...] }(老 prompt 的只返回数组格式)
 *   - 对象 → 原样返回
 *   - 被 max_tokens 截断 → 回退到最后一个完整元素并补全括号(salvageTruncatedJson)
 */
export function parseJsonRobust(raw: string): any | null {
  let s = (raw || '').trim();
  // 剥离 markdown 代码围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();

  // 提取最外层 {...} 或 [...] 块;有前导文字时从首个括号取到结尾(不要贪心到最后一个 '}',
  // 否则截断输出的尾部会被切掉,救济就无从下手)
  const body = (() => {
    if (s.startsWith('{') || s.startsWith('[')) return s;
    const i = Math.min(...[{ '{': s.indexOf('{') }, { '[': s.indexOf('[') }]
      .map(o => Object.values(o)[0]).filter(v => v >= 0).concat([Number.MAX_SAFE_INTEGER]));
    return Number.isFinite(i) && i < Number.MAX_SAFE_INTEGER ? s.slice(i) : null;
  })();
  if (!body) return null;

  const strategies = [
    (x: string) => JSON.parse(x),
    (x: string) => JSON.parse(x.replace(/,\s*([}\]])/g, '$1')),
    (x: string) => JSON.parse(x.replace(/"\s*\n\s*"/g, '",\n"')),
    (x: string) => JSON.parse(x.replace(/,\s*([}\]])/g, '$1').replace(/"\s*\n\s*"/g, '",\n"')),
    (x: string) => JSON.parse(x.replace(/,\s*([}\]])/g, '$1').replace(/"\s*\n\s*"/g, '",\n"').replace(/[\x00-\x1f]+/g, ' ')),
  ];
  for (const fn of strategies) {
    try {
      const r = fn(body);
      if (Array.isArray(r)) return { actions: r };
      if (r && typeof r === 'object') return r;
    } catch { /* try next */ }
  }
  // 收尾:截断救济(内部第一步即"补全原 body",失败再逐级回退元素边界)
  return salvageTruncatedJson(body);
}

/** 把 parseJsonRobust 结果规范化为 applyReflectResult 期望的 ReflectResult */
function normalizeReflectResult(parsed: any): ReflectResult {
  const out: any = { ...parsed };
  out.actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  if (FACT_EXTRACTION === 'off') {
    out.facts = [];
  } else if (Array.isArray(parsed.facts)) {
    out.facts = parsed.facts.slice(0, MAX_FACTS);
  } else {
    out.facts = [];
  }
  return out as ReflectResult;
}

export interface LlmResponse {
  content: string;
  reasoning: string;
}

/**
 * 调用 LLM(OpenAI 兼容,非流式)。
 * 通道:缺省用 reflect(REFLECT_*);传 channel 则用指定通道(triage/reflect)。
 */
export async function callLlm(systemPrompt: string, userPrompt: string, channel?: LlmChannel): Promise<LlmResponse | null> {
  const ch = channel ?? makeLlmChannel('reflect');
  if (!ch.apiKey) return null;
  // 到 API 的连接偶发被断(大 prompt/限流),单次失败就放弃会让整轮反思白跑 → 退避重试
  const attempts = Math.max(1, Number(process.env.REFLECT_LLM_RETRIES || 3));
  for (let i = 1; i <= attempts; i++) {
    try {
      const resp = await fetch(`${ch.url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ch.apiKey}` },
        body: JSON.stringify({
          model: ch.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 8192,
          stream: false,
        }),
      });
      if (!resp.ok) throw new Error(`LLM ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json() as any;
      const msg = data?.choices?.[0]?.message || {};
      return { content: msg.content || '', reasoning: msg.reasoning_content || '' };
    } catch (e: any) {
      const cause = e?.cause ? ` (cause: ${e.cause.code || e.cause.message || String(e.cause)})` : '';
      if (i >= attempts) {
        console.error(`[reflect-driver] LLM call failed after ${attempts} tries:`, e.message + cause);
        return null;
      }
      console.error(`[reflect-driver] LLM call failed (try ${i}/${attempts}):`, e.message + cause);
      await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
  return null;
}

export interface ReflectRunResult {
  ok: boolean;
  mode: 'auto' | 'deep';
  conversationCount?: number;
  memoryCount?: number;
  actions: number;
  applied: number;
  factsInserted?: number;
  factsUpdated?: number;
  errors: string[];
  skipped?: boolean;
  receipts?: ReflectReceipt[];
}

/** 日常反思:未分析对话 → 日记浓缩/提取 */
export async function runAutoReflect(charId: string, limit = 30, project?: string): Promise<ReflectRunResult> {
  const base: ReflectRunResult = { ok: false, mode: 'auto', actions: 0, applied: 0, errors: [] };
  if (!isReflectConfigured()) {
    return { ...base, skipped: true, errors: ['REFLECT_LLM_API_KEY 未配置,跳过反思'] };
  }
  try {
    const conversations = getUnanalyzedConversations(charId, undefined, limit, project);
    if (conversations.length === 0) {
      return { ...base, ok: true, conversationCount: 0, skipped: true, errors: ['无未分析对话'] };
    }
    const userPrompt = `请分析以下对话，输出反思JSON：\n\n${conversations.map(c => (c as any).text).join('\n---\n').substring(0, 30000)}`;
    const llm = await callLlm(buildReflectSystemPrompt(), userPrompt);
    if (!llm) return { ...base, errors: ['LLM 调用失败'] };
    const parsed = parseJsonRobust(llm.content || llm.reasoning);
    if (!parsed) return { ...base, errors: ['未找到有效 JSON 结果'] };
    const result = normalizeReflectResult(parsed);
    const r = await applyReflectResult(result, charId, project);
    return {
      ok: true, mode: 'auto', conversationCount: conversations.length,
      actions: (result.actions || []).length, applied: r.actionsApplied, errors: r.errors,
      receipts: r.receipts, factsInserted: r.factsInserted, factsUpdated: r.factsUpdated,
    };
  } catch (e: any) {
    return { ...base, errors: [e.message] };
  }
}

/**
 * 深度校准:全量记忆 → 去重/画像/图谱
 * v1.20: 分批送模型(默认每批 12 条,单次最多 4 批)。一次性塞 30+ 条会让模型输出超过
 * max_tokens 被截断,JSON 解析失败反而整轮丢弃;分批后每批输出小、必闭合,代价是多次调用。
 * 可用 REFLECT_DEEP_CHUNK / REFLECT_DEEP_MAXCALLS 调参。
 */
export async function runDeepReflect(charId: string, limit = 500, project?: string): Promise<ReflectRunResult> {
  const base: ReflectRunResult = { ok: false, mode: 'deep', actions: 0, applied: 0, errors: [] };
  if (!isReflectConfigured()) {
    return { ...base, skipped: true, errors: ['REFLECT_LLM_API_KEY 未配置,跳过反思'] };
  }
  try {
    const memories = listAllMemories(charId, limit, project) as any[];
    if (memories.length === 0) {
      return { ...base, ok: true, memoryCount: 0, skipped: true, errors: ['库为空'] };
    }
    const slim = memories.map(m => ({
      id: m.id,
      text: (m.text || '').slice(0, 300),
      type: m.type, memType: m.memType || 'general', category: m.category,
      tags: m.tags || [], importance: m.importance ?? 0.5,
      emotionalImpact: m.emotionalImpact ?? 0, tier: m.tier || 'standard',
      locked: m.locked || 0, source: m.source || '',
      date: (m.createdAt || '').slice(0, 10),
    }));

    const chunk = Math.max(4, Number(process.env.REFLECT_DEEP_CHUNK || 12));
    const maxCalls = Math.max(1, Number(process.env.REFLECT_DEEP_MAXCALLS || 4));
    const batches: any[][] = [];
    for (let i = 0; i < slim.length; i += chunk) batches.push(slim.slice(i, i + chunk));

    const out: ReflectRunResult = {
      ok: true, mode: 'deep', memoryCount: memories.length,
      actions: 0, applied: 0, factsInserted: 0, factsUpdated: 0, errors: [], receipts: [],
    };
    let okBatches = 0;
    for (const batch of batches.slice(0, maxCalls)) {
      const userPrompt = `记忆列表(${batch.length} 条)：\n\n${JSON.stringify(batch, null, 1)}\n\n请深度分析本批记忆,返回 JSON 操作对象。`;
      const llm = await callLlm(buildDeepReflectPrompt(), userPrompt);
      if (!llm) { out.errors.push('LLM 调用失败'); continue; }
      const parsed = parseJsonRobust(llm.content || llm.reasoning);
      if (!parsed) { out.errors.push('未找到有效 JSON 结果'); continue; }
      const result = normalizeReflectResult(parsed);
      const r = await applyReflectResult(result, charId, project);
      okBatches++;
      out.actions += (result.actions || []).length;
      out.applied += r.actionsApplied;
      out.factsInserted = (out.factsInserted || 0) + (r.factsInserted || 0);
      out.factsUpdated = (out.factsUpdated || 0) + (r.factsUpdated || 0);
      out.receipts = [...(out.receipts || []), ...(r.receipts || [])];
      out.errors.push(...(r.errors || []));
    }
    if (okBatches === 0) out.ok = false;
    if (batches.length > maxCalls) {
      out.errors.push(`本轮只处理 ${maxCalls}/${batches.length} 批(其余留待下轮)`);
    }
    return out;
  } catch (e: any) {
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

export function buildConsolidationPrompt(): string {
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
  {"action":"keep","id":"d","reason":"唯一无重复"}
]
- merge 的 newMemType 必须属于 4 种封闭类型;不需要操作时返回 []`;
}

export const MEMORY_CONSOLIDATION_PROMPT: string = buildConsolidationPrompt();

/** 把整合 LLM 输出的动作规范化为 applyReflectActions 认识的 ReflectAction(keep 不落地,只计数) */
function normalizeConsolidationActions(raw: any): { actions: ReflectAction[]; kept: number; errors: string[] } {
  const list: any[] = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.actions) ? raw.actions : []);
  const actions: ReflectAction[] = [];
  let kept = 0;
  const errors: string[] = [];
  for (const a of list) {
    const action = a?.action;
    if (action === 'merge') {
      const ids = Array.isArray(a.sourceIds) ? a.sourceIds.filter((x: any) => typeof x === 'string' && x.length > 0) : [];
      if (ids.length >= 2 && typeof a.newText === 'string' && a.newText.trim().length > 0) {
        actions.push({ action: 'merge', sourceIds: ids, newText: a.newText, newMemType: isMemType(a.newMemType) ? a.newMemType : undefined });
      } else {
        errors.push('merge: need sourceIds(≥2) and newText, skipped');
      }
    } else if (action === 'delete') {
      if (typeof a.id === 'string' && a.id.length > 0) actions.push({ action: 'delete', targetId: a.id });
      else errors.push('delete: need id, skipped');
    } else if (action === 'keep') {
      if (typeof a.id === 'string' && a.id.length > 0) kept++;
      else errors.push('keep: need id, skipped');
    } else {
      errors.push(`unknown consolidation action: ${action || '(missing)'}, skipped`);
    }
  }
  return { actions, kept, errors };
}

export interface ConsolidateRunResult {
  ok: boolean;
  scanned: number;      // 扫描的 active 记忆条数
  candidates: number;   // 向量预筛出的候选对数(EMBED_MODE=none 全量扫兜底时为 0)
  merged: number;
  deleted: number;
  kept: number;
  actions: number;
  applied: number;
  errors: string[];
  skipped?: boolean;
  receipts?: ReflectReceipt[];
}

/**
 * v1.10: 记忆整合主流程 — 向量预筛 → LLM 整合 → applyReflectActions 原子执行。
 * - EMBED_MODE=none:预筛返回空 → LLM 全量扫兜底
 * - 有向量但无相似候选 → 直接返回空结果,不再调 LLM(省 token)
 */
export async function runConsolidate(
  charId: string = 'default',
  project?: string,
  threshold?: number,
  limit?: number,
): Promise<ConsolidateRunResult> {
  const base: ConsolidateRunResult = { ok: false, scanned: 0, candidates: 0, merged: 0, deleted: 0, kept: 0, actions: 0, applied: 0, errors: [] };
  if (!isReflectConfigured()) {
    return { ...base, skipped: true, errors: ['REFLECT_LLM_API_KEY 未配置,跳过整合'] };
  }
  const db = DatabaseManager.getInstance(project);
  const proj = normalizeProject(project);

  const mems = db.prepare(`
    SELECT id, mem_type, text, created_at FROM memory
    WHERE is_active = 1 AND project = ? AND (locked IS NULL OR locked = 0)
    ORDER BY importance DESC, created_at DESC
    LIMIT 500
  `).all(proj) as any[];
  const scanned = mems.length;
  if (scanned < 2) {
    return { ...base, ok: true, scanned, skipped: true, errors: ['active 记忆不足 2 条,无需整合'] };
  }

  // 1. 向量预筛(EMBED_MODE=none 返回空 → 全量扫兜底)
  let candidates: SimilarCandidate[] = [];
  if (isEmbedEnabled()) {
    candidates = await findSimilarCandidates(proj, threshold ?? CONSOLIDATE_SIMILARITY, limit ?? CONSOLIDATE_MAX_PAIRS);
    if (candidates.length === 0) {
      // 有向量但确实无相似对 → 不再调 LLM,省 token
      return { ...base, ok: true, scanned, skipped: true, errors: ['无相似候选,无需整合'] };
    }
  }

  // 2. 组装 LLM 输入:向量模式 → 候选涉及的记忆;全量模式 → 全部记忆
  const candidateIds = new Set<string>();
  for (const p of candidates) { candidateIds.add(p.idA); candidateIds.add(p.idB); }
  const inputMems = candidates.length > 0 ? mems.filter(m => candidateIds.has(m.id)) : mems;
  const today = new Date().toISOString().slice(0, 10);
  const itemsJson = JSON.stringify(inputMems.map(m => ({
    id: m.id,
    memType: m.mem_type || 'general',
    text: (m.text || '').slice(0, 600),
    createdAt: (m.created_at || '').slice(0, 10),
  })), null, 1);
  const pairsJson = JSON.stringify(candidates, null, 1);

  // 3. 最近对话转录(conversation_log,捕捉最新用户修正)
  let transcript = '';
  try {
    const convs = getRecentConversations(charId, 24 * 7, 20, proj);
    transcript = convs.map(c => (c as any).text).join('\n---\n').substring(0, 8000);
  } catch { transcript = ''; }

  const userPrompt = `今天是 ${today}(相对日期转绝对日期时以此为准)。
请整合以下候选记忆,输出整合 JSON 数组。

【候选记忆】
${itemsJson}

【候选相似对】
${pairsJson}

【近期对话转录】
${transcript || '无近期对话转录'}`;

  const llm = await callLlm(buildConsolidationPrompt(), userPrompt);
  if (!llm) return { ...base, scanned, candidates: candidates.length, errors: ['LLM 调用失败'] };
  const parsed = parseJsonRobust(llm.content || llm.reasoning);
  if (!parsed) return { ...base, scanned, candidates: candidates.length, errors: ['未找到有效 JSON 结果'] };

  // 4. 规范化 + 原子执行(keep 不落地;merge/delete 复用 applyReflectActions)
  const norm = normalizeConsolidationActions(parsed);
  let r: { applied: number; errors: string[]; receipts: ReflectReceipt[] } = { applied: 0, errors: [], receipts: [] };
  if (norm.actions.length > 0) {
    try {
      r = await applyReflectActions(norm.actions, charId, proj);
    } catch (e: any) {
      norm.errors.push(e.message);
    }
  }
  const merged = r.receipts.filter(x => x.action === 'merge' && x.status === 'applied').length;
  const deleted = r.receipts.filter(x => x.action === 'delete' && x.status === 'applied').length;

  return {
    ok: true,
    scanned,
    candidates: candidates.length,
    merged,
    deleted,
    kept: norm.kept,
    actions: norm.actions.length,
    applied: r.applied,
    errors: [...norm.errors, ...r.errors],
    receipts: r.receipts,
  };
}
