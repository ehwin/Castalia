/**
 * 三层指令记忆(instruction memory) + 两种上下文路由机制
 *
 * 类比 Claude Code 的 CLAUDE.md 层级:
 *   L1 global   — 所有用户/所有项目通用规则(首次启动写入全局规范种子)
 *   L2 user     — 当前用户所有项目共享(用户自填,无种子)
 *   L3 project  — 单项目专属规则(scope=project + project 名)
 *   rule        — 规则组(scope='rule', project=组名),仅作为 include 引用的可复用块
 *
 * 加载机制(关键):查找从近到远 L3→L2→L1;文本拼接喂给 LLM 时从远到近 L1→L2→L3。
 * L3 落在 Prompt 最末尾,利用 LLM 近因效应实现「后加载约束更高」,可覆盖 L1/L2 冲突规则。
 *
 * 路由机制 ① @include 递归:指令 content 内可写
 *   include: "rule:typescript-core"           → 引用单个规则组
 *   include: ["rule:a", "rule:b"]             → 引用多个规则组
 *   展开时替换为「[规则组 <组名>]\n<该组内容>」,规则组内容可再 include,深度上限 5,
 *   环路引用(seenSet 记录当前展开链)与超深均截断并注入 ⚠️ 警告行。
 *
 * 路由机制 ② Glob 条件过滤:指令可带 paths(JSON 数组,如 ["src/**","!src/temp/**"]),
 *   memory_context 传 path 时,getInstruction 只返回 paths 为空或匹配该 path 的指令。
 *   取反规则:前缀 ! 的模式命中即排除(后出现者覆盖先出现者,类似 .gitignore last-match-wins)。
 */
import { DatabaseManager, generateId, listProjectNames } from './db.js';
import picomatch from 'picomatch';
/** L1 全局种子:用户提供的全局规范全文 */
export const INSTRUCTION_SEED_GLOBAL = `以下是全局规范
1. 核心工作原则:代码可读性与类型安全,优先保证逻辑清晰与类型严谨;做最小化变更,仅修改与目标任务直接相关的代码,严禁无意义代码重排或不必要格式重构;环境安全优先,执行涉及文件删除、破坏性 Git 操作或网络请求的工具指令前务必谨慎确认。
2. 编码规范:TypeScript/JavaScript 严格禁止 any,优先定义 interface/type,ES6+ 语法优先 async/await,字符串统一单引号,2 空格缩进;Python 遵从 PEP 8,函数与类型标注完善(Type Hints),Python 3.10+,4 空格缩进;错误处理显式捕获异常,禁止空 catch 块,提供有意义且便于调试的错误日志。
3. 工具使用与交互约束:修改代码后主动运行相关 Lint 或单测验证,禁止抛出未经验证的代码;测试失败先读终端日志定位原因,不盲目重复同一种修补方案;耗时长的脚本或服务启动命令必须设置合理超时或后台挂起;查看日志或搜索代码限制输出行数(head/grep/--max-count),避免大文本污染。
4. 提交与文档规范:Git Commit 格式 <type>(<scope>): <short summary>,type 含 feat/fix/refactor/docs/test/chore,提交信息简洁,英文首字母小写,结尾不加句号;新增核心功能或修改架构接口时同步更新 README/API 文档。`;
/**
 * 首次启动:表内无任何指令时写入 L1 全局种子。
 * 返回是否真的写入了种子 + 当前表内条数。
 */
/**
 * 指令存储路由:v6.0 起分库。
 * L1(global)/L2(user)/rule(规则组) → global.sqlite(跨项目共享,rule 可被任何项目 include);
 * L3(scope=project) → 对应项目库(project-<name>.sqlite)。
 */
function dbForScope(scope, project) {
    if (scope === 'project') {
        return project ? DatabaseManager.getInstance(project) : DatabaseManager.getInstance();
    }
    return DatabaseManager.getGlobal();
}
export function ensureSeedInstructions() {
    const db = DatabaseManager.getGlobal();
    const row = db.prepare('SELECT COUNT(*) as c FROM instructions').get();
    const count = row.c;
    if (count > 0)
        return { seeded: false, count };
    db.prepare('INSERT INTO instructions (id, scope, project, content) VALUES (?, ?, ?, ?)')
        .run(generateId(), 'global', null, INSTRUCTION_SEED_GLOBAL);
    return { seeded: true, count: 1 };
}
/**
 * upsert:同 scope+project 覆盖更新(global/user 的 project 传 null;rule 的 project=组名)。
 * paths 为可选 glob 列表(JSON 数组存 DB),传 undefined/null/空数组 = 无路径限制。
 * 返回该行 id 与是否新建(created=false 表示覆盖更新)。
 */
export function saveInstruction(scope, project, content, paths) {
    const db = dbForScope(scope, project);
    const existing = db.prepare('SELECT id FROM instructions WHERE scope = ? AND project IS ?').get(scope, project);
    const pathsJson = paths && paths.length > 0 ? JSON.stringify(paths) : null;
    if (existing) {
        db.prepare('UPDATE instructions SET content = ?, paths = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(content, pathsJson, existing.id);
        return { id: existing.id, created: false };
    }
    const id = generateId();
    db.prepare('INSERT INTO instructions (id, scope, project, content, paths) VALUES (?, ?, ?, ?, ?)').run(id, scope, project, content, pathsJson);
    return { id, created: true };
}
// ═══════════════════════════════════════════════════════════════════
// 路由机制 ② Glob 条件过滤(picomatch)
// ═══════════════════════════════════════════════════════════════════
/** 编译缓存:key=pattern,避免重复编译 */
const matcherCache = new Map();
function getMatcher(pattern) {
    let m = matcherCache.get(pattern);
    if (!m) {
        m = picomatch(pattern);
        matcherCache.set(pattern, m);
    }
    return m;
}
/** 解析 DB 里的 paths TEXT(JSON 数组)为 string[];空/null/非法 → null */
export function parsePaths(raw) {
    if (!raw)
        return null;
    try {
        const v = JSON.parse(raw);
        if (Array.isArray(v)) {
            const arr = v.filter((x) => typeof x === 'string');
            return arr.length > 0 ? arr : null;
        }
    }
    catch { /* ignore */ }
    return null;
}
/**
 * 判断 path 是否命中 paths 过滤集。
 * - paths 为空/未传 → 不限(返回 true)
 * - path 为空/未传 → 不限(返回 true)
 * - 语义:last-match-wins,前导 ! 的模式命中即排除;至少一条正向模式命中才放行。
 *   Windows 反斜杠统一转成正斜杠再匹配。
 */
export function matchPaths(paths, path) {
    if (!paths || paths.length === 0)
        return true;
    if (path === undefined || path === null || path === '')
        return true;
    const p = path.replace(/\\/g, '/');
    let allowed = false;
    for (const raw of paths) {
        if (raw.startsWith('!')) {
            if (getMatcher(raw.slice(1))(p))
                allowed = false;
        }
        else if (getMatcher(raw)(p)) {
            allowed = true;
        }
    }
    return allowed;
}
// ═══════════════════════════════════════════════════════════════════
// 路由机制 ① @include 递归展开(规则组引用)
// ═══════════════════════════════════════════════════════════════════
/** include 递归深度上限(超过截断 + 警告) */
export const MAX_INCLUDE_DEPTH = 5;
const INCLUDE_LINE_RE = /^\s*include\s*:\s*(.+?)\s*$/;
/** 解析 include 行后的值:优先 JSON(string | string[]),失败按逗号切分 */
export function parseIncludeRefs(raw) {
    const t = raw.trim();
    try {
        const v = JSON.parse(t);
        if (typeof v === 'string')
            return [v];
        if (Array.isArray(v))
            return v.filter((x) => typeof x === 'string');
    }
    catch { /* not JSON */ }
    return t.split(',').map(s => s.trim()).filter(Boolean);
}
/** 取规则组内容(scope='rule', project=组名);规则组放 global.sqlite,可被任何项目 include 引用 */
export function getRuleGroup(name) {
    const db = DatabaseManager.getGlobal();
    const row = db.prepare('SELECT content, paths FROM instructions WHERE scope = ? AND project = ?').get('rule', name);
    if (!row)
        return null;
    return { content: row.content, paths: parsePaths(row.paths) };
}
/**
 * 递归展开 content 中的 include 引用。
 * @param content 原始指令文本
 * @param depth   当前深度(顶层 0;每 include 一层 +1)
 * @param seen    当前展开链上的规则组名(环路检测)
 * @param path    调用方传入的路径(可选);规则组自身 paths 非空时不匹配则整组跳过
 */
export function expandInstruction(content, depth = 0, seen = new Set(), path) {
    const out = [];
    for (const line of content.split('\n')) {
        const m = line.match(INCLUDE_LINE_RE);
        if (!m) {
            out.push(line);
            continue;
        }
        for (const ref of parseIncludeRefs(m[1])) {
            if (!ref.startsWith('rule:')) {
                out.push(`⚠️ [include] 未知引用类型:${ref}(仅支持 rule:<组名>)`);
                continue;
            }
            const name = ref.slice('rule:'.length).trim();
            if (!name)
                continue;
            const rule = getRuleGroup(name);
            if (!rule) {
                out.push(`⚠️ [include] 未找到规则组 "${name}"`);
                continue;
            }
            if (seen.has(name)) {
                out.push(`⚠️ [include] 环路引用已截断:"${name}"(出现在当前展开链)`);
                continue;
            }
            if (depth >= MAX_INCLUDE_DEPTH) {
                out.push(`⚠️ [include] 超过 ${MAX_INCLUDE_DEPTH} 层深度上限,"${name}" 已截断`);
                continue;
            }
            // 规则组自身带 paths 时也受调用方 path 过滤(为空则跟随引用方)
            if (rule.paths && rule.paths.length && path !== undefined && !matchPaths(rule.paths, path))
                continue;
            const nextSeen = new Set(seen);
            nextSeen.add(name);
            out.push(`[规则组 ${name}]`);
            out.push(expandInstruction(rule.content, depth + 1, nextSeen, path));
        }
    }
    return out.join('\n');
}
/**
 * 按 L1→L2→L3 顺序返回拼接数组(每层最多一条),content 已 include 展开。
 * path 可选:只返回 paths 为空或匹配该 path 的指令;L3 仅在传入 project 时查询。
 */
export function getInstruction(project, path) {
    const gdb = DatabaseManager.getGlobal();
    const result = [];
    const cands = [];
    const l1 = gdb.prepare('SELECT scope, project, content, paths FROM instructions WHERE scope = ?').get('global');
    const l2 = gdb.prepare('SELECT scope, project, content, paths FROM instructions WHERE scope = ?').get('user');
    if (l1)
        cands.push(l1);
    if (l2)
        cands.push(l2);
    const proj = (project ?? '').trim();
    if (proj.length > 0) {
        // L3(scope=project) 存在对应项目库
        const pdb = DatabaseManager.getInstance(proj);
        const l3 = pdb.prepare('SELECT scope, project, content, paths FROM instructions WHERE scope = ? AND project = ?').get('project', proj);
        if (l3)
            cands.push(l3);
    }
    for (const row of cands) {
        if (!matchPaths(parsePaths(row.paths), path))
            continue;
        result.push({
            scope: row.scope,
            project: row.project,
            paths: parsePaths(row.paths),
            content: expandInstruction(row.content, 0, new Set(), path),
        });
    }
    return result;
}
/** admin:全部列出(global/user/project/rule 按层排序,带 updated_at),content 为原始未展开文本。
 *  L1/L2/rule 来自 global.sqlite;L3(project)散落在各项目库,遍历 memory/ 目录聚合。 */
export function listInstructions() {
    const rows = [];
    const gdb = DatabaseManager.getGlobal();
    rows.push(...gdb.prepare(`
    SELECT id, scope, project, content, paths, updated_at FROM instructions
    WHERE scope != 'project'
    ORDER BY CASE scope WHEN 'global' THEN 1 WHEN 'user' THEN 2 ELSE 3 END, project
  `).all());
    // L3 项目指令:每个已有项目库各查一条 scope='project'
    for (const name of listProjectNames()) {
        try {
            const pdb = DatabaseManager.getInstance(name);
            const projRows = pdb.prepare(`
        SELECT id, scope, project, content, paths, updated_at FROM instructions
        WHERE scope = 'project'
        ORDER BY project
      `).all();
            rows.push(...projRows);
        }
        catch { /* 打不开的库跳过 */ }
    }
    rows.sort((a, b) => {
        const rank = (s) => (s === 'global' ? 1 : s === 'user' ? 2 : 3);
        return rank(a.scope) - rank(b.scope) || String(a.project || '').localeCompare(String(b.project || ''));
    });
    return rows.map(r => ({
        id: r.id,
        scope: r.scope,
        project: r.project,
        content: r.content,
        paths: parsePaths(r.paths),
        updatedAt: r.updated_at,
    }));
}
/** admin:删一层(global/user 的 project 传 null);返回是否删到。
 *  L1/L2/rule → global.sqlite;L3(project) → 对应项目库。 */
export function deleteInstruction(scope, project) {
    const db = dbForScope(scope, project ?? null);
    const r = db.prepare('DELETE FROM instructions WHERE scope = ? AND project IS ?').run(scope, project ?? null);
    return { deleted: r.changes > 0 };
}
