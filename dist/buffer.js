/**
 * SessionMemoryBuffer — 渐进式临时反思的缓冲触发器(吸收 Claude Code bufferController.ts +
 * src/memdir/trigger.ts MemoryExtractionTrigger 触发逻辑)
 *
 * v1.11 Part2:每轮对话 onNewMessage() → pendingCount++ / pendingTokens 估算,
 * 达到轮次阈值(BUFFER_SIZE,默认 5)或 Token 增量阈值(BUFFER_TOKENS,默认 4000)之一
 * 即后台异步触发 runIncrementalReflection(绝不 await,不阻塞主流程;错误静默 console.error)。
 * isExtracting 互斥锁:后台同一会话只允许一个提取任务,防并发重入。
 * forceFlush():会话结束/切换/周期兜底时强制补漏未达阈值的尾部消息。
 * 进程内单例 per (project, sessionId):getBuffer 工厂缓存。
 */
import { runIncrementalReflection } from './triage.js';
import { normalizeProject, CHAR_ID } from './env.js';
const DEFAULT_BUFFER_SIZE = (() => {
    const v = parseInt(process.env.BUFFER_SIZE || '5', 10);
    return Number.isFinite(v) && v > 0 ? v : 5; // 非法值兜底 5
})();
// 原厂 MemoryExtractionTrigger.MAX_TOKEN_THRESHOLD = 4000(新增对话累积 Token 增量阈值)
const DEFAULT_BUFFER_TOKENS = (() => {
    const v = parseInt(process.env.BUFFER_TOKENS || '4000', 10);
    return Number.isFinite(v) && v > 0 ? v : 4000;
})();
const buffers = new Map();
export class SessionMemoryBuffer {
    project;
    sessionId;
    characterId;
    threshold;
    tokenThreshold;
    pendingCount = 0;
    pendingTokens = 0;
    isExtracting = false;
    history = [];
    constructor(project, sessionId, characterId = CHAR_ID, threshold = DEFAULT_BUFFER_SIZE, tokenThreshold = DEFAULT_BUFFER_TOKENS) {
        this.project = project;
        this.sessionId = sessionId;
        this.characterId = characterId;
        this.threshold = threshold > 0 ? threshold : DEFAULT_BUFFER_SIZE;
        this.tokenThreshold = tokenThreshold > 0 ? tokenThreshold : DEFAULT_BUFFER_TOKENS;
    }
    onNewMessage(messages) {
        if (Array.isArray(messages))
            this.history.push(...messages);
        this.pendingCount++;
        // Token 增量估算(照搬原厂 字符数/4):累计本轮所有新消息(不止最后一条,否则超长 user 消息漏计)
        if (Array.isArray(messages)) {
            for (const m of messages) {
                if (m && typeof m.content === 'string') {
                    this.pendingTokens += Math.ceil(m.content.length / 4);
                }
            }
        }
        // 双阈值:满轮次 或 满 Token 增量,满足其一即触发
        const shouldTrigger = this.pendingCount >= this.threshold || this.pendingTokens >= this.tokenThreshold;
        if (shouldTrigger) {
            this.flush(messages);
        }
    }
    /**
     * 强制补漏:未达阈值的尾部消息也触发一次提取(会话结束 / 压缩上下文 / 周期兜底)
     */
    forceFlush(messages = []) {
        if (this.pendingCount > 0) {
            this.flush(messages);
        }
    }
    flush(messages) {
        if (this.isExtracting)
            return; // 互斥锁:后台已有提取任务,本次放弃(下轮再触发)
        this.pendingCount = 0;
        this.pendingTokens = 0;
        this.isExtracting = true;
        const recent = (this.history.length > 0 ? this.history : (messages || [])).slice(-10);
        this.history = [];
        // 后台异步执行,绝不 await 阻塞主流程;错误静默捕获
        Promise.resolve().then(async () => {
            try {
                await runIncrementalReflection(this.project, this.sessionId, recent, this.characterId);
            }
            catch (e) {
                console.error('[buffer] incremental reflection error:', e.message);
            }
            finally {
                this.isExtracting = false;
            }
        });
    }
}
/** 进程内单例工厂:key = `${project}|${sessionId}`,同会话复用同一 buffer */
export function getBuffer(project, sessionId, characterId) {
    const proj = normalizeProject(project);
    const key = `${proj}|${sessionId}`;
    let b = buffers.get(key);
    if (!b) {
        b = new SessionMemoryBuffer(proj, sessionId, characterId);
        buffers.set(key, b);
    }
    return b;
}
/** 周期兜底:强制 flush 所有活跃会话 buffer(补漏未达阈值的尾部消息)——digest/会话结束时调用 */
export function flushAllBuffers() {
    for (const b of buffers.values()) {
        try {
            b.forceFlush();
        }
        catch (e) {
            console.error('[buffer] flushAll error:', e.message);
        }
    }
}
