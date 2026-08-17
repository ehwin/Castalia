/**
 * 记忆体框架环境变量配置 — 可配项集中管理
 *
 * 所有通过环境变量可覆盖的配置在这里定义,
 * 避免散落在各模块里硬编码。
 */
/** 角色/实例 ID:用于数据分区。默认 'default'(通用场景) */
export const CHAR_ID = process.env.CHAR_ID || 'default';
/** 当前项目 ID(对齐 Hermes Project 概念):记忆按项目隔离。默认 'default' 保持向后兼容 */
export const PROJECT_ID = process.env.CASTALIA_PROJECT || 'default';
/**
 * 共享层项目名(约定,2026-08-16):存进该库的记忆为"所有库共知"候选。
 * 引擎不做隐式合并 —— 互通语义由上层/调用方显式决定(接口先行,规则待定)。
 */
export const SHARED_PROJECT = process.env.SHARED_PROJECT || 'shared';
/**
 * 规范化项目名:trim 前后空白;空字符串/纯空白回退到默认项目。
 * 防止 '' / ' ' / ' alpha ' 这类脏值产生孤立项目命名空间。
 */
export function normalizeProject(p) {
    const t = (p ?? '').trim();
    return t.length > 0 ? t : PROJECT_ID;
}
/**
 * 嵌入模式三档可选:
 *   none   → 纯本地:标签/正则 + 文本回退检索,零外部服务(不调 Ollama/API)
 *   ollama → 本地嵌入服务(OLLAMA_URL,默认,零 API 成本)
 *   api    → OpenAI 兼容 API(需 EMBEDDING_API_KEY)
 * 嵌入服务不可用时向量检索自动回退文本,记忆照常存取。
 */
export const EMBED_MODE = (process.env.EMBED_MODE || 'ollama').toLowerCase();
export function isEmbedEnabled() {
    return EMBED_MODE !== 'none';
}
/** MCP server 自描述名称 */
export const SERVER_NAME = process.env.MCP_SERVER_NAME || 'castalia';
/** 服务器版本号 */
export const SERVER_VERSION = process.env.MCP_SERVER_VERSION || '1.0.0';
