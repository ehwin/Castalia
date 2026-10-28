/**
 * B-1' 前后对比度量（一次性探针，不进回归）
 * 用**已发布的 summarizeForIndex** 跑 761 条活库，比旧实现 text.slice(0,150)+'…'。
 * 只读打开 sqlite（better-sqlite3 直接连，不 import 引擎，避免嵌入空间被声明）。
 *
 * 度量口径：先把样板（"# Label:" 与重复的标题行）剥掉再算"身份词"，
 * 否则 "Project Context" 这类样板三字串会被当成身份词，新实现去掉它反被记成损失。
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { summarizeForIndex } from '../dist/memType.js';

const ROOT = 'D:/AI/castalia/memory-banks/hermes/hermes';
const MTS = ['user', 'feedback', 'project', 'reference', 'general'];
const rows = [];
for (const mt of MTS) {
  const p = `${ROOT}/${mt}/memory.sqlite`;
  if (!fs.existsSync(p)) continue;
  const db = new Database(p, { readonly: true });
  for (const r of db.prepare("SELECT text FROM memory WHERE is_active=1 AND text IS NOT NULL AND text<>''").all()) {
    rows.push({ mt, text: r.text });
  }
  db.close();
}

const stripBoiler = t => {
  let x = (t || '').replace(/^#{1,6}\s*/, '');
  x = x.replace(/^(Project Context|User Profile|Feedback|Reference|General|Memory)\s*[:：]\s*/i, '');
  const parts = x.split(/\n\s*\n/);
  if (parts.length >= 2) {
    const title = parts[0].trim();
    const rest = parts.slice(1).join('\n\n').trim();
    if (title.length >= 8 && rest.startsWith(title.slice(0, Math.min(12, title.length)))) x = rest;
  }
  return x;
};
const clean = s => stripBoiler(s).replace(/[\s，。！？；：、]+/g, '');
const grams = s => {
  const t = clean(s);
  const o = new Set();
  for (let i = 0; i + 3 <= t.length; i++) o.add(t.slice(i, i + 3));
  return o;
};
const gs = rows.map(r => grams(r.text));
const df = new Map();
for (const g of gs) for (const k of g) df.set(k, (df.get(k) || 0) + 1);
const N = rows.length;
const distinctive = g => [...g].filter(k => df.get(k) <= Math.max(3, Math.floor(N / 100))).slice(0, 8);

const oldSum = t => (t.length > 150 ? t.slice(0, 150) + '…' : t);
const boundaryEnd = s => /[。！？；，、：;]…$/.test(s) || /[。！？；]$/.test(s.trimEnd());

function measure(fn, label) {
  let boiler = 0, midcut = 0, cut = 0, chars = 0, empties = 0;
  const loss = [];
  rows.forEach((r, i) => {
    const s = fn(r.text);
    if (!s.trim()) { empties++; return; }
    chars += s.length;
    if (/^#|^(Project Context|User Profile|Feedback|Reference|General)\s*[:：]/i.test(s.trim())) boiler++;
    if (r.text.length > s.length) {
      cut++;
      if (!boundaryEnd(s)) midcut++;
    }
    const d = distinctive(gs[i]);
    if (d.length) {
      const h = grams(s);
      loss.push(1 - d.filter(k => h.has(k)).length / d.length);
    }
  });
  loss.sort((a, b) => a - b);
  const med = loss[Math.floor(loss.length / 2)] || 0;
  const avg = loss.reduce((a, b) => a + b, 0) / (loss.length || 1);
  console.log(`\n${label}`);
  console.log(`  样板开头        ${boiler}/${rows.length} = ${(boiler / rows.length * 100).toFixed(1)}%`);
  console.log(`  被截断          ${cut} 条，其中切在句中 ${midcut} = ${(midcut / Math.max(1, cut) * 100).toFixed(1)}%`);
  console.log(`  头损率          平均 ${(avg * 100).toFixed(1)}%  中位 ${(med * 100).toFixed(1)}%`);
  console.log(`  平均摘要长度    ${(chars / Math.max(1, rows.length - empties)).toFixed(1)} 字  空摘要 ${empties}`);
}

console.log(`活库 hermes: ${rows.length} 条 active`);
measure(oldSum, "【旧】text.slice(0,150)+'…'");
measure(t => summarizeForIndex(t, 150), "【新】summarizeForIndex (B-1')");
