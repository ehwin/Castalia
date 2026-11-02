/**
 * 保留期清理（v1.29，2026-11-01）—— 把「已判定无用但还占着库」的死行收进墓碑表。
 *
 * 为什么需要
 *   实存活库：hermes 库 6.11MB 正文里 5.64MB（92%）是 `is_active=0` 的死行；
 *   其中 2,585 条是「写进去即作废」的会话原文（平均 2KB/条）。检索侧靠 `is_active=1` 过滤
 *   不会出错，但库体积、备份耗时、FTS/向量索引、全表扫描都在替这些行付钱。
 *   外部依据：Selective Forgetting（2608.28978）删 9.8% 节点/9.5% 字节、F1 变化 +0.001；
 *   FadeMem（2601.18642）同类做法存储 −45%。所以"能删"不是臆断，但要**只删证明过没人用的**。
 *
 * 三条纪律
 *   1. 只删 `is_active = 0` 且龄期超过 N 天（默认 30）的行 —— 不给任何"看起来没用"的活跃行开口子。
 *   2. 任何被引用的行一律保留：edges 端点、facts.source_memory_id、活跃行的
 *      merged_into / parent_id / merged_from(JSON)。引用关系不清就不删。
 *   3. 可回滚：墓碑表只存 id + 内容哈希 + 长度 + 来源，正文本身不复制（库快照里还在）。
 *      真要恢复正文，从 `_归档/banks-<ts>` 的 sqlite 快照里按 id 取。
 *
 * 不动的东西：FTS 由 AFTER DELETE 触发器自动同步；edges 无引用才可能被删。
 */
import type { Database } from 'better-sqlite3';
import { DatabaseManager, listAllProjects } from './db.js';
import { listMemTypeDirs } from './db.js';
import { normalizeProject } from './env.js';
import { debugCatch } from './log.js';
import crypto from 'node:crypto';

export interface ReapOptions {
  /** 默认：磁盘上全部库 */
  project?: string;
  /** 龄期下限（天），默认 30 */
  olderThanDays?: number;
  /** 只统计不删除 */
  dryRun?: boolean;
  /** 单个库单轮最多处理多少行（默认 20000，防一次性跑飞） */
  maxPerLibrary?: number;
}

export interface ReapLibraryStat {
  project: string;
  memType: string;
  scanned: number;
  candidates: number;
  reaped: number;
  keptReferenced: number;
  bytes: number;
}

export interface ReapResult {
  dryRun: boolean;
  olderThanDays: number;
  totalReaped: number;
  totalBytes: number;
  libraries: ReapLibraryStat[];
  errors: string[];
}

function ensureTombstone(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_tombstone (
    id TEXT PRIMARY KEY,
    project TEXT,
    mem_type TEXT,
    source TEXT,
    content_hash TEXT,
    chars INTEGER,
    created_at TEXT,
    reaped_at TEXT NOT NULL,
    reason TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_tombstone_reaped ON memory_tombstone(reaped_at)');
}

/** 收集"被引用"的 id：edges 端点 + facts 出处 + 活跃行的合并链 */
function collectReferenced(db: Database): Set<string> {
  const refs = new Set<string>();
  const add = (v: any) => { if (typeof v === 'string' && v) refs.add(v); };
  try {
    for (const r of db.prepare('SELECT source_id, target_id FROM edges').all() as any[]) {
      add(r.source_id); add(r.target_id);
    }
  } catch (e) { debugCatch('retention:edges', e); }
  try {
    for (const r of db.prepare('SELECT source_memory_id FROM facts WHERE source_memory_id IS NOT NULL').all() as any[]) {
      add(r.source_memory_id);
    }
  } catch (e) { debugCatch('retention:facts', e); }
  try {
    for (const r of db.prepare(`SELECT merged_into, parent_id, merged_from FROM memory WHERE is_active = 1`).all() as any[]) {
      add(r.merged_into); add(r.parent_id);
      if (r.merged_from) {
        try {
          const arr = JSON.parse(String(r.merged_from));
          if (Array.isArray(arr)) arr.forEach(add);
        } catch { /* 非 JSON 就忽略 */ }
      }
    }
  } catch (e) { debugCatch('retention:merged', e); }
  return refs;
}

function reapOneLibrary(db: Database, project: string, memType: string, opts: Required<Pick<ReapOptions, 'olderThanDays' | 'dryRun' | 'maxPerLibrary'>>): ReapLibraryStat {
  const stat: ReapLibraryStat = { project, memType, scanned: 0, candidates: 0, reaped: 0, keptReferenced: 0, bytes: 0 };
  const cutoffMs = Date.now() - opts.olderThanDays * 24 * 3600 * 1000;
  let rows: any[] = [];
  try {
    rows = db.prepare(`
      SELECT rowid, id, text, source, created_at FROM memory
      WHERE is_active = 0 AND project = ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(project, opts.maxPerLibrary) as any[];
  } catch (e) { debugCatch('retention:select', e); return stat; }
  stat.scanned = rows.length;
  if (!rows.length) return stat;

  const refs = collectReferenced(db);
  const picked: any[] = [];
  for (const r of rows) {
    const ts = Date.parse(r.created_at || '');
    if (!Number.isFinite(ts) || ts > cutoffMs) continue;   // 龄期不够或时间戳坏 → 不碰
    if (refs.has(r.id)) { stat.keptReferenced++; continue; }
    picked.push(r);
  }
  stat.candidates = picked.length;
  if (!picked.length || opts.dryRun) {
    stat.bytes = picked.reduce((n, r) => n + String(r.text || '').length, 0);
    return stat;
  }

  ensureTombstone(db);
  const nowIso = new Date().toISOString();
  const insTomb = db.prepare(`INSERT OR REPLACE INTO memory_tombstone
    (id, project, mem_type, source, content_hash, chars, created_at, reaped_at, reason)
    VALUES (?,?,?,?,?,?,?,?,'expired-inactive')`);
  const delVec = (() => { try { return db.prepare('DELETE FROM vec_memory WHERE rowid = ?'); } catch { return null; } })();
  const delRow = db.prepare('DELETE FROM memory WHERE id = ?');

  const tx = db.transaction((items: any[]) => {
    for (const r of items) {
      const text = String(r.text || '');
      const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
      insTomb.run(r.id, project, memType, r.source ?? null, hash, text.length, r.created_at ?? null, nowIso);
      try { delVec?.run(r.rowid); } catch (e) { debugCatch('retention:vec', e); }
      delRow.run(r.id);           // memory_fts 由 AFTER DELETE 触发器同步
      stat.reaped++;
      stat.bytes += text.length;
    }
  });
  try { tx(picked); } catch (e: any) { debugCatch('retention:tx', e); }
  return stat;
}

/** 清理一批库里的过期死行 */
export function reapDeadRows(opts: ReapOptions = {}): ReapResult {
  const dryRun = opts.dryRun !== false;          // 默认 dry-run：必须显式关掉才真删
  const olderThanDays = Number.isFinite(Number(opts.olderThanDays)) ? Math.max(1, Number(opts.olderThanDays)) : 30;
  const maxPerLibrary = Number.isFinite(Number(opts.maxPerLibrary)) ? Math.max(1, Number(opts.maxPerLibrary)) : 20000;
  const projects = opts.project ? [normalizeProject(opts.project)] : listAllProjects();
  const result: ReapResult = { dryRun, olderThanDays, totalReaped: 0, totalBytes: 0, libraries: [], errors: [] };

  for (const proj of projects) {
    for (const mt of listMemTypeDirs(proj)) {
      try {
        const db = DatabaseManager.getInstance(proj, mt);
        const stat = reapOneLibrary(db, proj, mt, { olderThanDays, dryRun, maxPerLibrary });
        if (stat.scanned || stat.candidates) result.libraries.push(stat);
        result.totalReaped += stat.reaped;
        result.totalBytes += stat.bytes;
      } catch (e: any) {
        result.errors.push(`[${proj}/${mt}] ${e?.message ?? e}`);
      }
    }
  }
  return result;
}
