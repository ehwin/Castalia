/* routes/lib.js — 共享常量/路径/DB 访问/MCP client/反思历史(供各 route 模块使用) */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');   // routes/ 位于 <root>/viz/routes/,ROOT = <root>(castalia-run 等实例根)
const LEGACY_DB_PATH = process.env.MEMORY_DB_PATH || '';
const CONFIG_PATH = process.env.MEMORY_CONFIG || join(ROOT, 'memory', 'config.json');
const NODE_BIN = process.env.NODE_BIN || (existsSync('D:\\system\\New Folder\\node.exe') ? 'D:\\system\\New Folder\\node.exe' : 'node');
const MCP_SERVER = join(ROOT, 'dist', 'index.js');
const PORT = parseInt(process.env.WEB_PORT || '3345', 10);

// 读 config 前确保 memory/ 目录存在(首次启动自动创建)
mkdirSync(dirname(CONFIG_PATH), { recursive: true });

// 记忆目录:env MEMORY_DB_DIR > config.json db_dir > <项目根>/memory/
function resolveDbDir() {
  if (process.env.MEMORY_DB_DIR) return process.env.MEMORY_DB_DIR;
  try {
    if (existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      if (cfg.db_dir && typeof cfg.db_dir === 'string' && cfg.db_dir.trim()) return cfg.db_dir.trim();
    }
  } catch {}
  return join(ROOT, 'memory');
}
const DB_DIR = resolveDbDir();
const DB_PATH = LEGACY_DB_PATH || join(DB_DIR, 'project-default.sqlite');

// 反思历史记录文件
const REFLECT_HISTORY_PATH = join(DB_DIR, 'reflect_history.jsonl');
const REFLECT_HISTORY_MAX = 200;

/** 追加一条反思历史 */
function appendReflectHistory(entry) {
  try {
    appendFileSync(REFLECT_HISTORY_PATH, JSON.stringify(entry) + '\n', 'utf-8');
    const lines = readFileSync(REFLECT_HISTORY_PATH, 'utf-8').split('\n').filter(l => l.trim());
    if (lines.length > REFLECT_HISTORY_MAX) {
      writeFileSync(REFLECT_HISTORY_PATH, lines.slice(lines.length - REFLECT_HISTORY_MAX).join('\n') + '\n', 'utf-8');
    }
  } catch (e) {
    console.error('[reflect-history] write failed:', e.message);
  }
}

/** 读取反思历史(倒序) */
function readReflectHistory(limit = 20) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  try {
    if (!existsSync(REFLECT_HISTORY_PATH)) return [];
    const lines = readFileSync(REFLECT_HISTORY_PATH, 'utf-8').split('\n').filter(l => l.trim());
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < cap; i--) {
      try { out.push(JSON.parse(lines[i])); } catch {}
    }
    return out;
  } catch (e) {
    console.error('[reflect-history] read failed:', e.message);
    return [];
  }
}

/** 把 reflect 结果规整为历史记录条目 */
function historyEntry(out, projects) {
  const list = out.insightList || [];
  return {
    ts: new Date().toISOString(),
    mode: out.mode,
    projects: out.mode === 'project' ? projects : null,
    dryRun: out.dryRun,
    ok: out.ok === true,
    scanned: out.scanned || { libraries: 0, memories: 0 },
    llm: out.llm || { insights: 0, skipped: 0, saved: 0 },
    errors: out.errors || [],
    insightTexts: list.map(i => (typeof i.text === 'string' ? i.text : '')),
    sources: list.map(i => (Array.isArray(i.sources) ? i.sources : [])),
  };
}

function openDb(readonly = false) {
  if (!existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, readonly ? { readonly: true } : {});
  try { db.pragma('busy_timeout = 5000'); } catch {}
  try { sqliteVec.load(db); } catch (e) { console.error('sqlite-vec load failed:', e.message); }
  return db;
}

// ═══ 嵌入配置 ═══
function loadConfig() {
  let cfg = {};
  if (existsSync(CONFIG_PATH)) {
    try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
  }
  return {
    embedding: {
      mode: 'ollama',
      ollama_url: 'http://127.0.0.1:11436',
      model: 'yuan-embedding-2.0-zh',
      api_url: '', api_key: '', api_model: '',
      ...(cfg.embedding || {}),
    },
    reflect: {
      llm_url: 'https://api.deepseek.com/v1', api_key: '', model: 'deepseek-chat',
      factExtraction: 'auto', maxFacts: 15,
      ...(cfg.reflect || {}),
    },
    triage: {
      llm_url: 'https://api.deepseek.com/v1', api_key: '', model: 'deepseek-chat',
      ...(cfg.triage || {}),
    },
  };
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

// ═══ MCP client:调用 dist/index.js 的反思工具 ═══
function mcpCall(toolName, args = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_BIN, [MCP_SERVER], {
      cwd: ROOT,
      env: {
        ...process.env,
        MEMORY_DB_DIR: DB_DIR,
        ...(LEGACY_DB_PATH ? { MEMORY_DB_PATH: LEGACY_DB_PATH } : {}),
        MEMORY_CONFIG: CONFIG_PATH,
        MCP_TOOLS: process.env.MCP_TOOLS || 'all',
        CASTALIA_KEYS_FILE: join(DB_DIR, 'keys.enc'),
        CASTALIA_KEY_FILE: join(DB_DIR, 'keys.key'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const logPath = join(DB_DIR, 'mcp_call_stderr.log');
    child.stderr.on('data', (d) => { try { appendFileSync(logPath, `[${toolName}] ${d.toString()}`); } catch {} });
    let buf = '';
    let id = 0;
    const pending = {};
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP 调用超时(' + Math.round(timeoutMs / 1000) + 's)')); }, timeoutMs);

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && pending[msg.id]) { pending[msg.id](msg); delete pending[msg.id]; }
        } catch {}
      }
    });
    child.on('exit', () => { clearTimeout(timer); });

    const initId = ++id;
    pending[initId] = () => {
      const callId = ++id;
      pending[callId] = (msg) => {
        clearTimeout(timer);
        child.kill();
        if (msg.error) reject(new Error(msg.error.message || 'MCP error'));
        else resolve(msg.result);
      };
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name: toolName, arguments: args } }) + '\n');
    };
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: initId, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'castalia-web', version: '1.0' } },
    }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  });
}

// ═══ 记忆总成(聚合本机多实例库) ═══
const AGGREGATE_DIRS = (() => {
  const raw = process.env.AGGREGATE_DIRS;
  if (raw) { try { const d = JSON.parse(raw); if (Array.isArray(d) && d.length) return d; } catch {} }
  const cands = [
    { name: 'Hermes', dir: 'D:\\AI\\castalia-run\\memory' },
    { name: 'LobeHub', dir: 'D:\\AI\\lobehub-run\\memory' },
    { name: 'AIRI', dir: 'D:\\AI\\anima-run\\memory' },
    { name: '当前实例', dir: DB_DIR },
  ];
  const seen = new Set();
  return cands.filter(c => c.dir && existsSync(c.dir) && !seen.has(c.dir) && seen.add(c.dir));
})();

function openLibDb(file, readonly = true) {
  if (!existsSync(file)) return null;
  const db = new Database(file, readonly ? { readonly: true } : {});
  try { db.pragma('busy_timeout = 5000'); } catch {}
  try { sqliteVec.load(db); } catch (e) { console.error('sqlite-vec load failed:', e.message); }
  return db;
}

function libFiles() {
  const out = [];
  for (const c of AGGREGATE_DIRS) {
    try {
      for (const f of readdirSync(c.dir)) {
        if (f.startsWith('project-') && f.endsWith('.sqlite')) {
          out.push({ instance: c.name, project: f.slice('project-'.length, -'.sqlite'.length), file: join(c.dir, f) });
          continue;
        }
        const p = join(c.dir, f);
        try {
          if (statSync(p).isDirectory()) {
            for (const sub of readdirSync(p)) {
              const sp = join(p, sub);
              try {
                if (statSync(sp).isDirectory()) {
                  const mp = join(sp, 'memory.sqlite');
                  if (existsSync(mp)) out.push({ instance: c.name, project: f, memType: sub, file: mp });
                } else if (sub.endsWith('.sqlite')) {
                  out.push({ instance: c.name, project: f, file: sp });
                }
              } catch {}
            }
          }
        } catch {}
      }
    } catch {}
  }
  return out;
}

function libFileByProject(project, memType) {
  const lib = libFiles().find(l => l.project === project && (!memType || l.memType === memType));
  return lib || null;
}

function openDbByProject(project, readonly = false, id = null) {
  if (!project) return openDb(readonly);
  const candidates = libFiles().filter(l => l.project === project);
  if (!candidates.length) return null;
  let lib = null;
  if (id) {
    for (const cand of candidates) {
      try {
        const db = new Database(cand.file, { readonly: true });
        const hit = db.prepare('SELECT id FROM memory WHERE id = ?').get(id);
        db.close();
        if (hit) { lib = cand; break; }
      } catch {}
    }
  }
  lib = lib || candidates.find(l => l.memType === 'general') || candidates[0];
  if (!lib || !existsSync(lib.file)) return null;
  const db = new Database(lib.file, readonly ? { readonly: true } : {});
  try { sqliteVec.load(db); } catch (e) { console.error('sqlite-vec load failed:', e.message); }
  return db;
}

function currentInstanceLibs() {
  const self = AGGREGATE_DIRS.find(c => c.dir === DB_DIR);
  const selfName = self ? self.name : null;
  return libFiles().filter(l => selfName ? l.instance === selfName : l.file.startsWith(DB_DIR));
}

function dbDirHasData(dir) {
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (!statSync(p).isDirectory()) {
        if (f === 'global.sqlite' || (f.startsWith('project-') && f.endsWith('.sqlite'))) return true;
        continue;
      }
      for (const sub of readdirSync(p)) {
        const sp = join(p, sub);
        try {
          if (statSync(sp).isDirectory() && existsSync(join(sp, 'memory.sqlite'))) return true;
        } catch {}
      }
    }
  } catch {}
  return false;
}

function safeFilePart(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'default';
}

function libFilePath(project, memType) {
  return join(DB_DIR, safeFilePart(project), safeFilePart(memType || 'general'), 'memory.sqlite');
}

function findLib(instance, project) {
  const libs = libFiles();
  if (instance && project) {
    const exact = libs.find(l => l.instance === instance && l.project === project);
    if (exact) return exact;
  }
  if (project) return libs.find(l => l.project === project) || null;
  return null;
}

function resolveSourceFile(id, fromInstance, fromProject) {
  if (fromInstance || fromProject) {
    const lib = findLib(fromInstance, fromProject);
    if (lib) {
      let db = null;
      try {
        db = openLibDb(lib.file, true);
        if (db && db.prepare('SELECT 1 FROM memory WHERE id = ?').get(id)) return lib.file;
      } catch {} finally { if (db) { try { db.close(); } catch {} } }
    }
  }
  for (const l of libFiles()) {
    let db = null;
    try {
      db = openLibDb(l.file, true);
      if (db && db.prepare('SELECT 1 FROM memory WHERE id = ?').get(id)) return l.file;
    } catch {} finally { if (db) { try { db.close(); } catch {} } }
  }
  return null;
}

function ensureLibSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      project TEXT DEFAULT 'default',
      session_id TEXT,
      type TEXT DEFAULT 'episodic',
      mem_type TEXT DEFAULT 'general',
      category TEXT DEFAULT 'general',
      subcategory TEXT,
      tags TEXT DEFAULT '[]',
      importance REAL DEFAULT 0.5,
      character_id TEXT,
      source TEXT,
      subject TEXT DEFAULT 'user',
      tier TEXT DEFAULT 'standard',
      expires_at DATETIME,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      accessed_count INTEGER DEFAULT 0,
      reference_count INTEGER DEFAULT 0,
      locked INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      project TEXT DEFAULT 'default',
      confidence REAL DEFAULT 0.5,
      source_memory_id TEXT,
      character_id TEXT,
      is_active INTEGER DEFAULT 1,
      accessed_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS categories (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      parent TEXT,
      color TEXT,
      is_parent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS embedding_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text_hash TEXT UNIQUE NOT NULL,
      embedding BLOB NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS instructions (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      project TEXT,
      content TEXT NOT NULL,
      paths TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  try { db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding float[1024])'); } catch (e) { console.error('vec_memory create failed:', e.message); }
  try { db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(embedding float[1024])'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project, is_active)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_memory_mem_type ON memory(mem_type, is_active)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_memory_tier ON memory(tier, is_active)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project, is_active)'); } catch {}
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_spo ON facts(subject, predicate, object, project)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject, is_active)'); } catch {}
}

export {
  ROOT, DB_DIR, DB_PATH, CONFIG_PATH, NODE_BIN, MCP_SERVER, LEGACY_DB_PATH, PORT,
  loadConfig, saveConfig, openDb, openLibDb, openDbByProject,
  AGGREGATE_DIRS, libFiles, libFileByProject, currentInstanceLibs, findLib,
  resolveSourceFile, ensureLibSchema, safeFilePart, libFilePath, dbDirHasData,
  mcpCall, appendReflectHistory, readReflectHistory, historyEntry,
};
