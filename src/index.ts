#!/usr/bin/env node
/**
 * AI Memory MCP Server — standalone memory framework for agent harnesses
 *
 * 全部功能通过标准 MCP 协议暴露。
 * 工具分两类：搜索/存储类工具（LLM 可见），
 * 对话自动化/反思类工具（由 harness 或代理内部调用）。
 */
// ⚠️ 必须第一个 import:加载 config.json 覆盖环境变量(嵌入/反思配置)
import './configLoader.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchMemory, searchFacts, getRecentMemories } from './search.js';
import { saveMemory, forgetMemory, updateMemory, saveConversationTurn, cleanupExpiredMemories, batchEmbedPending } from './store.js';
import { consolidate } from './consolidate.js';
import { DatabaseManager, listProjectNames, listMemTypeDirs, safeFilePart, currentMemDir, sweepExpiredSessionMemories } from './db.js';
import { getCategoryTree } from './category.js';
import { runDigest, getRecentConversations, maybeDigest } from './digest.js';
import { flushAllBuffers } from './buffer.js';
import { reflect, getAllMemories, getMemoryGraph, REFLECT_SYSTEM_PROMPT, getUnanalyzedConversations, applyReflectResult } from './reflect.js';
import { autoProcess } from './autoProcessor.js';
import { runAutoReflect, runDeepReflect, shouldAutoReflect, runConsolidate, shouldAutoConsolidate } from './reflectDriver.js';
import { ensureSeedInstructions, saveInstruction, getInstruction, listInstructions, deleteInstruction } from './instructions.js';
import { CHAR_ID, PROJECT_ID, SERVER_NAME, SERVER_VERSION, normalizeProject } from './env.js';
import { MEM_TYPES, MEM_TYPE_LABELS, summarizeForIndex } from './memType.js';

console.log = console.error;

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

function ok(data: any) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...data }, null, 2) }] };
}
function err(msg: string, code = 'ERROR') {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code, message: msg } }, null, 2) }], isError: true as const };
}
// ── 可选 HTTP 健康检查(默认关闭;设 HEALTH_PORT 才监听,供容器/编排/验证探活)──
const _healthPort = parseInt(process.env.HEALTH_PORT || '0', 10);
if (_healthPort > 0) {
  import('node:http').then((http) => {
    const _h = http.createServer((_req: any, res: any) => {
      if (_req.url !== '/health' && _req.url !== '/') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, service: SERVER_NAME, version: SERVER_VERSION }));
    });
    _h.listen(_healthPort, '127.0.0.1');
    console.error(`[health] listening on http://127.0.0.1:${_healthPort}/`);
  }).catch((e: any) => console.error('[health] init failed:', e.message));
}


// ═══════════════════════════════════════════════════════════════════
// Memory Snapshot Warning(借鉴 Claude Code retriever.ts formatRetrievedMemoryForPrompt)
// 记忆年龄 ≥ 1 天视为历史快照,注入时追加警告;否则返回 null
// ═══════════════════════════════════════════════════════════════════
function memorySnapshotWarn(createdAt: string): string | null {
  if (!createdAt) return null;
  const d = new Date(createdAt);
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diffDays < 1) return null;
  let dateText: string;
  try { dateText = d.toISOString().slice(0, 10); } catch { return null; }
  return `> ⚠️ [Memory Snapshot Warning] 该记忆记录于 ${dateText}(约 ${diffDays} 天前),属于历史快照,引用前请以最新对话/代码为准`;
}

// ═══════════════════════════════════════════════════════════════════
// 工具分级(借鉴 engram ProfileAgent/ProfileAdmin)
// 暴露面原则:主 Agent 只读(search/get/recent/fact/graph),
// 写入与管线工具归 harness,管理工具归 admin(console)。
// 环境变量 MCP_TOOLS: 逗号分隔的 profile 或工具名;默认 'agent'(agent 友好)。
//   MCP_TOOLS=all  → 全部注册(向后兼容)
//   MCP_TOOLS=agent,admin → agent + admin 两组
// ═══════════════════════════════════════════════════════════════════

const TOOL_GROUPS: Record<string, string[]> = {
  agent: ['memory_search', 'memory_get', 'memory_recent', 'memory_index', 'fact_search', 'memory_graph'],
  harness: ['auto_process', 'conversation_save', 'digest_run', 'reflect_auto', 'reflect_deep', 'reflect_batch_embed', 'memory_save', 'memory_update', 'memory_delete', 'memory_log', 'instruction_save'],
  admin: ['memory_list', 'stats_get', 'recent_conversations', 'daily_summary_data', 'reflect_analyze', 'reflect_apply', 'memory_context', 'context_get', 'project_list', 'project_create', 'instruction_list', 'instruction_delete', 'consolidate_deep'],
};

function resolveTools(input: string | undefined): Set<string> | null {
  if (!input || input === 'all') return null; // null = 注册全部
  const result = new Set<string>();
  for (const token of input.split(',').map(t => t.trim())) {
    if (token === 'all') return null;
    if (TOOL_GROUPS[token]) TOOL_GROUPS[token].forEach(t => result.add(t));
    else result.add(token);
  }
  return result;
}

const TOOL_ALLOWLIST = resolveTools(process.env.MCP_TOOLS);
const TOOL_GROUP_OF: Record<string, string> = {};
for (const [g, tools] of Object.entries(TOOL_GROUPS)) for (const t of tools) TOOL_GROUP_OF[t] = g;

function shouldRegister(name: string): boolean {
  if (TOOL_ALLOWLIST === null) return true;
  if (TOOL_ALLOWLIST.has(name)) return true;
  if (TOOL_ALLOWLIST.has('admin') || TOOL_ALLOWLIST.has('harness') || TOOL_ALLOWLIST.has('agent')) return false; // profile 已展开,不再匹配
  return false;
}

function register(name: string, group: string, description: string, schema: any, handler: (args: any) => any) {
  if (!shouldRegister(name)) {
    if (process.env.MCP_LOG_TOOLS === '1') console.error(`[tools] skipped: ${name} (group=${group})`);
    return;
  }
  server.tool(name, description, schema, handler);
}

// ═══════════════════════════════════════════════════════════════════
// 搜索类工具（LLM 可见）
// ═══════════════════════════════════════════════════════════════════

register(
  'memory_search', 'agent',
  'Search past memories using tag-first then vector KNN fallback. Use when recalling past events, facts, or user preferences.',
  {
    query: z.string().describe('What to search for'),
    topK: z.number().optional().describe('Max results (default 5)'),
    category: z.string().optional().describe('Filter by category'),
    memType: z.enum(MEM_TYPES).optional().describe('Filter by usage dimension: user/feedback/project/reference/general'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const base = { query: args.query, topK: args.topK ?? 5, category: args.category, memType: args.memType, characterId: CHAR_ID };
      const r = await searchMemory({ ...base, profile: 'balanced', project: args.project });
      return ok({
        op: 'search',
        query: args.query,
        count: r.length,
        results: r.map(m => ({
          project: m.project,
          id: m.id,
          text: m.text.length > 200 ? m.text.substring(0, 200) + '…' : m.text,
          truncated: m.text.length > 200,
          kind: m.type === 'episodic' ? 'episode' : m.type === 'semantic' ? 'reflection' : m.type,
          memType: m.memType,
          category: m.category,
          importance: m.importance,
          score: m.score,
          createdAt: m.createdAt,
        })),
        hint: '用 memory_get(id) 取完整内容',
      });
    } catch (e: any) { return err(e.message, 'SEARCH_FAILED'); }
  }
);

register(
  'fact_search', 'agent',
  'Search structured facts (subject-predicate-object triples) about the user.',
  {
    query: z.string().describe('Query text'),
    subject: z.enum(['user', 'agent', 'environment']).optional(),
    topK: z.number().optional().describe('Max results (default 5)'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const r = await searchFacts(args.query, { subject: args.subject, topK: args.topK ?? 5, minConfidence: 0.3, project: args.project });
      return ok({
        op: 'fact_search',
        query: args.query,
        count: r.length,
        results: r.map(f => ({
          id: f.id,
          subject: f.subject,
          predicate: f.predicate,
          object: f.object,
          confidence: f.confidence,
          similarity: f.similarity,
        })),
      });
    } catch (e: any) { return err(e.message, 'FACT_SEARCH_FAILED'); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 存储类工具
// ═══════════════════════════════════════════════════════════════════

register(
  'memory_save', 'harness',
  'Store a new memory or update existing one by exact text match. When memType is one of user/feedback/project/reference, the text is auto-wrapped into Markdown structure (# heading + - list items).',
  {
    text: z.string().min(1, 'text 不能为空').describe('Memory content'),
    type: z.enum(['episodic', 'semantic', 'entity', 'preference']).optional().default('episodic'),
    memType: z.enum(MEM_TYPES).optional().describe('Usage dimension: user (profile) / feedback (correction) / project (context) / reference (external pointer) / general (default). Non-general values force Markdown structure.'),
    category: z.string().optional().default('general'),
    tags: z.array(z.string()).optional().default([]),
    importance: z.number().optional().default(0.5),
    tier: z.enum(['temporary', 'standard', 'critical']).optional().default('standard'),
    source: z.string().optional(),
    subject: z.enum(['user', 'self', 'environment']).optional().default('user'),
    skipEmbed: z.boolean().optional().default(false),
    expiresAt: z.string().optional().describe('Custom expiration (ISO datetime) for temporary memories. Overrides the default 3-day TTL. Also honored on standard/critical tiers when explicitly set.'),
    sessionId: z.string().optional().describe('Session identifier for session-scoped memories (stored in session_id column). Reserved for session-level retrieval (next version).'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const r = await saveMemory({ text: args.text, project: args.project, sessionId: args.sessionId, type: args.type, memType: args.memType, category: args.category, tags: args.tags, importance: args.importance, tier: args.tier, source: args.source, subject: args.subject, characterId: CHAR_ID, skipEmbed: args.skipEmbed, expiresAt: args.expiresAt });
      return ok({ id: r.id, text: r.text.substring(0, 100), type: r.type, memType: r.memType, category: r.category });
    } catch (e: any) { return err(e.message); }
  }
);

register(
  'memory_delete', 'harness',
  'Soft-delete a memory by ID.',
  { id: z.string().describe('Memory ID to delete'), project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') },
  async (args) => {
    const ok_ = forgetMemory(args.id, args.project);
    return ok({ deleted: ok_ });
  }
);

register(
  'memory_update', 'harness',
  'Update memory fields (text, category, tags, importance, etc.).',
  {
    id: z.string().describe('Memory ID'),
    text: z.string().optional(),
    memType: z.enum(MEM_TYPES).optional().describe('Usage dimension to set (user/feedback/project/reference/general)'),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    importance: z.number().optional(),
    tier: z.string().optional(),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const r = await updateMemory(args.id, args as any);
      return ok(r ? { updated: true, id: r.id, memType: (r as any).mem_type || 'general' } : { updated: false, error: 'not found' });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 认知记录工具 — agent 显式沉淀(决策/模式/错误)
// 结构化认知:agent 边干活边"教"记忆体,跨会话复用
// 检索:memory_search(category=decision|pattern|mistake)
// ═══════════════════════════════════════════════════════════════════

register(
  'memory_log', 'harness',
  'Log a cognitive entry (decision/pattern/mistake) with kind. Internal mapping: decision→category=decision, pattern→knowledge+tag, mistake→category=mistake+tier=critical. Searchable via memory_search(category=...).',
  {
    kind: z.enum(['decision', 'pattern', 'mistake']).describe('Kind of cognitive entry'),
    text: z.string().max(2000).describe('The content: decision rationale / pattern insight / mistake lesson'),
    tags: z.array(z.string()).optional().describe('Optional tags'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const kind = args.kind as 'decision' | 'pattern' | 'mistake';
      const map = {
        decision: { type: 'episodic', category: 'decision', importance: 0.6, tier: 'standard', tags: args.tags ?? [] },
        pattern: { type: 'semantic', category: 'knowledge', importance: 0.6, tier: 'standard', tags: ['pattern', ...(args.tags ?? [])] },
        mistake: { type: 'episodic', category: 'mistake', importance: 0.7, tier: 'critical', tags: args.tags ?? [] },
      } as const;
      const conf = map[kind];
      const r = await saveMemory({
        text: args.text, project: args.project, type: conf.type, category: conf.category,
        tags: conf.tags, importance: conf.importance, tier: conf.tier,
        source: 'agent_log', characterId: CHAR_ID,
      });
      return ok({ id: r.id, kind, category: conf.category, tier: conf.tier });
    } catch (e: any) { return err(e.message, 'LOG_FAILED'); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 对话自动化工具（proxy.py 内部调用）
// ═══════════════════════════════════════════════════════════════════

register(
  'auto_process', 'harness',
  '[Internal] Process a conversation turn: save to log, update agent mood, observe user, queue VAD analysis. Called automatically after each LLM response.',
  {
    userMessage: z.string(),
    assistantMessage: z.string(),
    moodValue: z.number().optional(),
    moodReason: z.string().optional(),
    sessionId: z.string().optional().describe('Session identifier for progressive in-session reflection (rolls session memory, promotes long-term facts). Omit to keep the legacy behavior (no session buffer).'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const r = await autoProcess({ userMessage: args.userMessage, assistantMessage: args.assistantMessage, characterId: CHAR_ID, moodValue: args.moodValue, moodReason: args.moodReason, sessionId: args.sessionId, project: args.project });
      // Trigger event-driven digest
      maybeDigest(CHAR_ID)?.catch(() => {});
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

register(
  'digest_run', 'harness',
  '[Internal] Run the digest cycle: flush VAD queue, cleanup expired memories, restore lost critical memories.',
  {},
  async () => {
    try {
      flushAllBuffers(); // 周期兜底:强制 flush 所有会话 buffer(补漏未达阈值的尾部消息)
      const r = await runDigest(CHAR_ID);
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

register(
  'conversation_save', 'harness',
  '[Internal] Save a raw conversation turn to the log (no analysis, no embedding).',
  {
    userMessage: z.string(),
    assistantMessage: z.string(),
    moodValue: z.number().optional(),
    moodReason: z.string().optional(),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const r = await saveConversationTurn(args.userMessage, args.assistantMessage, CHAR_ID, args.moodValue, args.moodReason, args.project);
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 上下文/状态工具
// ═══════════════════════════════════════════════════════════════════

register(
  'context_get', 'admin',
  'Get memory context summary: recent memories + stats, for prompt injection.',
  { project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') },
  async (args) => {
    try {
      const db = DatabaseManager.getInstance(args.project);
      const recent = getRecentMemories(CHAR_ID, 5, 24, args.project);
      const stats = db.prepare('SELECT COUNT(*) as c FROM memory WHERE is_active=1 AND project=?').get(normalizeProject(args.project)) as any;
      return ok({
        recentMemories: recent.map(m => ({ text: m.text, category: m.category, importance: m.importance, createdAt: m.createdAt })),
        stats: { total: stats.c },
      });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 上下文包工具 — 借鉴 engram mem_context / memory-os fabric_brief
// 一次调用拿到组装好的注入上下文:近期 + 相关 + 认知记录 + 事实
// ═══════════════════════════════════════════════════════════════════

register(
  'memory_context', 'admin',
  'Assemble an injection-ready context bundle: recent important memories + memories related to the current task (optional query) + cognitive logs (decisions/mistakes/patterns) + key facts. Call at session start or when you need memory context.',
  {
    query: z.string().optional().describe('Current task/topic to find related memories (optional)'),
    hoursBack: z.number().optional().describe('Window for recent memories (default 48h)'),
    recentLimit: z.number().optional().describe('Max recent memories (default 5)'),
    relatedLimit: z.number().optional().describe('Max related memories (default 5)'),
    asText: z.boolean().optional().describe('Return ready-to-inject prompt text (default true)'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
    sessionId: z.string().optional().describe('Session identifier to inject its rolling session memory (progressive in-session reflection snapshot) into the prompt.'),
    path: z.string().optional().describe('Current file path for glob-filtered instructions (e.g. src/components/Button.tsx). Instructions whose paths pattern does not match are skipped.'),
  },
  async (args) => {
    try {
      const db = DatabaseManager.getInstance(args.project);
      const hoursBack = args.hoursBack ?? 48;
      const recentLimit = args.recentLimit ?? 5;
      const relatedLimit = args.relatedLimit ?? 5;
      const proj = normalizeProject(args.project);

      // 1. 近期重要记忆
      const recent = getRecentMemories(CHAR_ID, recentLimit, hoursBack, proj);

      // 2. 与当前任务相关的记忆(向量搜索)
      let related: any[] = [];
      if (args.query) {
        const r = await searchMemory({ query: args.query, topK: relatedLimit, profile: 'balanced', characterId: CHAR_ID, project: proj });
        related = r.map(m => ({ text: m.text, category: m.category, importance: m.importance, score: m.score, createdAt: m.createdAt }));
      }

      // 3. 认知记录(决策/错误/模式)
      const cognitiveCats = ['decision', 'mistake'];
      const cognitives = db.prepare(`
        SELECT text, category, importance, created_at FROM memory
        WHERE is_active = 1 AND project = ?
          AND (category IN ('decision','mistake') OR tags LIKE '%pattern%')
        ORDER BY created_at DESC LIMIT 9
      `).all(proj) as any[];

      // 4. 关键事实(高置信度)
      const facts = db.prepare(`
        SELECT subject, predicate, object, confidence FROM facts
        WHERE is_active = 1 AND project = ? AND confidence >= 0.7
        ORDER BY confidence DESC, created_at DESC LIMIT 5
      `).all(proj) as any[];

      // 4.5 记忆索引层(4 种封闭类型,轻量摘要 — 对应 Claude Code MEMORY.md,先索引后详情)
      const indexRows = db.prepare(`
        SELECT id, mem_type, substr(text, 1, 150) AS summary, length(text) AS full_len
        FROM memory
        WHERE is_active = 1 AND project = ?
          AND mem_type IN ('user','feedback','project','reference')
        ORDER BY updated_at DESC
        LIMIT 10
      `).all(proj) as any[];
      const indexLayer = indexRows.map((row: any) => {
        const s = row.summary || '';
        return {
          id: row.id,
          memType: row.mem_type || 'general',
          summary: row.full_len > 150 ? summarizeForIndex(s, 149) : s,
        };
      });

      // 0. 三层指令记忆(全局→用户→项目;拼接顺序 L1→L2→L3,L3 在 Prompt 末尾约束最高)
      //    path 可选:对带 paths 的指令做 glob 过滤
      const instructions = getInstruction(proj, args.path);

      const stats = db.prepare('SELECT COUNT(*) as c FROM memory WHERE is_active=1 AND project=?').get(proj) as any;

      // 5. Ground Truth 提示词组装(指令分节在最前面)
      const sections: string[] = [];
      if (instructions.length > 0) {
        const lines = instructions.map(i => {
          const base = i.scope === 'global' ? '[全局]' : i.scope === 'user' ? '[用户]' : '[项目]';
          const pathTag = i.paths && i.paths.length ? ` ${i.paths.join(', ')}` : '';
          return `${base}${pathTag} ${i.content}`;
        });
        sections.push(`【指令(全局→项目,项目约束最高)】\n${lines.join('\n')}`);
      }

      // 0.5 会话滚动状态(可选 sessionId):渐进式临时反思的滚动快照注入
      if (args.sessionId) {
        const sess = db.prepare(`
          SELECT text FROM memory
          WHERE is_active = 1 AND project = ? AND session_id = ? AND source = 'session_memory'
          ORDER BY updated_at DESC LIMIT 1
        `).get(proj, args.sessionId) as any;
        if (sess?.text) {
          sections.push(`\n■ 会话滚动状态(会话 ${args.sessionId},以此为准,勿重复询问):`);
          sections.push(sess.text);
        }
      }

      sections.push(`【当前记忆上下文】总记忆 ${stats.c} 条。请优先参考以下记忆,它们是之前会话沉淀的事实与经验:`);

      // v1.15: 用户偏好段(带触发条件,score_priority 排序,最先展示)
      const prefs = db.prepare(`
        SELECT text, metadata, score_priority FROM memory
        WHERE is_active = 1 AND project = ? AND type = 'preference' AND mem_type = 'user'
        ORDER BY COALESCE(score_priority, 0) DESC, importance DESC LIMIT 8
      `).all(proj) as any[];
      if (prefs.length > 0) {
        sections.push(`\n■ 用户偏好(跨会话行为指令,优先遵守):`);
        prefs.forEach((p: any, i: number) => {
          let ctxLine = '';
          try {
            const meta = JSON.parse(p.metadata || '{}');
            const oc = meta.originContext;
            if (oc) {
              const parts: string[] = [];
              if (oc.trigger) parts.push(`触发:${oc.trigger}`);
              if (oc.applicableWhen) parts.push(`适用:${oc.applicableWhen}`);
              if (oc.notApplicableWhen) parts.push(`不适用:${oc.notApplicableWhen}`);
              if (parts.length) ctxLine = ` (${parts.join(';')})`;
            }
          } catch { /* metadata 非 JSON 忽略 */ }
          sections.push(`${i + 1}. ${String(p.text || '').replace(/^# .*\n/, '')}${ctxLine}`);
        });
      }

      if (recent.length > 0) {
        sections.push(`\n■ 近期重要记忆(近 ${hoursBack} 小时):`);
        recent.forEach((m: any, i: number) => {
          sections.push(`${i + 1}. [${m.category}] ${m.text}${m.importance >= 0.8 ? ' (重要)' : ''}`);
          const warn = memorySnapshotWarn(m.createdAt);
          if (warn) sections.push(`  ${warn}`);
        });
      }

      if (related.length > 0) {
        sections.push(`\n■ 与当前任务相关:「${args.query}」`);
        related.forEach((m: any, i: number) => {
          sections.push(`${i + 1}. [${m.category}] ${m.text}`);
          const warn = memorySnapshotWarn(m.createdAt);
          if (warn) sections.push(`  ${warn}`);
        });
      }

      if (cognitives.length > 0) {
        sections.push(`\n■ 经验沉淀(决策/错误/模式):`);
        cognitives.forEach((m: any, i: number) => {
          const tag = m.category === 'mistake' ? '⚠️教训' : m.category === 'decision' ? '🎯决策' : '📐模式';
          sections.push(`${i + 1}. ${tag} ${m.text}`);
        });
      }

      if (facts.length > 0) {
        sections.push(`\n■ 已知事实:`);
        facts.forEach((f: any, i: number) => {
          sections.push(`${i + 1}. ${f.subject} — ${f.predicate}: ${f.object}`);
        });
      }

      if (indexLayer.length > 0) {
        sections.push(`\n■ 记忆索引(仅摘要,详情用 memory_get(id) 展开):`);
        indexLayer.forEach((m: any, i: number) => {
          sections.push(`${i + 1}. [${m.memType}] ${m.summary} (id: ${m.id})`);
        });
      }

      sections.push(`\n【要求】以上记忆来自用户的真实历史,与当前任务相关时请直接使用,不要重新询问用户已知信息。`);

      const bundle = {
        prompt: sections.join('\n'),
        instructions,
        recent: recent.map(m => ({ text: m.text, category: m.category, importance: m.importance, createdAt: m.createdAt })),
        related,
        cognitives: cognitives.map(m => ({ text: m.text, category: m.category })),
        facts,
        index: indexLayer,
        stats: { total: stats.c },
        injectedAt: new Date().toISOString(),
      };

      return ok(args.asText === false ? bundle : { prompt: bundle.prompt });
    } catch (e: any) { return err(e.message); }
  }
);

register(
  'stats_get', 'admin',
  'Get memory system statistics: total count, by category, by source.',
  { project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') },
  async (args) => {
    try {
      const proj = normalizeProject(args.project);
      // memdir:聚合项目全部分类库统计
      let total = 0;
      const byCategory: Record<string, number> = {};
      const bySource: Record<string, number> = {};
      const byMemType: Record<string, number> = {};
      for (const mt of listMemTypeDirs(proj)) {
        const db = DatabaseManager.getInstance(proj, mt);
        total += (db.prepare('SELECT COUNT(*) as c FROM memory WHERE is_active=1 AND project=?').get(proj) as any).c;
        for (const r of db.prepare('SELECT category,COUNT(*) as c FROM memory WHERE is_active=1 AND project=? GROUP BY category').all(proj) as any[]) {
          byCategory[r.category] = (byCategory[r.category] || 0) + r.c;
        }
        for (const r of db.prepare('SELECT source,COUNT(*) as c FROM memory WHERE is_active=1 AND project=? GROUP BY source').all(proj) as any[]) {
          bySource[r.source] = (bySource[r.source] || 0) + r.c;
        }
        for (const r of db.prepare('SELECT mem_type,COUNT(*) as c FROM memory WHERE is_active=1 AND project=? GROUP BY mem_type').all(proj) as any[]) {
          byMemType[r.mem_type] = (byMemType[r.mem_type] || 0) + r.c;
        }
      }
      return ok({
        op: 'stats',
        total,
        byCategory: Object.entries(byCategory).map(([category, c]) => ({ category, c })),
        bySource: Object.entries(bySource).map(([source, c]) => ({ source, c })),
        byMemType: Object.entries(byMemType).map(([mem_type, c]) => ({ mem_type, c })),
        characterId: CHAR_ID,
        project: proj,
      });
    } catch (e: any) { return err(e.message, 'STATS_FAILED'); }
  }
);


// ═══════════════════════════════════════════════════════════════════
// 记忆列表/图谱工具
// ═══════════════════════════════════════════════════════════════════

register(
  'memory_list', 'admin',
  'List active memories, optionally filtered. Admin tool: hard limit 50 to protect context.',
  {
    limit: z.number().max(50).optional().default(50).describe('Max results (hard cap 50)'),
    category: z.string().optional(),
    source: z.string().optional(),
    memType: z.enum(MEM_TYPES).optional().describe('Filter by usage dimension: user/feedback/project/reference/general'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const memories = getAllMemories(CHAR_ID, args.limit, args.project);
      let filtered = memories;
      if (args.category) filtered = filtered.filter((m: any) => m.category === args.category);
      if (args.source) filtered = filtered.filter((m: any) => m.source === args.source);
      if (args.memType) filtered = filtered.filter((m: any) => m.memType === args.memType);
      const sliced = filtered.slice(0, args.limit);
      return ok({
        op: 'list',
        count: sliced.length,
        results: sliced.map(m => ({
          id: m.id,
          text: m.text.length > 200 ? m.text.substring(0, 200) + '…' : m.text,
          truncated: m.text.length > 200,
          memType: m.memType || 'general',
          category: m.category,
          importance: m.importance,
          createdAt: m.createdAt,
        })),
        hint: '用 memory_get(id) 取完整内容',
      });
    } catch (e: any) { return err(e.message, 'LIST_FAILED'); }
  }
);

register(
  'memory_get', 'agent',
  'Get one memory by ID with full text. Use to expand a search/recent/list result.',
  {
    id: z.string().describe('Memory ID'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      // memdir:按 id 遍历项目分类库定位
      const proj = normalizeProject(args.project);
      let db: any = null;
      let row: any = null;
      for (const mt of listMemTypeDirs(proj)) {
        const d = DatabaseManager.getInstance(proj, mt);
        const r = d.prepare('SELECT * FROM memory WHERE id = ? AND is_active = 1').get(args.id) as any;
        if (r) { db = d; row = r; break; }
      }
      if (!row) return err('memory not found: ' + args.id, 'NOT_FOUND');
      // v1.3: 访问一次 → 热度 +1(配合热度升格:accessed_count ≥ 阈值自动升 tier)
      db.prepare('UPDATE memory SET accessed_count = accessed_count + 1, last_accessed_at = ? WHERE id = ?')
        .run(new Date().toISOString(), args.id);
      return ok({
        op: 'get',
        result: {
          id: row.id,
          text: row.text,
          truncated: false,
          type: row.type,
          memType: row.mem_type || 'general',
          category: row.category,
          tags: JSON.parse(row.tags || '[]'),
          importance: row.importance,
          tier: row.tier,
          source: row.source,
          subject: row.subject,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          metadata: {
            accessedCount: row.accessed_count + 1,
            referenceCount: row.reference_count,
            locked: row.locked === 1,
          },
        },
      });
    } catch (e: any) { return err(e.message, 'GET_FAILED'); }
  }
);

register(
  'memory_graph', 'agent',
  'Get the memory relationship graph. Neighborhood only: nodes capped by limit (default 50), edges kept only between returned nodes.',
  { limit: z.number().max(200).optional().default(50).describe('Max nodes (default 50)'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') },
  async (args) => {
    try {
      const g = getMemoryGraph(CHAR_ID, args.project);
      const limit = args.limit ?? 50;
      const nodes = g.nodes.slice(0, limit);
      const nodeIds = new Set(nodes.map((n: any) => n.id));
      const edges = g.edges.filter((e: any) => nodeIds.has(e.sourceId) && nodeIds.has(e.targetId));
      return ok({
        op: 'graph',
        count: nodes.length,
        nodes,
        edges,
        truncated: g.nodes.length > limit,
        hint: '图已按节点数截断,如需完整图用 Web Console',
      });
    } catch (e: any) { return err(e.message, 'GRAPH_FAILED'); }
  }
);

register(
  'memory_recent', 'agent',
  'Get recent important memories (no vector search, just time+importance).',
  {
    limit: z.number().optional().default(5),
    hoursBack: z.number().optional().default(24),
    memType: z.enum(MEM_TYPES).optional().describe('Filter by usage dimension: user/feedback/project/reference/general'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const r = getRecentMemories(CHAR_ID, args.limit, args.hoursBack, args.project, args.memType);
      return ok({
        op: 'recent',
        count: r.length,
        results: r.map(m => ({
          id: m.id,
          text: m.text.length > 200 ? m.text.substring(0, 200) + '…' : m.text,
          truncated: m.text.length > 200,
          memType: m.memType,
          category: m.category,
          importance: m.importance,
          createdAt: m.createdAt,
        })),
        hint: '用 memory_get(id) 取完整内容',
      });
    } catch (e: any) { return err(e.message, 'RECENT_FAILED'); }
  }
);

register(
  'memory_index', 'agent',
  'Lightweight memory index (corresponds to Claude Code MEMORY.md): returns id + mem_type + 150-char summary per row, no full text. Use memory_get(id) to expand a summary into full detail (index-first, detail-after).',
  {
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
    memType: z.enum(MEM_TYPES).optional().describe('Filter by usage dimension: user/feedback/project/reference/general'),
    limit: z.number().max(100).optional().default(20).describe('Max index rows (default 20, hard cap 100)'),
  },
  async (args) => {
    try {
      const db = DatabaseManager.getInstance(args.project);
      const proj = normalizeProject(args.project);
      const limit = Math.min(args.limit ?? 20, 100);
      const conds = ['is_active = 1', 'project = ?'];
      const params: any[] = [proj];
      if (args.memType) { conds.push('mem_type = ?'); params.push(args.memType); }
      params.push(limit);
      const rows = db.prepare(`
        SELECT id, mem_type, substr(text, 1, 150) AS summary, length(text) AS full_len, updated_at
        FROM memory
        WHERE ${conds.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(...params) as any[];
      return ok({
        op: 'index',
        count: rows.length,
        results: rows.map((row: any) => ({
          id: row.id,
          memType: row.mem_type || 'general',
          summary: row.summary,
          summaryTruncated: row.full_len > 150,
          updatedAt: row.updated_at,
        })),
        hint: '摘要层只含标题+150字。用 memory_get(id) 拉全文。',
      });
    } catch (e: any) { return err(e.message, 'INDEX_FAILED'); }
  }
);

register(
  'recent_conversations', 'admin',
  'Get recent conversation log entries.',
  {
    hoursBack: z.number().optional().default(24),
    limit: z.number().optional().default(50),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const r = getRecentConversations(CHAR_ID, args.hoursBack, args.limit, args.project);
      return ok({ count: r.length, results: r });
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 反思工具
// ═══════════════════════════════════════════════════════════════════

register(
  'reflect_analyze', 'admin',
  'Get unanalyzed conversations bundled with system prompt for a big LLM to perform reflection.',
  { limit: z.number().optional().default(30),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') },
  async (args) => {
    try {
      const conversations = getUnanalyzedConversations(CHAR_ID, undefined, args.limit ?? 30, args.project);
      const prompt = conversations.map((c: any) => c.text).join('\n---\n');
      return ok({
        conversationCount: conversations.length,
        systemPrompt: REFLECT_SYSTEM_PROMPT,
        userPrompt: `请分析以下对话，输出反思JSON：\n\n${prompt.substring(0, 30000)}`,
        conversationIds: conversations.map((c: any) => c.id),
      });
    } catch (e: any) { return err(e.message); }
  }
);

register(
  'reflect_apply', 'admin',
  'Apply reflection results (merge, extract, reclassify, delete actions).',
  {
    action: z.enum(['apply', 'preview']).optional().default('apply'),
    actions: z.string().describe('JSON array of reflection actions'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      let parsed: any;
      try {
        parsed = JSON.parse(args.actions);
      } catch {
        const m = args.actions.match(/```(?:json)?\s*([\s\S]*?)```/);
        parsed = m ? JSON.parse(m[1]) : JSON.parse(args.actions);
      }
      const r = await reflect(args.action, { actions: parsed, project: args.project });
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

register(
  'reflect_auto', 'harness',
  'Run automatic reflection: feed unanalyzed conversations (or ALL memories when mode=deep) to the configured LLM, apply extracted actions. Requires REFLECT_LLM_API_KEY.',
  {
    limit: z.number().optional().default(30),
    mode: z.enum(['daily', 'deep']).optional().default('daily').describe('daily=unanalyzed conversations; deep=full calibration'),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
  },
  async (args) => {
    try {
      const r = args.mode === 'deep'
        ? await runDeepReflect(CHAR_ID, args.limit ?? 500, args.project)
        : await runAutoReflect(CHAR_ID, args.limit ?? 30, args.project);
      return ok({ op: args.mode === 'deep' ? 'reflect_deep' : 'reflect_auto', ...r });
    } catch (e: any) { return err(e.message, 'REFLECT_FAILED'); }
  }
);

register(
  'reflect_deep', 'harness',
  '[Legacy] Deep calibration. Use reflect_auto(mode="deep") instead.',
  { limit: z.number().optional().default(500),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') },
  async (args) => {
    try {
      const r = await runDeepReflect(CHAR_ID, args.limit ?? 500, args.project);
      return ok({ op: 'reflect_deep', ...r });
    } catch (e: any) { return err(e.message, 'REFLECT_FAILED'); }
  }
);

register(
  'reflect_batch_embed', 'harness',
  '[Internal] Batch embed all pending (un-embedded) memories. Called after reflect. characterId="any" embeds across all roles (e.g. reflect library).',
  { project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
    characterId: z.string().optional().describe('Character id filter (default CHAR_ID; "any" = no filter, e.g. for reflect library)') },
  async (args) => {
    try {
      const r = await batchEmbedPending(args.characterId ?? CHAR_ID, args.project);
      return ok(r);
    } catch (e: any) { return err(e.message); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 记忆整合工具(v1.10 Memory Consolidator)
// 向量预筛相似对 → LLM 去重/矛盾消解/主题归并 → 原子应用
// ═══════════════════════════════════════════════════════════════════

register(
  'consolidate_deep', 'admin',
  'Run memory consolidation: vector pre-screen similar pairs (cos > threshold) → LLM dedup/merge/conflict-resolution (MEMORY_CONSOLIDATION_PROMPT) → atomic apply. Requires REFLECT_LLM_API_KEY. No candidates → returns empty without calling LLM. EMBED_MODE=none falls back to LLM full scan.',
  {
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")'),
    threshold: z.number().optional().describe('Min cosine similarity for candidate pairs (default CONSOLIDATE_SIMILARITY=0.88)'),
    limit: z.number().optional().describe('Max candidate pairs (default 50)'),
  },
  async (args) => {
    try {
      const r = await runConsolidate(CHAR_ID, args.project, args.threshold, args.limit);
      return ok({ op: 'consolidate_deep', ...r });
    } catch (e: any) { return err(e.message, 'CONSOLIDATE_FAILED'); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 每日摘要工具
// ═══════════════════════════════════════════════════════════════════

register(
  'daily_summary_data', 'admin',
  'Get conversation and auto-process data for the past N hours.',
  { hoursBack: z.number().optional().default(24),
    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or "default")') },
  async (args) => {
    try {
      const db = DatabaseManager.getInstance(args.project);
      const since = new Date(Date.now() - (args.hoursBack || 24) * 3600000).toISOString();
      const proj = normalizeProject(args.project);
      const convs = db.prepare("SELECT text FROM memory WHERE is_active=1 AND source='conversation_log' AND project=? AND created_at>? ORDER BY created_at ASC LIMIT 100").all(proj, since).map((r: any) => r.text);
      const aps = db.prepare("SELECT text FROM memory WHERE is_active=1 AND source='auto_process' AND project=? AND created_at>? ORDER BY created_at ASC LIMIT 50").all(proj, since).map((r: any) => r.text);
      return ok({ conversations: [...convs, ...aps] });
    } catch (e: any) { return err(e.message); }
  }
);

register(
  'project_list', 'admin',
  'List all project namespaces and their memory/fact counts. Use to discover which projects have memories (e.g. after switching working directories).',
  {},
  async () => {
    try {
      // 兼容模式(MEMORY_DB_PATH):单库内按 project 列分组统计(旧行为)
      if (process.env.MEMORY_DB_PATH) {
        const db = DatabaseManager.getInstance();
        const mem = db.prepare(`
          SELECT project, COUNT(*) as c FROM memory
          WHERE is_active = 1 GROUP BY project ORDER BY c DESC
        `).all() as any[];
        const facts = db.prepare(`
          SELECT project, COUNT(*) as c FROM facts
          WHERE is_active = 1 GROUP BY project ORDER BY c DESC
        `).all() as any[];
        const byId: Record<string, any> = {};
        for (const r of mem) byId[r.project || 'default'] = { project: r.project || 'default', memories: r.c, facts: 0 };
        for (const r of facts) {
          const key = r.project || 'default';
          if (!byId[key]) byId[key] = { project: key, memories: 0, facts: 0 };
          byId[key].facts = r.c;
        }
        const projects = Object.values(byId).sort((a: any, b: any) => (b.memories + b.facts) - (a.memories + a.facts));
        return ok({
          op: 'project_list',
          count: projects.length,
          current: PROJECT_ID,
          projects,
          hint: '读写工具传 project 参数即切换到该项目的记忆空间;不传则用当前项目(' + PROJECT_ID + ')',
        });
      }

      // 新目录结构:遍历 memory/ 下 project-*.sqlite(无库文件的项目不算)
      const gdb = DatabaseManager.getGlobal();
      const regMap = new Map<string, string>();
      try {
        for (const r of gdb.prepare('SELECT project, created_at FROM projects').all() as any[]) {
          regMap.set(r.project, r.created_at);
        }
      } catch { /* projects 表不可用时忽略 */ }

      const projects: any[] = [];
      for (const name of listProjectNames()) {
        try {
          // memdir:聚合项目全部分类库统计
          let mem = 0;
          let facts = 0;
          for (const mt of listMemTypeDirs(name)) {
            const db = DatabaseManager.getInstance(name, mt);
            mem += (db.prepare('SELECT COUNT(*) as c FROM memory WHERE is_active=1').get() as any).c;
            try { facts += (db.prepare('SELECT COUNT(*) as c FROM facts WHERE is_active=1').get() as any).c; } catch {}
          }
          projects.push({
            project: name,
            memories: mem,
            facts,
            createdAt: regMap.get(name) || null,
          });
        } catch { /* 打不开的库跳过 */ }
      }
      projects.sort((a, b) => (b.memories + b.facts) - (a.memories + a.facts));
      return ok({
        op: 'project_list',
        count: projects.length,
        current: PROJECT_ID,
        projects,
        hint: '读写工具传 project 参数即切换到该项目的记忆空间;不传则用当前项目(' + PROJECT_ID + ')',
      });
    } catch (e: any) { return err(e.message, 'PROJECT_LIST_FAILED'); }
  }
);

register(
  'project_create', 'admin',
  'Create a new project (library) namespace. Immediately usable for memory_save / memory_search with project=<name>. Name uses letters/digits/._- only.',
  {
    name: z.string().min(1).describe('New library name (letters/digits/._- recommended)'),
  },
  async (args) => {
    try {
      const raw = String(args.name).trim();
      if (!raw) return err('项目名不能为空', 'INVALID_PROJECT_NAME');
      const safe = safeFilePart(raw);
      if (safe !== raw) {
        return err(`项目名包含不安全字符,已规范化为 "${safe}"。建议只用字母/数字/._-`, 'INVALID_PROJECT_NAME');
      }
      DatabaseManager.getInstance(safe);
      return ok({
        op: 'project_create',
        project: safe,
        hint: `读写工具传 project=${safe} 即指向该库;约定库名 shared 为共享层(互通语义待定)`,
      });
    } catch (e: any) { return err(e.message, 'PROJECT_CREATE_FAILED'); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// 三层指令记忆工具(类比 CLAUDE.md 层级)
// L1 global:所有用户/项目通用规则(种子为全局规范)
// L2 user:当前用户所有项目共享
// L3 project:单项目专属规则,拼接在 Prompt 最末尾、约束最高,可覆盖 L1/L2 冲突
// rule:规则组(scope=rule),供 include 引用复用;指令带 paths 时可做 glob 路径过滤
// ═══════════════════════════════════════════════════════════════════

register(
  'instruction_save', 'harness',
  'Save (upsert) an instruction rule into one of four layers: global (all users/projects, seeded with global rules), user (current user, all projects), project (this project only), or rule (a reusable rule group referenced via include lines like include: "rule:typescript-core" in any instruction). Load order into prompt: global→user→project; project rules land at the very end and carry the highest constraint. Same scope+project overwrites the previous content. Optional paths accepts glob patterns (JSON array of strings, e.g. ["src/**","!src/temp/**"]) — when memory_context is called with a path, instructions whose paths do not match are skipped.',
  {
    scope: z.enum(['global', 'user', 'project', 'rule']).describe('Layer: global=all users/projects, user=this user shared, project=this project only, rule=reusable rule group (project = group name)'),
    project: z.string().optional().describe('Project name (REQUIRED when scope=project) or rule group name (REQUIRED when scope=rule)'),
    content: z.string().describe('Instruction rule content. May contain include lines: include: "rule:groupname" or include: ["rule:a","rule:b"]'),
    paths: z.array(z.string()).optional().describe('Glob patterns (picomatch). NULL = applies to all paths; patterns with leading ! are negations (last match wins).'),
  },
  async (args) => {
    try {
      const needsProject = args.scope === 'project' || args.scope === 'rule';
      if (needsProject && !(args.project ?? '').trim()) return err(args.scope === 'rule' ? 'scope=rule 时必须传 project 参数(规则组名)' : 'scope=project 时必须传 project 参数', 'INVALID_PROJECT');
      const proj = needsProject ? normalizeProject(args.project) : null;
      const r = saveInstruction(args.scope, proj, args.content, args.paths ?? null);
      return ok({ saved: true, scope: args.scope, project: proj, paths: args.paths ?? null, created: r.created, id: r.id });
    } catch (e: any) { return err(e.message, 'INSTRUCTION_SAVE_FAILED'); }
  }
);

register(
  'instruction_list', 'admin',
  'List all instruction layers (global/user/project/rule) with scope, project, content, paths and updated_at. Rule groups are scope=rule + project=group name. Admin tool: use instruction_save to add/update, instruction_delete to remove.',
  {},
  async () => {
    try {
      const rows = listInstructions();
      return ok({ count: rows.length, instructions: rows });
    } catch (e: any) { return err(e.message, 'INSTRUCTION_LIST_FAILED'); }
  }
);

register(
  'instruction_delete', 'admin',
  'Delete one instruction layer. scope=project requires the matching project name; scope=rule requires the rule group name. Admin tool.',
  {
    scope: z.enum(['global', 'user', 'project', 'rule']).describe('Layer to delete'),
    project: z.string().optional().describe('Project name (required when scope=project) or rule group name (required when scope=rule)'),
  },
  async (args) => {
    try {
      const needsProject = args.scope === 'project' || args.scope === 'rule';
      if (needsProject && !(args.project ?? '').trim()) return err(args.scope === 'rule' ? 'scope=rule 时必须传 project 参数(规则组名)' : 'scope=project 时必须传 project 参数', 'INVALID_PROJECT');
      const proj = needsProject ? normalizeProject(args.project) : null;
      const r = deleteInstruction(args.scope, proj);
      return ok({ deleted: r.deleted, scope: args.scope, project: proj });
    } catch (e: any) { return err(e.message, 'INSTRUCTION_DELETE_FAILED'); }
  }
);

// ═══════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════

async function main() {
  // 三层指令记忆:启动时创建 memory/ 目录 + global.sqlite(建表 + L1 全局种子)
  // 项目库懒加载:首次访问某 project 才创建
  DatabaseManager.getGlobal();
  const seed = ensureSeedInstructions();
  console.error(`[instructions] L1 种子${seed.seeded ? '已写入(scope=global)' : `跳过(表已有 ${seed.count} 条)`}`);

  // v1.11 Part2: 会话记忆 TTL 孤儿清扫(启动时静默执行,默认项目 + 已存在项目库各一次)
  try {
    let swept = sweepExpiredSessionMemories();
    for (const name of listProjectNames()) {
      try { swept += sweepExpiredSessionMemories(name); } catch { /* 打不开的库跳过 */ }
    }
    if (swept > 0) console.error(`[session-memory] TTL 清扫: ${swept} 条过期会话记忆已清除`);
  } catch (e: any) {
    console.error('[session-memory] TTL 清扫失败:', e.message);
  }

  // Agent state: nothing to flush (in-memory only)

  // Consolidate every 24 hours
  setInterval(() => { consolidate().catch(() => {}); }, 24 * 60 * 60 * 1000);

  // Event-driven digest check every 1 minute
  setInterval(() => {
    maybeDigest(CHAR_ID)?.catch((e: any) => console.error('digest error:', e));
  }, 60 * 1000);

  // WAL checkpoint every 30 minutes
  setInterval(() => {
    try {
      const r = DatabaseManager.checkpoint();
      if (r.pages > 0) console.error('[db] WAL checkpoint:', r.pages, 'pages');
    } catch {}
  }, 30 * 60 * 1000);

  // Cleanup expired every 30 minutes
  setInterval(() => {
    const cleaned = cleanupExpiredMemories();
    if (cleaned > 0) console.error(`[castalia] cleaned ${cleaned} expired temporary memories`);
  }, 30 * 60 * 1000);

  // Auto-reflect every N hours (REFLECT_INTERVAL_HOURS > 0 enables)
  const reflectIntervalHours = parseFloat(process.env.REFLECT_INTERVAL_HOURS || '0');
  if (reflectIntervalHours > 0) {
    const runOnce = () => {
      runAutoReflect(CHAR_ID).then(r => {
        if (r.skipped) return;
        console.error(`[reflect-auto] applied ${r.applied}/${r.actions} actions, errors: ${r.errors.length}`);
      }).catch((e: any) => console.error('[reflect-auto] error:', e.message));
    };
    setInterval(runOnce, reflectIntervalHours * 3600 * 1000);
    console.error(`[castalia] auto-reflect every ${reflectIntervalHours}h`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[airi-memory] v5.0.0 started — unified MCP server (proxy + LLM tools)');

  // ═══ 启动时自动反思 ═══
  // 触发逻辑:条件达成(距上次反思 ≥ REFLECT_MIN_GAP_HOURS 且未分析对话 > REFLECT_MIN_UNANALYZED)
  // 后,下次启动 server 时自动执行一次 runAutoReflect;启动后不再周期性自动跑。
  // 用 setTimeout 异步执行,不阻塞 server 启动;失败 catch 记录不崩。
  setTimeout(() => {
    (async () => {
      try {
        const cond = shouldAutoReflect(CHAR_ID);
        if (!cond.should) {
          console.error(`[reflect-startup] 跳过: ${cond.reason}`);
          return;
        }
        console.error(`[reflect-startup] 条件达成(${cond.reason}),启动自动反思...`);
        const r = await runAutoReflect(CHAR_ID);
        console.error(`[reflect-startup] 完成: ok=${r.ok}, actions=${r.actions}, applied=${r.applied}, factsInserted=${r.factsInserted ?? 0}, factsUpdated=${r.factsUpdated ?? 0}, errors=${r.errors.length}${r.skipped ? ', skipped' : ''}`);
        if (r.errors.length > 0) console.error(`[reflect-startup] errors: ${r.errors.join('; ')}`);
      } catch (e: any) {
        console.error('[reflect-startup] error:', e.message);
      }
    })();
  }, 0);

  // ═══ v1.10: 启动时自动记忆整合 ═══
  // 触发逻辑:记忆过多(active > CONSOLIDATE_MIN_MEMORIES,默认 15)时,下次启动异步执行一次
  // consolidate_deep 流程(向量预筛 → LLM 去重/矛盾消解)。开关 CONSOLIDATE_AUTO_ON_START(默认 1;0=只手动)。
  setTimeout(() => {
    (async () => {
      try {
        if ((process.env.CONSOLIDATE_AUTO_ON_START ?? '1') === '0') {
          console.error('[consolidate-startup] 跳过: CONSOLIDATE_AUTO_ON_START=0');
          return;
        }
        const cond = shouldAutoConsolidate();
        if (!cond.should) {
          console.error(`[consolidate-startup] 跳过: 记忆 ${cond.count} 条未超阈值 ${cond.min}`);
          return;
        }
        console.error(`[consolidate-startup] 记忆 ${cond.count} 条超阈值 ${cond.min},自动整合...`);
        const r = await runConsolidate(CHAR_ID);
        console.error(`[consolidate-startup] 完成: ok=${r.ok}, scanned=${r.scanned}, candidates=${r.candidates}, merged=${r.merged}, deleted=${r.deleted}, kept=${r.kept}, errors=${r.errors.length}${r.skipped ? ', skipped' : ''}`);
        if (r.errors.length > 0) console.error(`[consolidate-startup] errors: ${r.errors.join('; ')}`);
      } catch (e: any) {
        console.error('[consolidate-startup] error:', e.message);
      }
    })();
  }, 500);

  process.on('SIGINT', () => { DatabaseManager.close(); process.exit(0); });
  process.on('SIGTERM', () => { DatabaseManager.close(); process.exit(0); });
}

main();
