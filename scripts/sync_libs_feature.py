# -*- coding: utf-8 -*-
"""2026-08-16 多库互通特性:同源补丁同步到 Anima / 主系统 memory-fused(保留各自情感增强)"""
import os, sys, shutil

AI = r'D:\AI\castalia\Castalia-Full'
REPOS = [r'D:\AI\castalia\Castalia-Anima', r'D:\system\AIRI\memory\memory-fused']

def rd(p):
    with open(p, 'r', encoding='utf-8') as f:
        return f.read()

def wr(p, s):
    with open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(s)

def patch_file(path, old, new, tag):
    s = rd(path)
    if old not in s:
        print(f'  [FAIL] {tag}: 锚点未找到 -> {path}')
        sys.exit(1)
    if new in s and old != new:
        print(f'  [SKIP] {tag}: 已包含新内容')
        return
    wr(path, s.replace(old, new, 1))
    print(f'  [OK] {tag}')

SHARED_BLOCK = """
/**
 * 共享层项目名(约定,2026-08-16):存进该库的记忆为"所有库共知"候选。
 * 引擎不做隐式合并 —— 互通语义由上层/调用方显式决定(接口先行,规则待定)。
 */
export const SHARED_PROJECT: string = process.env.SHARED_PROJECT || 'shared';
"""

CURRENT_MEM_DIR = """
/** 当前实例的 memory 目录(供联邦搜索/聚合层使用) */
export function currentMemDir(): string {
  return memDir();
}
"""

SEARCH_ACROSS = """
/**
 * 跨库搜索(多项目合并,2026-08-16) — 显式语义:
 * 调用方明确指定要搜哪些库(projects),引擎不做隐式合并/共享魔法;
 * 互通规则由上层决定(接口先行)。结果按 score 降序,每行 project 标注来源库。
 * projects=['*'] 或 ['all'] → 本实例全部库(扫描 memory 目录)。
 */
export async function searchMemoryAcross(options: SearchOptions & { projects?: string[] }): Promise<SearchResult[]> {
  const raw = (options.projects ?? []).map(x => (x ?? '').trim()).filter(Boolean);
  const targetProjects = raw.length === 0
    ? [normalizeProject(options.project)]
    : raw.some(x => x === '*' || x === 'all')
      ? listProjectNames()
      : raw.map(normalizeProject);

  const perProject = Math.max(3, Math.ceil((options.topK ?? 10) * 1.5));
  const all: SearchResult[] = [];
  for (const proj of targetProjects) {
    try {
      const r = await searchMemory({ ...options, project: proj, topK: perProject });
      all.push(...r);
    } catch {
      // 单个库失败不影响其他库
    }
  }
  all.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const r of all) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    unique.push(r);
  }
  return unique.slice(0, options.topK ?? 10);
}
"""

NEW_TOOLS = """
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

register(
  'memory_search_all', 'admin',
  'Federation search interface (read-only): search this instance\\'s libraries plus any external instances listed in FEDERATION_DIRS env ([{"name":"...","dir":"..."},...]). Explicit semantics — the engine does NOT merge libraries automatically; the caller decides interop policy. Results carry "instance" and "project".',
  {
    query: z.string().describe('Query text'),
    topK: z.number().optional().describe('Max results per library (default 5)'),
    mode: z.enum(['text', 'vector']).optional().describe('text = LIKE substring search (default); vector = reserved for sqlite-vec KNN (falls back to text in this build)'),
  },
  async (args) => {
    try {
      const libs = resolveFedLibraries(currentMemDir());
      const topK = args.topK ?? 5;
      const results = fedTextSearch(libs, args.query, topK);
      return ok({
        op: 'memory_search_all',
        query: args.query,
        libraries: libs.length,
        mode: args.mode === 'vector' ? 'text_fallback' : 'text',
        count: results.length,
        results: results.map(r => ({
          instance: r.instance,
          project: r.project,
          id: r.id,
          text: r.text,
          score: r.score,
          createdAt: r.createdAt,
        })),
        hint: '接口先行:互通语义未定,引擎不自动合并库。FEDERATION_DIRS 配置参与联邦的外部实例目录。',
      });
    } catch (e: any) { return err(e.message, 'FEDERATION_FAILED'); }
  }
);
"""

for repo in REPOS:
    name = os.path.basename(repo.rstrip('\\/ ')) or repo
    print(f'=== {name} ===')

    # 1. env.ts: SHARED_PROJECT
    patch_file(os.path.join(repo, 'src', 'env.ts'),
               "export const PROJECT_ID: string = process.env.CASTALIA_PROJECT || 'default';",
               "export const PROJECT_ID: string = process.env.CASTALIA_PROJECT || 'default';" + SHARED_BLOCK,
               'env.ts SHARED_PROJECT')

    # 2. db.ts: currentMemDir
    db_path = os.path.join(repo, 'src', 'db.ts')
    db_s = rd(db_path)
    anchor = "    .map(f => f.slice('project-'.length, -'.sqlite'.length));\n}"
    if anchor in db_s and 'currentMemDir' not in db_s:
        wr(db_path, db_s.replace(anchor, anchor + CURRENT_MEM_DIR, 1))
        print('  [OK] db.ts currentMemDir')
    elif 'currentMemDir' in db_s:
        print('  [SKIP] db.ts currentMemDir')
    else:
        print('  [FAIL] db.ts 锚点未找到'); sys.exit(1)

    # 3. search.ts: import + searchMemoryAcross
    patch_file(os.path.join(repo, 'src', 'search.ts'),
               "import { DatabaseManager } from './db.js';",
               "import { DatabaseManager, listProjectNames } from './db.js';",
               'search.ts import listProjectNames')
    search_path = os.path.join(repo, 'src', 'search.ts')
    search_s = rd(search_path)
    end_anchor = "  updateAccessed(db, unique.slice(0, topK));\n  return unique.slice(0, topK);\n}"
    if 'searchMemoryAcross' not in search_s:
        if end_anchor not in search_s:
            print('  [FAIL] search.ts 函数结尾锚点未找到'); sys.exit(1)
        wr(search_path, search_s.replace(end_anchor, end_anchor + '\n' + SEARCH_ACROSS, 1))
        print('  [OK] search.ts searchMemoryAcross')
    else:
        print('  [SKIP] search.ts searchMemoryAcross')

    # 4. federation.ts: 复制新文件
    shutil.copyfile(os.path.join(AI, 'src', 'federation.ts'), os.path.join(repo, 'src', 'federation.ts'))
    print('  [OK] federation.ts 复制')

    # 5. index.ts 补丁
    idx = os.path.join(repo, 'src', 'index.ts')
    patch_file(idx,
               "import { searchMemory, searchFacts, getRecentMemories } from './search.js';",
               "import { searchMemory, searchFacts, getRecentMemories, searchMemoryAcross } from './search.js';",
               'index.ts import searchMemoryAcross')
    patch_file(idx,
               "import { DatabaseManager, listProjectNames, sweepExpiredSessionMemories } from './db.js';",
               "import { DatabaseManager, listProjectNames, safeFilePart, currentMemDir, sweepExpiredSessionMemories } from './db.js';",
               'index.ts import safeFilePart/currentMemDir')
    patch_file(idx,
               "import { MEM_TYPES, MEM_TYPE_LABELS, summarizeForIndex } from './memType.js';",
               "import { MEM_TYPES, MEM_TYPE_LABELS, summarizeForIndex } from './memType.js';\nimport { resolveFedLibraries, fedTextSearch } from './federation.js';",
               'index.ts import federation')
    patch_file(idx,
               "'project_list', 'instruction_list'",
               "'project_list', 'project_create', 'memory_search_all', 'instruction_list'",
               'index.ts TOOL_GROUPS')

    # memory_search handler:保留 charFor(单库路径),跨库不带 characterId
    old_handler = "const r = await searchMemory({ query: args.query, topK: args.topK ?? 5, profile: 'balanced', category: args.category, memType: args.memType, characterId: charFor(args.project), project: args.project });"
    new_handler = "const r = args.projects && args.projects.length > 0\n        ? await searchMemoryAcross({ query: args.query, topK: args.topK ?? 5, category: args.category, memType: args.memType, projects: args.projects })\n        : await searchMemory({ query: args.query, topK: args.topK ?? 5, profile: 'balanced', category: args.category, memType: args.memType, characterId: charFor(args.project), project: args.project });"
    patch_file(idx, old_handler, new_handler, 'index.ts memory_search 跨库分支')
    # schema 加 projects 参数
    patch_file(idx,
               "    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or \"default\")'),\n  },",
               "    project: z.string().optional().describe('Project namespace (default: CASTALIA_PROJECT env or \"default\")'),\n    projects: z.array(z.string()).optional().describe('Cross-library search: search several libraries in one call (e.g. [\"default\",\"shushu\"]). \"*\" or [\"all\"] = every library of this instance. Omit for single-library search. Each result carries its source library in \"project\".'),\n  },",
               'index.ts memory_search projects 参数')
    # 新工具插入(project_list 之后)
    patch_file(idx,
               "    } catch (e: any) { return err(e.message, 'PROJECT_LIST_FAILED'); }\n  }\n);",
               "    } catch (e: any) { return err(e.message, 'PROJECT_LIST_FAILED'); }\n  }\n);\n" + NEW_TOOLS,
               'index.ts project_create + memory_search_all')

    # 6. smoke_test.py(仅 Anima 有)
    smoke = os.path.join(repo, 'scripts', 'smoke_test.py')
    if os.path.exists(smoke):
        patch_file(smoke,
                   "NODE = shutil.which('node') or r\"D:\\system\\New Folder\\node.exe\"  # fallback:本机 node",
                   "NODE137 = r\"D:\\system\\New Folder\\node.exe\"  # better-sqlite3/sqlite-vec 按 NODE_MODULE_VERSION 137 编译\nNODE = NODE137 if os.path.exists(NODE137) else (shutil.which('node') or NODE137)  # PATH 第一个可能是 Hermes 127,会 ABI 崩溃",
                   'smoke_test.py NODE137')

print('\n=== 全部补丁完成 ===')
