/**
 * ProcessClaims —— 跨进程的持久游标 + 租约式 claim（记忆体层，不含情感/psyche）
 *
 * 两份报告里"自循环"的可靠性与情感无关，是这个仓库同样缺的：
 *
 *   - 游标必须是 (created_at, rowid) 的有序对，不能用 id 字符串比较
 *     （旧实现的 `m.id > cursor` 在 id 交错时既会重复处理也会漏行）；
 *   - 处理前先 claim，claim 写进库、带过期时间，进程被杀后由下一轮回收（stale reclaim）；
 *   - 同一批证据在同一时刻只能有一个执行者 —— 本机多个桥各起一个引擎进程，这是实际场景；
 *   - 读-判-写全部在 `BEGIN IMMEDIATE` 内完成，避免两个进程同时读到"没人处理"。
 *
 * 表落在项目 general 库（与 projects 表同级），语义是项目级调度元数据，不是记忆。
 */

import { DatabaseManager } from './db.js';
import { normalizeProject } from './env.js';

export interface ProcessCursor {
  createdAt: string;
  rowid: number;
  /** 跨库扫描的次级排序（memType）。同 created_at + 不同库时 rowid 不可比较，必须带这个。 */
  tag?: string;
}

export interface ClaimArgs {
  project?: string;
  kind: string;
  owner: string;
  keys: string[];
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function projectDb(project?: string): any {
  return DatabaseManager.getInstance(normalizeProject(project));
}

export function ensureProcessTables(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS process_claim (
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      evidence_key TEXT NOT NULL,
      owner TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (project, kind, evidence_key)
    );
    CREATE TABLE IF NOT EXISTS process_cursor (
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      last_created_at TEXT NOT NULL,
      last_rowid INTEGER NOT NULL,
      last_tag TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project, kind)
    );
  `);
}

/**
 * 取一批 claim。返回"现在归我处理"的 key 列表：
 *   - 没人持有 → 取到；
 *   - 我自己持有且未过期 → 续期并继续（重试幂等）；
 *   - 别人持有且未过期 → 跳过；
 *   - 别人持有但已过期 → 回收（stale reclaim）。
 */
export function claimBatch(args: ClaimArgs): string[] {
  const keys = [...new Set((args.keys || []).filter(k => typeof k === 'string' && k.trim()))].sort();
  if (!keys.length) return [];
  const db = projectDb(args.project);
  ensureProcessTables(db);
  const proj = normalizeProject(args.project);
  const ttl = args.ttlMs && args.ttlMs > 0 ? args.ttlMs : DEFAULT_TTL_MS;
  const now = Date.now();
  const claimedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttl).toISOString();

  const select = db.prepare(
    `SELECT owner, expires_at FROM process_claim WHERE project = ? AND kind = ? AND evidence_key = ?`,
  );
  const upsert = db.prepare(`
    INSERT INTO process_claim (project, kind, evidence_key, owner, claimed_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, kind, evidence_key) DO UPDATE SET
      owner = excluded.owner,
      claimed_at = excluded.claimed_at,
      expires_at = excluded.expires_at
    WHERE process_claim.owner = excluded.owner
       OR process_claim.expires_at < excluded.claimed_at
  `);

  const tx = db.transaction((list: string[]) => {
    const mine: string[] = [];
    for (const key of list) {
      const row = select.get(proj, args.kind, key) as any;
      if (row && row.owner !== args.owner && String(row.expires_at) >= claimedAt) continue;
      const res = upsert.run(proj, args.kind, key, args.owner, claimedAt, expiresAt);
      if (res.changes > 0) mine.push(key);
    }
    return mine;
  });
  return (tx.immediate as any)(keys) as string[];
}

/** 处理结束（成功或确定不再重试）：释放自己持有的 claim */
export function completeClaims(args: Omit<ClaimArgs, 'ttlMs'>): number {
  const keys = (args.keys || []).filter(Boolean);
  if (!keys.length) return 0;
  const db = projectDb(args.project);
  ensureProcessTables(db);
  const proj = normalizeProject(args.project);
  const del = db.prepare(
    `DELETE FROM process_claim WHERE project = ? AND kind = ? AND evidence_key = ? AND owner = ?`,
  );
  const tx = db.transaction((list: string[]) => {
    let n = 0;
    for (const key of list) n += del.run(proj, args.kind, key, args.owner).changes;
    return n;
  });
  return (tx.immediate as any)(keys) as number;
}

/**
 * 处理失败但希望立刻交给下一轮：删掉自己的 claim。
 * 与 completeClaims 的差别只在语义（一个"做完了"，一个"没做成"）；库里的状态一致，
 * 因为失败必须能被重新取到，否则证据会被永久卡在一台已经放弃的进程名下。
 */
export function releaseClaims(args: Omit<ClaimArgs, 'ttlMs'>): number {
  return completeClaims(args);
}

export function getCursor(project: string | undefined, kind: string): ProcessCursor | null {
  const db = projectDb(project);
  ensureProcessTables(db);
  const row = db.prepare(
    `SELECT last_created_at, last_rowid, last_tag FROM process_cursor WHERE project = ? AND kind = ?`,
  ).get(normalizeProject(project), kind) as any;
  if (!row) return null;
  return { createdAt: String(row.last_created_at), rowid: Number(row.last_rowid), tag: row.last_tag ?? undefined };
}

export function setCursor(project: string | undefined, kind: string, cursor: ProcessCursor): void {
  const db = projectDb(project);
  ensureProcessTables(db);
  db.prepare(`
    INSERT INTO process_cursor (project, kind, last_created_at, last_rowid, last_tag, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, kind) DO UPDATE SET
      last_created_at = excluded.last_created_at,
      last_rowid = excluded.last_rowid,
      last_tag = excluded.last_tag,
      updated_at = excluded.updated_at
  `).run(
    normalizeProject(project), kind, String(cursor.createdAt), Number(cursor.rowid),
    cursor.tag ?? null, new Date().toISOString(),
  );
}

/** 观测用：当前活跃/过期 claim 数（报告要求的 claim reclaim 可观测性） */
export function claimStats(project: string | undefined, kind: string): { active: number; stale: number } {
  const db = projectDb(project);
  ensureProcessTables(db);
  const nowIso = new Date().toISOString();
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN expires_at >= ? THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN expires_at <  ? THEN 1 ELSE 0 END) AS stale
    FROM process_claim WHERE project = ? AND kind = ?
  `).get(nowIso, nowIso, normalizeProject(project), kind) as any;
  return { active: Number(row?.active || 0), stale: Number(row?.stale || 0) };
}

/** 进程级 owner 标识：同一进程内复用，跨进程天然不同 */
export function processOwner(): string {
  return `pid${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
}
