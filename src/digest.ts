/**
 * digest — 轻量周期任务
 *
 * 职责：
 *   1. 清理过期临时记忆
 *   2. 恢复丢失的 critical 记忆
 *
 * 不负责：
 *   ✗ 合并对话 → reflect 做
 *   ✗ 提纯/升华 → reflect 做
 *
 * 事件驱动：有新对话才跑，间隔 ≥ 1 分钟
 */

import { DatabaseManager, listMemTypeDirs } from './db.js';
import { cleanupExpiredMemories } from './store.js';
import { normalizeProject } from './env.js';

const MIN_DIGEST_GAP_MS = 60 * 1000;
/* v1.19 B6:digest 热闸 per-project —— 原单变量让多库共享消化节奏互相错乱 */
const lastDigestTimeByProject = new Map<string, number>();

export interface DigestResult {
  success: boolean;
  cleaned: number;
  restored: number;
  errors: string[];
  details?: string[];
}

export async function runDigest(characterId: string = 'default', project?: string): Promise<DigestResult> {
  const result: DigestResult = {
    success: true,
    cleaned: 0,
    restored: 0,
    errors: [],
  };

  // 1. 清理过期临时记忆(memdir:遍历项目全部分类库)
  result.cleaned = cleanupExpiredMemories(project);

  // 2. critical 记忆不再无条件复活：inactive 可能代表人工删除、合并删除或跨 memType 迁移墓碑。
  // 只有显式人工恢复接口才能恢复，避免同一 ID 在多个分类库同时 active。

  return result;
}

export function maybeDigest(characterId: string = 'default', project?: string): Promise<DigestResult> | null {
  const now = Date.now();
  const proj = normalizeProject(project);
  const last = lastDigestTimeByProject.get(proj) || 0;
  if (now - last < MIN_DIGEST_GAP_MS) return null;

  let unanalyzed = 0;
  for (const mt of listMemTypeDirs(proj)) {
    try {
      const db = DatabaseManager.getInstance(proj, mt);
      unanalyzed += (db.prepare(`
        SELECT COUNT(*) as c FROM memory
        WHERE is_active = 0 AND source = 'conversation_log'
          AND last_accessed_at = created_at
      `).get() as any)?.c || 0;
    } catch { /* 单分类库失败不阻断其它库 */ }
  }

  if (unanalyzed === 0) return null;

  lastDigestTimeByProject.set(proj, now);
  return runDigest(characterId, project);
}

export function getRecentConversations(characterId: string, hoursBack: number = 24, limit: number = 50, project?: string): any[] {
  const db = DatabaseManager.getInstance(project);
  const since = new Date(Date.now() - hoursBack * 3600000).toISOString();
  const proj = normalizeProject(project);
  return db.prepare(`
    SELECT id, text, created_at, importance
    /* 对话审计带写入时 is_active=0(store.ts saveConversationTurn);
     * 按 is_active=1 过滤会永远查不到新数据(2026-10-17 修)。 */
    FROM memory WHERE source = 'conversation_log' AND project = ?
      AND created_at > ?
    ORDER BY created_at DESC LIMIT ?
  `).all(proj, since, limit) as any[];
}
