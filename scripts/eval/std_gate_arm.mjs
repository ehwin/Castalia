#!/usr/bin/env node
/**
 * 单个评测臂：在给定的库副本上跑一批查询，记录每个查询返回了哪些候选。
 *
 * 为什么要独立副本：检索会写 accessed_count / last_accessed_at，共用副本会污染
 * 后续臂（论文项目里因此作废过一整轮）。所以每个臂由调用方准备一份新副本。
 *
 * 用法：node scripts/eval/std_gate_arm.mjs --bank <MEMORY_DB_DIR> --pairs <pairs_v5_gate.json>
 *        --project airi --floor 0.15 --topk 3
 * 输出：stdout JSON {floor, project, fired, items:[{id, cell, cands:[{id,sim,score}]}]}
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const arg = (k, d = '') => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const BANK = arg('bank');
const PAIRS = arg('pairs');
const PROJECT = arg('project', 'airi');
const FLOOR = parseFloat(arg('floor', '0'));
const TOPK = parseInt(arg('topk', '3'), 10);

if (!BANK || !PAIRS) { console.error('需要 --bank 与 --pairs'); process.exit(2); }

process.env.MEMORY_DB_DIR = BANK;
process.env.CASTALIA_PROJECT = PROJECT;
process.env.CHAR_ID = PROJECT;
process.env.EMBED_MODE = 'none';          // 论文该库是 lexical-only
process.env.MCP_LOG_TOOLS = '0';
process.env.CASTALIA_BACKGROUND_TASKS = '0';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const { searchMemory } = await import(pathToFileURL(path.join(ROOT, 'dist', 'search.js')).href);

const data = JSON.parse(fs.readFileSync(PAIRS, 'utf8'));
const out = { floor: FLOOR, project: PROJECT, topK: TOPK, fired: 0, items: [] };

for (const it of data.items) {
  let cands = [];
  try {
    const r = await searchMemory({
      query: it.text, project: PROJECT, profile: 'balanced', topK: TOPK, simFloor: FLOOR,
    });
    cands = r.map(x => ({ id: x.id, sim: x.similarity, score: x.score }));
  } catch (e) {
    cands = [{ error: String(e.message || e).slice(0, 120) }];
  }
  if (cands.length) out.fired++;
  out.items.push({ id: it.id, cell: it.cell, cands });
}

process.stdout.write(JSON.stringify(out));
