/**
 * 调试级日志（v1.26）—— 给「防御性降级」的空 catch 一条可观察的出口
 *
 * 背景：引擎里有 60+ 处 `catch {}`，语义都是「附属操作失败不阻塞主操作」
 * （迁移 DDL 撞已存在列、缓存写不进去、向量表还没建……）。这在正常路径上是对的，
 * 但代价是出问题时**完全没有痕迹**：TECHNICAL.md §12 把它列成已知限制。
 *
 * 取舍：
 * - **默认静默**：这些 catch 每秒可能撞无数次（检索时刷新访问计数就会碰 vec 表），
 *   默认打印会把 stdio 管道刷满，还会拖慢主路径。所以只在显式开调试时输出。
 * - **一个开关**：`CASTALIA_DEBUG=1`（或 `DEBUG` 里含 castalia）。不引入日志框架、
 *   不分级、不落文件 —— 这个引擎的日志出口本来就是 stderr。
 * - **绝不抛错**：debugCatch 自己失败也只是吞掉。它是取证用的，不是主路径的一部分。
 * - **不做缓存**：每次读 env。一个字符串比较的开销远小于"改了环境变量日志却不生效"
 *   带来的排查成本（测试也依赖这个行为）。
 */

function debugEnabled(): boolean {
  const d = String(process.env.CASTALIA_DEBUG || '').toLowerCase();
  if (d === '1' || d === 'true' || d === 'yes' || d === 'on') return true;
  return String(process.env.DEBUG || '').toLowerCase().includes('castalia');
}

/** 记一条被吞掉的错误（仅在 CASTALIA_DEBUG 打开时输出） */
export function debugCatch(where: string, e?: unknown): void {
  if (!debugEnabled()) return;
  try {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : (e === undefined ? '' : String(e));
    console.error(`[debug] ${where}${msg ? ' — ' + msg : ''}`);
  } catch {
    /* 日志本身失败不影响主路径 */
  }
}

/** 记一条调试信息（同开关；用来解释「为什么跳过了/退化成了什么」） */
export function debugLog(where: string, ...args: unknown[]): void {
  if (!debugEnabled()) return;
  try {
    console.error(`[debug] ${where}`, ...args);
  } catch {
    /* 同上 */
  }
}
