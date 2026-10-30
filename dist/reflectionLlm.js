export function makeLlmChannel(prefix) {
    const name = prefix.toLowerCase();
    prefix = prefix.toUpperCase();
    const get = (suffix, fallback) => {
        const v = process.env[`${prefix}_${suffix}`];
        return v && v.trim().length > 0 ? v.trim() : fallback;
    };
    return {
        name,
        url: get('LLM_URL', process.env.REFLECT_LLM_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
        apiKey: get('LLM_API_KEY', process.env.REFLECT_LLM_API_KEY || ''),
        model: get('LLM_MODEL', process.env.REFLECT_LLM_MODEL || 'deepseek-chat'),
    };
}
/**
 * 按当前解析状态补全未闭合的括号与字符串(用于截断救济)
 * 只做词法扫描,不解析语义:字符串内的括号不计数,被截断的字符串补引号,左括号逐个补右括号。
 */
function closeBrackets(x) {
    let inStr = false, esc = false;
    const stack = [];
    for (const ch of x) {
        if (esc) {
            esc = false;
            continue;
        }
        if (ch === '\\') {
            esc = true;
            continue;
        }
        if (ch === '"') {
            inStr = !inStr;
            continue;
        }
        if (inStr)
            continue;
        if (ch === '{' || ch === '[')
            stack.push(ch);
        else if (ch === '}' || ch === ']')
            stack.pop();
    }
    let out = x;
    if (inStr)
        out += '"';
    while (stack.length)
        out += (stack.pop() === '[' ? ']' : '}');
    return out;
}
/** 常见坏 JSON 修补:尾随逗号 / 裸控制字符 / 非法反斜杠转义(LLM 写 Windows 路径 `C:\path\x` 时必犯) */
function repairJson(x) {
    return x
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/[\x00-\x1f]+/g, ' ')
        .replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
}
/** 判断末尾是否停在未闭合的字符串字面量里(截断的典型特征) */
function endsInsideString(x) {
    let inStr = false, esc = false;
    for (const ch of x) {
        if (esc) {
            esc = false;
            continue;
        }
        if (ch === '\\') {
            esc = true;
            continue;
        }
        if (ch === '"') {
            inStr = !inStr;
        }
    }
    return inStr;
}
/**
 * 截断救济:LLM 输出被 max_tokens 截断时(常见:action 条数多),
 * 从尾部逐级回退到最后一个完整元素的收尾符,丢弃残缺元素后补全括号再解析。
 * 宁可少应用几条 action,也不要整轮丢弃。
 */
function salvageTruncatedJson(body) {
    const accept = (x) => {
        try {
            const r = JSON.parse(repairJson(x));
            if (Array.isArray(r))
                return { actions: r };
            if (r && typeof r === 'object')
                return r;
        }
        catch { /* keep trimming */ }
        return null;
    };
    let cut = body.length;
    // 末尾停在未闭合字符串 → 最后一条元素残缺:回退到"上一个完整元素的收尾符"再补括号,
    // 不能退到元素内部的逗号(那会把残缺元素补成半个对象,如 {action:"merge"})
    if (endsInsideString(body)) {
        const next = Math.max(body.lastIndexOf('}', cut - 1), body.lastIndexOf(']', cut - 1));
        if (next > 1)
            cut = next;
    }
    for (let i = 0; i < 80 && cut > 1; i++) {
        const cand = body.slice(0, cut).replace(/[,\s]+$/, '');
        const r = accept(closeBrackets(cand));
        if (r)
            return r;
        const next = Math.max(body.lastIndexOf(',', cut - 1), body.lastIndexOf('}', cut - 1), body.lastIndexOf(']', cut - 1));
        if (next <= 1)
            break;
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
export function parseJsonRobust(raw, allowSalvage = true) {
    let s = (raw || '').trim();
    // 剥离 markdown 代码围栏
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence)
        s = fence[1].trim();
    // 提取最外层 {...} 或 [...] 块;有前导文字时从首个括号取到结尾(不要贪心到最后一个 '}',
    // 否则截断输出的尾部会被切掉,救济就无从下手)
    const body = (() => {
        if (s.startsWith('{') || s.startsWith('['))
            return s;
        const i = Math.min(...[{ '{': s.indexOf('{') }, { '[': s.indexOf('[') }]
            .map(o => Object.values(o)[0]).filter(v => v >= 0).concat([Number.MAX_SAFE_INTEGER]));
        return Number.isFinite(i) && i < Number.MAX_SAFE_INTEGER ? s.slice(i) : null;
    })();
    if (!body)
        return null;
    const strategies = [
        (x) => JSON.parse(x),
        (x) => JSON.parse(x.replace(/,\s*([}\]])/g, '$1')),
        (x) => JSON.parse(x.replace(/"\s*\n\s*"/g, '",\n"')),
        (x) => JSON.parse(x.replace(/,\s*([}\]])/g, '$1').replace(/"\s*\n\s*"/g, '",\n"')),
        (x) => JSON.parse(x.replace(/,\s*([}\]])/g, '$1').replace(/"\s*\n\s*"/g, '",\n"').replace(/[\x00-\x1f]+/g, ' ')),
    ];
    for (const fn of strategies) {
        try {
            const r = fn(body);
            if (Array.isArray(r))
                return { actions: r };
            if (r && typeof r === 'object')
                return r;
        }
        catch { /* try next */ }
    }
    // 收尾:截断救济(内部第一步即"补全原 body",失败再逐级回退元素边界)
    return allowSalvage ? salvageTruncatedJson(body) : null;
}
const _usage = { calls: 0, prompt: 0, completion: 0, reasoning: 0, cached: 0, ms: 0 };
/** 读当前累计(返回副本,不影响累计值) */
export function llmUsageSnapshot() { return { ..._usage }; }
/** 两次快照相减,得到一段工作的真实用量 */
export function llmUsageDelta(before, after = llmUsageSnapshot()) {
    return {
        calls: after.calls - before.calls,
        prompt: after.prompt - before.prompt,
        completion: after.completion - before.completion,
        reasoning: after.reasoning - before.reasoning,
        cached: after.cached - before.cached,
        ms: after.ms - before.ms,
    };
}
/**
 * DeepSeek 官方价目(元/百万 token,2026-09-10 调价后)。
 * 闲时 = 高峰×0.5;高峰 = 工作日(不含法定节假日) 9:00-12:00、14:00-18:00(北京时间)。
 * 认不出的模型 → 按 flash 计(偏保守),并在返回里标记 estimated=true。
 */
const PRICES = {
    'deepseek-flash': { hit: 0.02, miss: 1.0, out: 4.0 },
    'deepseek-v4-flash': { hit: 0.02, miss: 1.0, out: 4.0 },
    'deepseek-v4-pro': { hit: 0.15, miss: 4.5, out: 13.5 },
    'deepseek-v4-1-flash': { hit: 0.02, miss: 1.0, out: 4.0 },
};
/** 北京时间是否落在 DeepSeek 高峰时段(法定节假日不在此判定内 —— 只会把节假日当高峰,偏保守) */
export function isPeakHour(at = new Date()) {
    // 固定 UTC+8,不受宿主时区影响
    const bj = new Date(at.getTime() + 8 * 3600_000);
    const day = bj.getUTCDay(); // 0=周日 6=周六
    if (day === 0 || day === 6)
        return false;
    const h = bj.getUTCHours();
    return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}
/** 估算一段用量的成本(元);peak 参数让调用方复算峰谷 */
export function estimateCostCny(u, model, at = new Date()) {
    const p = PRICES[String(model || '').trim().toLowerCase()];
    const price = p || PRICES['deepseek-flash'];
    const peak = isPeakHour(at);
    const k = peak ? 2 : 1;
    const hit = Math.min(u.cached, u.prompt);
    const miss = Math.max(0, u.prompt - hit);
    const cny = (hit * price.hit + miss * price.miss + u.completion * price.out) * k / 1e6;
    return { cny: Math.round(cny * 1e4) / 1e4, peak, estimated: !p };
}
/**
 * v1.11.3 重路径(总反思/深度反思/整合)的输出预算 —— 与浅层(triage 临时反思 / reflect_auto)分开。
 * 为什么需要:推理模型(如 deepseek-v4-pro)的**思考 token 也计入 max_tokens**,8192 会被"想"吃光,
 * 返回 finish_reason=length 且 content 为空 → 整合报 `未找到有效 JSON 结果`(实测 reasoning 18600 字符)。
 * 浅层仍走 callLlm 的 8192 默认值,不受此影响。config.json 的 `reflect.maxTokens` 可覆盖。
 */
export const REFLECT_DEEP_MAX_TOKENS = (() => {
    const v = parseInt(process.env.REFLECT_DEEP_MAX_TOKENS || '32768', 10);
    return Number.isFinite(v) && v >= 1024 ? v : 32768;
})();
/**
 * 调用 LLM(OpenAI 兼容,非流式)。
 * 通道:缺省用 reflect(REFLECT_*);传 channel 则用指定通道(triage/reflect)。
 */
export async function callLlm(systemPrompt, userPrompt, channel, maxTokens = 8192) {
    const ch = channel ?? makeLlmChannel('reflect');
    if (!ch.apiKey)
        return null;
    // 到 API 的连接偶发被断(大 prompt/限流),单次失败就放弃会让整轮反思白跑 → 退避重试
    const attempts = Math.max(1, Number(process.env.REFLECT_LLM_RETRIES || 3));
    for (let i = 1; i <= attempts; i++) {
        const startedAt = Date.now();
        const timeoutMs = Math.max(10_000, Number(process.env.REFLECT_LLM_TIMEOUT_MS || 180_000) || 180_000);
        try {
            // v1.23.2-fix: 无超时的 fetch 遇到半开连接会永远挂起（退避/游标都走不到），
            // 超时按可重试错误走 attempts。
            const resp = await fetch(`${ch.url}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ch.apiKey}` },
                body: JSON.stringify({
                    model: ch.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    max_tokens: maxTokens,
                    stream: false,
                }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!resp.ok)
                throw new Error(`LLM ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
            const data = await resp.json();
            const msg = data?.choices?.[0]?.message || {};
            const finishReason = data?.choices?.[0]?.finish_reason;
            // 每一次调用都必须能看到账：此前 usage 被直接丢弃，导致"pro 开销大"无从归因。
            const usage = data?.usage || {};
            const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
            const cached = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0;
            console.error(`[llm] ts=${new Date().toISOString()} channel=${ch.name || 'reflect'} model=${ch.model}` +
                ` prompt=${usage.prompt_tokens ?? '?'} completion=${usage.completion_tokens ?? '?'}` +
                ` reasoning=${reasoning} cached=${cached}` +
                ` finish=${finishReason || 'n/a'} ms=${Date.now() - startedAt}`);
            // 用量落账(账单归因):cost 由 estimateCostCny 在调用方按峰谷复算
            _usage.calls += 1;
            _usage.prompt += Number(usage.prompt_tokens || 0);
            _usage.completion += Number(usage.completion_tokens || 0);
            _usage.reasoning += Number(reasoning || 0);
            _usage.cached += Number(cached || 0);
            _usage.ms += Date.now() - startedAt;
            if (finishReason === 'length') {
                console.error(`[llm] 警告：输出撞到 max_tokens=${maxTokens} 被截断，prompt+completion 仍全额计费`);
            }
            return { content: msg.content || '', reasoning: msg.reasoning_content || '', finishReason };
        }
        catch (e) {
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
