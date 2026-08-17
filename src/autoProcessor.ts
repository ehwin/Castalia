/**
 * AutoProcessor — 对话轮次自动处理
 *
 * 职责：把一轮对话保存为 conversation_log 记忆，并触发消化周期。
 * 消息管道不阻塞（同步部分仅 SQLite 写入，毫秒级）。
 */

import { saveConversationTurn } from './store.js';
import { maybeDigest } from './digest.js';
import { getBuffer } from './buffer.js';
import { PROJECT_ID } from './env.js';

export async function autoProcess(args: {
  userMessage: string;
  assistantMessage: string;
  moodValue?: number;
  moodReason?: string;
  characterId?: string;
  project?: string;
  sessionId?: string;  // v1.11 Part2: 会话 ID — 传了才启用会话记忆缓冲(渐进式临时反思),不传保持旧行为
}): Promise<any> {
  const cid = args.characterId || 'default';
  const proj = args.project || PROJECT_ID;
  const results: any = {
    success: true,
    conversationSaved: false,
    details: [] as string[],
  };

  try {
    await saveConversationTurn(args.userMessage, args.assistantMessage, cid, args.moodValue, args.moodReason, proj);
    results.conversationSaved = true;
    results.details.push('conversation saved');
  } catch (e: any) {
    results.details.push('save error: ' + e.message);
  }

  // v1.11 Part2: 会话记忆缓冲 — sessionId 可选;不传 → 不启用,保持向后兼容。
  // 每轮对话入缓冲,累计 BUFFER_SIZE 轮后后台异步增量反思(不阻塞)。
  if (args.sessionId && String(args.sessionId).trim()) {
    try {
      getBuffer(proj, String(args.sessionId).trim(), cid).onNewMessage([
        { role: 'user', content: args.userMessage },
        { role: 'assistant', content: args.assistantMessage },
      ]);
      results.details.push('session buffer +1');
    } catch (e: any) {
      results.details.push('session buffer error: ' + e.message);
    }
  }

  // 事件驱动 digest(不阻塞)
  try {
    maybeDigest(cid, proj)?.catch(() => {});
    results.details.push('digest triggered');
  } catch {
    /* noop */
  }

  return results;
}
