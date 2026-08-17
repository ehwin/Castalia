#!/usr/bin/env python3
"""memdir 迁移:旧 project-<name>.sqlite → memory/<project>/<memType>/memory.sqlite
按 mem_type 拆分类(显式 rowid 复制,保 vec_memory 关联)。迁移前请先停桥/托盘。
用法: python scripts/migrate_memdir.py [memory_dir ...]
"""
import os, sys, shutil, sqlite3

MEM_TYPES = ['general', 'user', 'feedback', 'project', 'reference']

def table_ddl(conn, name):
    row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
    return row[0] if row else None

def migrate_dir(memdir):
    print(f"=== {memdir} ===")
    for f in sorted(os.listdir(memdir)):
        if not (f.startswith('project-') and f.endswith('.sqlite')):
            continue
        proj = f[len('project-'):-len('.sqlite')]
        src_path = os.path.join(memdir, f)
        print(f"  迁移 {f} → {proj}/<memType>/memory.sqlite")
        src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
        try:
            src.row_factory = sqlite3.Row
            # 读取源表清单
            tables = [r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
            tables = [t for t in tables if t != 'sqlite_sequence']
            for mt in MEM_TYPES:
                dst_dir = os.path.join(memdir, proj, mt)
                os.makedirs(dst_dir, exist_ok=True)
                dst_path = os.path.join(dst_dir, 'memory.sqlite')
                if os.path.exists(dst_path):
                    os.remove(dst_path)
                dst = sqlite3.connect(dst_path)
                # 复制表结构;vec0 虚拟表(python 无 sqlite-vec 扩展)跳过,由引擎启动建表+batch_embed 补嵌入
                for t in tables:
                    ddl = table_ddl(src, t) or ''
                    if 'VIRTUAL TABLE' in ddl.upper() or 'USING vec0' in ddl:
                        continue
                    if ddl:
                        dst.execute(ddl)
                # 复制 memory 行(按 mem_type 过滤;general = general/NULL/未知)
                if 'memory' in tables:
                    if mt == 'general':
                        rows = src.execute(
                            "SELECT rowid AS _rowid, * FROM memory WHERE is_active=1 AND (mem_type IS NULL OR mem_type='' OR mem_type='general')"
                        ).fetchall()
                    else:
                        rows = src.execute("SELECT rowid AS _rowid, * FROM memory WHERE is_active=1 AND mem_type=?", (mt,)).fetchall()
                    cols = [d['name'] for d in src.execute("PRAGMA table_info(memory)").fetchall()]
                    for r in rows:
                        vals = [r[c] for c in cols]
                        placeholders = ','.join('?' * len(cols))
                        dst.execute(f"INSERT OR REPLACE INTO memory(rowid,{','.join(cols)}) VALUES (?,{placeholders})", [r['_rowid']] + vals)
                    # vec_memory 按 rowid 复制(仅当目标表存在——vec0 虚拟表由引擎重建,此处跳过)
                    if 'vec_memory' in tables and 'vec_memory' in [r[0] for r in dst.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]:
                        ids = [r['_rowid'] for r in rows]
                        if ids:
                            vcols = [d['name'] for d in src.execute("PRAGMA table_info(vec_memory)").fetchall()]
                            ph = ','.join('?' * len(ids))
                            vrows = src.execute(f"SELECT * FROM vec_memory WHERE rowid IN ({ph})", ids).fetchall()
                            for v in vrows:
                                vvals = [v[c] for c in vcols]
                                vph = ','.join('?' * len(vcols))
                                dst.execute(f"INSERT OR REPLACE INTO vec_memory({','.join(vcols)}) VALUES ({vph})", vvals)
                # 复制其他表(edges/facts 等全量,避免丢关联)
                for t in tables:
                    if t in ('memory', 'vec_memory', 'sqlite_sequence'):
                        continue
                    try:
                        dcols = [d['name'] for d in src.execute(f"PRAGMA table_info({t})").fetchall()]
                        drows = src.execute(f"SELECT * FROM {t}").fetchall()
                        for r in drows:
                            vals = [r[c] for c in dcols]
                            ph = ','.join('?' * len(dcols))
                            dst.execute(f"INSERT OR REPLACE INTO {t}({','.join(dcols)}) VALUES ({ph})", vals)
                    except Exception as e:
                        print(f"      (表 {t} 复制跳过: {e})")
                dst.commit()
                n = dst.execute("SELECT COUNT(*) FROM memory").fetchone()[0] if 'memory' in tables else 0
                dst.close()
                print(f"    {mt}: {n} 条")
        finally:
            src.close()
    print()

def main():
    dirs = sys.argv[1:] or [
        r"D:\AI\castalia-run\memory",
        r"D:\AI\lobehub-run\memory",
        r"D:\AI\anima-run\memory",
    ]
    for d in dirs:
        if os.path.isdir(d):
            migrate_dir(d)
    print("迁移完成")

if __name__ == '__main__':
    main()
