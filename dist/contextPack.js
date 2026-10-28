/**
 * 上下文装箱（context packing）— memory_context 的纯函数内核
 *
 * 为什么单独抽出来：
 *   旧实现把所有段拼成一个大字符串，超限时 `slice(0, 24000)` —— 段序决定"先死的是谁"，
 *   结果是经验沉淀/已知事实/索引先被砍，且砍在句子中间。
 *   外部实测（Per-Object Context Allocation, arXiv 2607.26937）：
 *   证据进入 top-5 的比例 64.16%，但活过 token 预算的只有 39.59% —— 检索成功后还掉 24.57 点；
 *   病因是同一个对象被多段渲染、各占一个位置（authority multiplication）。
 *
 * 这里做三件确定性的事：
 *   1. packet 去重：同一来源（parentId ?? id）只完整渲染一次，后续段只留一行引用
 *   2. 每段配额：超出段配额只在**条边界**裁，绝不切半个句子
 *   3. 全局预算：按段优先级从低到高整条丢弃，且每段至少留 1 条（不让任何一段凭空消失）
 *
 * 纯函数：不读库、不调 LLM、不看时间 —— 同样的输入永远同样的输出，便于测试与回归。
 */
const len = (s) => s.length;
const itemChars = (it) => it.lines.reduce((n, l) => n + l.length + 1, 0);
/**
 * 段预算权重（总和 1.0）—— 配额从总预算派生，而不是写死。
 * 写死配额（旧版 3000/4000/2500…）的问题是：合计可能远小于总预算，于是
 * "每段各自砍尾巴、剩下的预算白白空着"。权重制保证各段配额之和 = 总预算。
 *
 * 排序依据：行为约束（偏好/会话）> 任务相关 > 近期 > 经验 > 事实 > 原文回捞 > 索引。
 * 索引和回捞放最后，因为两者都能用 memory_search/memory_get 再取回来。
 */
export const DEFAULT_WEIGHTS = {
    prefs: 0.08,
    session: 0.08,
    related: 0.22,
    recent: 0.18,
    cognitives: 0.16,
    facts: 0.06,
    hydrated: 0.14,
    index: 0.08,
};
export function deriveCaps(totalBudget, weights = DEFAULT_WEIGHTS) {
    const out = {};
    for (const [k, w] of Object.entries(weights))
        out[k] = Math.floor(Math.max(200, totalBudget * w));
    return out;
}
/** 同一 packet 的后续视图压缩成一行引用，避免一个对象占多个位置 */
function referenceLine(title, packetKey) {
    const short = packetKey.length > 12 ? packetKey.slice(0, 12) + '…' : packetKey;
    return `  ↪ 同上（${title} 已列，id ${short}）`;
}
export function packContext(sections, opts) {
    const totalBudget = Math.max(1000, Math.floor(opts.totalBudget));
    const minItems = Math.max(0, opts.minItemsPerSection ?? 1);
    // ① 复制，避免修改调用方数据；记下原始条数用于统计
    const work = sections.map(s => ({
        ...s,
        original: s.items.length,
        items: s.items.map(it => ({ packetKey: it.packetKey ?? null, lines: [...it.lines] })),
        reserve: [],
        kept: s.items.length,
        dereferenced: 0,
    }));
    // ② packet 去重：按优先级顺序，先到先得
    const byPriority = [...work].sort((a, b) => a.priority - b.priority);
    const seen = new Map(); // packetKey -> 首次出现的 section title
    for (const s of byPriority) {
        for (const it of s.items) {
            if (!it.packetKey)
                continue;
            const owner = seen.get(it.packetKey);
            if (owner === undefined) {
                seen.set(it.packetKey, s.title);
                continue;
            }
            if (owner === s.title)
                continue; // 同一段内不互相降级
            it.lines = [referenceLine(owner, it.packetKey)];
            s.dereferenced++;
        }
    }
    // ③ 全局预算：先按优先级整条丢（低优先段先死），再做段配额兜底。
    //    顺序很关键：反过来会变成"每段各自砍尾巴"——索引 10 条全留、相关 6 条砍半，
    //    等于又回到"谁排在后面谁先死"，只是换了个形式。
    const totalOf = () => work.reduce((n, s) => n + s.items.reduce((m, it) => m + itemChars(it), 0), 0);
    let evicted = 0;
    let guard = 5000; // 防御：极端输入下也不会死循环
    while (totalOf() > totalBudget && guard-- > 0) {
        const candidates = work
            .filter(s => s.priority > 0 && s.items.length > minItems)
            .sort((a, b) => (b.priority - a.priority) || (b.items.length - a.items.length));
        if (candidates.length === 0)
            break;
        candidates[0].items.pop();
        evicted++;
    }
    // ④ 段内配额：安全阀，从尾部整条裁（priority 0 的段不裁）；被裁的进 reserve 以便回填
    for (const s of work) {
        if (s.priority === 0)
            continue;
        let chars = s.items.reduce((n, it) => n + itemChars(it), 0);
        while (chars > s.cap && s.items.length > minItems) {
            const dropped = s.items.pop();
            chars -= itemChars(dropped);
            s.reserve.push(dropped);
        }
    }
    // ④.5 回填：把别处用不完的预算借给还有 reserve 的段。
    //   按优先级从高到低借，单段最多借到 2×cap（防止一段吃掉全部余量）。
    //   不做这一步的话，配额制会留下"每段最多浪费一个条目的长度"的空转，
    //   实测 12k 预算只用了 8.3k —— 等于白扔 30% 的上下文额度。
    let guard2 = 5000;
    for (;;) {
        if (guard2-- <= 0)
            break;
        const total = totalOf();
        if (total >= totalBudget)
            break;
        let restored = false;
        for (const s of [...work].sort((a, b) => a.priority - b.priority)) {
            if (s.reserve.length === 0)
                continue;
            const next = s.reserve[s.reserve.length - 1];
            const chars = s.items.reduce((n, it) => n + itemChars(it), 0);
            if (chars + itemChars(next) > s.cap * 2)
                continue;
            if (total + itemChars(next) > totalBudget)
                continue;
            s.items.push(s.reserve.pop());
            restored = true;
            break;
        }
        if (!restored)
            break;
    }
    // ⑤ 渲染
    const out = [];
    const stats = [];
    for (const s of work) {
        const body = s.items.flatMap(it => it.lines);
        const chars = body.reduce((n, l) => n + len(l) + 1, 0);
        stats.push({ key: s.key, chars, cap: s.cap, kept: s.items.length, dropped: s.original - s.items.length, dereferenced: s.dereferenced });
        // 段头预算显示：回填可能让某段临时超过 cap（上限 2×cap），显示真实生效的额度，
        // 免得出现 characters="2070/1920" 这种看起来像越界的读数。
        const shownCap = chars > s.cap ? s.cap * 2 : s.cap;
        if (s.items.length === 0) {
            out.push(`\n■ ${s.title} characters="0/${s.cap}"${s.emptyNote ? `（${s.emptyNote}）` : ''}`);
            continue;
        }
        out.push(`\n■ ${s.title} characters="${chars}/${shownCap}"`);
        out.push(...body);
    }
    const text = out.join('\n');
    if (evicted > 0 && opts.footer !== false) {
        out.push(`\n…（预算不足，已整条裁掉 ${evicted} 条；用 memory_search / memory_get 精确取）`);
    }
    const finalText = out.join('\n');
    return { text: finalText, sections: stats, totalChars: finalText.length, evicted };
}
