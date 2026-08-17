/**
 * Config Loader — 启动时读取 config.json 覆盖环境变量
 *
 * 供 web 管理界面持久化配置:嵌入模型(Ollama/API 两种模式)+ 反思 LLM。
 * 配置文件路径:环境变量 MEMORY_CONFIG 或 ./memory/config.json(与 web/server.mjs 共享)
 *
 * 加密 API-key 存储(memory/keys.enc):AES-256-GCM 解密后注入环境变量,与 Anima 版同构。
 * 优先级:显式环境变量 > keys.enc > config.json(仅填充未设置的 env,不覆盖已有值)。
 *
 * 必须在 index.ts 的 import 中放在最前面(确保在 ollama.ts/reflectDriver.ts 读取 env 之前生效)。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const CONFIG_PATH = process.env.MEMORY_CONFIG
    || path.join(process.cwd(), 'memory', 'config.json');
/**
 * 解密 memory/keys.enc(由 scripts/keygen.js 生成)注入环境变量。
 * 密钥:CASTALIA_KEY_FILE 或 <cwd>/memory/keys.key(32 字节 hex)
 * 密文:{ iv, tag, data }(base64)→ 明文 JSON:
 *   { "reflect": { "api_key": ... }, "triage": { "api_key": ... }, "embedding": { "api_key": ... } }
 * 解密失败/文件缺失:静默跳过,console.warn 一次。
 */
function loadEncryptedSecrets() {
    const keysFile = process.env.CASTALIA_KEYS_FILE
        || path.join(process.cwd(), 'memory', 'keys.enc');
    const keyFile = process.env.CASTALIA_KEY_FILE
        || path.join(process.cwd(), 'memory', 'keys.key');
    const keyMissing = !fs.existsSync(keyFile);
    const encMissing = !fs.existsSync(keysFile);
    if (keyMissing && encMissing)
        return; // 未配置,静默跳过
    if (keyMissing || encMissing) {
        console.warn(`[config] keys.enc/keys.key missing (${keyMissing ? 'keys.key' : 'keys.enc'}) — skipping encrypted secrets`);
        return;
    }
    try {
        const key = Buffer.from(fs.readFileSync(keyFile, 'utf-8').trim(), 'hex');
        if (key.length !== 32)
            throw new Error(`key must be 32 bytes, got ${key.length}`);
        const enc = JSON.parse(fs.readFileSync(keysFile, 'utf-8'));
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'hex'));
        decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
        const plain = Buffer.concat([
            decipher.update(Buffer.from(enc.data, 'hex')),
            decipher.final(),
        ]).toString('utf-8');
        const secrets = JSON.parse(plain);
        const channels = [
            ['reflect', 'REFLECT_LLM_API_KEY'],
            ['triage', 'TRIAGE_LLM_API_KEY'],
            ['embedding', 'EMBEDDING_API_KEY'],
        ];
        let injected = 0;
        for (const [channel, envVar] of channels) {
            const val = secrets[channel]?.api_key;
            if (typeof val === 'string' && val.trim() && !(envVar in process.env)) {
                process.env[envVar] = val.trim();
                injected++;
            }
        }
        if (injected > 0)
            console.error(`[config] loaded ${injected} api key(s) from ${keysFile}`);
    }
    catch (e) {
        console.warn(`[config] keys.enc decrypt failed: ${e.message} — falling back to env/config.json`);
    }
}
loadEncryptedSecrets();
try {
    if (fs.existsSync(CONFIG_PATH)) {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        // 记忆库目录配置:config.json 的 db_dir 字段(若有)覆盖环境变量
        if (cfg.db_dir && typeof cfg.db_dir === 'string' && cfg.db_dir.trim()) {
            process.env.MEMORY_DB_DIR = cfg.db_dir.trim();
        }
        // 嵌入模型配置
        const emb = cfg.embedding || {};
        if (emb.mode === 'api') {
            if (emb.api_url)
                process.env.OLLAMA_URL = emb.api_url.replace(/\/+$/, '');
            if (emb.api_model)
                process.env.EMBEDDING_MODEL = emb.api_model;
            if (emb.api_key && !process.env.EMBEDDING_API_KEY)
                process.env.EMBEDDING_API_KEY = emb.api_key;
        }
        else {
            // 默认 Ollama 模式
            if (emb.ollama_url)
                process.env.OLLAMA_URL = emb.ollama_url.replace(/\/+$/, '');
            if (emb.model)
                process.env.EMBEDDING_MODEL = emb.model;
        }
        // 反思 LLM 配置
        const ref = cfg.reflect || {};
        if (ref.llm_url)
            process.env.REFLECT_LLM_URL = ref.llm_url.replace(/\/+$/, '');
        if (ref.api_key && !process.env.REFLECT_LLM_API_KEY)
            process.env.REFLECT_LLM_API_KEY = ref.api_key;
        if (ref.model)
            process.env.REFLECT_LLM_MODEL = ref.model;
        if (ref.factExtraction)
            process.env.REFLECT_FACT_EXTRACTION = String(ref.factExtraction);
        if (ref.maxFacts != null)
            process.env.REFLECT_MAX_FACTS = String(ref.maxFacts);
        // v1.9: 启动自动反思阈值(可选,给 admin 界面留路;没有则用 env/默认值)
        if (ref.minGapHours != null)
            process.env.REFLECT_MIN_GAP_HOURS = String(ref.minGapHours);
        if (ref.minUnanalyzed != null)
            process.env.REFLECT_MIN_UNANALYZED = String(ref.minUnanalyzed);
        // v1.11: triage(LLM1 入站分拣)配置 — admin 第三个通道
        const tri = cfg.triage || {};
        if (tri.llm_url)
            process.env.TRIAGE_LLM_URL = tri.llm_url.replace(/\/+$/, '');
        if (tri.api_key && !process.env.TRIAGE_LLM_API_KEY)
            process.env.TRIAGE_LLM_API_KEY = tri.api_key;
        if (tri.model)
            process.env.TRIAGE_LLM_MODEL = tri.model;
        // v1.11 Part2: 渐进式临时反思配置(admin 留路;缺省用 env/默认值)
        if (tri.bufferSize != null)
            process.env.BUFFER_SIZE = String(tri.bufferSize);
        if (tri.sessionTtlDays != null)
            process.env.SESSION_MEMORY_TTL_DAYS = String(tri.sessionTtlDays);
        // v1.10: 记忆整合配置(可选,给 admin 界面留路;没有则用 env/默认值)
        const cons = cfg.consolidate || {};
        if (cons.minMemories != null)
            process.env.CONSOLIDATE_MIN_MEMORIES = String(cons.minMemories);
        if (cons.similarity != null)
            process.env.CONSOLIDATE_SIMILARITY = String(cons.similarity);
        console.error(`[config] loaded ${CONFIG_PATH} (embed=${emb.mode || 'ollama'}, reflect=${ref.model || 'unset'}, facts=${process.env.REFLECT_FACT_EXTRACTION || 'auto'}, consolidate=${process.env.CONSOLIDATE_MIN_MEMORIES || '15'}/${process.env.CONSOLIDATE_SIMILARITY || '0.88'}, triage=${tri.model || 'unset'}, buffer=${process.env.BUFFER_SIZE || '5'}, sessionTtl=${process.env.SESSION_MEMORY_TTL_DAYS || '7'}d)`);
    }
}
catch (e) {
    console.error('[config] load failed:', e.message);
}
