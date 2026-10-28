/**
 * 工具事件（A-1）：把"跑了什么命令、结果如何"变成可检索的记忆
 *
 * 背景：hermes_memory_hook 只投喂 user 消息 + 非工具调用的最终答复
 * （`a1.tool_calls IS NULL`），于是 1678 条 conversation_log 里没有一条命令、报错或
 * 文件改动 —— 对整天在跑命令的 agent 来说，等于把"怎么修好的"整段扔了。
 * 外部对照：claude-mem 的 PostToolUse 钩子就是干这件事；OTel GenAI 把工具调用
 * 定义成独立 span（gen_ai.operation.name=execute_tool，属性 gen_ai.tool.name /
 * gen_ai.tool.call.id / gen_ai.tool.call.arguments / gen_ai.tool.call.result）。
 * 这里只借它的**字段命名**，不接整套 OTel。
 *
 * 三条设计纪律：
 *   1. 只存可判定的事实（工具名、命令原样、退出码、错误首行、耗时），**不存完整输出**
 *   2. 不进反思输入（避免污染记忆抽取），只做检索与统计
 *   3. 事件落 general 库（events 与 memType 无关，不该跟着 user/project 分库走）
 */
import { DatabaseManager } from './db.js';
import { normalizeProject, CHAR_ID } from './env.js';
const MAX_ARGS = 600;
const MAX_ERR = 200;
/** 事件表 + FTS。skipped=true 表示该 SQLite 不带 FTS5（降级为 LIKE）。 */
export function ensureEventSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS tool_events (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      character_id TEXT,
      session_id TEXT,
      turn_id TEXT,
      tool_name TEXT NOT NULL,
      call_id TEXT,
      args_digest TEXT,
      exit_code INTEGER,
      status TEXT DEFAULT 'unknown',
      error_head TEXT,
      result_chars INTEGER,
      duration_ms INTEGER,
      at TEXT NOT NULL
    );
  `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_project_at ON tool_events(project, at)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_call ON tool_events(call_id) WHERE call_id IS NOT NULL`);
    let fts = false;
    try {
        // trigram：中文没有空格，unicode61 会把整句当一个 token；trigram 支持 ≥3 字的子串匹配
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS tool_events_fts USING fts5(
      event_id UNINDEXED, tool_name, args, error, tokenize='trigram'
    )`);
        fts = true;
    }
    catch {
        fts = false; // 无 FTS5 的构建：退化为 LIKE
    }
    return { fts };
}
const clip = (s, n) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
function genId() {
    return 'ev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}
export function ingestEvents(events, opts = {}) {
    const proj = normalizeProject(opts.project);
    const cid = opts.characterId || CHAR_ID;
    const db = DatabaseManager.getInstance(proj, 'general');
    const { fts } = ensureEventSchema(db);
    let inserted = 0, skipped = 0;
    const ins = db.prepare(`INSERT INTO tool_events
    (id, project, character_id, session_id, turn_id, tool_name, call_id, args_digest,
     exit_code, status, error_head, result_chars, duration_ms, at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insFts = fts ? db.prepare('INSERT INTO tool_events_fts (event_id, tool_name, args, error) VALUES (?,?,?,?)') : null;
    const tx = db.transaction((list) => {
        for (const e of list) {
            const toolName = clip(e.toolName, 60);
            if (!toolName) {
                skipped++;
                continue;
            }
            const callId = e.callId ? clip(e.callId, 120) : null;
            if (callId) {
                const dup = db.prepare('SELECT id FROM tool_events WHERE call_id = ?').get(callId);
                if (dup) {
                    skipped++;
                    continue;
                }
            }
            const id = genId();
            const args = clip(e.argsDigest, MAX_ARGS);
            const err = clip(e.errorHead, MAX_ERR);
            const status = e.status || (typeof e.exitCode === 'number' ? (e.exitCode === 0 ? 'ok' : 'error') : 'unknown');
            const at = e.at || new Date().toISOString();
            ins.run(id, proj, cid, e.sessionId || null, e.turnId || null, toolName, callId, args, typeof e.exitCode === 'number' ? e.exitCode : null, status, err || null, typeof e.resultChars === 'number' ? e.resultChars : null, typeof e.durationMs === 'number' ? e.durationMs : null, at);
            if (insFts)
                insFts.run(id, toolName, args, err);
            inserted++;
        }
    });
    try {
        tx(events);
    }
    catch (e) {
        return { inserted, skipped: skipped + (events.length - inserted), fts };
    }
    return { inserted, skipped, fts };
}
/** FTS 查询串：trigram 需要 ≥3 字符；短词退回 LIKE。引号会被转义成短语。 */
function ftsQuery(q) {
    const terms = String(q || '').split(/\s+/).map(t => t.trim()).filter(Boolean);
    if (terms.length === 0)
        return null;
    if (terms.some(t => t.length < 3))
        return null;
    return terms.map(t => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}
export function searchEvents(query, opts = {}) {
    const proj = normalizeProject(opts.project);
    const db = DatabaseManager.getInstance(proj, 'general');
    try {
        ensureEventSchema(db);
    }
    catch {
        return { rows: [], mode: 'recent' };
    }
    const limit = Math.min(50, Math.max(1, Math.floor(Number(opts.limit) || 10)));
    const where = ['e.project = ?'];
    const params = [proj];
    if (opts.tool) {
        where.push('e.tool_name = ?');
        params.push(opts.tool);
    }
    if (opts.sessionId) {
        where.push('e.session_id = ?');
        params.push(opts.sessionId);
    }
    if (opts.since) {
        where.push('e.at >= ?');
        params.push(opts.since);
    }
    const fq = ftsQuery(query);
    if (fq) {
        try {
            const rows = db.prepare(`
        SELECT e.* FROM tool_events_fts f JOIN tool_events e ON e.id = f.event_id
        WHERE tool_events_fts MATCH ? AND ${where.join(' AND ')}
        ORDER BY e.at DESC LIMIT ?`).all(fq, ...params, limit);
            if (rows.length > 0)
                return { rows: rows.map(mapRow), mode: 'fts' };
        }
        catch { /* 落到 LIKE */ }
    }
    // LIKE 兜底：短词（中文 2 字）与 FTS 空结果
    const like = clip(query, 80);
    if (like) {
        const likeWhere = [...where, '(e.args_digest LIKE ? OR e.error_head LIKE ? OR e.tool_name LIKE ?)'];
        const lp = [`%${like}%`, `%${like}%`, `%${like}%`];
        const rows = db.prepare(`SELECT e.* FROM tool_events e WHERE ${likeWhere.join(' AND ')} ORDER BY e.at DESC LIMIT ?`)
            .all(...params, ...lp, limit);
        if (rows.length > 0)
            return { rows: rows.map(mapRow), mode: 'like' };
    }
    if (!query) {
        const rows = db.prepare(`SELECT e.* FROM tool_events e WHERE ${where.join(' AND ')} ORDER BY e.at DESC LIMIT ?`)
            .all(...params, limit);
        return { rows: rows.map(mapRow), mode: 'recent' };
    }
    return { rows: [], mode: fq ? 'fts' : 'like' };
}
function mapRow(r) {
    return {
        id: r.id, project: r.project, sessionId: r.session_id, toolName: r.tool_name,
        callId: r.call_id, argsDigest: r.args_digest, exitCode: r.exit_code, status: r.status,
        errorHead: r.error_head, resultChars: r.result_chars, durationMs: r.duration_ms, at: r.at,
    };
}
/** 统计：最近 N 天按工具聚合（给 stats_get 用，回答"这个 agent 到底在干什么"） */
export function eventStats(project, days = 7) {
    const proj = normalizeProject(project);
    const db = DatabaseManager.getInstance(proj, 'general');
    try {
        ensureEventSchema(db);
    }
    catch {
        return { total: 0, byTool: [], errorRate: 0 };
    }
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const total = db.prepare('SELECT COUNT(*) c FROM tool_events WHERE project = ? AND at >= ?').get(proj, since).c;
    const byTool = db.prepare('SELECT tool_name tool, COUNT(*) n FROM tool_events WHERE project = ? AND at >= ? GROUP BY 1 ORDER BY 2 DESC LIMIT 12')
        .all(proj, since);
    const errs = db.prepare("SELECT COUNT(*) c FROM tool_events WHERE project = ? AND at >= ? AND status = 'error'").get(proj, since).c;
    return { total, byTool, errorRate: total > 0 ? Math.round((errs / total) * 1000) / 1000 : 0 };
}
