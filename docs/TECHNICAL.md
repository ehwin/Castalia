# Castalia 技术文档(Technical Design)

> 版本:v1.11 · 2026-08-05 · 对应代码提交 `79b2d88`(GitHub: ehwin/Castalia)

Castalia 是一个**标准 MCP stdio 记忆服务器**——为 Agent Harness(Claude Code、OpenCode、Hermes 等)提供分层化、可检索、可维护的长期记忆。本文档描述其架构设计、数据模型、管线流程与关键实现决策。

---

## 1. 设计目标与原则

| 原则 | 含义 |
|---|---|
| **记忆必须分层** | 任何记忆都有明确归属(项目级/会话级 + 4 种封闭类型),**不允许无分类的随意填入**——即便向量检索能兜底语义召回 |
| **本地优先,零 API 存储成本** | SQLite + sqlite-vec,嵌入模型本地缓存,离线可用 |
| **LLM 只做语义判断,不做机械操作** | 分拣/反思/整合等"判断"交给 LLM(小模型),去重/落库/清理等"机械"操作全确定性脚本 |
| **按项目物理隔离** | 每项目一个 .sqlite,备份/删除/向量 KNN 天然隔离 |
| **不阻塞主对话** | 所有后台维护(反思/整合/清扫)异步执行,绝不阻塞 MCP 响应 |
| **兼容演进** | 每版本向后兼容,旧配置/旧数据平滑过渡 |

---

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────────────┐
│                        MCP stdio 边界                                 │
│  29 tools: agent(6 只读) / harness(11 写入) / admin(12 管理)          │
└───────────────┬──────────────────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────────────┐
│                       三通道 LLM 管线                                 │
│                                                                      │
│  ① LLM1 (triage)  入站分拣 + 渐进式临时反思     TRIAGE_LLM_*          │
│  ② 向量模型        记忆改动后嵌入(1024-dim)      OLLAMA_URL / EMBEDDING_MODEL │
│  ③ LLM2 (reflect) 每日反思 + 记忆整合           REFLECT_LLM_*          │
└───────────────┬──────────────────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────────────┐
│                    存储层:memory/ 目录(SQLite 分库)                   │
│  global.sqlite          指令 L1/L2 + 规则组 + 项目注册表               │
│  project-<name>.sqlite  每项目一库:记忆/向量/facts/指令L3             │
│  config.json            三通道配置                                    │
│  receipts/              反思回执                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. 数据模型

### 3.1 memory 表(每项目库)

```sql
CREATE TABLE memory (
  id            TEXT PRIMARY KEY,          -- UUID
  text          TEXT NOT NULL,             -- 内容(Markdown 结构,封闭类型强制)
  project       TEXT DEFAULT 'default',    -- 项目命名空间
  session_id    TEXT,                      -- NULL=项目级;非NULL=会话级滚动记忆
  type          TEXT DEFAULT 'episodic',   -- 性质维度:episodic/semantic/entity/preference
  mem_type      TEXT DEFAULT 'general',    -- 用途维度:user/feedback/project/reference/general
  category      TEXT DEFAULT 'general',    -- 自由标签
  tags          TEXT DEFAULT '[]',         -- JSON 数组
  importance    REAL DEFAULT 0.5,
  character_id  TEXT,                      -- 角色/实例分区
  source        TEXT,                      -- conversation_log/session_memory/reflect_*/manual_lore...
  subject       TEXT DEFAULT 'user',
  tier          TEXT DEFAULT 'standard',   -- temporary/standard/critical
  expires_at    DATETIME,
  is_active     INTEGER DEFAULT 1,         -- 软删除标记
  created_at / updated_at / last_accessed_at DATETIME,
  accessed_count / reference_count INTEGER DEFAULT 0,
  locked        INTEGER DEFAULT 0
);
```

**两个正交维度**(核心设计):

| 维度 | 字段 | 回答的问题 |
|---|---|---|
| 性质(type) | episodic/semantic/entity/preference | "这条记忆是什么性质?"(事件/知识/实体/偏好) |
| 用途(mem_type) | user/feedback/project/reference/general | "这条记忆拿来干什么?"(画像/纠错/项目/指针) |

一条记忆可同时是 `type=episodic` + `mem_type=feedback`(性质是事件,用途是行为纠正)。

### 3.2 4 种封闭类型(Claude Code 模式)

| mem_type | 含义 | 示例 | 强制 Markdown |
|---|---|---|---|
| `user` | 用户画像:偏好/技术栈/风格/人物关系 | "偏好 TypeScript,禁止 any" | ✅ |
| `feedback` | 行为纠正(正负双向都记) | "不要写内联 mock" / "这种拆分很好,保持" | ✅ |
| `project` | 项目上下文(非代码可推导) | "数据库端口 5433,上线 2026-09-01" | ✅ |
| `reference` | 外部指针(URL/ID/文档) | "Swagger: https://api.internal/v1/docs" | ✅ |
| `general` | 显式声明的通用记忆(非兜底) | — | ❌ |

封闭类型写入时自动 Markdown 规范化(`# User Profile: <标题>` + `- ` 列表),增强 LLM 阅读理解。

### 3.3 指令表(三层 + 规则组)

```sql
CREATE TABLE instructions (
  id TEXT PRIMARY KEY,
  scope TEXT CHECK(scope IN ('global','user','project','rule')),
  project TEXT,          -- scope=project 时项目名;scope=rule 时组名
  content TEXT NOT NULL, -- 支持 include: "rule:<组名>" 递归引用
  paths TEXT,            -- JSON 数组,glob 条件过滤
  updated_at DATETIME
);
```

### 3.4 向量表(sqlite-vec,1024 维)

```
vec_memory(rowid → memory.rowid, embedding)   -- 记忆向量
vec_facts(rowid → facts.rowid, embedding)     -- facts 向量
```

**关键约束**:sqlite-vec 的 vec0 虚拟表 KNN 查询**不允许 JOIN**——所有向量检索都是"全库 KNN 取候选集 → 第二段查询按 project/character 过滤",候选集适当放大保证单项目召回。

---

## 4. 写入管线(入站分层)

```
auto_process(userMessage, assistantMessage, sessionId?)
  │
  ├─ saveConversationTurn → 原文落库(source=conversation_log, 项目级)
  │
  ├─ [LLM1] 入站分拣:文本 → mem_type(user/feedback/project/reference)
  │     classifyMemTypeLLM(triage 通道,失败兜底 general + 警告)
  │
  └─ [SessionMemoryBuffer] sessionId 传入时:
        pendingCount++ → 达 BUFFER_SIZE(默认5)→ 后台异步
        └─ runIncrementalReflection(LLM1):
             输入 = 会话旧快照 + 最近 10 条增量
             输出 = { sessionMemory(滚动状态), promoted(长效干货) }
             ├─ promoted → 晋升项目级(session_id=NULL, Markdown) → 晋升即删会话碎片
             ├─ sessionMemory → 滚动覆盖(session_id 非空)
             └─ 失败静默(console.error),不阻塞
```

**分层语义**:

| 层 | session_id | 生命周期 | 维护者 |
|---|---|---|---|
| 项目级 | NULL | 长期 | LLM2 每日反思 + 临时反思晋升 |
| 会话级 | 非空 | 临时(默认 7 天 TTL) | LLM1 渐进式临时反思 |

**写入校验**(v1.11.3 debug 修复):`memory_save` 拒绝空/纯空白文本(zod min(1) + saveMemory trim 防御);非法 memType 由 zod 拒绝;项目名 `safeFilePart` 安全化防路径逃逸。

---

## 4.5 MCP 上下文注入模型(三层注入定义)

> 定义依据:Claude Code / 标准 Agent 架构的"工具驱动唤醒(Tool-Driven Injection)+ Prompt 规范引导"范式。本记忆体作为 MCP Server,对上下文的注入遵循三层模型:

### 层 1 — 启动/系统级(Static Warm-up)

**职责**:告知 LLM"存在一个项目级 SQLite 记忆库,格式为 Markdown,有哪些工具、何时该调用"。

**Castalia 实现**:每个工具的 description 字段(如 `memory_context` 描述"Assemble an injection-ready context bundle...")即层 1 素材;最终拼装进 System Prompt 的动作在 **harness 侧**(MCP 协议只提供工具 schema 与描述)。

```typescript
// harness 侧示例(定义文档用,非 Castalia 代码)
<mcp_memory_guidelines>
- memory_context: 任务开始时调用,获取用户偏好/项目约定/任务相关记忆
- memory_save: 用户表达明确偏好/行为纠正/项目约束时调用
- 高优先级记忆必须尊重,避免询问已在记忆中回答的问题
</mcp_memory_guidelines>
```

### 层 2 — 主动按需召回(Dynamic Active Retrieval)—— MCP 核心机制 ✅ 已实现

**职责**:用户发消息 → LLM 识别需要记忆 → 主动 Tool Call `memory_context(query, project?, sessionId?)` → MCP Server 检索 SQLite 物理分库 → 返回带 Snapshot Warning 的 Markdown 分节 → 注入上下文窗口。

**Castalia 实现**(完整支持):
- `memory_context` 工具:三层指令 + 会话滚动状态 + 近期/相关记忆 + 经验沉淀 + 已知事实 + 记忆索引,`asText` 选项
- **Snapshot Warning**:旧记忆(≥1 天)注入时自动追加 `> ⚠️ [Memory Snapshot Warning] ...` 防止把历史快照当当前事实
- **物理分库检索**:按 `project` 路由到对应 `project-<name>.sqlite`,向量 KNN 不跨项目

### 层 3 — 被动只读挂载(Passive Read-Only Injection)—— 需 harness 配合

**职责**:不依赖 LLM 主动调用,harness 在每轮请求末尾自动拼接 `<system-reminder>` 记忆块(只读、防污染)。

**Castalia 实现**:提供 `context_get`(轻量召回:近期记忆 + 统计)作为素材源;**挂载动作在 harness 侧**——harness 依据用户意图自动查 Top-K 记忆,以 `<system-reminder>` 标签拼在最后一个 User Message 底部。

```typescript
// harness 侧示例(定义文档用,非 Castalia 代码)
const memoryBlock = `<system-reminder>
# PROJECT LONG-TERM MEMORY (Auto-Injected)
${topMemories.map(m => `- [${m.type.toUpperCase()}] ${m.title}: ${m.content}`).join('\n')}
</system-reminder>`;
```

### 三层职责边界(重要澄清)

| 层 | 动作发生在 | Castalia 角色 |
|---|---|---|
| 层 1 系统级 | harness(System Prompt 组装) | 提供工具描述(schema) |
| 层 2 主动召回 | **MCP 协议**(LLM → tool call) | ✅ 完整实现(memory_context) |
| 层 3 被动挂载 | harness(消息末尾拼接) | 提供素材(context_get) |

> **官方定义文案**:本 MCP 记忆体采用"**主动 Tool 召回 + 被动 `<system-reminder>` 挂载**"的双轨上下文注入机制:主动模式由 Agent 通过 MCP 标准协议调用 `memory_context(query)`,Server 检索 SQLite 物理分库,返回结构化、带快照时间警告的 Markdown 文本片段;被动模式由 Harness 在请求发送前依用户意图自动提取 Top-K 记忆,以只读 `<system-reminder>` 标签挂载于 Prompt 末尾。**层 2 由本 Server 完整实现;层 1/层 3 的注入动作发生在 Harness 侧,本 Server 提供工具描述与轻量查询接口作为支撑。**

## 5. 读取管线(memory_context 注入包)

组装顺序(指令在最前,约束递增):

```
【指令(全局→项目,项目约束最高)】
  [全局] L1 指令(可 include 规则组,glob 过滤)
  [用户] L2 指令
  [项目] L3 指令
【会话滚动状态】(sessionId 传入时,渐进式反思快照)
【当前记忆上下文】总记忆 N 条
  ■ 近期重要记忆(近 X 小时)     ← 旧记忆带 ⚠️ Memory Snapshot Warning
  ■ 与当前任务相关:「query」     ← 三路召回(标签+向量+文本),旧记忆带警告
  ■ 经验沉淀(决策/教训/模式)
  ■ 已知事实(facts)
  ■ 记忆索引(150 字摘要,详情 memory_get 展开)
【要求】...
```

**Memory Snapshot Warning**(v1.10.1):记忆年龄 ≥1 天时注入 `> ⚠️ [Memory Snapshot Warning] 该记忆记录于 X 天前,属于历史快照,引用前请以最新对话/代码为准`——防止 LLM 把旧记忆当"当前事实"硬依赖。

**先索引后详情**(v1.8):`memory_index` 只返回 150 字摘要,命中后 `memory_get(id)` 拉全文——省 token。

---

## 6. 后台维护管线

| 触发 | 条件 | 动作 |
|---|---|---|
| **启动自动反思**(v1.9) | 距上次反思 ≥24h 且未分析对话 >5 | LLM2 runAutoReflect(提取 facts/记忆) |
| **启动自动整合**(v1.10) | active 记忆 >15 条 | consolidate_deep(向量预筛→LLM 去重/矛盾消解/归并) |
| **启动 TTL 清扫**(v1.11) | 会话记忆 >7 天无活动 | 删孤儿 session_memory |
| 每 30min | — | WAL checkpoint + 过期 temporary 清理 |
| 每 24h | — | consolidate() sigmoid 衰减 + 升华 |

**Consolidator 流程**(v1.10,吸收 Claude Code 原厂):
```
findSimilarCandidates(cos > 0.88, 上限50对)  ← 向量预筛,省 token
  → MEMORY_CONSOLIDATION_PROMPT(原厂规则:
      矛盾消解-ALWAYS 偏最新用户决定 / 去重归并-保持4封闭类型
      剪枝-删临时调试/相对日期转绝对 / NEVER invent new facts)
  → applyReflectActions(原子事务)
```

---

## 7. 三通道 LLM 配置

| 通道 | env | config.json | 用途 | 缺省 |
|---|---|---|---|---|
| LLM1 triage | `TRIAGE_LLM_URL/_API_KEY/_MODEL` | `triage.*` | 入站分拣 + 增量反思 | 回退 REFLECT_* |
| 向量 | `OLLAMA_URL/EMBEDDING_MODEL/EMBED_MODE` | `embedding.*` | 记忆改动后嵌入 | 11436 本地 |
| LLM2 reflect | `REFLECT_LLM_URL/_API_KEY/_MODEL` | `reflect.*` | 每日反思 + 整合 | 无 key 跳过 |

`makeLlmChannel(prefix)` 逐字段回退:前缀通道 → REFLECT_* → 内置默认(https://api.deepseek.com/v1, deepseek-chat)。无任何 LLM key 时服务器仍是完整读写记忆库,仅反思/分拣跳过。

---

## 8. 工具清单(29)

| 分组 | 工具 |
|---|---|
| **agent(6)** 只读 | `memory_search` `fact_search` `memory_get` `memory_recent` `memory_index` `memory_graph` |
| **harness(11)** 写入 | `auto_process` `conversation_save` `digest_run` `reflect_auto` `reflect_deep` `reflect_batch_embed` `memory_save` `memory_update` `memory_delete` `memory_log` `instruction_save` |
| **admin(12)** 管理 | `memory_list` `stats_get` `recent_conversations` `daily_summary_data` `reflect_analyze` `reflect_apply` `memory_context` `context_get` `project_list` `instruction_list` `instruction_delete` `consolidate_deep` |

暴露面原则:主 agent 只读,写入归 harness,管理归 admin——`MCP_TOOLS` 环境变量控制(`agent`/`harness`/`admin`/`all`/逗号列表)。

---

## 9. 关键实现决策记录

| 决策 | 理由 |
|---|---|
| **每项目一个 .sqlite**(v1.7) | 物理隔离:备份/删除按项目粒度,向量 KNN 不串项目;单库数据量撑得住但管理粒度粗 |
| **mem_type 与 type 正交**(v1.8) | 用途维度与性质维度不冲突,一条记忆可同时表达两者 |
| **SQLite 存储 + Markdown 内容**(v1.8) | 不生成实体 .md 文件,但内容按 Markdown 组织——兼得数据库管理能力与 LLM 理解力 |
| **渐进式临时反思**(v1.11) | 5 轮攒批 + 后台异步 + 增量提炼(旧快照+10条),token 极省,零响应延迟;晋升即删 + TTL 兜底闭环 |
| **正则分拣被否决**(v1.11 决策) | "以后别用 npm 了改用 pnpm"(feedback)vs"项目用的是 pnpm"(project)vs"我是 pnpm 粉丝"(user)——规则匹配无法区分,LLM 语义分拣才是正解 |
| **consolidate_deep 向量预筛**(v1.10) | 相似对先筛出来只喂候选给 LLM,省 90% token;无候选不调 LLM |
| **JIT 工具加载不做**(v1.6.1) | MCP tools/list 每连接只发现一次、stdio 无重注册通道、动态隐藏破坏 harness 白名单——路径控制改在数据层(glob 过滤) |

---

## 10. 调试与验证方法

- `npm run build` + `python scripts/smoke_test.py`(29 工具全链路,无需嵌入服务)
- `python scripts/vec_test.py`(需要 11436 嵌入服务)
- 独立 e2e(MCP stdio + mock LLM + 独立 MEMORY_DB_DIR):每个版本功能都有独立复验脚本,不采信实现方自报
- 已知坑:
  - **vec0 KNN 禁 JOIN**——向量检索必须两段查询
  - **Windows ESM import**——node runner 测试需 `file://` URL
  - **旧版 MCP 实例会把 memory.sqlite 写回项目根**——与 v1.7+ 的 memory/ 目录冲突,需重启旧实例
  - **Windows 文件句柄延迟**——测试目录删除需重试/等锁释放

---

## 11. 版本演进摘要

| 版本 | 内容 |
|---|---|
| v1.5 | 项目隔离(project 列) |
| v1.5.3 | 嵌入三档(EMBED_MODE=none/ollama/api) |
| v1.5.4 | facts 写入链路打通(独立反思 agent) |
| v1.6 | 三层指令记忆(全局/用户/项目) |
| v1.6.1 | 上下文路由(include 递归 + picomatch glob) |
| v1.7 | 按项目分库(Project-per-DB) |
| v1.7.1 | 存储统一收敛 memory/ 目录 |
| v1.8 | 4 种封闭类型 + Markdown 内容 + memory_index |
| v1.9 | 启动自动反思(24h + >5 条) |
| v1.10 | 记忆整合子进程(Consolidator) |
| v1.10.1 | Memory Snapshot Warning |
| v1.11 | 三通道架构:LLM1 分拣/向量/LLM2 反思 |
| v1.11.1 | 渐进式临时反思(缓冲+晋升+TTL) |
| v1.11.3 | debug:空文本修复 + 边界加固 |

---

## 12. 已知限制与后续方向

- **promoted 不即时嵌入**:临时反思晋升的记忆 `skipEmbed`,需 `reflect_batch_embed` 统一向量化(避免后台依赖嵌入服务)
- **维护性周期任务只作用于默认项目**:consolidate/digest 的多项目遍历未做(最小化)
- **Web 控制台数据接口只读默认库**:多项目聚合展示待做
- **promotedKeys 精确晋升即删**:当前简化"晋升成功后清空该会话碎片",未按 LLM 返回 key 精确删
- **空 catch 块无日志**:防御性降级(附属操作失败不阻塞主操作)但静默,后续可加 debug 级日志
