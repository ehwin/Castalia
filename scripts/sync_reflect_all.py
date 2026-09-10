# -*- coding: utf-8 -*-
"""2026-08-16 reflect_all 模块同步到 Anima / 主系统(锚点补丁,保留各自增强)"""
import os, shutil

AI = r'D:\AI\castalia\Castalia-Full'
REPOS = [r'D:\AI\castalia\Castalia-Anima', r'D:\system\AIRI\memory\memory-fused']

main_idx = open(os.path.join(AI, 'src', 'index.ts'), encoding='utf-8').read()
start = main_idx.index("register(\n  'reflect_all', 'admin',")
end = main_idx.index("register(\n  'memory_search_all', 'admin',")
block = main_idx[start:end].rstrip() + "\n"

for repo in REPOS:
    name = os.path.basename(repo.rstrip('\\/ '))
    idx = os.path.join(repo, 'src', 'index.ts')
    s = open(idx, encoding='utf-8').read()

    # 1. import
    if 'runReflectAll' not in s:
        old_imp = "import { resolveFedLibraries, fedTextSearch } from './federation.js';"
        assert old_imp in s, f'[{name}] import 锚点缺失'
        s = s.replace(old_imp, old_imp + "\nimport { runReflectAll } from './reflectAll.js';", 1)

    # 2. TOOL_GROUPS.admin
    tg_section = s.split('TOOL_GROUPS')[1].split(']')[0]
    if 'reflect_all' not in tg_section:
        old_tg = "'project_create', 'memory_search_all', 'instruction_list'"
        assert old_tg in s, f'[{name}] TOOL_GROUPS 锚点缺失'
        s = s.replace(old_tg, "'project_create', 'memory_search_all', 'reflect_all', 'instruction_list'", 1)

    # 3. 注册块(memory_search_all 之前)
    if "  'reflect_all', 'admin'," not in s:
        anchor = "register(\n  'memory_search_all', 'admin',"
        assert anchor in s, f'[{name}] 注册锚点缺失'
        s = s.replace(anchor, block + anchor, 1)

    open(idx, 'w', encoding='utf-8', newline='').write(s)
    shutil.copyfile(os.path.join(AI, 'src', 'reflectAll.ts'), os.path.join(repo, 'src', 'reflectAll.ts'))
    print(f'[OK] {name}: reflectAll.ts + index.ts 补丁')
print('完成')
