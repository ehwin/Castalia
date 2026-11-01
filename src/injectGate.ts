/**
 * InjectGate —— 对级注入裁决（v1.28，默认关闭）
 *
 * 为什么不是又一个阈值：检索层能排序，但分数族本身不承载"这条该不该进上下文"。
 * 论文在 1,082 对上测过：同一批候选，
 *   部署门（相似度+分类型门槛）→ 精确率 22.8% / 召回 88.4% / F1 36.3
 *   对级裁决（明确问句 + 标注 codebook）→ 精确率 81.9~93.2% / F1 85.5~85.6
 * 并且消融显示收益来自"把决策变成一个明确的问题"，**不是**来自保守先验：
 * 删掉"宁可 SKIP"那句反而更高（88.5 vs 85.5）。所以下面的 prompt 故意不写保守条款。
 *
 * 设计约束：
 *   - 默认 off：不做任何 LLM 调用，行为与不加这个模块一致。
 *   - shadow：照常调用并记录决策，**不改变**返回给调用方的候选（用来在真实流量上量收益）。
 *   - on：只保留 A（需要）的候选。
 *   - 一次调用判一批候选（按查询），不是每个候选一次；论文的对照是逐对调用，
 *     差异必须在报告里写明，不能直接拿它的 85.5 当本模块的成绩。
 */
import { makeLlmChannel, type LlmChannel } from './reflectionLlm.js';

export type InjectGateMode = 'off' | 'shadow' | 'on';
export type GateLabel = 'A' | 'B' | 'C' | 'D';

export interface GateCandidate {
  id: string;
  text: string;
  similarity?: number;
}

export interface GateVerdict {
  id: string;
  decision: 'INJECT' | 'SKIP';
  label: GateLabel;
  confidence: number;
  why: string;
}

export interface GateInput {
  query: string;
  /** 最近几轮对话（越靠后越近）。缺省时只按查询判，已知会偏保守。 */
  context?: { role: string; text: string }[];
  candidates: GateCandidate[];
  project?: string;
  mode?: InjectGateMode;
  /** 覆盖通道（测试用） */
  channel?: LlmChannel;
}

export interface GateResult {
  mode: InjectGateMode;
  verdicts: GateVerdict[];
  /** mode=on 时保留的候选；shadow/off 时等于输入 */
  kept: GateCandidate[];
  dropped: string[];
  errors: string[];
}

/**
 * 判定 codebook —— 刻意与论文 §4 的标注口径同构（A/B/C/D），
 * 但不复用它的措辞细节，避免"用标注 prompt 判标注"的循环。
 */
const GATE_SYSTEM = `你是记忆注入判定器。给你一段最近的对话、用户这一轮的发言、以及若干条候选记忆，
逐条回答一个问题：**这条记忆现在要不要出现在助手的上下文里？**

判定类别（只看此刻，不看这条记忆本身的价值）：
- A 需要 —— 用户这句话指向的事，这条记忆能直接用到：回答它、补全它、纠正它。
- B 相关但不是现在 —— 同一话题或同一实体，但这一轮用不上。
- C 不对 —— 与这句话无关；人或事对不上；或只是字面重合。
- D 无法判断 —— 信息不足。

硬规则：
1. "以后可能有用""这条很重要""记住它有价值"都不是 A。
2. 判定对象是「这条记忆对**这句话**的用处」，不是它对用户的整体价值。
3. 字面重合不算证据：两边出现同样的一两个字、同一个动词，不构成 A。
4. 主语要能对上：记忆里说的是别人/别的项目，就不算 A。
5. 只输出 JSON，不要解释性文字、不要代码围栏。

输出格式：
{"verdicts":[{"id":"候选ID","label":"A|B|C|D","confidence":0.0-1.0,"why":"不超过20字"}]}`;

function renderContext(context: GateInput['context']): string {
  if (!context || context.length === 0) return '（无）';
  return context.slice(-6).map(m => `${m.role === 'assistant' ? '助手' : '对方'}: ${String(m.text).slice(0, 400)}`).join('\n');
}

function buildUser(input: GateInput): string {
  const cands = input.candidates
    .map((c, i) => `[${i + 1}] id=${c.id}\n${String(c.text).slice(0, 800)}`)
    .join('\n\n');
  return `【最近对话】\n${renderContext(input.context)}\n\n【用户这一轮】\n${input.query}\n\n【候选记忆】\n${cands}`;
}

/** 从模型输出里抠出 JSON（容忍围栏、前后废话、被截断的尾巴） */
function parseVerdicts(raw: string): { id: string; label: GateLabel; confidence: number; why: string }[] {
  let s = String(raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let obj: any;
  try { obj = JSON.parse(s.slice(start, end + 1)); } catch { return []; }
  const list = Array.isArray(obj?.verdicts) ? obj.verdicts : Array.isArray(obj) ? obj : [];
  const out: { id: string; label: GateLabel; confidence: number; why: string }[] = [];
  for (const v of list) {
    const id = String(v?.id ?? '').trim();
    const label = String(v?.label ?? '').trim().toUpperCase();
    if (!id || !['A', 'B', 'C', 'D'].includes(label)) continue;
    const conf = Number(v?.confidence);
    out.push({
      id,
      label: label as GateLabel,
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
      why: String(v?.why ?? '').slice(0, 40),
    });
  }
  return out;
}

export function gateModeFromEnv(raw?: string): InjectGateMode {
  const m = String(raw ?? process.env.INJECT_GATE ?? 'off').trim().toLowerCase();
  return m === 'on' || m === 'shadow' ? m : 'off';
}

/**
 * 对一批候选做注入裁决。
 * 未配置 LLM 通道时返回 off 语义（全部保留）+ 一条 error —— 绝不因为判不了就丢记忆。
 */
export async function adjudicateInjection(input: GateInput): Promise<GateResult> {
  const mode = input.mode ?? gateModeFromEnv();
  const all = input.candidates;
  if (mode === 'off') return { mode, verdicts: [], kept: all, dropped: [], errors: [] };
  if (all.length === 0) return { mode, verdicts: [], kept: [], dropped: [], errors: [] };

  const channel = input.channel ?? makeLlmChannel('reflect');
  if (!channel.apiKey) {
    return { mode, verdicts: [], kept: all, dropped: [], errors: ['未配置 LLM 通道（REFLECT_LLM_API_KEY），本次按 off 处理'] };
  }

  const errors: string[] = [];
  let parsed: ReturnType<typeof parseVerdicts> = [];

  const resp = await callGateLlm(GATE_SYSTEM, buildUser(input), channel).catch((e: any) => {
    errors.push(`gate llm: ${String(e?.message ?? e).slice(0, 160)}`);
    return null;
  });
  if (resp) parsed = parseVerdicts(resp);

  // 模型漏判的候选按"保留"处理（fail-open）：判不了不等于该丢。
  const byId = new Map(parsed.map(v => [v.id, v]));
  const verdicts: GateVerdict[] = all.map(c => {
    const v = byId.get(c.id);
    if (!v) {
      errors.push(`未给出判定: ${c.id}`);
      return { id: c.id, decision: 'INJECT', label: 'D', confidence: 0, why: '模型未判定（保留）' };
    }
    return { id: c.id, decision: v.label === 'A' ? 'INJECT' : 'SKIP', label: v.label, confidence: v.confidence, why: v.why };
  });

  if (mode === 'shadow') return { mode, verdicts, kept: all, dropped: [], errors };
  const kept = all.filter(c => verdicts.find(v => v.id === c.id)?.decision === 'INJECT');
  const dropped = all.filter(c => !kept.includes(c)).map(c => c.id);
  return { mode, verdicts, kept, dropped, errors };
}

/**
 * 只给裁决用的调用：temperature 0 + json_object。
 * 不复用 reflectionLlm.callLlm 是因为它不设 temperature（默认 1.0），
 * 判定任务上那点随机性会直接变成翻脸不认账的抖动。
 */
async function callGateLlm(system: string, user: string, ch: LlmChannel): Promise<string> {
  const timeoutMs = Math.max(10_000, Number(process.env.INJECT_GATE_TIMEOUT_MS || 90_000));
  const resp = await fetch(`${ch.url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ch.apiKey}` },
    body: JSON.stringify({
      model: ch.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: Number(process.env.INJECT_GATE_MAX_TOKENS || 2048),
      temperature: 0,
      response_format: { type: 'json_object' },
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`LLM ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const j: any = await resp.json();
  return String(j?.choices?.[0]?.message?.content ?? '');
}
