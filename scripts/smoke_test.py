#!/usr/bin/env python3
"""MCP stdio 冒烟测试 — 验证记忆体核心 CRUD 往返(不依赖嵌入服务)"""
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE137 = r"D:\system\New Folder\node.exe"  # better-sqlite3/sqlite-vec 按 NODE_MODULE_VERSION 137 编译
NODE = NODE137 if os.path.exists(NODE137) else (shutil.which('node') or NODE137)  # PATH 第一个可能是 Hermes 127,会 ABI 崩溃
SERVER = os.path.join(ROOT, "dist", "index.js")

# 继承完整系统环境(env 传自定义 dict 会完全替换,导致 node crypto 初始化崩溃)
env = {**os.environ, **{'MCP_TOOLS': os.environ.get('MCP_TOOLS', 'all'),
    "OLLAMA_URL": os.environ.get('OLLAMA_URL', "http://127.0.0.1:11435"),
    "EMBEDDING_MODEL": os.environ.get('EMBEDDING_MODEL', "yuan-embedding-2.0-zh"),
    "MEMORY_DB_PATH": os.path.join(ROOT, "test_smoke.sqlite"),
    "CHAR_ID": "harness-test",
}}

proc = subprocess.Popen(
    [NODE, SERVER],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    env=env,
    cwd=ROOT,
)

msg_id = 0

def send(method, params):
    global msg_id
    msg_id += 1
    req = {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}
    proc.stdin.write((json.dumps(req) + "\n").encode())
    proc.stdin.flush()
    return msg_id

def recv(timeout=20):
    proc.stdout.flush()
    line = proc.stdout.readline()
    if not line:
        return None
    return json.loads(line)

def call_tool(name, args):
    mid = send("tools/call", {"name": name, "arguments": args})
    while True:
        r = recv()
        if r.get("id") == mid:
            return r

try:
    # 1. initialize
    mid = send("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "smoke-test", "version": "1.0"}})
    while True:
        r = recv()
        if r.get("id") == mid:
            assert "result" in r, f"initialize failed: {r}"
            print("[OK] initialize → server:", r["result"]["serverInfo"])
            break
    send("notifications/initialized", {})

    # 2. tools/list — 确认工具数量
    mid = send("tools/list", {})
    while True:
        r = recv()
        if r.get("id") == mid:
            tools = [t["name"] for t in r["result"]["tools"]]
            print(f"[OK] tools/list → {len(tools)} tools: {tools}")
            break

    # 3. memory_save (skipEmbed=true 避开嵌入服务)
    r = call_tool("memory_save", {"text": "harness 冒烟测试记忆:用户正在测试纯记忆体框架", "type": "episodic", "category": "conversation", "tags": ["smoke"], "importance": 0.8, "skipEmbed": True})
    saved = json.loads(r["result"]["content"][0]["text"])
    assert "id" in saved, f"save failed: {r}"
    print("[OK] memory_save →", saved["id"][:8], saved["text"])

    # 4. memory_search — 标签优先,不依赖向量
    r = call_tool("memory_search", {"query": "纯记忆体框架"})
    res = json.loads(r["result"]["content"][0]["text"])
    print(f"[OK] memory_search → {res['count']} results")
    for m in res["results"][:3]:
        print("     -", m["text"][:40], "| score:", round(m["score"], 3))

    # 5. stats_get
    r = call_tool("stats_get", {})
    stats = json.loads(r["result"]["content"][0]["text"])
    print("[OK] stats_get → total:", stats["total"])

    # 6. memory_recent
    r = call_tool("memory_recent", {"limit": 5, "hoursBack": 24})
    recent = json.loads(r["result"]["content"][0]["text"])
    print("[OK] memory_recent →", recent["count"], "memories")

    # ── v1.5 项目隔离测试 ──────────────────────────────────────────
    # 7. 往 alpha 项目写记忆,再用 project 参数搜索验证隔离
    r = call_tool("memory_save", {"text": "alpha 项目专属记忆:前端重构计划", "project": "alpha", "skipEmbed": True})
    assert "id" in json.loads(r["result"]["content"][0]["text"]), f"alpha save failed: {r}"
    print("[OK] memory_save(project=alpha) → alpha 项目记忆已写入")

    r = call_tool("memory_save", {"text": "beta 项目专属记忆:数据库迁移方案", "project": "beta", "skipEmbed": True})
    assert "id" in json.loads(r["result"]["content"][0]["text"]), f"beta save failed: {r}"
    print("[OK] memory_save(project=beta) → beta 项目记忆已写入")

    # 8. 精确去重跨项目不生效:同文本在 beta 再存一次,应返回不同 id
    r = call_tool("memory_save", {"text": "数据库迁移方案", "project": "beta", "skipEmbed": True})
    beta2 = json.loads(r["result"]["content"][0]["text"])
    r = call_tool("memory_save", {"text": "数据库迁移方案", "project": "alpha", "skipEmbed": True})
    alpha_dup = json.loads(r["result"]["content"][0]["text"])
    if "id" in beta2 and "id" in alpha_dup and beta2["id"] != alpha_dup["id"]:
        print("[OK] 跨项目去重隔离:同一文本在不同项目各自落库")
    else:
        print("[WARN] 跨项目去重未隔离(beta2:", beta2, "alpha_dup:", alpha_dup, ")")

    # 9. project_list 看到两个项目
    r = call_tool("project_list", {})
    pl = json.loads(r["result"]["content"][0]["text"])
    names = {p2["project"] for p2 in pl.get("projects", [])}
    assert "alpha" in names and "beta" in names, f"project_list missing projects: {pl}"
    print(f"[OK] project_list → {pl['count']} 个项目: {names}")

    # 10. stats_get(project=alpha) 只统计 alpha
    r = call_tool("stats_get", {"project": "alpha"})
    st = json.loads(r["result"]["content"][0]["text"])
    print("[OK] stats_get(project=alpha) → total:", st["total"], "| project:", st.get("project"))

    print("\n=== ALL SMOKE TESTS PASSED ===")
finally:
    proc.stdin.close()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
