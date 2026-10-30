# Castalia — 本地记忆引擎（MCP stdio 服务）

**给 agent harness 用的独立记忆服务器**：标准 MCP stdio 服务，记忆落在本地 SQLite，按「项目 × 分类」分库物理隔离；向量检索走 `sqlite-vec`，嵌入服务自己选（本地 Ollama 兼容端点或任意 OpenAI 兼容 API），存储侧零 API 成本。

当前版本 **1.25.4**。版本号只有一个来源：仓库根 `VERSION`，构建时由 `scripts/gen_version.mjs` 生成 `src/version.ts`，不要在别处手改。

- **32** 个 MCP tool，按 profile 分档暴露（默认只开 7 个只读工具）
- **25** 个 TypeScript 源文件；运行时依赖 5 个：MCP SDK / better-sqlite3 / sqlite-vec / picomatch / zod
- Node.js **≥ 20**（原生模块的 ABI 与安装时的 Node 绑定）
- 不配 LLM 也能当读写记忆库用；不配嵌入服务则退化为标签 + 词法检索

技术设计细节见 [docs/TECHNICAL.md](docs/TECHNICAL.md)，安装与踩坑见 [INSTALL.md](INSTALL.md)。

---

## 三仓关系（Three repos）

本仓是**引擎核心**，另两个仓是在它之上拼出来的形态，不自带引擎演进：

| 仓库 | 角色 | 相对本仓 |
|---|---|---|
| **Castalia**（本仓） | 引擎核心：分库存储、混合检索、记忆分层、反思与整合、指令、Web 控制台 | 唯一版本锚，`VERSION` 从这里发 |
| **Castalia-Full** | 核心 + 跨库总线（联邦 `fedServer`、总反思 `reflect_all`、`memory_search_all`、聚合星图） | 核心文件由 `sync_core.py` 从本仓同步，只额外维护总线模块 |
| **Castalia-Anima** | 核心 + 情感层（agent 状态、偏置、情绪加权检索） | 情感变体，自带一条引擎线与版本号 |

判据很简单：**引擎能力只在本仓实现**，Full / Anima 里出现的引擎改动都是从本仓回同步的产物。

---

## 能力概览

- **分库存储**：`memory/<project>/<memType>/memory.sqlite` —— 项目是最外层，内部 5 个分类目录（user / feedback / project / reference / general）各一个独立 sqlite，备份、删除、向量 KNN 都不跨项目边界
- **混合检索**：标签命中 → 词法通道（CJK bigram，不靠向量也能召回中文问句）→ 向量 KNN → 文本兜底；相似度与时间衰减加权排序
- **记忆分层**：4 种封闭用途类型（user / feedback / project / reference）+ general 默认；项目级（`session_id` 为空）与会话级分离，会话滚动状态带 TTL
- **热度与冷存**：临时记忆被反复访问就自动升级，长期不动且低重要性的记忆转冷存（不删，只降权）
- **反思**：入站分拣（LLM1）+ 会话增量反思（每 5 轮或 4000 token 触发）+ 启动每日反思（LLM2）+ 深度反思（全量重排画像 / 去重 / 关系图）
- **整合**：sigmoid 时间衰减 + 引用计数升华 + 向量预筛候选交 LLM 裁决合并与矛盾消解
- **指令三层**：global → user → project（约束递增）+ 可复用规则组，支持 `@include` 递归与 glob 路径过滤
- **工具事件**：把「跑了什么命令、退出码、错误首行」记成可检索事件，不进反思输入、不存完整输出
- **模型与维度可配**：换嵌入模型只改配置；维度或嵌入空间变化时自动重建索引，正文不丢
- **Web 控制台**：3D 星系主视图 + 记忆总成 + 库管理，静态资源本地打包，离线可用

---

## Quick Start

### 1. 构建与自检

```bash
npm install            # better-sqlite3 / sqlite-vec 是原生模块；换了 Node 版本要重装
npm run build          # 刷新 version.ts → tsc → dist/index.js
python scripts/smoke_test.py   # 走一遍 save / search / delete，不需要嵌入服务
```

`smoke_test.py` 用临时库跑完整的 MCP stdio 往返，首个不匹配即非零退出。原生模块没编出来（`Cannot find module ... better_sqlite3.node`）看 [INSTALL.md](INSTALL.md)。

### 2. 嵌入服务（可选，向量检索需要）

任何 Ollama 兼容的 `/api/embed` 端点都行，指向它并声明模型与维度即可：

```bash
export OLLAMA_URL=http://127.0.0.1:11434
export EMBEDDING_MODEL=<your-model>
export EMBEDDING_DIM=<model-output-dim>    # 不填 = 1024
```

仓库自带一个本地服务（Windows 脚本，需要 Python 环境与 torch）：

```bat
scripts\start-embed.bat        # 监听 127.0.0.1:11436，1024 维
```

首次启动要下载模型权重（约 600 MB，分钟级），之后走本地缓存。只想做文本检索就设 `EMBED_MODE=none`，引擎完全不调嵌入端点。

### 3. LLM 通道（可选）

反思与分拣需要 LLM。配置写在库根 `config.json`（路径解析：`MEMORY_CONFIG` > `MEMORY_DB_DIR/config.json` > `./memory/config.json`）：

```json
{
  "embedding": { "mode": "ollama", "ollama_url": "http://127.0.0.1:11436", "model": "your-embed-model", "dim": 1024 },
  "triage":    { "llm_url": "https://api.example.com/v1", "api_key": "sk-...", "model": "your-chat-model" },
  "reflect":   { "llm_url": "https://api.example.com/v1", "api_key": "sk-...", "model": "your-chat-model", "maxFacts": 15 }
}
```

- `config.json` 只填充**未设置**的环境变量，显式环境变量永远优先（避免「引擎读 B 库、控制台显示 A 库」这类串库）
- `triage` 缺省回退 `reflect` 通道；完全不配 key，服务照常读写，只是跳过反思 / 分拣
- 不想把 key 落明文：`node scripts/keygen.js` 生成 `keys.enc` + `keys.key`（AES-256-GCM），启动时自动解密注入。优先级 **环境变量 > keys.enc > config.json**，解密失败静默回退
- Windows 编辑器可能给 `config.json` 写 UTF-8 BOM，读取时已剥离，不会导致整份配置被忽略

### 4. 接入 MCP 客户端

```json
{
  "mcpServers": {
    "castalia": {
      "command": "node",
      "args": ["<repo>/dist/index.js"],
      "env": {
        "MEMORY_DB_DIR": "<repo>/memory",
        "MCP_TOOLS": "all",
        "EMBED_MODE": "ollama",
        "OLLAMA_URL": "http://127.0.0.1:11436",
        "EMBEDDING_MODEL": "<your-model>",
        "EMBEDDING_DIM": "1024"
      }
    }
  }
}
```

模板见 `mcp-config.example.json`。重启客户端后调任意工具（如 `memory_save`）确认握手。生产上建议 `MCP_TOOLS` 保持默认的 `agent`（只读），把写入口留给 harness 侧。

### 5. 一键生成客户端配置

```bash
python scripts/setup.py            # 列出支持的客户端
python scripts/setup.py claude     # Claude Code → .mcp.json
python scripts/setup.py opencode   # OpenCode    → .opencode.json
python scripts/setup.py cursor     # Cursor      → .cursor/mcp.json
python scripts/setup.py vscode     # VS Code     → .vscode/mcp.json
python scripts/setup.py codex      # Codex CLI
python scripts/setup.py hermes     # Hermes Agent
python scripts/setup.py json       # 直接打印标准 mcpServers JSON
```

脚本会自动探测仓库根、生成绝对路径、与已有配置智能合并（保留你原有的 server 条目）。

---

## 架构（Architecture）

```
传入对话 ──▶ auto_process
              │
              ├─① LLM1 分拣（TRIAGE_*，缺省回退 REFLECT_*）
              │     文本 → user / feedback / project / reference
              │
              ├─▶ 会话缓冲（5 轮 或 4000 token，任一命中即触发）
              │     后台增量反思 → 长效干货晋升项目级
              │                  → 会话状态滚动覆盖
              │                  → 晋升即删 + TTL 兜底
              │
              └─▶ 嵌入（OLLAMA_URL / EMBEDDING_MODEL / EMBEDDING_DIM）

启动 / 周期（CASTALIA_BACKGROUND_TASKS ≠ 0）
  ├─ 每日反思（距上次 ≥24h 且未分析 >5 条）        LLM2
  ├─ 深度反思 reflect_deep（全量画像 / 去重 / 关系图）
  ├─ 整合 consolidate_deep（衰减 + 引用升华 + LLM 裁决）
  ├─ 缺失向量补齐、WAL checkpoint、过期清理
  └─ 可选 HTTP 健康检查（HEALTH_PORT）
```

后台任务全部异步、失败只记日志：嵌入服务挂了不影响记忆读写，LLM 挂了只跳过反思。

---

## 存储布局（Storage layout）

```
memory/                              ← MEMORY_DB_DIR
  global.sqlite                      ← 指令 L1/L2 + 规则组 + 项目注册表
  <project>/<memType>/memory.sqlite  ← 每个「项目 × 分类」一个独立库
  config.json                        ← 嵌入 / triage / reflect 配置
  receipts/                          ← 反思回执（每次反思的输入摘要与动作）
  keys.enc, keys.key                 ← 加密的 API key（已在 .gitignore）
  project-<name>.sqlite              ← 旧单库结构，仍可读
```

- 库根默认 `./memory`，`MEMORY_DB_DIR` 可指向任意位置；备份时整目录复制即可
- `MEMORY_DB_PATH` 是旧单库兼容模式，显式设置会告警并退化为单库
- WAL 模式，每 30 分钟 checkpoint；库文件在进程停止后完全可移植
- `*.sqlite` / `keys.*` / `receipts/` 均不入 git

---

## 记忆分层与检索（Layering & Retrieval）

记忆不存在「未分类的堆」：两层作用域 × 一个用途维度，每条都有明确位置。

| 维度 | 取值 | 含义 |
|---|---|---|
| 作用域 | `session_id` 为空 | 项目级：长期沉淀，不随会话消失 |
| 作用域 | `session_id` 非空 | 会话级：滚动状态，`SESSION_MEMORY_TTL_DAYS`（默认 7 天）兜底清扫 |
| 用途 `mem_type` | user / feedback / project / reference | 4 种封闭类型，写入时强制 Markdown 结构（标题 + 正文） |
| 用途 `mem_type` | general | 默认值，不强制格式（事件、元数据等落这里） |
| 分层 `tier` | temporary / standard / critical | temporary 默认 3 天 TTL；访问达 `HEAT_PROMOTE_THRESHOLD`（5）次自动升 standard |
| 状态 `status` | active / cold / superseded | 60 天未访问且 importance < 0.6 → cold，检索降权而非删除 |

**检索是四路合流**，不是单走向量：

| 通道 | 触发条件 | 作用 |
|---|---|---|
| 标签匹配 | 永远先跑 | 零向量调用，命中够用就直接返回 |
| 词法通道 | 与标签同批 | CJK 按 bigram 切分，自然问句也能召回 |
| 向量 KNN | 前两路不足 topK | sqlite-vec 近邻，按 `SEARCH_MIN_SCORE` 过滤 |
| 文本兜底 | KNN 报错 / 零命中 / 缺向量 | `LIKE` 兜底，保证「有字就能查到」 |

排序分 = `0.65 × 相似度 + 0.35 × 时间衰减`，通用半衰期 30 天；对话 / 会话类记录用 10 天短半衰期自然沉底。三档检索 profile：`quick`（3 条 / 0.6）、`balanced`（5 条 / 0.15，默认）、`deep`（10 条 / 0.1）。

**注入侧**：`memory_index` 先给 150 字摘要索引（省 token），需要细节再 `memory_get(id)` 展全文；`memory_context` 按段配额装箱，只在条边界裁、不切半句，超过 1 天的记忆自动附「历史快照」警告。

**写前闸门**：晋升路径上有三道闸 —— 文本过长或信息密度过低拒、命中其它库专名拒、与同库同类型记忆 bigram Jaccard > 0.72 视为无增量拒；通过的再做精确去重。

---

## 反思与整合（Reflection & Consolidation）

| 环节 | 触发 | 产出 |
|---|---|---|
| 入站分拣 | 每次 `auto_process` | mem_type 归类 + 投递会话缓冲 |
| 增量反思 | 缓冲达 5 轮或 4000 token | 项目级晋升 / 会话状态覆盖，异步不阻塞主流程 |
| 每日反思 | 距上次 ≥24h 且未分析 >5 条，启动时 | 画像更新、事实抽取（每轮 ≤15 条 SPO） |
| 深度反思 | `reflect_deep` / `reflect_auto` | 全量重排：合并重复、修正画像、重建关系 |
| 整合 | 记忆数 >15 且距上次 ≥6h，启动 / 24h 周期 | 衰减降权、引用升华、LLM 裁决合并与矛盾消解（原子事务） |
| 周期反思 | `REFLECT_INTERVAL_HOURS > 0` | 按小时自动跑 `reflect_auto`（默认关闭） |

- 没有 `REFLECT_LLM_API_KEY` 时整条链路跳过并记一行日志，不影响存储
- 每次反思写回执到 `receipts/`，可回溯「这次改了什么」
- prompt 可用 `REFLECT_PROMPT_FILE` / `CONSOLIDATE_PROMPT_FILE` 覆盖，不必改源码
- LLM 调用带重试（默认 3 次）与超时（默认 180s），失败按 `REFLECT_FAIL_BACKOFF_HOURS` 退避

---

## 环境变量（Environment variables）

引擎读 **75** 个环境变量，Web 控制台另有 **7** 个（`WEB_PORT` / `NODE_BIN` / `CASTALIA_MCP` / `ANIMA_DIR` / `AGGREGATE_DIRS` / `FEDERATION_DIRS` / `GRAPH_SCOPE`），合计 82 个。下表只列需要动的那部分。

**存储与实例**

| 变量 | 默认 | 说明 |
|---|---|---|
| `MEMORY_DB_DIR` | `./memory` | 库根目录，一切的物理载体 |
| `MEMORY_CONFIG` | `<MEMORY_DB_DIR>/config.json` | 配置文件路径（优先级最高） |
| `CHAR_ID` | `default` | 实例 / 角色分区，多实例共享一个库也不串味 |
| `CASTALIA_PROJECT` | `default` | 默认项目命名空间 |
| `MEMORY_DB_PATH` | — | 旧单库路径，显式设置会告警 |

**嵌入**

| 变量 | 默认 | 说明 |
|---|---|---|
| `EMBED_MODE` | `ollama` | `none` 纯文本 / `ollama` 本地端点 / `api` OpenAI 兼容 |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | 嵌入端点（自带服务在 11436） |
| `EMBEDDING_MODEL` | `yuan-embedding-2.0-zh` | 模型名；**换模型必须显式设**，否则沿用库内记录的模型 |
| `EMBEDDING_DIM` / `VEC_DIM` | `1024` | 向量维度，与 `config.json` 的 `embedding.dim` 等价 |
| `EMBEDDING_API_KEY` | — | `EMBED_MODE=api` 时必填（缺 key 时不清索引） |
| `EMBED_TIMEOUT_MS` | `30000` | 单次嵌入请求超时 |

**LLM 通道**

| 变量 | 默认 | 说明 |
|---|---|---|
| `REFLECT_LLM_URL` / `_MODEL` | `https://api.deepseek.com/v1` / `deepseek-chat` | 反思通道（LLM2），任意 OpenAI 兼容端点 |
| `REFLECT_LLM_API_KEY` | — | 不设 = 关闭反思与整合 |
| `TRIAGE_LLM_URL` / `_MODEL` / `_API_KEY` | 回退 `REFLECT_*` | 分拣通道（LLM1） |
| `REFLECT_LLM_RETRIES` / `_TIMEOUT_MS` | `3` / `180000` | 重试次数与超时毫秒 |

**分层与生命周期**

| 变量 | 默认 | 说明 |
|---|---|---|
| `BUFFER_SIZE` / `BUFFER_TOKENS` | `5` / `4000` | 增量反思双阈值（任一命中即触发） |
| `SESSION_MEMORY_TTL_DAYS` | `7` | 孤儿会话记忆清扫期限 |
| `HEAT_PROMOTE_THRESHOLD` | `5` | 访问多少次后 temporary 升 standard |
| `COLD_AFTER_DAYS` / `COLD_MAX_IMPORTANCE` | `60` / `0.6` | 转冷存的两个条件 |

**检索与上下文**

| 变量 | 默认 | 说明 |
|---|---|---|
| `SEARCH_MIN_SCORE` | `0.15` | `balanced` profile 的最低分 |
| `HALF_LIFE_HOURS` | `720` | 通用时间衰减半衰期（30 天） |
| `EPHEMERAL_HALF_LIFE_HOURS` | `240` | 对话 / 会话类短半衰期 |
| `MEMORY_CONTEXT_BUDGET` | `24000` | `memory_context` 的总字符预算 |

**反思与整合**

| 变量 | 默认 | 说明 |
|---|---|---|
| `REFLECT_MIN_GAP_HOURS` / `_MIN_UNANALYZED` | `24` / `5` | 启动反思的两个门槛 |
| `REFLECT_FACT_EXTRACTION` / `REFLECT_MAX_FACTS` | `auto` / `15` | 事实抽取开关与条数上限 |
| `REFLECT_INTERVAL_HOURS` | `0` | 周期反思间隔，0 = 关 |
| `REFLECT_BATCH_LIMIT` | `30` | 单轮反思处理的对话条数 |
| `CONSOLIDATE_MIN_MEMORIES` / `_SIMILARITY` | `15` / `0.88` | 整合触发条数与候选阈值 |
| `CONSOLIDATE_MIN_INTERVAL_HOURS` / `_MAX_PAIRS` | `6` / `50` | 整合最小间隔与候选对数上限 |
| `CONSOLIDATE_DECAY_STEEPNESS` / `_MIDPOINT_DAYS` | `0.04` / `90` | sigmoid 衰减形状 |
| `CONSOLIDATE_PROMOTE_REF_COUNT` | `2` | 被引用几次后升华 |
| `REFLECT_PROMPT_FILE` / `CONSOLIDATE_PROMPT_FILE` | — | prompt 覆盖文件路径 |

**服务与暴露面**

| 变量 | 默认 | 说明 |
|---|---|---|
| `MCP_TOOLS` | `agent` | 工具分档：`agent` / `harness` / `admin` / `all` / 逗号列表 |
| `MCP_SERVER_NAME` | `castalia` | 握手时报的服务名 |
| `HEALTH_PORT` | `0` | >0 时在 `127.0.0.1:<port>/health` 提供探活 |
| `CASTALIA_BACKGROUND_TASKS` | 开 | 设 `0` 关闭全部后台任务（测试 / 单次脚本） |

---

## 工具（32 个，按 profile 分档）

`MCP_TOOLS` 决定注册哪些：默认 `agent`（7 个只读），`harness`（12 个写入与管线），`admin`（13 个管理），`all` 全开，也可直接写具体工具名。

| Profile | 工具 | 用途 |
|---|---|---|
| **agent**（7） | `memory_search` `memory_get` `memory_recent` `memory_index` `fact_search` `memory_graph` `event_search` | 供 LLM 只读回忆 |
| **harness**（12） | `memory_save` `memory_update` `memory_delete` `memory_log` `auto_process` `conversation_save` `digest_run` `events_ingest` `instruction_save` `reflect_auto` `reflect_deep` `reflect_batch_embed` | 写入与管线，由 harness / 系统调用 |
| **admin**（13） | `memory_list` `stats_get` `recent_conversations` `daily_summary_data` `memory_context` `context_get` `project_list` `project_create` `instruction_list` `instruction_delete` `reflect_analyze` `reflect_apply` `consolidate_deep` | 管理、上下文装配、Web 控制台 |

几个容易混淆的点：

- `memory_search` 返回带 `score` 的合并结果；`memory_index` 返回摘要索引；`memory_get` 才是全文
- `memory_context` 是**可直接拼进 prompt 的整包**：三层指令 + 近期记忆 + 任务相关 + 经验沉淀 + 已知事实 + 索引 + 会话状态
- `fact_search` 查 SPO 三元组；`event_search` 查工具执行事件（命令、退出码、错误首行），两者不吃向量也能查
- `instruction_save` 的 scope 是 `global` / `user` / `project` / `rule`；`rule` 只作为 `@include` 引用的可复用块，不直接进 prompt
- `reflect_analyze` / `reflect_apply` 是两步式手动反思：先分析拿动作列表，确认后再落库

---

## Web 控制台（Web Console）

```bash
cd web
npm install        # 独立依赖：express + better-sqlite3 + sqlite-vec
node server.mjs    # → http://127.0.0.1:3345   (WEB_PORT 可改)
```

三个页面，6 个路由模块（`graph` / `memory` / `config` / `reflect` / `aggregate` / `lib`）：

| 页面 | 内容 |
|---|---|
| `/`（记忆星座） | 3D 星系主视图：项目为星系核心、mem_type 为小星系，节点大小按 importance，边来自 `edges` 表的关系类型（按类型赋强度）+ 库内相似度边（限 ≤100 节点的库、余弦 ≥0.65）；悬停出详情、点击飞行定位、空闲自动环绕 |
| `/manage.html`（库管理） | 分库清单、记忆增删改、搬移分类、重要度切换、单库统计 |
| `/aggregate.html`（记忆总成） | 跨目录汇总：总条数与事实数、跨库搜索、软件 → 库的二部关系图 |

- 前端 3D 依赖（three + 3d-force-graph）打成单文件放 `web/public/vendor/`，**离线可用**，不依赖 CDN
- 控制台里改的嵌入 / triage / reflect 三通道配置写回 `config.json`，MCP 服务重启后生效
- 概览 / 星图 / 总成对库只读打开（`readonly`），不与 MCP 进程抢写锁；只有管理页的写操作才建写连接

---

## 联邦（Federation）

本仓（Lite）**不包含**跨库联邦工具：没有 `memory_search_all`、`reflect_all`、`fedServer`，`src/federation/` 只是保留目录。这些是 [Castalia-Full](https://github.com/ehwin/Castalia-Full) 的职责。

本仓唯一的多实例能力在 Web 侧：**记忆总成**页可以同时汇总多份库目录，配 `FEDERATION_DIRS`（或 `AGGREGATE_DIRS`）：

```json
[
  { "name": "instance-a", "dir": "/path/to/bank-a" },
  { "name": "instance-b", "dir": "/path/to/bank-b" }
]
```

行为是纯只读聚合：目录扫描 → 概览统计 → 跨库 `LIKE` 搜索 → 二部关系图。引擎本身不做隐式合并，互通语义由调用方决定。

---

## 故障排查（Troubleshooting）

| 症状 | 原因 | 处理 |
|---|---|---|
| 启动即退出，`Cannot find module ... better_sqlite3.node` | npm 拦了原生安装脚本 | `npm install-scripts approve better-sqlite3`，再 `npm install --foreground-scripts` |
| `NODE_MODULE_VERSION` 不匹配 | 装完之后换了 Node | 用目标 Node 重跑 `npm install --foreground-scripts` |
| 检索召回为 0 | 查询与写入不在同一项目，或 `CHAR_ID` 不一致 | 核对 `CASTALIA_PROJECT` / `CHAR_ID`，或降低 `SEARCH_MIN_SCORE` |
| 换嵌入模型后检索一度全空 | 嵌入空间或维度变了，索引被重建 | 预期行为：重启后自动补向量，或手动 `reflect_batch_embed` |
| 日志 `reflect-startup skipped: ... not configured` | 没有 LLM key | 预期行为，配 `REFLECT_LLM_API_KEY` 才启用 |
| 日志 `consolidate-startup skipped: below threshold` | 记忆数没到阈值 | 预期行为，阈值见 `CONSOLIDATE_MIN_MEMORIES` |
| 改了配置不生效 | 环境变量优先于 `config.json` | 检查同名 env 是否已设置 |
| 目录里又冒出 `project-*.sqlite` | 有旧版进程还在写 | 停掉旧实例；新版写 `memory/<project>/<memType>/` |
| Web 页面白屏 | 浏览器不支持 ESM 或被脚本拦截 | 换较新浏览器；页面有 3D 库自检提示 |

安装期问题（原生模块、嵌入服务、smoke test 卡住）见 [INSTALL.md](INSTALL.md)。

---

## 回归脚本

`scripts/` 下 12 个 `.mjs` 是可重复跑的回归，挑常用的：

```bash
node scripts/regression_embed_dim.mjs     # 维度可配 / 自动重建 / 正文不丢
node scripts/regression_cjk_recall.mjs    # 中文问句召回
node scripts/test_lexical.mjs             # 词法通道
node scripts/test_context_pack.mjs        # 上下文装箱
node scripts/test_embed_space_safety.mjs  # 换模型不误清索引
node scripts/test_lineage.mjs             # 记忆血缘
node scripts/test_events.mjs              # 工具事件
node scripts/test_e2e_mcp.mjs             # 端到端 MCP
```

另含 `smoke_test.py`、`verify_v115.mjs`、`gen_version.mjs`、`setup.py`、`keygen.js` 等工具脚本。

---

## Credits & License

独立演进的项目，设计上参考了：

- **Claude Code**（Anthropic）—— 封闭记忆类型（user / feedback / project / reference）、MEMORY.md 式索引、渐进式会话维护、整合子代理、历史快照警告（本仓以 SQLite 重新实现）
- **engram** —— profile 分档暴露工具、一键 setup 脚本的交互形态
- **memory-os / cognitive-memory** —— 本地向量存储与检索的分层思路

姊妹仓：[Castalia-Full](https://github.com/ehwin/Castalia-Full)（总线与联邦）、[Castalia-Anima](https://github.com/ehwin/Castalia-Anima)（情感变体）。

License: MIT，见 `LICENSE`。
