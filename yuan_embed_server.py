"""
Yuan-EB 2.0-zh Embedding Server
轻量嵌入服务，加载 IEITYuan/Yuan-embedding-2.0-zh
兼容 Ollama /api/embed 接口格式，1024 维输出
fp16 加载：模型权重 ~600MB，总内存 ~2GB
"""
import sys
import json
import time
import threading
import numpy as np
import torch
from flask import Flask, request, jsonify

# pythonw 无控制台运行时 stdout/stderr 为 None，重定向到 DEVNULL 防崩
if sys.stdout is None:
    sys.stdout = open(__import__('os').devnull, 'w', encoding='utf-8')
if sys.stderr is None:
    sys.stderr = open(__import__('os').devnull, 'w', encoding='utf-8')

# ── 文件日志（pythonw 无窗口时也能排障）──
import logging
import os as _os
_SCRIPT_DIR = _os.path.dirname(_os.path.abspath(__file__))
logging.basicConfig(
    filename=_os.path.join(_SCRIPT_DIR, "embed-server.log"),
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    encoding="utf-8",
)
logger = logging.getLogger("yuan_embed")
_console = print

def _log(msg):
    logger.info(msg)
    try: _console(msg)
    except Exception: pass

app = Flask(__name__)

# 延迟加载，避免启动阻塞
_model = None
_tokenizer = None
_last_access = time.time()

def load_model():
    global _model, _tokenizer
    if _model is not None:
        return
    _log("Loading Yuan-EB 2.0-zh (fp16, from modelscope)...")
    import os
    os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
    from transformers import AutoTokenizer, AutoModel
    try:
        _tokenizer = AutoTokenizer.from_pretrained("IEITYuan/Yuan-embedding-2.0-zh", trust_remote_code=True)
        _model = AutoModel.from_pretrained(
            "IEITYuan/Yuan-embedding-2.0-zh",
            trust_remote_code=True,
            torch_dtype=torch.float16,
        )
    except:
        # fallback: modelscope
        from modelscope import snapshot_download
        model_dir = snapshot_download('IEITYuan/Yuan-embedding-2.0-zh')
        _tokenizer = AutoTokenizer.from_pretrained(model_dir, trust_remote_code=True)
        _model = AutoModel.from_pretrained(
            model_dir,
            trust_remote_code=True,
            torch_dtype=torch.float16,
        )
    _log("Yuan-EB 2.0-zh loaded (fp16).")

# 空闲 10 分钟后自动卸载模型，释放内存
UNLOAD_IDLE_SEC = 600

def _auto_unloader():
    global _model, _tokenizer
    while True:
        time.sleep(60)
        if _model is not None and time.time() - _last_access > UNLOAD_IDLE_SEC:
            _model = None
            _tokenizer = None
            import gc
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            _log("Yuan-EB: model unloaded (idle > 10min)")

threading.Thread(target=_auto_unloader, daemon=True).start()

def embed_texts(texts: list) -> list:
    """返回 list of 1024-dim float vectors (fp16 推理，输出 float32)"""
    global _last_access
    _last_access = time.time()
    load_model()
    inputs = _tokenizer(texts, padding=True, truncation=True, max_length=512, return_tensors="pt")
    with torch.no_grad():
        outputs = _model(**inputs)
        # mean pooling (兼容 fp16/fp32 混合精度)
        attention_mask = inputs["attention_mask"]
        hidden = outputs.last_hidden_state.float()  # fp16→fp32 安全转换
        mask_expanded = attention_mask.unsqueeze(-1).expand(hidden.size()).float()
        pooled = (hidden * mask_expanded).sum(1) / mask_expanded.sum(1).clamp(min=1e-9)
        # L2 normalize
        pooled = torch.nn.functional.normalize(pooled, p=2, dim=1)
    return pooled.cpu().numpy().tolist()

@app.route("/api/embed", methods=["POST"])
def embed():
    """Ollama-compatible /api/embed endpoint"""
    data = request.get_json(force=True, silent=True) or {}
    if isinstance(data, str):
        import json as _json
        try: data = _json.loads(data)
        except: data = {}
    model = data.get("model", "")
    text_input = data.get("input", "")
    if isinstance(text_input, str):
        texts = [text_input]
    elif isinstance(text_input, list):
        texts = text_input
    else:
        return jsonify({"error": "invalid input"}), 400
    
    vectors = embed_texts(texts)
    return jsonify({
        "model": model or "yuan-embedding-2.0-zh",
        "embeddings": vectors,
    })

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": "yuan-embedding-2.0-zh"})

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 11436
    _log(f"Yuan-EB Embed Server starting on port {port}")
    app.run(host="127.0.0.1", port=port, threaded=True)
