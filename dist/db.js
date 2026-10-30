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
import { normalizeProject, isEmbedEnabled } from './env.js';
import { normalizeMemType } from './memType.js';
import { debugCatch } from './log.js';
/** memdir 分类文件夹名(memType → 目录名,general 为默认/元数据) */
export function memTypeDir(memType) {
    return normalizeMemType(memType);
}
/** 默认向量维度(Yuan-EB 2.0-zh)。实际取值见 vecDim():可由 config.json 的 embedding.dim / env EMBEDDING_DIM 覆盖。 */
const DEFAULT_VEC_DIM = 1024;
let _vecDim;
/** 库内已记录的嵌入模型(未显式配置时沿用,避免"默认模型"销毁别人建好的索引) */
let _embedModelOverride = '';
/**
 * 当前向量维度(v1.25 起不再是常量)。
 *
 * 惰性读取环境变量,这样 configLoader 在本模块 import 之后注入 EMBEDDING_DIM 也能生效
 * (config.json 的 embedding.dim → EMBEDDING_DIM)。非法/越界值回退默认 1024。
 */
export function vecDim() {
    if (_vecDim !== undefined)
        return _vecDim;
    const raw = (process.env.EMBEDDING_DIM || process.env.VEC_DIM || '').trim();
    const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
    _vecDim = Number.isFinite(n) && n > 0 && n <= 65536 ? n : DEFAULT_VEC_DIM;
    return _vecDim;
}
/** 默认维度(历史常量,保留导出做兼容;运行时维度请用 vecDim()) */
export const VEC_DIM = DEFAULT_VEC_DIM;
/** 目标维度是否来自显式配置(env EMBEDDING_DIM/VEC_DIM,含 config.json 注入)。未设置 = 只是内置默认值。 */
function vecDimIsExplicit() {
    return !!((process.env.EMBEDDING_DIM || process.env.VEC_DIM || '').trim());
}
/** 当前嵌入模型名(惰性读取,configLoader 注入 EMBEDDING_MODEL 后也能生效) */
export function embedModelName() {
    return (_embedModelOverride || process.env.EMBEDDING_MODEL || 'yuan-embedding-2.0-zh').trim();
}
/** 嵌入模型是否来自显式配置(env EMBEDDING_MODEL,含 config.json 注入)。未设置 = 只是内置默认值。 */
function embedModelIsExplicit() {
    return !!((process.env.EMBEDDING_MODEL || '').trim());
}
/**
 * 目标嵌入后端是否**真的能重嵌**。清空向量索引是不可恢复操作(原文不在 vec 表里,
 * 清了就只能靠重嵌补回来),所以只有确认能重嵌时才允许清。
 * - EMBED_MODE=api:必须有 EMBEDDING_API_KEY,否则每次请求都 401/fetch failed。
 * - EMBED_MODE=none:已在 isEmbedEnabled() 里挡掉。
 * - 其余(ollama/默认本地):无法在清空前探活,保持原行为(允许清)。
 */
function embedTargetUsable() {
    const mode = (process.env.EMBED_MODE || '').toLowerCase().trim();
    if (mode === 'api')
        return !!((process.env.EMBEDDING_API_KEY || '').trim());
    return true;
}
/**
 * 嵌入空间指纹(2026-10-27 新增,修 E4)。
 *
 * 为什么不能只看维度:换模型时维度**常常相同**(同为 1024),但两个模型的向量属于
 * 不同语义空间,混在一起会让"相似度"失去意义 —— 实测同一文本的自相似度会从 1.000
 * 掉到 0.000,而毫不相关的文本反而 1.000。所以指纹取 sha256(model|dim)。
 */
export function embedSpaceHash() {
    return crypto.createHash('sha256').update(`${embedModelName()}|${vecDim()}`).digest('hex');
}
/**
 * 嵌入空间对齐(修 E4):库内指纹与当前 model|dim 不一致时,清空向量索引与嵌入缓存,
 * 让 batchEmbedPending 按新空间重嵌。
 *
 * 安全性:vec_memory / vec_facts 只是索引,原文在 memory / facts,清掉不丢数据;
 * embedding_cache 是纯派生数据。EMBED_MODE=none 时**不动**(无法重嵌,清了只会让检索变差),
 * 只告警,等下次带嵌入开库时再对齐。
 */
export function ensureEmbedSpace(db) {
    const to = embedSpaceHash();
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS _embed_space (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      model TEXT, dim INTEGER, space_hash TEXT, updated_at TEXT
    )`);
        const row = db.prepare('SELECT model, dim, space_hash FROM _embed_space WHERE id = 1').get();
        if (!row) {
            // 首次记录指纹:不销毁任何既有向量(旧库升级路径,假定现有向量属于当前空间)
            db.prepare('INSERT OR REPLACE INTO _embed_space (id, model, dim, space_hash, updated_at) VALUES (1, ?, ?, ?, ?)')
                .run(embedModelName(), vecDim(), to, new Date().toISOString());
            return { changed: false, to };
        }
        if (row.space_hash === to)
            return { changed: false, to };
        // 2026-10-29 修复(与 reconcileVecDim 的 E2 同构):模型**未显式配置**时,绝不因为
        // 「内置默认模型」与库内不同就销毁索引。默认值只是历史常量(yuan-embedding-2.0-zh),
        // 含义是"没人告诉我要用哪个模型",不代表库里的向量是错的;沿用库内模型即可。
        // 真换模型必须显式设置 EMBEDDING_MODEL(或 config.json 的 embedding.api_model/model),
        // 那时才允许清空重嵌。实测事故:宿主 cwd 下缺 memory/config.json → 默认模型 y
        // yuan-embedding-2.0-zh 覆盖了库内 BAAI/bge-m3 → 817 条记忆的向量被清空且无法重嵌。
        if (!embedModelIsExplicit() && row.model && String(row.model).trim()
            && String(row.model).trim() !== embedModelName()) {
            _embedModelOverride = String(row.model).trim();
            console.warn(`[db] 未显式配置嵌入模型,沿用库内 ${_embedModelOverride}(不清向量);`
                + '要换模型请显式设置 EMBEDDING_MODEL 或 config.json 的 embedding.api_model/model');
            return { changed: false, to: embedSpaceHash() };
        }
        if (!isEmbedEnabled()) {
            console.warn(`[db] 嵌入空间变化(库内 ${row.model}/${row.dim} → 配置 ${embedModelName()}/${vecDim()}),但 EMBED_MODE=none 无法重嵌,暂不改动向量与缓存`);
            return { changed: false, to };
        }
        // 同一类的第二道闸:目标是云端 API 但没拿到 key 时清空是**不可恢复**的
        // (清了也没法重嵌,只会把可用索引变成空索引),按 EMBED_MODE=none 同样处理。
        if (!embedTargetUsable()) {
            console.warn(`[db] 嵌入空间变化(库内 ${row.model}/${row.dim} → 配置 ${embedModelName()}/${vecDim()}),`
                + '但 EMBED_MODE=api 且没有 EMBEDDING_API_KEY,无法重嵌,暂不改动向量与缓存');
            return { changed: false, to };
        }
        console.warn(`[db] 嵌入空间变化: ${row.model}/${row.dim} → ${embedModelName()}/${vecDim()}(维度可能相同,旧向量属于另一语义空间),清空向量索引与嵌入缓存,稍后按新空间重嵌`);
        try {
            db.exec('DELETE FROM vec_memory');
        }
        catch (_e) {
            debugCatch('db:ddl', _e);
        }
        try {
            db.exec('DELETE FROM vec_facts');
        }
        catch (_e) {
            debugCatch('db:ddl', _e);
        }
        try {
            db.exec('DELETE FROM embedding_cache');
        }
        catch (_e) {
            debugCatch('db:ddl', _e);
        }
        db.prepare('UPDATE _embed_space SET model = ?, dim = ?, space_hash = ?, updated_at = ? WHERE id = 1')
            .run(embedModelName(), vecDim(), to, new Date().toISOString());
        return { changed: true, to };
    }
    catch (e) {
        console.error(`[db] 嵌入空间对齐失败(不阻断开库): ${e.message}`);
        return { changed: false, to };
    }
}
/** 读出某个 vec0 虚表当前的维度(如 `float[1024]`);表不存在或解析不出 → null */
function vecTableDim(db, name) {
    try {
        const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
        const m = row && row.sql ? /float\[(\d+)\]/.exec(String(row.sql)) : null;
        return m ? Number.parseInt(m[1], 10) : null;
    }
    catch (_e) {
        debugCatch('db:vecTableDim', _e);
        return null;
    }
}
/**
 * 维度对齐(v1.25):库内 vec 表维度与当前配置不一致时重建。
 *
 * 为什么必须重建:sqlite-vec 的 vec0 表把维度写在建表语句里(`embedding float[N]`),
 * 换嵌入模型常常同时换维度(BAAI/bge-m3 = 1024,qwen3-embedding:8b = 4096…)。
 * 数据不丢:memory / facts 的原文与关系都在普通表,vec 表只是索引;
 * 重建后 vec 表为空,batchEmbedPending 会把缺向量的行重新嵌入
 * (EMBED_MODE=none 时保持"待嵌"状态,下次开嵌入再补)。
 */
function reconcileVecDim(db) {
    const want = vecDim();
    const dims = [vecTableDim(db, 'vec_memory'), vecTableDim(db, 'vec_facts')];
    const existing = dims.filter((d) => d !== null);
    if (existing.length === 0)
        return; // 从未建过 → 首次建表
    if (existing.every(d => d === want))
        return; // 已是目标维度
    // 2026-10-27 修复(E2):目标维度只是**内置默认值**(既没有 env,也没有 config.json 的
    // embedding.dim)时,绝不因为它与库内不同就销毁索引。控制台把注入的默认 dim=1024
    // 写回 config.json 后,曾让 4096 维库被静默降维 + DROP 索引 + 清空 embedding_cache;
    // 连 config.json 都不存在的纯默认场景同样会清库。此时应沿用库内维度。
    if (!vecDimIsExplicit()) {
        const adopted = existing[0];
        _vecDim = adopted;
        console.warn(`[db] 库内向量维度 ${[...new Set(existing)].join('/')} 与内置默认 ${want} 不同;因未显式配置维度,沿用库内维度 ${adopted}(不重建、不清索引)。若确实要换维度,请显式设置 EMBEDDING_DIM 或 config.json 的 embedding.dim`);
        return;
    }
    // 2026-10-27 修复(P2-2,复核提出):EMBED_MODE=none 时**不能**重建 —— 清了也没法重嵌,
    // 只会把可用索引变成空索引,而且与 ensureEmbedSpace 的 none 语义自相矛盾。
    if (!isEmbedEnabled()) {
        console.warn(`[db] 向量维度变化: 库内 ${[...new Set(existing)].join('/')} 维 → 配置 ${want} 维,但 EMBED_MODE=none 无法重嵌,暂不重建(不清索引、不清缓存)`);
        return;
    }
    console.warn(`[db] 向量维度变化: 库内 ${[...new Set(existing)].join('/')} 维 → 配置 ${want} 维,重建 vec 表(重启嵌入后自动补向量)`);
    try {
        db.exec(`DROP TABLE IF EXISTS vec_memory`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e);
    }
    try {
        db.exec(`DROP TABLE IF EXISTS vec_facts`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e);
    }
    try {
        db.exec(`DELETE FROM embedding_cache`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e);
    }
}
export function generateId() {
    return crypto.randomUUID();
}
/** 表是否存在(用于旧库/半初始化库的安全探测) */
function tableExists(db, name) {
    try {
        return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    }
    catch (_e) {
        debugCatch('db:tableExists', _e);
        return false;
    }
}
/**
 * 孤儿向量自愈(v1.25-fix)。
 *
 * vec_memory / vec_facts 是 vec0 虚表,主键是源表 rowid。任何绕过 store 层的硬删
 * (手写 SQL、外部工具、历史 bug)都会留下孤儿向量:它既会污染 KNN 结果,又会在
 * SQLite 复用 rowid 后让下一次 `INSERT INTO vec_memory` 撞
 * `UNIQUE constraint failed on vec_memory primary key` —— 该条记忆此后永久保存失败。
 *
 * 在库 open/init 时(每进程每库一次,不是每次查询)删除 rowid 已不存在于源表的向量。
 * 幂等:没有孤儿时零删除;只删"源表查不到 rowid"的行,不碰合法行。
 * 不用 JOIN(vec0 对 KNN 之外的 JOIN 支持受限):先取两侧 rowid 集合,再按主键删。
 */
export function healVecOrphans(db) {
    const healed = { memory: 0, facts: 0 };
    const pairs = [
        ['vec_memory', 'memory', 'memory'],
        ['vec_facts', 'facts', 'facts'],
    ];
    for (const [vecTable, srcTable, key] of pairs) {
        try {
            if (!tableExists(db, vecTable) || !tableExists(db, srcTable))
                continue;
            const alive = new Set();
            for (const row of db.prepare(`SELECT rowid FROM ${srcTable}`).all()) {
                alive.add(String(row.rowid));
            }
            const orphans = [];
            for (const row of db.prepare(`SELECT rowid FROM ${vecTable}`).all()) {
                if (!alive.has(String(row.rowid)))
                    orphans.push(row.rowid);
            }
            if (orphans.length === 0)
                continue;
            // 误删保险：孤儿占该表向量总数的一半以上、且超过 50 行时，说明是 rowid 体系
            // 整体不匹配(例如外部工具用别的表灌过向量)，而不是零星硬删残留。此时只告警
            // 不删除——宁可留下孤儿被 KNN 过滤，也不能一次性抹掉整库 embedding。
            const totalVec = Number(db.prepare(`SELECT count(*) AS c FROM ${vecTable}`).get()?.c || 0);
            if (orphans.length > 50 && orphans.length > totalVec * 0.5) {
                console.error(`[db] ${vecTable} 孤儿占比异常(${orphans.length}/${totalVec})，判定为 rowid 体系不匹配，跳过自愈以防误删`);
                continue;
            }
            const del = db.prepare(`DELETE FROM ${vecTable} WHERE rowid = ?`);
            db.transaction((ids) => { for (const id of ids)
                del.run(id); })(orphans);
            healed[key] = orphans.length;
            console.error(`[db] 清理孤儿向量 ${vecTable}: ${orphans.length} 行(rowid 已不在 ${srcTable})`);
        }
        catch (e) {
            // 旧库缺表 / vec0 扩展异常时不能阻断开库
            console.error(`[db] ${vecTable} 孤儿清理跳过: ${e.message}`);
        }
    }
    return healed;
}
/** memory 目录:env MEMORY_DB_DIR 或 <cwd>/memory/ */
function memDir() {
    const dir = process.env.MEMORY_DB_DIR;
    return dir && dir.trim().length > 0 ? dir.trim() : path.join(process.cwd(), 'memory');
}
/** 旧单库路径(兼容模式):显式设置了 MEMORY_DB_PATH 时启用单库行为 */
function legacyDbPath() {
    const p = process.env.MEMORY_DB_PATH;
    return p && p.trim().length > 0 ? p.trim() : undefined;
}
/** 项目名 → 文件名安全片段:禁止路径分隔符/危险字符(避免 ../ 逃逸 memory 目录) */
export function safeFilePart(name) {
    const cleaned = String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_');
    // v1.23.1-fix: '.' / '..' 能通过原白名单并让 path.join 上跳一级（memory/../…）。
    if (!cleaned || cleaned === '.' || cleaned === '..' || /^\.+$/.test(cleaned))
        return 'default';
    return cleaned;
}
let warnedLegacy = false;
function isLegacyMode() {
    return !!legacyDbPath();
}
/** 判断某目录是否是 memdir 项目目录(含 memory.sqlite 或任意 .sqlite),排除 receipts 等元目录 */
function dirLooksLikeProject(p) {
    try {
        for (const f of fs.readdirSync(p)) {
            if (f.endsWith('.sqlite'))
                return true;
            const sub = path.join(p, f);
            try {
                if (fs.statSync(sub).isDirectory() && fs.existsSync(path.join(sub, 'memory.sqlite')))
                    return true;
            }
            catch { /* skip */ }
        }
    }
    catch { /* unreadable */ }
    return false;
}
/** 扫描 memory 目录下已有的项目(目录或旧 project-<name>.sqlite),返回项目名 */
export function listProjectNames() {
    const dir = memDir();
    if (isLegacyMode() || !fs.existsSync(dir))
        return [];
    const names = new Set();
    for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        try {
            if (fs.statSync(p).isDirectory() && dirLooksLikeProject(p))
                names.add(f);
        }
        catch { /* skip */ }
    }
    // 兼容旧结构 project-<name>.sqlite(迁移脚本运行前仍可识别)
    for (const f of fs.readdirSync(dir)) {
        if (f.startsWith('project-') && f.endsWith('.sqlite')) {
            names.add(f.slice('project-'.length, -'.sqlite'.length));
        }
    }
    return [...names];
}
/**
 * v1.26：维护类任务要跑的库清单 —— 默认库 + 磁盘上现有的全部库（去重、排序）
 *
 * 起因：consolidate / digest / 启动反思过去一律用 PROJECT_ID，多库实例上
 * 非默认库永远等不到维护 —— TECHNICAL.md §12 第二条。
 * 这里把「要跑哪些库」收敛成一个函数，周期任务与启动任务共用，避免两边口径漂移。
 */
export function listAllProjects(defaultProject) {
    const base = defaultProject || process.env.CASTALIA_PROJECT || 'default';
    const set = new Set([base, ...listProjectNames()]);
    return [...set].filter(Boolean).sort();
}
/** 项目下的分类文件夹(memdir:user/feedback/project/reference/general),不存在则返回默认四类+general */
export function listMemTypeDirs(project) {
    const dir = path.join(memDir(), safeFilePart(project));
    const base = ['general', 'user', 'feedback', 'project', 'reference'];
    if (!fs.existsSync(dir))
        return base;
    const found = fs.readdirSync(dir).filter(f => {
        try {
            return fs.statSync(path.join(dir, f)).isDirectory() && base.includes(f);
        }
        catch {
            return false;
        }
    });
    // 旧结构 project-<name>.sqlite 存在时视为单库(全部在 general 语义下)
    const legacy = fs.existsSync(path.join(memDir(), `project-${safeFilePart(project)}.sqlite`));
    return legacy ? ['general'] : (found.length ? found : base);
}
/** 当前实例的 memory 目录(供联邦搜索/聚合层使用) */
export function currentMemDir() {
    return memDir();
}
// ═══════════════════════════════════════════════════════════════════
// Schema 初始化(拆分为 全局库 / 项目库 两组)
// ═══════════════════════════════════════════════════════════════════
/** 三层指令表(global/user/project/rule)+ 索引 + v5.5 迁移 */
function initInstructionsSchema(db) {
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
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    // v5.5 迁移:老表补 paths 列 + scope='rule'(规则组)。
    // SQLite 无法 ALTER 修改 CHECK 约束,必须重建表;用事务保证原子性,不破坏已有数据。
    // 幂等:每次启动检查 table_info + sqlite_master.sql,缺任一特性才重建。
    try {
        const instCols = db.prepare(`PRAGMA table_info(instructions)`).all();
        const hasPaths = instCols.some(c => c.name === 'paths');
        const instSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='instructions'`).get()?.sql || '';
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
        }
        else {
            try {
                db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_instructions_rule_unique ON instructions(project) WHERE scope = 'rule'`);
            }
            catch (_e) {
                debugCatch('db:ddl', _e);
            }
        }
    }
    catch (_e) {
        debugCatch('db:ddl:instructions', _e); /* instructions 表尚未创建时跳过 */
    }
}
/** 全局库 schema:指令表 + 项目注册表(不含 memory/vec 业务表) */
function initGlobalSchema(db) {
    initInstructionsSchema(db);
    try {
        db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    }
    catch (_e) {
        debugCatch('db:ddl', _e);
    }
}
/** 项目库 schema:全部业务表(与旧单库一致)+ 指令表(保持原 schema) */
export function initProjectSchema(db) {
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
        try {
            db.exec(sql);
        }
        catch (_e) {
            debugCatch('db:ddl', _e); /* already exists */
        }
    }
    // v5.3: locked column for permanent memory protection
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN locked INTEGER DEFAULT 0`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_tier ON memory(tier, is_active)`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e);
    }
    // v1.5: project column for per-project memory isolation
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN project TEXT DEFAULT 'default'`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE facts ADD COLUMN project TEXT DEFAULT 'default'`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project, is_active)`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e);
    }
    try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project, is_active)`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e);
    }
    // v6.0: session_id column for session-level memory (reserved, no logic added yet)
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN session_id TEXT`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    // v1.8: mem_type column — 用途维度(Claude Code 4 种封闭类型),默认 general
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN mem_type TEXT DEFAULT 'general'`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_mem_type ON memory(mem_type, is_active)`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e);
    }
    // v1.15: LobeHub 精细化吸收 — 四维评分/元数据/身份 CRUD 维护
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN metadata TEXT`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN title TEXT`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN status TEXT`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN score_confidence REAL`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN score_impact REAL`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN score_priority REAL`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN score_urgency REAL`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN identity_locked INTEGER DEFAULT 0`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type, is_active)`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e);
    }
    // v1.15: LobeHub 精细化吸收 — 四维评分/元数据/身份 CRUD 维护
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN metadata TEXT`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN title TEXT`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN status TEXT`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN score_confidence REAL`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN score_impact REAL`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN score_priority REAL`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN score_urgency REAL`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN identity_locked INTEGER DEFAULT 0`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type, is_active)`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e);
    }
    // v1.23 Parent-Child 检索：leaf 记忆指回父对话（llama_index ParentDocumentRetriever 思路）
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN parent_id TEXT`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_parent ON memory(parent_id)`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e);
    }
    // v1.23 事实边：Graphiti 式时间有效性 + 证据引用（不删除，只失效）
    try {
        db.exec(`ALTER TABLE facts ADD COLUMN valid_from DATETIME`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE facts ADD COLUMN valid_to DATETIME`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE facts ADD COLUMN evidence TEXT`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    // v1.24 记忆血缘（Graphiti EntityEdge 语义）：合并必须可追溯，旧行不得消失
    //   valid_at       事实/记忆何时开始成立
    //   expired_at     何时被系统取代（soft supersede，与"事实不再成立"区分）
    //   reference_time 产生它的来源时间（用于相对日期归一）
    //   merged_from    这条合并结果吃掉了哪些 id（JSON 数组）
    //   merged_quotes  合并结果的逐字引证（JSON 数组，写入时做子串校验）
    //   merged_into    反向指针：这条被谁取代（旧行 → 新行）
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN valid_at DATETIME`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN expired_at DATETIME`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN reference_time DATETIME`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN merged_from TEXT`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN merged_quotes TEXT`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN merged_into TEXT`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_merged_into ON memory(merged_into)`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e);
    }
    // v1.23.1: 衰减基线。importance 会被 consolidate 按年龄衰减；如果每次都在“已衰减值”上再乘一次，
    // 衰减速度就取决于 consolidate 跑了几次而不是记忆多老（实测 61 天 0.9 分 7 次运行后跌破阈值被删）。
    // base_importance 保存原始值，衰减永远从基线算；触发器覆盖所有 INSERT 路径。
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN base_importance REAL`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    // v1.23.2: 向量化失败计数，避免连续失败的头部记录永久占满 batchEmbedPending 的 200 条窗口
    try {
        db.exec(`ALTER TABLE memory ADD COLUMN embed_fail_count INTEGER DEFAULT 0`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e); /* already exists */
    }
    try {
        db.exec(`UPDATE memory SET base_importance = importance WHERE base_importance IS NULL`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e);
    }
    try {
        db.exec(`CREATE TRIGGER IF NOT EXISTS trg_memory_base_importance AFTER INSERT ON memory
             WHEN NEW.base_importance IS NULL
             BEGIN UPDATE memory SET base_importance = NEW.importance WHERE id = NEW.id; END`);
    }
    catch (_e) {
        debugCatch('db:ddl:trigger', _e); /* trigger 已存在或旧库不支持 */
    }
    // v1.24: 词法通道（FTS5 trigram + 外部内容表 + 触发器）。
    // 现有三路（tags LIKE / 向量 KNN / text LIKE）对"精确短语"无能为力：
    // 古籍原句、卦名、错误码、路径、端口都查不到 —— 这是用户笔记里记过的老问题。
    // 外部内容表 + 触发器让同步完全由 SQLite 负责，不需要在每个写路径上手插索引。
    try {
        const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'").get();
        if (!exists) {
            db.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(
        text, tags, category, content='memory', content_rowid='rowid', tokenize='trigram'
      )`);
            db.exec(`CREATE TRIGGER IF NOT EXISTS trg_memory_fts_ai AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts(rowid, text, tags, category) VALUES (new.rowid, new.text, new.tags, new.category);
      END`);
            db.exec(`CREATE TRIGGER IF NOT EXISTS trg_memory_fts_ad AFTER DELETE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, text, tags, category) VALUES ('delete', old.rowid, old.text, old.tags, old.category);
      END`);
            db.exec(`CREATE TRIGGER IF NOT EXISTS trg_memory_fts_au AFTER UPDATE OF text, tags, category ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, text, tags, category) VALUES ('delete', old.rowid, old.text, old.tags, old.category);
        INSERT INTO memory_fts(rowid, text, tags, category) VALUES (new.rowid, new.text, new.tags, new.category);
      END`);
            // 建表后立刻用现有行回填（外部内容表的一次性 rebuild）
            db.exec(`INSERT INTO memory_fts(memory_fts) VALUES('rebuild')`);
        }
    }
    catch (e) {
        // 无 FTS5 的构建：检索侧会自动回落到 LIKE，这里只记一次日志
        console.error(`[db] memory_fts 不可用（${e.message}），词法检索回落 LIKE`);
    }
    // Unique index for fact dedup (per-project: same SPO allowed across projects)
    // v1.23.1-fix: 不再每次启动 DROP。旧实现 DROP 成功、CREATE 因历史重复失败且被吞掉，
    // 此后 saveFacts 的 ON CONFLICT 目标消失 → 每次 prepare 直接抛错，facts 静默断流。
    // 现在只补建缺失索引；建不起来只告警（saveFacts 已改为显式 update/insert，不再依赖该索引）。
    try {
        const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_facts_spo'").get();
        if (!idx) {
            db.exec(`CREATE UNIQUE INDEX idx_facts_spo ON facts(subject, predicate, object, project)`);
        }
    }
    catch (e) {
        console.error(`[db] facts 唯一索引未建立（存在重复 SPO 或旧库）: ${e.message}`);
    }
    try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject, is_active)`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e);
    }
    // 指令表(保持原 schema:项目库也建;三层指令路由在 instructions.ts 决定)
    initInstructionsSchema(db);
    // ═══ v5.0 迁移：4096-dim → 1024-dim (Yuan-EB) ═══
    const SCHEMA_VERSION = 5;
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER)`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e);
    }
    const currentVersion = db.prepare('SELECT MAX(version) as v FROM _schema_version').get()?.v || 0;
    if (currentVersion < SCHEMA_VERSION) {
        console.log(`[db] migrating schema v${currentVersion} → v${SCHEMA_VERSION}`);
        try {
            db.exec(`DROP TABLE IF EXISTS vec_memory`);
        }
        catch (_e) {
            debugCatch('db:ddl', _e);
        }
        try {
            db.exec(`DROP TABLE IF EXISTS vec_facts`);
        }
        catch (_e) {
            debugCatch('db:ddl', _e);
        }
        try {
            db.exec(`DELETE FROM embedding_cache`);
        }
        catch (_e) {
            debugCatch('db:ddl', _e);
        }
        db.prepare('INSERT OR REPLACE INTO _schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
        console.log(`[db] migration complete: vec tables will be created with ${vecDim()}-dim`);
    }
    // v1.25: 维度按配置对齐(换模型/换维度不必改源码),再按当前维度建表
    reconcileVecDim(db);
    try {
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding float[${vecDim()}])`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e);
    }
    try {
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(embedding float[${vecDim()}])`);
    }
    catch (_e) {
        debugCatch('db:ddl', _e);
    }
    // v1.26: 嵌入空间(模型+维度)对齐 —— 换模型但维度不变时,旧向量属于另一语义空间,必须失效重嵌。
    // 放在建表之后、批量嵌入之前;EMBED_MODE=none 时只告警不动数据。
    ensureEmbedSpace(db);
    // v1.25-fix: 孤儿向量自愈(硬删残留 / 历史 bug 留下的 rowid 已不存在的 vec 行)。
    // 必须在 vec 表建好之后、批量嵌入之前跑;每库每进程只跑一次。
    healVecOrphans(db);
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
    static connections = new Map();
    /**
     * memdir 分库(memory/<project>/<memType>/memory.sqlite):memType 缺省 → general(默认/元数据库)。
     * 四分类:user/feedback/project/reference。project 为空 → 默认项目(default)。
     * 首次访问某项目时懒加载创建,并登记进 global.sqlite 的 projects 表。
     * 兼容模式(MEMORY_DB_PATH 显式设置):所有 project 落到同一个单库,行为不变。
     */
    static getInstance(project, memType) {
        const proj = normalizeProject(project);
        if (isLegacyMode()) {
            if (!warnedLegacy) {
                warnedLegacy = true;
                console.error('[db] ⚠️ MEMORY_DB_PATH 已弃用:建议改用 MEMORY_DB_DIR(按项目分库)。当前以单库兼容模式运行,不创建 memory/ 目录。');
            }
            return DatabaseManager.open('__legacy__', legacyDbPath(), initProjectSchema);
        }
        const mt = normalizeMemType(memType);
        const db = DatabaseManager.open(`project:${proj}:${mt}`, path.join(memDir(), safeFilePart(proj), memTypeDir(mt), 'memory.sqlite'), initProjectSchema);
        // 项目注册表(global.sqlite):懒加载登记
        try {
            const g = DatabaseManager.getGlobal();
            g.prepare('INSERT OR IGNORE INTO projects (project) VALUES (?)').run(proj);
        }
        catch (e) {
            console.error('[db] register project failed:', e.message);
        }
        return db;
    }
    /**
     * 项目下**实际存在**的分类库(不创建空库)。
     * 只读工具用它遍历,避免 stats_get/context 在项目目录不存在时凭空造出 5 个 sqlite。
     */
    static existingMemTypes(project) {
        const proj = normalizeProject(project);
        if (isLegacyMode())
            return ['general'];
        return listMemTypeDirs(proj).filter((mt) => fs.existsSync(path.join(memDir(), safeFilePart(proj), memTypeDir(mt), 'memory.sqlite')));
    }
    /**
     * 跨分类库查询:对项目下每个已存在的 memType 库执行同一条 SQL,合并结果。
     * 调用方负责跨库排序/截断(每个库的 LIMIT 各自生效,不能直接当全局 LIMIT)。
     */
    static queryAll(project, sql, params = []) {
        const proj = normalizeProject(project);
        if (isLegacyMode())
            return DatabaseManager.getInstance(proj).prepare(sql).all(...params);
        const out = [];
        for (const mt of DatabaseManager.existingMemTypes(proj)) {
            try {
                out.push(...DatabaseManager.getInstance(proj, mt).prepare(sql).all(...params));
            }
            catch { /* 单个分类库损坏不阻断其它库 */ }
        }
        return out;
    }
    /** 全局库(global.sqlite):L1/L2 指令 + rule 规则组 + 项目注册表。兼容模式下返回单库。 */
    static getGlobal() {
        if (isLegacyMode())
            return DatabaseManager.getInstance();
        return DatabaseManager.open('global', path.join(memDir(), 'global.sqlite'), initGlobalSchema);
    }
    static open(key, dbPath, init) {
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
    static checkpoint() {
        let pages = 0;
        let walSize = 0;
        for (const db of DatabaseManager.connections.values()) {
            try {
                const before = db.pragma('wal_checkpoint(TRUNCATE)');
                pages += before?.checkpointed ?? 0;
                walSize += before?.wal_size ?? 0;
            }
            catch { /* ignore */ }
        }
        return { walSize, pages };
    }
    /** 关闭所有打开的库连接 */
    static close() {
        DatabaseManager.checkpoint();
        for (const db of DatabaseManager.connections.values()) {
            try {
                db.close();
            }
            catch { /* ignore */ }
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
export function sweepExpiredSessionMemories(project) {
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
        // v1.23.2-fix: 硬删必须同时清 vec_memory / edges，否则孤儿向量会被 KNN 命中，
        // rowid 复用时还会撞 vec0 主键让下一次 saveMemory 整笔回滚。
        try {
            const rows = db.prepare(`
        SELECT rowid, id FROM memory
        WHERE source = 'session_memory' AND session_id IS NOT NULL AND is_active = 1
          AND updated_at < ?
      `).all(cutoff);
            if (rows.length) {
                const tx = db.transaction(() => {
                    const delVec = db.prepare('DELETE FROM vec_memory WHERE rowid = ?');
                    const delEdge = db.prepare('DELETE FROM edges WHERE source_id = ? OR target_id = ?');
                    for (const row of rows) {
                        try {
                            delVec.run(row.rowid);
                        }
                        catch { /* 无 vec 表 */ }
                        try {
                            delEdge.run(row.id, row.id);
                        }
                        catch { /* 无 edges 表 */ }
                    }
                    return db.prepare(`
            DELETE FROM memory
            WHERE source = 'session_memory' AND session_id IS NOT NULL AND is_active = 1
              AND updated_at < ?
          `).run(cutoff).changes;
                });
                total += tx();
            }
        }
        catch { /* 单库失败不影响其它库 */ }
    }
    return total;
}
