/**
 * Memory Database Manager
 * SQLite + sqlite-vec with Alaya-compatible schema
 *
 * v6.0: 单库 → 按项目分库(物理隔离)
 *   - global.sqlite             : L1(global)/L2(user) 指令 + rule 规则组 + 项目注册表(projects)
 *   - project-<name>.sqlite     : 每项目一个库,含全部业务表 + L3(scope=project) 指令
 *   目录:env MEMORY_DB_DIR 或 <cwd>/memory/。project 为空 → project-default.sqlite(向后兼容)。
 *   兼容模式:显式设置旧环境变量 MEMORY_DB_PATH 时仍为单库(向后兼容),并警告提示改用 MEMORY_DB_DIR。
 *
 * v5.0: 1024-dim vectors (Yuan-EB 2.0-zh), auto-migration from 4096
 * v4.0: 4096-dim vectors (qwen3-embedding:8b)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { normalizeProject } from './env.js';
import { normalizeMemType } from './memType.js';

/** memdir 分类文件夹名(memType → 目录名,general 为默认/元数据) */
export function memTypeDir(memType?: string): string {
  return normalizeMemType(memType);
}

export const VEC_DIM = 1024; // Yuan-EB 2.0-zh

export function generateId(): string {
  return crypto.randomUUID();
}

/** memory 目录:env MEMORY_DB_DIR 或 <cwd>/memory/ */
function memDir(): string {
  const dir = process.env.MEMORY_DB_DIR;
  return dir && dir.trim().length > 0 ? dir.trim() : path.join(process.cwd(), 'memory');
}

/** 旧单库路径(兼容模式):显式设置了 MEMORY_DB_PATH 时启用单库行为 */
function legacyDbPath(): string | undefined {
  const p = process.env.MEMORY_DB_PATH;
  return p && p.trim().length > 0 ? p.trim() : undefined;
}

/** 项目名 → 文件名安全片段:禁止路径分隔符/危险字符(避免 ../ 逃逸 memory 目录) */
export function safeFilePart(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'default';
}

let warnedLegacy = false;
function isLegacyMode(): boolean {
  return !!legacyDbPath();
}

/** 判断某目录是否是 memdir 项目目录(含 memory.sqlite 或任意 .sqlite),排除 receipts 等元目录 */
function dirLooksLikeProject(p: string): boolean {
  try {
    for (const f of fs.readdirSync(p)) {
      if (f.endsWith('.sqlite')) return true;
      const sub = path.join(p, f);
      try {
        if (fs.statSync(sub).isDirectory() && fs.existsSync(path.join(sub, 'memory.sqlite'))) return true;
      } catch { /* skip */ }
    }
  } catch { /* unreadable */ }
  return false;
}

/** 扫描 memory 目录下已有的项目(目录或旧 project-<name>.sqlite),返回项目名 */
export function listProjectNames(): string[] {
  const dir = memDir();
  if (isLegacyMode() || !fs.existsSync(dir)) return [];
  const names = new Set<string>();
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      if (fs.statSync(p).isDirectory() && dirLooksLikeProject(p)) names.add(f);
    } catch { /* skip */ }
  }
  // 兼容旧结构 project-<name>.sqlite(迁移脚本运行前仍可识别)
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('project-') && f.endsWith('.sqlite')) {
      names.add(f.slice('project-'.length, -'.sqlite'.length));
    }
  }
  return [...names];
}

/** 项目下的分类文件夹(memdir:user/feedback/project/reference/general),不存在则返回默认四类+general */
export function listMemTypeDirs(project: string): string[] {
  const dir = path.join(memDir(), safeFilePart(project));
  const base = ['general', 'user', 'feedback', 'project', 'reference'];
  if (!fs.existsSync(dir)) return base;
  const found = fs.readdirSync(dir).filter(f => {
    try { return fs.statSync(path.join(dir, f)).isDirectory() && base.includes(f); } catch { return false; }
  });
  // 旧结构 project-<name>.sqlite 存在时视为单库(全部在 general 语义下)
  const legacy = fs.existsSync(path.join(memDir(), `project-${safeFilePart(project)}.sqlite`));
  return legacy ? ['general'] : (found.length ? found : base);
}

/** 当前实例的 memory 目录(供联邦搜索/聚合层使用) */
export function currentMemDir(): string {
  return memDir();
}

// ═══════════════════════════════════════════════════════════════════
// Schema 初始化(拆分为 全局库 / 项目库 两组)
// ═══════════════════════════════════════════════════════════════════

/** 三层指令表(global/user/project/rule)+ 索引 + v5.5 迁移 */
function initInstructionsSchema(db: Database.Database) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS instructions (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('global','user','project','rule')),
        project TEXT,
        content TEXT NOT NULL,
        paths TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_instructions_scope_unique ON instructions(scope) WHERE scope IN ('global','user');
      CREATE UNIQUE INDEX IF NOT EXISTS idx_instructions_project_unique ON instructions(scope, project) WHERE scope = 'project';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_instructions_rule_unique ON instructions(project) WHERE scope = 'rule';
      CREATE INDEX IF NOT EXISTS idx_instructions_scope ON instructions(scope, project);
    `);
  } catch (_e) { /* already exists */ }

  // v5.5 迁移:老表补 paths 列 + scope='rule'(规则组)。
  // SQLite 无法 ALTER 修改 CHECK 约束,必须重建表;用事务保证原子性,不破坏已有数据。
  // 幂等:每次启动检查 table_info + sqlite_master.sql,缺任一特性才重建。
  try {
    const instCols = db.prepare(`PRAGMA table_info(instructions)`).all() as any[];
    const hasPaths = instCols.some(c => c.name === 'paths');
    const instSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='instructions'`).get() as any)?.sql || '';
    const hasRuleScope = /'rule'/.test(instSql);
    if (!hasPaths || !hasRuleScope) {
      console.log('[db] migrating instructions → v5.5 (paths column + scope=rule)');
      db.transaction(() => {
        db.exec(`ALTER TABLE instructions RENAME TO instructions_v55_old`);
        db.exec(`
          CREATE TABLE instructions (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL CHECK(scope IN ('global','user','project','rule')),
            project TEXT,
            content TEXT NOT NULL,
            paths TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO instructions (id, scope, project, content, updated_at)
            SELECT id, scope, project, content, updated_at FROM instructions_v55_old;
          DROP TABLE instructions_v55_old;
        `);
      })();
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_instructions_scope_unique ON instructions(scope) WHERE scope IN ('global','user');
        CREATE UNIQUE INDEX IF NOT EXISTS idx_instructions_project_unique ON instructions(scope, project) WHERE scope = 'project';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_instructions_rule_unique ON instructions(project) WHERE scope = 'rule';
        CREATE INDEX IF NOT EXISTS idx_instructions_scope ON instructions(scope, project);
      `);
    } else {
      try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_instructions_rule_unique ON instructions(project) WHERE scope = 'rule'`); } catch (_e) {}
    }
  } catch (_e) { /* instructions 表尚未创建时跳过 */ }
}

/** 全局库 schema:指令表 + 项目注册表(不含 memory/vec 业务表) */
function initGlobalSchema(db: Database.Database) {
  initInstructionsSchema(db);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch (_e) {}
}

/** 项目库 schema:全部业务表(与旧单库一致)+ 指令表(保持原 schema) */
export function initProjectSchema(db: Database.Database) {
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
      reference_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(source_id) REFERENCES memory(id),
      FOREIGN KEY(target_id) REFERENCES memory(id)
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
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(source_memory_id) REFERENCES memory(id)
    );
  `);

  // Safe column migrations (may already exist)
  const migrations = [
    `ALTER TABLE memory ADD COLUMN tier TEXT DEFAULT 'standard'`,
    `ALTER TABLE memory ADD COLUMN expires_at DATETIME`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (_e) { /* already exists */ }
  }

  // v5.3: locked column for permanent memory protection
  try { db.exec(`ALTER TABLE memory ADD COLUMN locked INTEGER DEFAULT 0`); } catch (_e) { /* already exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_tier ON memory(tier, is_active)`); } catch (_e) {}

  // v1.5: project column for per-project memory isolation
  try { db.exec(`ALTER TABLE memory ADD COLUMN project TEXT DEFAULT 'default'`); } catch (_e) { /* already exists */ }
  try { db.exec(`ALTER TABLE facts ADD COLUMN project TEXT DEFAULT 'default'`); } catch (_e) { /* already exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project, is_active)`); } catch (_e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project, is_active)`); } catch (_e) {}

  // v6.0: session_id column for session-level memory (reserved, no logic added yet)
  try { db.exec(`ALTER TABLE memory ADD COLUMN session_id TEXT`); } catch (_e) { /* already exists */ }

  // v1.8: mem_type column — 用途维度(Claude Code 4 种封闭类型),默认 general
  try { db.exec(`ALTER TABLE memory ADD COLUMN mem_type TEXT DEFAULT 'general'`); } catch (_e) { /* already exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_mem_type ON memory(mem_type, is_active)`); } catch (_e) {}

  // v1.15: LobeHub 精细化吸收 — 四维评分/元数据/身份 CRUD 维护
  try { db.exec(`ALTER TABLE memory ADD COLUMN metadata TEXT`); } catch (_e) { /* already exists */ }
  try { db.exec(`ALTER TABLE memory ADD COLUMN title TEXT`); } catch (_e) { /* already exists */ }
  try { db.exec(`ALTER TABLE memory ADD COLUMN status TEXT`); } catch (_e) { /* already exists */ }
  try { db.exec(`ALTER TABLE memory ADD COLUMN score_confidence REAL`); } catch (_e) { /* already exists */ }
  try { db.exec(`ALTER TABLE memory ADD COLUMN score_impact REAL`); } catch (_e) { /* already exists */ }
  try { db.exec(`ALTER TABLE memory ADD COLUMN score_priority REAL`); } catch (_e) { /* already exists */ }
  try { db.exec(`ALTER TABLE memory ADD COLUMN score_urgency REAL`); } catch (_e) { /* already exists */ }
  try { db.exec(`ALTER TABLE memory ADD COLUMN identity_locked INTEGER DEFAULT 0`); } catch (_e) { /* already exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type, is_active)`); } catch (_e) {}

  // Unique index for fact dedup (per-project: same SPO allowed across projects)
  try { db.exec(`DROP INDEX IF EXISTS idx_facts_spo`); } catch (_e) {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_spo ON facts(subject, predicate, object, project)`); } catch (_e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject, is_active)`); } catch (_e) {}

  // 指令表(保持原 schema:项目库也建;三层指令路由在 instructions.ts 决定)
  initInstructionsSchema(db);

  // ═══ v5.0 迁移：4096-dim → 1024-dim (Yuan-EB) ═══
  const SCHEMA_VERSION = 5;
  try { db.exec(`CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER)`); } catch (_e) {}
  const currentVersion = (db.prepare('SELECT MAX(version) as v FROM _schema_version').get() as any)?.v || 0;

  if (currentVersion < SCHEMA_VERSION) {
    console.log(`[db] migrating schema v${currentVersion} → v${SCHEMA_VERSION}`);
    try { db.exec(`DROP TABLE IF EXISTS vec_memory`); } catch (_e) {}
    try { db.exec(`DROP TABLE IF EXISTS vec_facts`); } catch (_e) {}
    try { db.exec(`DELETE FROM embedding_cache`); } catch (_e) {}
    db.prepare('INSERT OR REPLACE INTO _schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    console.log(`[db] migration complete: vec tables recreated with ${VEC_DIM}-dim`);
  }

  // Create vec tables with current dimension
  try { db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding float[${VEC_DIM}])`); } catch (_e) {}
  try { db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(embedding float[${VEC_DIM}])`); } catch (_e) {}

  // Seed default categories (SynaBun-style hierarchical)
  const defaultCategories = [
    { name: 'episodic', description: '事件记忆 — 发生了什么', is_parent: 1 },
    { name: 'milestone', description: '成长里程碑 — 第一次、重要决定 [critical]', parent: 'episodic' },
    { name: 'conversation', description: '对话记忆 — 有意义的对话片段', parent: 'episodic' },
    { name: 'semantic', description: '事实记忆 — 知识和关系', is_parent: 1 },
    { name: 'identity', description: '身份信息 — 人物、角色、身份 [critical]', parent: 'semantic' },
    { name: 'knowledge', description: '知识事实 — 学到的东西', parent: 'semantic' },
    { name: 'preference', description: '偏好记忆 — 用户喜好和习惯', is_parent: 1 },
    { name: 'entity', description: '实体记忆 — 人物、地点、物品', is_parent: 1 },
    { name: 'relationship', description: '关系记忆 — 人与人之间的关系 [critical]', parent: 'entity' },
  ];

  const insertCat = db.prepare(`
    INSERT OR IGNORE INTO categories (name, description, parent, is_parent)
    VALUES (?, ?, ?, ?)
  `);

  for (const cat of defaultCategories) {
    insertCat.run(cat.name, cat.description, cat.parent || null, cat.is_parent || 0);
  }
}

// ═══════════════════════════════════════════════════════════════════
// DatabaseManager — 按项目路由,管理所有打开的库连接
// ═══════════════════════════════════════════════════════════════════

export class DatabaseManager {
  private static connections = new Map<string, Database.Database>();

  /**
   * memdir 分库(memory/<project>/<memType>/memory.sqlite):memType 缺省 → general(默认/元数据库)。
   * 四分类:user/feedback/project/reference。project 为空 → 默认项目(default)。
   * 首次访问某项目时懒加载创建,并登记进 global.sqlite 的 projects 表。
   * 兼容模式(MEMORY_DB_PATH 显式设置):所有 project 落到同一个单库,行为不变。
   */
  public static getInstance(project?: string, memType?: string): Database.Database {
    const proj = normalizeProject(project);
    if (isLegacyMode()) {
      if (!warnedLegacy) {
        warnedLegacy = true;
        console.error('[db] ⚠️ MEMORY_DB_PATH 已弃用:建议改用 MEMORY_DB_DIR(按项目分库)。当前以单库兼容模式运行,不创建 memory/ 目录。');
      }
      return DatabaseManager.open('__legacy__', legacyDbPath()!, initProjectSchema);
    }
    const mt = normalizeMemType(memType);
    const db = DatabaseManager.open(
      `project:${proj}:${mt}`,
      path.join(memDir(), safeFilePart(proj), memTypeDir(mt), 'memory.sqlite'),
      initProjectSchema,
    );
    // 项目注册表(global.sqlite):懒加载登记
    try {
      const g = DatabaseManager.getGlobal();
      g.prepare('INSERT OR IGNORE INTO projects (project) VALUES (?)').run(proj);
    } catch (e: any) {
      console.error('[db] register project failed:', e.message);
    }
    return db;
  }

  /** 全局库(global.sqlite):L1/L2 指令 + rule 规则组 + 项目注册表。兼容模式下返回单库。 */
  public static getGlobal(): Database.Database {
    if (isLegacyMode()) return DatabaseManager.getInstance();
    return DatabaseManager.open('global', path.join(memDir(), 'global.sqlite'), initGlobalSchema);
  }

  private static open(key: string, dbPath: string, init: (db: Database.Database) => void): Database.Database {
    let db = DatabaseManager.connections.get(key);
    if (!db) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new Database(dbPath);
      sqliteVec.load(db);
      db.pragma('journal_mode = WAL');
      init(db);
      DatabaseManager.connections.set(key, db);
    }
    return db;
  }

  /** v5.3: WAL checkpoint to prevent WAL file bloat — 对每个已打开的库执行 */
  public static checkpoint(): { walSize: number; pages: number } {
    let pages = 0;
    let walSize = 0;
    for (const db of DatabaseManager.connections.values()) {
      try {
        const before = db.pragma('wal_checkpoint(TRUNCATE)') as any;
        pages += before?.checkpointed ?? 0;
        walSize += before?.wal_size ?? 0;
      } catch { /* ignore */ }
    }
    return { walSize, pages };
  }

  /** 关闭所有打开的库连接 */
  public static close(): void {
    DatabaseManager.checkpoint();
    for (const db of DatabaseManager.connections.values()) {
      try { db.close(); } catch { /* ignore */ }
    }
    DatabaseManager.connections.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════
// v1.11 Part2: 会话记忆 TTL 孤儿清扫(吸收 Claude cleaner.sweepExpiredSessions)
// 正常流程晋升即删;TTL 只兜底孤儿(进程被 kill 等)。
// 仅删 source=session_memory 且 session_id 非空的行。
// ═══════════════════════════════════════════════════════════════════

/**
 * 清扫过期会话记忆:SESSION_MEMORY_TTL_DAYS(默认 7)天无更新的
 * source=session_memory 会话级记忆。返回删除条数。
 * 注:updated_at 以 ISO 字符串存储,故用 JS 计算 cutoff 传参,
 *    而非 SQLite datetime('now','-N days')(两种格式文本序不一致)。
 */
export function sweepExpiredSessionMemories(project?: string): number {
  const ttlDays = (() => {
    const v = parseInt(process.env.SESSION_MEMORY_TTL_DAYS || '7', 10);
    return Number.isFinite(v) && v > 0 ? v : 7; // 非法值兜底 7
  })();
  const cutoff = new Date(Date.now() - ttlDays * 86400000).toISOString();
  const proj = normalizeProject(project);
  let total = 0;
  // memdir:会话滚动记忆也可能落在任意 memType 分类库,逐库清扫
  for (const mt of listMemTypeDirs(proj)) {
    const db = DatabaseManager.getInstance(proj, mt);
    const r = db.prepare(`
      DELETE FROM memory
      WHERE source = 'session_memory' AND session_id IS NOT NULL AND is_active = 1
        AND updated_at < ?
    `).run(cutoff);
    total += r.changes;
  }
  return total;
}
