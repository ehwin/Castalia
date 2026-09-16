# Installation & Deployment

> Lite / neutral single-instance edition
> Everything from a clean checkout to a working MCP client — including the pitfalls we hit on
> real machines. Total time: about 5 minutes (plus a one-off native build).

## Requirements

| Component | Requirement | Notes |
| --- | --- | --- |
| **Node.js** | **≥ 20** (v22 LTS recommended) | `better-sqlite3` / `sqlite-vec` are native modules compiled for the Node ABI that runs `npm install` |
| **Python 3.10+** | optional | Only needed for the local embedding service |
| OS | Windows / Linux / macOS | Windows helper scripts are `.bat` |

> **Node version matters.** Native binaries are compiled against the ABI of the Node that ran
> `npm install`. Switching Node later (nvm, a different install, etc.) breaks them — re-run
> `npm install --foreground-scripts` after the switch, or the engine exits immediately on start.

## Quick start

### 1. Get the code

```bash
git clone https://github.com/ehwin/castalia.git
cd castalia
```

### 2. Install dependencies

```bash
npm install
```

> ### ⚠️ npm 12+ blocks native install scripts
> npm 12 blocks package install scripts by default (supply-chain hardening). Blocked scripts mean
> `better-sqlite3` has **no compiled binary**, and the engine dies at startup with:
>
> ```
> Cannot find module '.../better-sqlite3/build/Release/better_sqlite3.node'
> ```
>
> This repo declares the permission in `package.json`, so a plain `npm install` is enough:
>
> ```json
> "allowScripts": { "better-sqlite3": true }
> ```
>
> If you still hit the error (older checkout, a stale `node_modules`, or a custom `.npmrc`), run:
>
> ```bash
> npm install-scripts approve better-sqlite3
> npm install --foreground-scripts      # compiles the native module, 1-5 min
> ```
>
> Confirm the binary is there:
>
> ```bash
> ls node_modules/better-sqlite3/build/Release/better_sqlite3.node
> ```
>
> Note: `.npmrc`'s `allow-scripts` is **ignored** when `package.json` declares its own
> `allowScripts` field — the package.json entry wins.

### 3. Build

```bash
npm run build          # tsc -> dist/
```

### 4. Smoke test (no embedding service required)

```bash
python scripts/smoke_test.py
```

This drives the server over stdio and round-trips save / search / delete against a throwaway
`test_smoke.sqlite`. It exits non-zero on the first mismatch.

> If it crashes with `Cannot find module ... better_sqlite3.node`, go back to step 2.
> If it reports an ABI error, your Node version changed after `npm install` — see the note above.

### 5. (Optional) local embedding service

Vector search needs a 1024-dim embedding endpoint. Any Ollama-compatible service works — point
`OLLAMA_URL` + `EMBEDDING_MODEL` at it (for a hosted OpenAI-compatible endpoint, also set
`EMBEDDING_API_KEY`).

A ready-made local service is included:

```bat
scripts\start-embed.bat
```

It listens on `http://127.0.0.1:11436`. The first start downloads the model — **that can take
minutes and several hundred MB**, not the "30-60s" a warm cache takes.

Skip this entirely if you only need text search: the engine degrades gracefully and logs
`embed = API / local` at startup.

### 6. Connect an MCP client

Add a server entry to your client's MCP config (see `mcp-config.example.json` for a template):

```json
{
  "mcpServers": {
    "castalia": {
      "command": "node",
      "args": ["<absolute path to this repo>/dist/index.js"],
      "env": {
        "MCP_TOOLS": "all",
        "MEMORY_DB_DIR": "<absolute path to this repo>/memory",
        "EMBEDDING_MODEL": "bge-m3",
        "OLLAMA_URL": "http://127.0.0.1:11436"
      }
    }
  }
}
```

Restart the client, then call any tool (e.g. `memory_save`) to confirm the connection.

## Where data lives

| Path | Content |
| --- | --- |
| `memory/` | SQLite databases, one per project (`MEMORY_DB_DIR`) |
| `memory/keys.enc`, `memory/keys.key` | Encrypted API keys — **never commit these** (already in `.gitignore`) |
| `test_smoke.sqlite` | Throwaway DB created by the smoke test; safe to delete |

`MEMORY_DB_DIR` is the recommended knob. The legacy single-file `MEMORY_DB_PATH` still works but
logs a deprecation warning and skips per-project layout.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Cannot find module ...better_sqlite3.node` | npm blocked the native install script | `npm install-scripts approve better-sqlite3` then `npm install --foreground-scripts` |
| Engine exits instantly, `NODE_MODULE_VERSION` mismatch in the error | Node changed after install | Re-run `npm install --foreground-scripts` with the Node you intend to use |
| `[reflect-startup] skipped: REFLECT_LLM_API_KEY not configured` | Expected without an LLM key | Set the key to enable reflection; harmless otherwise |
| `[consolidate-startup] skipped: ... below threshold` | Fewer memories than the threshold | Expected on a fresh database |
| Embedding requests 404/hang | No embedding service on `OLLAMA_URL` | Start `scripts\start-embed.bat`, or set `OLLAMA_URL` to your own endpoint |
| Smoke test hangs | It waits for a server response that never arrives | Check the server starts manually: `node dist/index.js` (it stays open on stdio — send a JSON-RPC `initialize` line) |

## Verifying a fresh install (what we actually ran)

1. `git clone` a clean checkout into an empty directory — no `node_modules`, no databases.
2. `npm install` → native module built, `better_sqlite3.node` present.
3. `npm run build` → compiles clean.
4. MCP `initialize` handshake → responds with `serverInfo {name: "castalia"}`.
5. `python scripts/smoke_test.py` → CRUD round-trip passes.
