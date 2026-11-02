#!/usr/bin/env node
/**
 * 死行收割 CLI（v1.29）。默认 dry-run；只有 --apply 才真删。
 *
 *   node scripts/reap_dead_rows.mjs                      # 全库 dry-run（30 天龄期）
 *   node scripts/reap_dead_rows.mjs --apply --project hermes
 *   node scripts/reap_dead_rows.mjs --older-than 60 --apply
 *
 * 删除前请确认有库快照（正文回滚只能从快照取，墓碑只留哈希）。
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const apply = argv.includes('--apply');
const project = flag('--project', undefined);
const olderThanDays = Number(flag('--older-than', 30));
const maxPerLibrary = Number(flag('--max', 20000));

const { reapDeadRows } = await import(pathToFileURL(path.join(ROOT, 'dist', 'retention.js')).href);
const t0 = Date.now();
const r = reapDeadRows({ project, olderThanDays, maxPerLibrary, dryRun: !apply });
const ms = Date.now() - t0;

const sizeMB = (bytes) => (bytes / 1048576).toFixed(2);
console.log(`== ${r.dryRun ? 'DRY-RUN' : 'APPLY'} · 龄期 >= ${r.olderThanDays} 天 · ${ms}ms ==`);
console.log('库', '扫描', '可收割', '已收割', '因引用保留', 'MB');
for (const l of r.libraries.sort((a, b) => b.candidates - a.candidates).slice(0, 15)) {
  console.log(`${l.project}/${l.memType}`.padEnd(22), String(l.scanned).padStart(6), String(l.candidates).padStart(7),
    String(l.reaped).padStart(7), String(l.keptReferenced).padStart(9), sizeMB(l.bytes).padStart(7));
}
console.log(`合计：可收割/已收割 ${r.totalReaped} 行，正文 ${sizeMB(r.totalBytes)} MB，库数 ${r.libraries.length}`);
if (r.errors.length) console.log('errors:', r.errors.slice(0, 5));
