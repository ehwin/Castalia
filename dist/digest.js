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
/* v1.19 B6:digest 热闸 per-project */
const lastDigestTimeByProject = new Map();
export async function runDigest(characterId = 'default', project) {
    const result = {
        success: true,
        cleaned: 0,
        restored: 0,
        errors: [],
    };
    // 1. 清理过期临时记忆(memdir:遍历项目全部分类库)
    result.cleaned = cleanupExpiredMemories(project);
    // 2. 恢复被误标记的 critical 记忆(memdir:遍历项目全部分类库)
    const proj = normalizeProject(project);
    for (const mt of listMemTypeDirs(proj)) {
        try {
            const db = DatabaseManager.getInstance(proj, mt);
            const lostCritical = db.prepare(`
        UPDATE memory SET is_active = 1
        WHERE tier = 'critical' AND is_active = 0
      `).run();
            result.restored += lostCritical.changes;
        }
        catch (e) {
            result.errors.push('restore critical: ' + e.message);
        }
    }
    return result;
}
export function maybeDigest(characterId = 'default', project) {
    const now = Date.now();
    const proj = normalizeProject(project);
    const last = lastDigestTimeByProject.get(proj) || 0;
    if (now - last < MIN_DIGEST_GAP_MS)
        return null;
    const db = DatabaseManager.getInstance(project);
    const unanalyzed = db.prepare(`
    SELECT COUNT(*) as c FROM memory
    WHERE is_active = 0 AND source = 'conversation_log'  /* v1.19 分隔带 */
      AND last_accessed_at = created_at
  `).get()?.c || 0;
    if (unanalyzed === 0)
        return null;
    lastDigestTimeByProject.set(proj, now);
    return runDigest(characterId, project);
}
export function getRecentConversations(characterId, hoursBack = 24, limit = 50, project) {
    const db = DatabaseManager.getInstance(project);
    const since = new Date(Date.now() - hoursBack * 3600000).toISOString();
    const proj = normalizeProject(project);
    return db.prepare(`
    SELECT id, text, created_at, importance
    FROM memory WHERE is_active = 1
      AND source = 'conversation_log' AND project = ?
      AND created_at > ?
    ORDER BY created_at DESC LIMIT ?
  `).all(proj, since, limit);
}
