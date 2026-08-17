# Castalia 技术报告

> 版本:1.0.0(2026-08-03)
> 定位:标准 MCP stdio 记忆服务器,SQLite + sqlite-vec 本地向量存储,零 API 成本
> 架构血统:AIRI 记忆系统的独立分支,剥离人格化层后通用化,面向 agent harness

---

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    Web Console(web/server.mjs :3345)         │
│          3D 星图主界面 + 管理抽屉(反思/配置/记忆/日志)        │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP(直读 DB + MCP client)
┌──────────────────────────▼──────────────────────────────────┐
│                  MCP Server(dist/index.js, stdio)           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ 工具注册  │ │ 定时任务  │ │ 配置加载  │ │ 反思驱动        │  │
│  │ 25 工具   │ │ 4+1 项   │ │ env+json │ │ reflectDriver  │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───────┬────────┘  │
│       └────────────┴──────┬─────┴────────────────┘           │
│  ┌────────────────────────▼───────────────────────────────┐  │
│  │ 业务层: store / search / reflect / digest / consolidate│  │
│  └────────────────────────┬───────────────────────────────┘  │
│  ┌────────────────────────▼───────────────────────────────┐  │
│  │ 基础层: db(schema+vec) / ollama(嵌入双模式) / category  │  │
│  └────────────────────────┬───────────────────────────────┘  │
│  ┌────────────────────────▼───────────────────────────────┐  │
│  │ SQLite + sqlite-vec(1024 维)                           │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                           │ stdio
┌──────────────────────────▼──────────────────────────────────┐
│ 嵌入服务 yuan_embed_server.py(:11436,Ollama 兼容 /api/embed) │
│ 或任意 1024 维嵌入服务(含云端 API key 模式)                   │
└──────────────────────────────────────────────────────────────┘
```

**核心设计原则**:
- 标准 MCP 协议(2024-11-05),零自定义扩展——任何 MCP 客户端可接
- 本地优先:SQLite 单文件 + 本地嵌入,无外部服务依赖(嵌入可换云端)
- 分层隔离:存储/检索/反思/界面各司其职,人格化层已剥离

---

## 2. 模块职责(src,2976 行)

| 文件 | 行数 | 职责 |
|------|------|------|
| `index.ts` | 610 | MCP server 入口:注册 25 工具、启动定时任务、stdio 连接 |
| `db.ts` | 192 | SQLite 管理:schema 建表、sqlite-vec 加载、迁移、WAL checkpoint |
| `store.ts` | 417 | 记忆 CRUD:写入去重(精确+向量)、软删除、更新、对话存档、批量向量化、facts |
| `search.ts` | 439 | 检索:标签优先→向量 KNN→文本回退,中性评分 |
| `ollama.ts` | 108 | 嵌入调用:Ollama `/api/embed` / 云端 API `/embeddings` 双模式 + 双层缓存 |
| `reflect.ts` | 612 | 反思编排:analyze 打包、apply 执行动作(合并/拆分/提取/重分类/删除/关联)、图谱 |
| `reflectDriver.ts` | 239 | 反思驱动:拿记忆→调 LLM→解析 JSON 动作→应用(打包进 server) |
| `digest.ts` | 82 | 周期任务:清理过期临时记忆、恢复 critical 记忆(事件驱动) |
| `consolidate.ts` | 71 | 每日整合:sigmoid 时间衰减降权、reference_count 升华 |
| `autoProcessor.ts` | 42 | 对话轮次自动处理:存档 + 触发 digest |
| `category.ts` | 108 | 分层分类管理(11 预设分类 CRUD) |
| `configLoader.ts` | 41 | 启动时读 config.json 覆盖环境变量(嵌入/反思配置) |
| `env.ts` | 15 | 环境变量集中管理(CHAR_ID/SERVER_NAME/版本) |

---

## 3. 运行机制

### 3.1 启动流程

```
node dist/index.js
  → configLoader:读 config.json(存在则覆盖 OLLAMA_URL/EMBEDDING_*/REFLECT_*)
  → db:打开 SQLite + 加载 sqlite-vec + 建表/迁移(首次自动)
  → 注册 25 个 MCP 工具
  → 启动定时任务:
      ├─ 24h    consolidate(记忆整合/衰减)
      ├─ 1min   maybeDigest(事件驱动检查)
      ├─ 30min  WAL checkpoint
      ├─ 30min  过期临时记忆清理
      └─ 可选   REFLECT_INTERVAL_HOURS>0 时定时自动反思
  → 连接 stdio transport,就绪
```

### 3.2 写入流(memory_save)

```
saveMemory(text, type, category, ...)
  → ① 精确去重:相同文本已存在 → 更新 accessed_count 返回原记录
  → ② 向量去重(非 skipEmbed 时):嵌入后 KNN 找最近邻居,
      相似度超阈值 → 视为重复,软抑制
  → ③ INSERT memory 表(事务)
  → ④ 向量化(非 skipEmbed):写入 vec_memory(1024 维)+ embedding_cache(持久缓存)
  → ⑤ 每 50 次保存自动触发 consolidate()
```

### 3.3 检索流(memory_search)

```
searchMemory(query)
  → Phase 1 标签搜索:提取关键词 → tags LIKE 匹配(零向量调用)
      结果足够(topK 且首条 ≥0.5)→ 直接返回
  → Phase 2 向量 KNN:embed(query) → vec_memory MATCH 取 top 30
  → Phase 3 文本回退:向量不可用时 text LIKE
  → 合并去重 → 中性评分排序 → 更新访问计数
```

### 3.4 对话沉淀流(auto_process)

```
每轮对话 → auto_process(userMessage, assistantMessage)
  → saveConversationTurn 存为 conversation_log 记忆(本地,零 LLM)
  → maybeDigest:未分析对话数 >0 且距上次 ≥60s → runDigest
      ├─ 清理过期临时记忆
      └─ 恢复被误标记的 critical 记忆
```

### 3.5 反思流(reflect_auto / reflect_deep)

```
reflect_auto(日常):getUnanalyzedConversations(未分析对话)
reflect_deep(深度):listAllMemories(全量,≤500)
  → 精简每条记忆(id/text/category/tags/importance/locked/date)
  → 调 LLM(OpenAI 兼容 /chat/completions,DeepSeek 默认)
      system = 反思提示词(日记浓缩/记忆提取 或 深度校准)
  → 解析返回 JSON 动作数组(多策略容错解析)
  → reflect_apply 执行:merge/extract/reclassify/delete/relate/decay
  → 无 API key 时优雅跳过,不影响其他工具
```

---

## 4. 数据库设计

| 表 | 用途 |
|----|------|
| `memory` | 主表:文本/类型/分类/标签/情绪值/重要性/角色/来源/主题/tier/锁定/时间戳/访问计数/引用计数/VAD 列 |
| `vec_memory` | 向量虚表(vec0,float[1024]),rowid 关联 memory |
| `vec_facts` | 事实向量虚表 |
| `embedding_cache` | 嵌入持久化缓存(text_hash → BLOB),重启不丢,重复文本 0ms |
| `facts` | 事实三元组(subject-predicate-object,唯一索引去重,置信度) |
| `edges` | 记忆关系图(source→target,relation_type) |
| `categories` | 分层分类(11 预设,可自定义) |

关键字段语义:
- `tier`:critical(免清理,评分×2.0)/ standard / temporary(30 分钟清理,评分×0.5)
- `locked`:永久锁定,反思禁止修改(绝对保护)
- `is_active`:软删除标记(删除=置 0 + 删向量)
- `character_id`:多实例分区(CHAR_ID),互不串扰

---

## 5. 检索评分机制(中性版)

```
finalScore = rawScore × importanceMult × tierBoost × accessBoost

rawScore = 0.65×consistency + 0.35×timeDecay
  consistency = min(相似度, 0.85)          # 语义/标签匹配
  timeDecay   = 0.5^(小时/720)             # 30 天半衰期指数衰减
  importanceMult = 0.5 + importance
  tierBoost   = critical 2.0 / temporary 0.5
  accessBoost = 1 + log2(1+访问数)×0.1
```

全部权重可经环境变量覆盖(WEIGHT_*/HALF_LIFE_HOURS/SEARCH_MIN_SCORE)。Castalia 无情绪维度(去情感版)。

---

## 6. 配置体系(双通道)

### 6.1 环境变量(MCP server 直读)

| 变量 | 默认 | 说明 |
|------|------|------|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | 嵌入服务地址 |
| `EMBEDDING_MODEL` | `yuan-embedding-2.0-zh` | 嵌入模型(必须 1024 维) |
| `EMBEDDING_API_KEY` | 空 | 设置后走云端 `/embeddings` 模式 |
| `MEMORY_DB_PATH` | `./memory.sqlite` | 数据库路径 |
| `CHAR_ID` | `default` | 实例/角色分区 ID |
| `MCP_SERVER_NAME` | `castalia` | MCP server 名 |
| `SEARCH_MIN_SCORE` | `0.15` | 检索最低分阈值 |
| `WEIGHT_CONSISTENCY/EMOTION/TIME` | 0.60/0.10/0.30 | 评分权重 |
| `HALF_LIFE_HOURS` | `720` | 时间衰减半衰期 |
| `REFLECT_LLM_URL/API_KEY/MODEL` | DeepSeek 默认 | 反思 LLM |
| `REFLECT_INTERVAL_HOURS` | `0` | 定时自动反思(0=手动) |
| `MEMORY_CONFIG` | `./config.json` | 配置文件路径 |

### 6.2 config.json(Web 界面持久化)

```json
{
  "embedding": { "mode": "ollama|api", "ollama_url": "...", "model": "...",
                 "api_url": "...", "api_key": "...", "api_model": "..." },
  "reflect":   { "llm_url": "...", "api_key": "...", "model": "..." }
}
```
MCP server 启动时 configLoader 读取并覆盖环境变量;界面保存后**重启 server 生效**。

---

## 7. 工具清单(25 个)

| 分组 | 工具 | 说明 |
|------|------|------|
| **搜索** | `memory_search` | 标签优先→向量 KNN→文本回退 |
| | `fact_search` | 事实三元组语义搜索 |
| **记忆 CRUD** | `memory_save` / `update` / `delete` / `list` / `recent` / `graph` | 完整生命周期 |
| **认知记录** | `memory_log_decision` / `pattern` / `mistake` | agent 显式沉淀(决策=category,模式=tag,错误=critical 免清理) |
| **对话自动化** | `auto_process` / `conversation_save` / `digest_run` / `daily_summary_data` | 对话→记忆闭环 |
| **上下文** | `memory_context` | 注入包组装:近期+相关+认知+事实+Ground Truth(借鉴 engram mem_context) |
| | `context_get` | 轻量版(近期+统计) |
| **统计** | `stats_get` / `mood_journal` | |
| **反思** | `reflect_analyze` / `apply` / `auto` / `deep` / `batch_embed` | 分析→LLM→应用全链路打包进 server |

---

## 8. Web Console(web/,端口 3345)

- **主界面**:3D 力导向星图(3d-force-graph),分类锚点分布,点击节点看详情
- **副界面**:右侧管理抽屉(默认收起)
  - 反思控制(日常/深度)
  - 嵌入模型配置(下拉:Ollama 本地 / 云端 API key)
  - 反思 LLM 配置(URL/Key/模型)
  - 记忆管理(搜索/列表/删除)
  - 运行日志
- 后端:Express + 直读 SQLite(只读查询)+ MCP client(反思经 stdio 调 dist/index.js)
- 配置持久化到 config.json

---

## 9. 部署与接入

```bash
# 1. 装依赖
npm install
cd web && npm install && cd ..

# 2. 启动嵌入服务(首次加载模型 30-60s)
scripts\start-embed.bat

# 3. 一键接入 agent(借鉴 engram setup)
python scripts/setup.py claude|opencode|cursor|vscode|codex|json

# 4. 启动 Web 控制台(可选)
cd web && node server.mjs   # http://127.0.0.1:3345
```

测试:
```bash
python scripts/smoke_test.py   # 核心 CRUD(无嵌入依赖)
python scripts/vec_test.py     # 嵌入+向量链路(需嵌入服务)
```

---

## 10. 已知边界与演进方向

| 边界 | 说明 | 演进方向 |
|------|------|----------|
| 反思依赖手动/定时 | 用户可能"忘记点" | **对话内自触发**(积累 N 轮自动反思,计划中) |
| 25 工具全量暴露 | agent 上下文开销 | 工具分级(agent/admin profile,借鉴 engram) |
| 无会话生命周期 | 长会话场景缺"摘要" | memory_session_summary(借鉴 engram compaction survival) |
| 1024 维锁死 | 换模型受限 | VEC_DIM 环境变量化 |
| 无 FTS5 | LIKE 检索 | 量级到十万级再评估 |
| 反思 LLM 成本 | 每次反思调 API | 阈值触发 + 空闲触发控制频率 |

---

## 11. 合规

- Apache-2.0(LICENSE)
- 上游声明(README Credits):cognitive-memory(Apache-2.0,schema 与向量 KNN 概念继承,代码已大幅重写);AIRI Alaya/SynaBun 设计参考
- JPlag 扫描验证(2026-08-03):最长连续匹配 14 token,无代码级复制,声明充分
