/**
 * MemType — 记忆用途维度(与 type 性质维度正交共存)
 *
 * v1.8: 融合 Claude Code 的 4 种封闭记忆类型 + Markdown 内容格式。
 * 值域:
 *   user      — 用户画像(偏好/技术栈/风格/人物关系洞察)
 *   feedback  — 行为纠正(正负双向都要记)
 *   project   — 项目上下文(截止时间/环境约定/非代码可推导信息)
 *   reference — 外部指针(URL/ID/文档链接,不存内容副本)
 *   general   — 默认,现有记忆不受影响
 */
/** 4 种封闭类型 + general 默认值 */
export const MEM_TYPES = ['user', 'feedback', 'project', 'reference', 'general'];
/** 仅 4 种封闭类型(写记忆时强制 Markdown 结构) */
export const CLOSED_MEM_TYPES = ['user', 'feedback', 'project', 'reference'];
/** Markdown 标题前缀(对应各类型) */
export const MEM_TYPE_LABELS = {
    user: 'User Profile',
    feedback: 'Feedback',
    project: 'Project Context',
    reference: 'Reference',
};
export function isMemType(v) {
    return typeof v === 'string' && MEM_TYPES.includes(v);
}
export function isClosedMemType(v) {
    return typeof v === 'string' && CLOSED_MEM_TYPES.includes(v);
}
export function normalizeMemType(v) {
    return isMemType(v) ? v : 'general';
}
/**
 * Markdown 规范化包装 — 仅对 4 种封闭类型生效(general 不强制转换)。
 * 规则:
 *   1. 已是 Markdown 结构(含 # 标题行)→ 原样返回,不重复包装
 *   2. 标题行:`# <Label>: <标题>`,标题取首行(剥掉列表符号),超 40 字截断
 *   3. 正文原样保留，包括代码缩进、空行、引用和表格
 *   保持原文本内容不变,只加结构。
 */
export function normalizeMarkdown(text, memType) {
    if (!isClosedMemType(memType))
        return text;
    const trimmed = (text ?? '').trim();
    if (!trimmed)
        return text;
    // 已有 Markdown 标题 → 视为已规范化
    if (/^#{1,6}\s/m.test(trimmed))
        return text;
    const lines = trimmed.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const label = MEM_TYPE_LABELS[memType];
    let title = lines[0].replace(/^[-*+]\s+/, '').replace(/^\d+[.、)]\s*/, '').trim();
    if (title.length > 40)
        title = title.slice(0, 40) + '…';
    const header = title ? `# ${label}: ${title}` : `# ${label}`;
    return `${header}\n\n${text}`;
}
/**
 * 索引摘要：给"先索引后详情"用的单行描述（≤maxLen）。
 *
 * 旧实现是 `t.slice(0,150)+'…'`，实测两个可量化的亏（761 条活库）：
 *   1. 98.7% 的截断切在句中（"…共 305 条断言通过、8/9 脚本 ex…"）；
 *   2. addTypeHeader 写入的 `# Project Context: <首 40 字>` 与正文首句**重复**，
 *      31.6% 的行实际是同一句话占了两份，平均白花 42 字。
 * 这两条都是确定的浪费，不需要 LLM 生成描述（B-1 原本设想）就能消掉。
 */
export function summarizeForIndex(text, maxLen = 150) {
    let t = (text ?? '').replace(/\r/g, '').trim();
    if (!t)
        return '';
    // 1) 去掉 markdown 标题符与角色样板前缀（段头已经标了 [memType]）
    t = t.replace(/^#{1,6}\s*/, '');
    t = t.replace(/^(Project Context|User Profile|Feedback|Reference|General|Memory)\s*[:：]\s*/i, '');
    // 2) 丢开"标题行 = 正文首句"的重复（addTypeHeader 的产物）
    const parts = t.split(/\n\s*\n/);
    if (parts.length >= 2) {
        const title = parts[0].trim();
        const rest = parts.slice(1).join('\n\n').trim();
        const probe = title.slice(0, Math.min(12, title.length));
        if (title.length >= 8 && probe && rest.startsWith(probe))
            t = rest;
    }
    // 3) 单行化
    t = t.replace(/\s*\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
    if (t.length <= maxLen)
        return t;
    // 4) 就近在分句处收尾，不切半句；只有当分句点落在窗口后 15% 内才采用，
    //    否则宁可硬切到 maxLen —— 阈值定 0.5 会让平均摘要从 115 字缩到 100 字，
    //    头损率从 1.3% 涨到 9.9%（实测）。
    const win = t.slice(0, maxLen);
    const marks = '。；！？，、：;';
    let cut = -1;
    for (let i = win.length - 1; i >= 0; i--) {
        if (marks.includes(win[i])) {
            cut = i;
            break;
        }
    }
    if (cut >= Math.floor(maxLen * 0.85))
        return win.slice(0, cut + 1) + '…';
    return win.replace(/\s+\S*$/, '') + '…';
}
