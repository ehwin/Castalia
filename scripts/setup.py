#!/usr/bin/env python3
"""
Castalia setup — 一键为你的 agent 配置 MCP 接入(借鉴 engram 的 `engram setup` 模式)

用法:
  python setup.py                      # 列出支持的 agent
  python setup.py claude               # Claude Code  → 项目 .mcp.json
  python setup.py opencode             # OpenCode     → .opencode.json
  python setup.py cursor               # Cursor       → .cursor/mcp.json
  python setup.py vscode               # VS Code      → .vscode/mcp.json
  python setup.py codex                # Codex CLI    → .codex/config.toml (mcp 命令)
  python setup.py hermes               # Hermes Agent → 打印 `hermes config set` 命令
  python setup.py json                 # 输出标准 mcpServers JSON(自行粘贴)

行为:
  - 检测项目根目录(本脚本上一级),生成绝对路径配置
  - 已有配置文件时智能合并(保留原 server 条目)
  - 配置完提醒启动嵌入服务
"""
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def shutil_which_node():
    return shutil.which('node') or 'node'


def mcp_server_config():
    """返回 Castalia 的 MCP server 配置(绝对路径)"""
    return {
        "castalia": {
            "command": shutil_which_node(),
            "args": [os.path.join(ROOT, "dist", "index.js")],
            "env": {
                "OLLAMA_URL": os.environ.get("OLLAMA_URL", "http://127.0.0.1:11436"),
                "EMBEDDING_MODEL": os.environ.get("EMBEDDING_MODEL", "yuan-embedding-2.0-zh"),
                "MEMORY_DB_PATH": os.path.join(ROOT, "memory.sqlite"),
                "CHAR_ID": os.environ.get("CHAR_ID", "default"),
            },
        }
    }


def merge_servers(existing, new):
    """合并 mcpServers 字典,新配置优先"""
    merged = dict(existing or {})
    for k, v in new.items():
        merged[k] = v
    return merged


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"  ✓ 已写入 {path}")


def setup_claude():
    # Claude Code:项目级 .mcp.json
    path = os.path.join(ROOT, ".mcp.json")
    existing = {}
    if os.path.exists(path):
        existing = json.load(open(path, encoding="utf-8"))
    existing["mcpServers"] = merge_servers(existing.get("mcpServers"), mcp_server_config())
    write_json(path, existing)
    print("  重启 Claude Code 后生效")


def setup_opencode():
    path = os.path.join(ROOT, ".opencode.json")
    existing = {}
    if os.path.exists(path):
        existing = json.load(open(path, encoding="utf-8"))
    existing["mcp"] = merge_servers(existing.get("mcp"), mcp_server_config())
    write_json(path, existing)
    print("  重启 OpenCode 后生效")


def setup_cursor():
    path = os.path.join(ROOT, ".cursor", "mcp.json")
    existing = {}
    if os.path.exists(path):
        existing = json.load(open(path, encoding="utf-8"))
    existing["mcpServers"] = merge_servers(existing.get("mcpServers"), mcp_server_config())
    write_json(path, existing)
    print("  重启 Cursor 后生效")


def setup_vscode():
    # VS Code:项目 .vscode/mcp.json(新版本地 MCP 支持)
    path = os.path.join(ROOT, ".vscode", "mcp.json")
    existing = {}
    if os.path.exists(path):
        existing = json.load(open(path, encoding="utf-8"))
    existing["servers"] = merge_servers(existing.get("servers"), mcp_server_config())
    write_json(path, existing)
    print("  重启 VS Code 后生效")


def setup_codex():
    # Codex CLI:输出 mcp add 命令(Codex 的 MCP 通过命令管理)
    cfg = mcp_server_config()["castalia"]
    cmd = (
        f"codex mcp add castalia -- {cfg['command']} {' '.join(cfg['args'])}"
    )
    print("  Codex 通过命令管理 MCP,请手动执行:")
    print(f"    {cmd}")
    print("  或在 ~/.codex/config.toml 的 [mcp_servers] 段添加:")
    print(json.dumps(cfg, indent=2, ensure_ascii=False))


def setup_hermes():
    # Hermes Agent:用 `hermes mcp add` 写入 config.yaml(注意 --args 必须放最后)
    cfg = mcp_server_config()["castalia"]
    envs = " ".join(f'"{k}={v}"' for k, v in cfg.get("env", {}).items())
    print("  Hermes Agent 使用 `hermes mcp add` 写入 config.yaml:")
    print(f"    hermes mcp add castalia --command \"{cfg['command']}\"")
    if envs:
        print(f"      --env {envs}")
    print(f"      --args \"{cfg['args'][0]}\"")
    print()
    print("  执行后回答 Y 启用全部工具,然后【新开一个会话】生效(Hermes 无 MCP 热重载)。")
    print("  验证:hermes mcp list / hermes mcp test castalia(期望 Tools discovered: 23)")
    print()
    print("  ⚠️ 不要用 `hermes config set mcp_servers '{...}'` — 会把 JSON 存成字符串,")
    print("     MCP 客户端要求 dict,字符串会被忽略导致 server 永不加载(2026-08-05 实测踩坑)。")
    print("  💡 Windows 上若 node 不在系统 PATH(如 git-bash 自带的 node),请把 --command 换成 node.exe 绝对路径。")


def setup_json():
    print(json.dumps({"mcpServers": mcp_server_config()}, ensure_ascii=False, indent=2))


AGENTS = {
    "claude": setup_claude,
    "opencode": setup_opencode,
    "cursor": setup_cursor,
    "vscode": setup_vscode,
    "codex": setup_codex,
    "hermes": setup_hermes,
    "json": setup_json,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in AGENTS:
        print("Castalia setup — 支持以下 agent:")
        for name in AGENTS:
            print(f"  python setup.py {name}")
        print("\n例如: python setup.py claude")
        sys.exit(1)

    print(f"Castalia MCP 接入配置 → {sys.argv[1]}")
    print(f"  项目根: {ROOT}")
    print(f"  MCP server: {os.path.join(ROOT, 'dist', 'index.js')}")
    print()
    AGENTS[sys.argv[1]]()
    print()
    print("⚠️  首次使用前请先启动嵌入服务:")
    print(f"    scripts\\start-embed.bat")
    print("   (或在你的 agent 环境中设置 OLLAMA_URL 指向其他 1024 维嵌入服务)")


if __name__ == "__main__":
    main()
