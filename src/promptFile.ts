/**
 * 提示词文件覆盖(共享模块) -- 让**单个实例/项目**用自己的反思提示词,而无需改动源码:
 *   REFLECT_PROMPT_FILE        日常反思 system prompt (reflectDriver + reflect 两条路径共用)
 *   REFLECT_DEEP_PROMPT_FILE   深度校准 system prompt
 *   CONSOLIDATE_PROMPT_FILE    记忆整合 system prompt
 * 相对路径先按 MEMORY_CONFIG 所在目录解析,再回退 cwd;读不到则回退内置提示词(打一行 stderr)。
 */
import fs from 'node:fs';
import path from 'node:path';

const _promptFileCache = new Map<string, string>();

export function loadPromptOverride(envKey: string, builtin: string): string {
  const raw = (process.env[envKey] || '').trim();
  if (!raw) return builtin;
  const hit = _promptFileCache.get(envKey);
  if (hit) return hit;
  const baseDir = process.env.MEMORY_CONFIG ? path.dirname(process.env.MEMORY_CONFIG) : process.cwd();
  const candidates = path.isAbsolute(raw)
    ? [raw]
    : [path.join(baseDir, raw), path.join(process.cwd(), raw)];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const text = fs.readFileSync(p, 'utf-8').trim();
        if (text) {
          console.error(`[prompt] ${envKey} -> ${p} (${text.length} chars)`);
          _promptFileCache.set(envKey, text);
          return text;
        }
      }
    } catch { /* try next candidate */ }
  }
  console.error(`[prompt] ${envKey} unreadable (${candidates.join(' | ')}), using builtin prompt`);
  return builtin;
}
