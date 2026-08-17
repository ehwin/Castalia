@echo off
chcp 65001 >nul
title AI-Memory Embed Server
rem --- 清除 PYTHONPATH 污染（Hermes 注入的 venv 路径会让 Python310 加载错误二进制） ---
set PYTHONPATH=

echo ========================================
echo   AI Memory — Embed Server (Yuan-EB 2.0-zh)
echo ========================================
echo.

rem --- 端口清理:先杀 11436 上的旧进程 ---
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":11436" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a 2>nul
)
timeout /t 1 /nobreak >nul

rem --- 启动嵌入服务(无窗口,日志落 embed-server.log) ---
start "YuanEmbed" "C:/Users/yuepengcheng/AppData/Local/Programs/Python/Python310/pythonw.exe" "%~dp0yuan_embed_server.py" 11436

echo  嵌入服务启动中,首次加载模型约 30-60 秒...
timeout /t 5 /nobreak >nul

curl -s http://127.0.0.1:11436/health || echo  服务未就绪,查看 embed-server.log
echo.
echo  就绪后,在你的 MCP 客户端里配置:
echo    node "D:\AI\AI memory\dist\index.js"
echo    env: OLLAMA_URL=http://127.0.0.1:11436
echo         EMBEDDING_MODEL=yuan-embedding-2.0-zh
echo         MEMORY_DB_PATH=D:\AI\AI memory\memory.sqlite
echo         CHAR_ID=你的角色ID(可选,默认 airi)
echo.
echo  完整示例见 mcp-config.example.json
pause
