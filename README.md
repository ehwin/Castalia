# Castalia — Standalone MCP Memory Server for Agent Harnesses

**Standard MCP stdio server (27 tools, profile-gated).** Local memory on SQLite (per-project DB files) + sqlite-vec vectors — **zero API cost** for storage, works offline once the embedding model is cached.

Independent, neutral, general-purpose memory component. No personality layer, no vendor lock-in — bring your own LLM, bring your own embedding service (any Ollama-compatible `/api/embed`, 1024-dim).

Designed after studying Claude Code's memory architecture (closed memory types, progressive session maintenance, consolidation) and engram / memory-os patterns.

> **Lite edition (this repo):** single-instance memory — no federation / cross-library reflection. If you need the full edition (cross-library `reflect_all` + federation search over `FEDERATION_DIRS`), see **[Castalia-Full](https://github.com/ehwin/Castalia-Full)**. For the emotional variant (agent state / bias layer / emotion-weighted search), see **[Castalia-Anima](https://github.com/ehwin/Castalia-Anima)**.

> 📖 详细技术设计见 [docs/TECHNICAL.md](docs/TECHNICAL.md)(架构/数据模型/管线/决策记录)。


---

## Quick Start

### 1. Build + verify

```bash
npm install
npm run build                  # tsc → dist/index.js
python scripts/smoke_test.py   # core CRUD round-trip (no embedding service needed)
```

### 2. Start the embedding service (first load ~30-60s)

```bat
scripts\start-embed.bat
```

Listens on `http://127.0.0.1:11436` (Ollama-compatible `/api/embed`, 1024-dim, model `IEITYuan/Yuan-embedding-2.0-zh`, cached locally — no re-download).
> Any Ollama-compatible embed service outputting **1024-dim** works: point `OLLAMA_URL` + `EMBEDDING_MODEL` at it and skip this step.

### 3. Configure LLM channels (optional but recommended)

Copy `memory/config.json` from the template (or create it) to wire the two LLM channels:

```json
{
  "triage":   { "llm_url": "https://api.deepseek.com/v1", "api_key": "sk-...", "model": "deepseek-chat" },
  "reflect":  { "llm_url": "https://api.deepseek.com/v1", "api_key": "sk-...", "model": "deepseek-chat" },
  "embedding": { "mode": "ollama", "ollama_url": "http://127.0.0.1:11436", "model": "yuan-embedding-2.0-zh" }
}
```

`triage` is optional — unset values fall back to `reflect`. Without any LLM key, the server still works fully as a read/write memory store; only reflection/triage are skipped.

> 🔐 **推荐:API key 加密存储(不落明文到 config.json)**
>
> 三通道 API key 可用 `scripts/keygen.js` 加密后单独存放(`memory/keys.enc`,AES-256-GCM,密钥在 `memory/keys.key`,均不入 git):
>
> ```bash
> node scripts/keygen.js     # 交互输入 reflect/triage/embedding 的 api_key(有 env/config.json 值则预填)
> node scripts/keygen.js --no-input   # 非交互:只取 env 与 memory/config.json 已有值
> ```
>
> 启动时自动解密注入。优先级:**显式环境变量 > keys.enc > config.json**(均不覆盖已有 env)。解密失败/文件缺失时静默回退到 env/config.json。轮换密钥用 `--new-key`(之后需重跑 keygen)。

### 4. Connect from your MCP client

```json
{
  "mcpServers": {
    "castalia": {
      "command": "node",
      "args": ["/absolute/path/to/castalia/dist/index.js"],
      "env": {
        "OLLAMA_URL": "http://127.0.0.1:11436",
        "EMBEDDING_MODEL": "yuan-embedding-2.0-zh",
        "MEMORY_DB_DIR": "/absolute/path/to/castalia/memory",
        "CHAR_ID": "default"
      }
    }
  }
}
```

### 5. One-command agent setup (borrowed from engram's `engram setup`)

```bash
python scripts/setup.py claude     # Claude Code → .mcp.json
python scripts/setup.py opencode   # OpenCode    → .opencode.json
python scripts/setup.py cursor     # Cursor      → .cursor/mcp.json
python scripts/setup.py vscode     # VS Code     → .vscode/mcp.json
python scripts/setup.py codex      # Codex       → prints `codex mcp add` command
python scripts/setup.py hermes     # Hermes Agent → prints `hermes config set` command
python scripts/setup.py json       # print standard mcpServers JSON
```

---

## Federation — collecting any number of memory instances

`memory_search_all` (and cross-library `reflect_all`) can span **any number of memory
instances** — not a fixed set of three. The key property: **a member needs no code
changes to be collected.** It only has to be reachable in one of two ways:

| transport | what the member needs | cost | use when |
|---|---|---|---|
| `local-dir` | its library files on the same machine (`project-<name>.sqlite`, or `<project>/<memType>/memory.sqlite`) | microseconds | same box |
| `mcp-http` | **any MCP endpoint** exposing `memory_search` (a Castalia memory bridge qualifies as-is) | milliseconds | other process / other machine / other backend |

Configure members with `FEDERATION_MEMBERS`:

```jsonc
[
  { "id": "hermes", "transport": "local-dir", "target": "D:/banks/hermes", "variant": "lite" },
  { "id": "airi", "label": "Castalia Anima", "variant": "anima",
    "capabilities": ["emotion"], "transport": "mcp-http",
    "target": "http://127.0.0.1:3320/mcp" }
]
```

Legacy `FEDERATION_DIRS` (`[{"name":"...","dir":"..."}]`) keeps working — every entry
becomes a `local-dir` member, so existing deployments do not change behaviour.

Notes:

* **Explicit semantics, unchanged**: the engine still does *not* merge libraries on its
  own — the caller decides interop policy. Results carry `instance`, `member`, `project`.
* **Read-only, always**: providers never write to a peer.
* **One bad member never breaks a search**: failures are collected in the result's
  `errors` array instead of silently looking like "no hits".
* **Capabilities are declarative**: `variant` / `capabilities` let a collector filter
  members (e.g. only `emotion` members) instead of hard-coding instance names.

Adding a new kind of member = adding one provider file under `src/federation/`
(implement `FedProvider`: `available()` / `describe()` / `search()`, plus
`libraries()` if the members' files are directly readable). Nothing else changes.

## Architecture Overview (v1.11)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Three-channel pipeline                                              │
│                                                                      │
│  ① LLM1 (triage)  — 入站分拣 + 渐进式临时反思(轻量,快速)              │
│     TRIAGE_LLM_URL / TRIAGE_LLM_API_KEY / TRIAGE_LLM_MODEL           │
│     缺省回退 REFLECT_* 通道                                          │
│  ② 向量模型        — 记忆库改动后嵌入(1024-dim)                       │
│     OLLAMA_URL / EMBEDDING_MODEL(已有)                              │
│  ③ LLM2 (reflect) — 每日反思 + 记忆整合(重量级)                      │
│     REFLECT_LLM_URL / REFLECT_LLM_API_KEY / REFLECT_LLM_MODEL        │
└──────────────────────────────────────────────────────────────────────┘

对话进入 auto_process
  → LLM1 入站分拣:文本 → user/feedback/project/reference(4 种封闭类型)
  → SessionMemoryBuffer(每 5 轮)→ 后台异步增量反思
       ├─ 长效干货 → 晋升项目级(session_id=NULL, Markdown 格式)
       ├─ 会话状态 → 滚动覆盖(session_id 非空)
       └─ 晋升即删 + TTL 7 天孤儿清理
  → LLM2 每日反思(距上次 ≥24h 且未分析 >5 条,启动时自动)
  → consolidate_deep(记忆 >15 条,向量预筛 + LLM 去重/矛盾消解)
```

### Storage layout — per-project DB files

```
memory/                              ← MEMORY_DB_DIR(一切记忆的物理载体)
  global.sqlite                      ← 指令 L1/L2 + 规则组 + 项目注册表
  <project>/<memType>/memory.sqlite  ← memdir:项目 × 分类文件夹 各一库(物理隔离)
  config.json                        ← 记忆服务配置(embedding/triage/reflect)
  receipts/                          ← 反思回执
```

**Per-project physical isolation**: project A's memories, vectors and facts live in their own `.sqlite` — backups, deletes and vector KNN never cross project boundaries.


---

## Hermes Agent

[Hermes Agent](https://hermes-agent.nousresearch.com) has a native MCP client: any server under `mcp_servers` in `config.yaml` is discovered at startup, and its tools appear with the `mcp_castalia_*` prefix (e.g. `mcp_castalia_memory_search`, `mcp_castalia_memory_save`).

### Install

```bash
python scripts/setup.py hermes
```

prints a ready-made `hermes mcp add` command — run it (answer `Y` to enable all tools), then **start a new session** (MCP servers are discovered at startup; no hot reload).

> ⚠️ **Do NOT use `hermes config set mcp_servers '{...}'`** — it stores the JSON as a *string*, and the MCP client ignores non-dict values, so the server silently never loads. Always use `hermes mcp add` (writes a real dict under `mcp_servers`).
>
> **Windows note**: if `node` is not on the system `PATH`, use the absolute path to `node.exe` as `command`.

### Recommended env for Hermes

| Var | Value | Why |
|-----|-------|-----|
| `MCP_TOOLS` | `harness` (default `agent`) | agent = read-only (6 tools); `harness` adds writes; `admin` adds management. See Tools section |
| `CHAR_ID` | e.g. `hermes` | separate partition per agent/role, share one DB safely |
| `EMBEDDING_MODEL` | your 1024-dim model | e.g. `qwen3-embedding:0.6b` on a local Ollama |

---

## Memory Layering (the core design)

Memories are **strictly layered** — nothing falls into an unclassified pile, even though vector search could catch it:

```
项目级(session_id = NULL)   ← 长效:LLM2 每日反思沉淀 + 临时反思晋升
会话级(session_id = 'x')    ← 临时:渐进式滚动状态,TTL 7 天
4 种封闭类型(mem_type)      ← 每层内部再分类:
   user      用户画像(偏好/技术栈/风格)
   feedback  行为纠正(正负双向)
   project   项目上下文(约定/截止/环境)
   reference 外部指针(URL/ID/文档)
```

- **写入分层**: `auto_process` 每轮对话由 LLM1 分拣 mem_type;`memory_save` 可显式指定
- **渐进式临时反思**(Claude Code progressive maintenance):每 5 轮对话后台异步提炼 → 长效干货**晋升**到项目级,会话状态滚动覆盖,晋升即删 + TTL 兜底;提炼产出经**查重**(文本归一化 + 向量余弦预筛)防止重复堆积
- **每日反思**:距上次 ≥24h 且未分析对话 >5 条 → 下次启动自动执行(LLM2)
- **记忆整合**(Memory Consolidator):记忆 >15 条时向量预筛相似对 → LLM 去重/矛盾消解/归并(原子事务)


---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_DB_DIR` | `./memory` | **v1.7** Memory directory: `global.sqlite` + `project-<name>.sqlite` (per-project DB files) |
| `MEMORY_DB_PATH` | *(deprecated)* | Legacy single-DB path. If explicitly set, runs in single-DB compatibility mode with a warning |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Embedding service address (bundled service runs on 11436) |
| `EMBEDDING_MODEL` | `yuan-embedding-2.0-zh` | Embedding model name; must output **1024-dim** |
| `EMBED_MODE` | `ollama` | **v1.5.3** Embedding pipeline: `ollama` (local) / `api` (OpenAI-compatible, `EMBEDDING_API_KEY`) / `none` (pure local, no embed service at all) |
| `EMBEDDING_API_KEY` | *(unset)* | Key for `EMBED_MODE=api` |
| `CHAR_ID` | `default` | Instance/partition ID. Multiple instances can share one DB without cross-talk |
| `CASTALIA_PROJECT` | `default` | **v1.5** Default project namespace |
| `TRIAGE_LLM_URL` / `_API_KEY` / `_MODEL` | fallback REFLECT_* | **v1.11** LLM1 channel: inbound triage + incremental reflection |
| `REFLECT_LLM_URL` / `_API_KEY` / `_MODEL` | deepseek / unset / deepseek-chat | **v1.5.4** LLM2 channel: daily reflection + consolidation |
| `REFLECT_FACT_EXTRACTION` | `auto` | **v1.5.4** Extract SPO facts during reflection (`auto`/`off`) |
| `REFLECT_MIN_GAP_HOURS` | `24` | **v1.9** Startup-reflection min gap since last reflection |
| `REFLECT_MIN_UNANALYZED` | `5` | **v1.9** Startup-reflection min unanalyzed conversations |
| `BUFFER_SIZE` | `5` | **v1.11** Session memory buffer threshold (turns per incremental reflection) |
| `SESSION_MEMORY_TTL_DAYS` | `7` | **v1.11** Orphan session-memory TTL (swept at startup) |
| `CONSOLIDATE_MIN_MEMORIES` | `15` | **v1.10** Auto-consolidation threshold at startup |
| `CONSOLIDATE_SIMILARITY` | `0.88` | **v1.10** Vector similarity threshold for merge candidates |
| `MCP_TOOLS` | `agent` | Tool visibility: `agent` / `harness` / `admin` / `all` / comma list |

---

## Tools (30, profile-gated)

| Profile | Representative tools | Purpose |
|---------|----------------------|---------|
| **agent** | `memory_search` / `fact_search` / `memory_get` / `memory_recent` / `memory_index` / `memory_graph` | Read-only recall for the LLM |
| **harness** | `auto_process` / `conversation_save` / `digest_run` / `reflect_auto` / `reflect_deep` / `reflect_batch_embed` / `memory_save` / `memory_update` / `memory_delete` / `memory_log` / `instruction_save` | Writes + pipeline, called by harness/system |
| **admin** | `memory_list` / `stats_get` / `recent_conversations` / `daily_summary_data` / `reflect_analyze` / `reflect_apply` / `memory_context` / `context_get` / `project_list` / `instruction_list` / `instruction_delete` / `consolidate_deep` | Management, Web Console |

`MCP_TOOLS=all` registers everything (backward compatible).

### Search & Recall

- `memory_search` — tag-first, vector KNN, text fallback (three-way, project-scoped)
- `fact_search` — semantic search over fact triples (subject-predicate-object)
- `memory_index` — **v1.8** lightweight index (150-char summaries, Claude Code MEMORY.md pattern): inject index first, expand details via `memory_get(id)` to save tokens
- `memory_get` — expand one memory by ID (full text + metadata, incl. memType)

### Memory CRUD

- `memory_save` — store a memory. Optional `memType` (user/feedback/project/reference → auto Markdown-wrapped), `sessionId` (session-scoped), `expiresAt`, `skipEmbed`
- `memory_update` / `memory_delete` — update fields / soft-delete
- `memory_list` / `memory_recent` / `memory_graph` — enumerate / recent important / relation graph

### Context & Injection

- `memory_context` — **injection-ready bundle**: 三层指令(全局→用户→项目,约束递增) + 近期记忆 + 任务相关 + 经验沉淀 + 已知事实 + 记忆索引 + 会话滚动状态;旧记忆自动带 **Memory Snapshot Warning**
- `context_get` — lightweight recent memories + stats
- `stats_get` — memory statistics (incl. byMemType)

### Instructions (three layers, v1.6)

- `instruction_save` — upsert into `global` / `user` / `project` / `rule` layers
- `instruction_list` / `instruction_delete` — admin view/remove
- Load order into prompt: **global → user → project** (project lands last = highest constraint, recency bias). Supports `@include` rule-group recursion (depth 5, cycle-safe) and picomatch glob `paths` filtering

### Reflection & Consolidation (LLM-driven, bundled in-server)

- `reflect_auto` — one-shot auto-reflection (needs `REFLECT_LLM_API_KEY`)
- `reflect_deep` — deep calibration: all memories → dedup/profile/graph → apply
- `reflect_analyze` / `reflect_apply` — manual two-step reflection
- `consolidate_deep` — **v1.10** Memory Consolidator: vector pre-screen → LLM dedup/merge/conflict-resolution → atomic apply (needs `REFLECT_LLM_API_KEY`)
- `reflect_batch_embed` — batch-vectorize pending memories

### Conversation automation (call per dialog turn)

- `auto_process` — save turn + trigger digest + **inbound triage (LLM1) + session buffer** (pass `sessionId` to enable progressive reflection)
- `conversation_save` — save raw turn only
- `digest_run` — run cleanup cycle


---

## Web Console (3D main + admin side)

Bundled web UI: fullscreen 3D memory graph as the main view, admin drawer (reflection, embedding/triage/reflect LLM config, memory management, logs) as the side panel.

```bat
cd web
npm install
node server.mjs        # → http://127.0.0.1:3345
```

- Config saved to `memory/config.json` (embedding source + triage LLM + reflection LLM), applied on MCP server restart
- Admin panel configures all **three channels** (embedding / triage / reflect)

### 3D Star Map (v1.22 — UMAP semantic layout + density blobs)

The 3D view is a **semantic map**, not a decorative layout:

- **Positions come from UMAP-3D** over the memory embeddings (`umap-js`, vendored — works offline). No force simulation, no Fibonacci shells: a node lands where its *meaning* puts it.
- **Density blobs** — memories group by `project/memType`; each blob's radius scales with its member count (`R = R_med × (n/n_med)^0.45`), and members relax to a count-derived minimum spacing — big groups *grow* instead of packing.
- **Blobs separate along all three axes** (rigid translation, vacuum in between); the on-screen badge reports blob count + depth ratio.
- **Trunk pipelines** — one gate per blob pair, anchored to **support points on the blob surfaces** (never to individual nodes), so a trunk cannot cut through its own blob; near-parallel trunks may share a corridor.
- **Point-to-point links are hover-only** — no permanent cross-blob spaghetti.
- **Legend layers** — region (agent/instance) → folder (`memType`) → library (project); hue encodes the folder, shade encodes the library.
- Vectors that lack an embedding land on a deterministic in-blob spiral (never stacked onto one point).

---

## Storage

- **memdir 分库**(v1.13):`memory/<project>/<memType>/memory.sqlite` — 项目为最外层,内部 user/feedback/project/reference/general 五个分类文件夹;兼容旧 `project-<name>.sqlite` 读取
- Fixed **1024-dim** vectors; swap embedding models only if same dim (or rebuild the DB)
- WAL mode; auto-checkpoint; expired temporaries cleaned periodically; consolidation on startup when >15 memories
- DB files are fully portable (copy while stopped)

---

## Credits & Upstream

Independent evolution of a memory system; design informed by:

- **[Castalia-Full](https://github.com/ehwin/Castalia-Full)** — full edition of this project (adds cross-library federation `reflect_all`); same neutral core, more tools
- **[Castalia-Anima](https://github.com/ehwin/Castalia-Anima)** — the emotional variant (personality layer on the same architecture); the repos cross-pollinate — Anima feeds architecture back into Castalia, Castalia keeps the neutral core stable
- **Claude Code** (Anthropic) — closed memory types (user/feedback/project/reference), MEMORY.md index, progressive session maintenance, consolidation sub-agent, snapshot warnings (patterns re-implemented in SQLite)
- **engram** — profile-gated tool exposure, setup script
- **memory-os / cognitive-memory** — local vector storage patterns

License: MIT, see `LICENSE`.

---

## Troubleshooting

- Embedding service down → `memory_save` reports embed failure; check `curl http://127.0.0.1:11436/health`
- Empty search results → lower `SEARCH_MIN_SCORE`, or verify `CHAR_ID` matches the writer
- **Legacy `memory.sqlite` reappears in project root** → an old-code MCP instance is running; restart it with the new build (v1.7+ uses `memory/` dir)
- Hermes: tools not appearing → restart Hermes; verify `hermes config get mcp_servers`; on Windows ensure `command` is an absolute path to `node.exe`
