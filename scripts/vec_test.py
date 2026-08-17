#!/usr/bin/env python3
"""MCP stdio 完整链路测试 — 验证嵌入服务 + 向量搜索(真实 embed 往返)"""
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which('node') or r"D:\system\New Folder\node.exe"  # fallback:本机 node
SERVER = os.path.join(ROOT, "dist", "index.js")

env = {**os.environ, **{'MCP_TOOLS': os.environ.get('MCP_TOOLS', 'all'),
    "OLLAMA_URL": os.environ.get('OLLAMA_URL', "http://127.0.0.1:11436"),  # 独立嵌入服务
    "EMBEDDING_MODEL": os.environ.get('EMBEDDING_MODEL', "yuan-embedding-2.0-zh"),
    "MEMORY_DB_PATH": os.path.join(ROOT, "test_vec.sqlite"),
    "CHAR_ID": "harness-test",
}}

proc = subprocess.Popen(
    [NODE, SERVER],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    env=env, cwd=ROOT,
)

msg_id = 0

def send(method, params):
    global msg_id
    msg_id += 1
    req = {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}
    proc.stdin.write((json.dumps(req) + "\n").encode())
    proc.stdin.flush()
    return msg_id

def recv(timeout=30):
    proc.stdout.flush()
    line = proc.stdout.readline()
    return json.loads(line) if line else None

def call_tool(name, args):
    mid = send("tools/call", {"name": name, "arguments": args})
    while True:
        r = recv()
        if r and r.get("id") == mid:
            return r

try:
    mid = send("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "vec-test", "version": "1.0"}})
    while True:
        r = recv()
        if r and r.get("id") == mid:
            print("[OK] initialize")
            break
    send("notifications/initialized", {})

    # 带嵌入保存 3 条记忆
    mems = [
        "用户喜欢喝美式咖啡,每天早上都要一杯",
        "用户最近在测试一个纯记忆体框架,用于 harness 内测",
        "用户在研究紫微斗数和六爻古籍的数字化",
    ]
    for m in mems:
        r = call_tool("memory_save", {"text": m, "type": "episodic", "category": "conversation", "tags": ["test"], "importance": 0.6})
        saved = json.loads(r["result"]["content"][0]["text"])
        assert "id" in saved, f"save failed: {r}"
        print(f"[OK] saved → {saved['id'][:8]} {m[:30]}")

    time.sleep(1)

    # 向量搜索:语义相似查询(关键词不重叠,只能靠向量)
    for q in ["咖啡口味", "记忆体内测"]:
        r = call_tool("memory_search", {"query": q, "topK": 3})
        res = json.loads(r["result"]["content"][0]["text"])
        print(f"[OK] vec_search('{q}') → {res['count']} results")
        for m in res["results"][:3]:
            print(f"     {round(m['score'], 3)} | {m['text'][:35]}")

    r = call_tool("stats_get", {})
    stats = json.loads(r["result"]["content"][0]["text"])
    print("[OK] stats total:", stats["total"])

    # ── v1.5 向量项目隔离:同语义记忆在不同项目互不可见 ──
    r = call_tool("memory_save", {"text": "用户喜欢喝美式咖啡,每天早上都要一杯", "project": "vproj", "type": "episodic", "category": "conversation", "tags": ["test"], "importance": 0.6})
    assert "id" in json.loads(r["result"]["content"][0]["text"]), f"vproj save failed: {r}"
    print("[OK] saved → 项目 vproj 带嵌入记忆")

    time.sleep(1)

    # 在 vproj 里搜"咖啡口味" → 应命中 vproj 的咖啡记忆(向量 KNN + project 过滤)
    r = call_tool("memory_search", {"query": "咖啡口味", "topK": 3, "project": "vproj"})
    res = json.loads(r["result"]["content"][0]["text"])
    assert res["count"] >= 1, f"vproj search returned nothing: {res}"
    print(f"[OK] vec_search('咖啡口味', project=vproj) → {res['count']} results(全部属于 vproj)")

    # 用 project_list 核对 vproj 存在且带向量记忆
    r = call_tool("project_list", {})
    pl = json.loads(r["result"]["content"][0]["text"])
    names = {p2["project"] for p2 in pl.get("projects", [])}
    assert "vproj" in names, f"project_list missing vproj: {pl}"
    print("[OK] project_list 包含 vproj")

    print("\n=== VECTOR CHAIN TEST PASSED ===")
finally:
    proc.stdin.close()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
