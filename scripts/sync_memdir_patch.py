#!/usr/bin/env python3
"""memdir 架构同步:把通用版(ai-memory)的 memdir 改造移植到 Anima/主系统(保留各自情感/独有内容)。
用法: python scripts/sync_memdir_patch.py <target_src_dir>
"""
import sys, re

GEN = r"D:\AI\castalia\Castalia-Full\src"

def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()

def write(p, s):
    with open(p, 'w', encoding='utf-8', newline='\n') as f:
        f.write(s)

def extract_function(src, name):
    """提取 src 中名为 name 的函数(从 'export function/async function name' 到配对大括号)"""
    m = re.search(rf'(export (?:async )?function {name}\b.*?)(?=\nexport |\n// ═|\n/\*\*|\nregister\(|\Z)', src, re.S)
    return m.group(1) if m else None

def replace_function(text, name, new_fn):
    """用 new_fn 替换 text 中同名函数"""
    pat = re.compile(rf'export (?:async )?function {name}\b.*?(?=\nexport |\n// ═|\n/\*\*|\nregister\(|\Z)', re.S)
    if not pat.search(text):
        return None, f"未找到函数 {name}"
    return pat.sub(lambda m: new_fn.rstrip(), text, count=1), None

def sync_file(target, fname, funcs, extra=None):
    gen_path = rf"{GEN}\{fname}"
    tgt_path = rf"{target}\{fname}"
    gen_src = read(gen_path)
    tgt_src = read(tgt_path)
    orig = tgt_src
    report = []
    for fn in funcs:
        new_fn = extract_function(gen_src, fn)
        if not new_fn:
            report.append(f"  ⚠️ 通用版无函数 {fn}")
            continue
        tgt_src, err = replace_function(tgt_src, fn, new_fn)
        if err:
            report.append(f"  ⚠️ {fn}: {err}")
        else:
            report.append(f"  ✅ {fn} 已同步")
    if extra:
        for old, new, note in extra:
            if old in tgt_src:
                tgt_src = tgt_src.replace(old, new, 1)
                report.append(f"  ✅ {note}")
            else:
                report.append(f"  ⚠️ {note}: 锚点未匹配")
    if tgt_src != orig:
        write(tgt_path, tgt_src)
    print(f"=== {fname} ===")
    for r in report:
        print(r)

def main():
    target = sys.argv[1] if len(sys.argv) > 1 else r"D:\AI\castalia\Castalia-Anima\src"
    print(f"目标: {target}\n")

    # db.ts / federation.ts:无情感差异,直接复制
    for f in ['db.ts', 'federation.ts']:
        write(rf"{target}\{f}", read(rf"{GEN}\{f}"))
        print(f"=== {f} === 直接复制 ✅")

    # store.ts:锚点替换(保留 emotionalImpact/recordTopics)
    sync_file(target, 'store.ts',
        ['forgetMemory', 'restoreMemory', 'updateMemory', 'promoteToProject'],
        extra=[
            ("import { DatabaseManager, generateId } from './db.js';",
             "import { DatabaseManager, generateId, listMemTypeDirs } from './db.js';\nimport type Database from 'better-sqlite3';",
             "import 补 listMemTypeDirs+Database"),
            ("  const db = DatabaseManager.getInstance(params.project);",
             "  // memdir 路由:按 memType 落对应分类库(memory/<project>/<memType>/memory.sqlite)\n  const db = DatabaseManager.getInstance(params.project, params.memType);",
             "saveMemory memdir 路由"),
        ])

    # search.ts:锚点替换聚合函数(保留情感评分)
    sync_file(target, 'search.ts',
        ['searchMemory', 'getRecentMemories'],
        extra=[
            ("import { DatabaseManager, listProjectNames } from './db.js';",
             "import { DatabaseManager, listProjectNames, listMemTypeDirs } from './db.js';",
             "import 补 listMemTypeDirs"),
            ("import { MemType } from './memType.js';",
             "import { MemType, normalizeMemType } from './memType.js';\nimport type Database from 'better-sqlite3';",
             "import 补 normalizeMemType+Database"),
        ])

    # reflect.ts:listAllMemories 聚合
    sync_file(target, 'reflect.ts',
        ['listAllMemories'],
        extra=[
            ("import { DatabaseManager } from './db.js';",
             "import { DatabaseManager, listMemTypeDirs } from './db.js';",
             "import 补 listMemTypeDirs"),
        ])

    # index.ts:stats_get/memory_get/project_list 聚合 + import
    sync_file(target, 'index.ts', [],
        extra=[
            ("import { DatabaseManager, listProjectNames, safeFilePart, currentMemDir, sweepExpiredSessionMemories } from './db.js';",
             "import { DatabaseManager, listProjectNames, listMemTypeDirs, safeFilePart, currentMemDir, sweepExpiredSessionMemories } from './db.js';",
             "import 补 listMemTypeDirs"),
        ])
    print("\n⚠️ index.ts 的 stats_get/memory_get/project_list 聚合需手工核对(目标版有独有工具,函数边界可能不同)")
    print("  检查点: ①stats_get 应遍历 listMemTypeDirs ②memory_get 按 id 遍历分类库 ③project_list 聚合统计")

if __name__ == '__main__':
    main()
