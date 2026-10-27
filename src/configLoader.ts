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
function loadEncryptedSecrets(): void {
  const keysFile = process.env.CASTALIA_KEYS_FILE
    || path.join(process.cwd(), 'memory', 'keys.enc');
  const keyFile = process.env.CASTALIA_KEY_FILE
    || path.join(process.cwd(), 'memory', 'keys.key');

  const keyMissing = !fs.existsSync(keyFile);
  const encMissing = !fs.existsSync(keysFile);
  if (keyMissing && encMissing) return; // 未配置,静默跳过

  if (keyMissing || encMissing) {
    console.warn(`[config] keys.enc/keys.key missing (${keyMissing ? 'keys.key' : 'keys.enc'}) — skipping encrypted secrets`);
    return;
  }

  try {
    const key = Buffer.from(fs.readFileSync(keyFile, 'utf-8').trim(), 'hex');
    if (key.length !== 32) throw new Error(`key must be 32 bytes, got ${key.length}`);
    const enc = JSON.parse(fs.readFileSync(keysFile, 'utf-8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
    const plain = Buffer.concat([
        decipher.update(Buffer.from(enc.data, 'hex')),
        decipher.final(),
    ]).toString('utf-8');
    const secrets = JSON.parse(plain);

    const channels: Array<[channel: string, envVar: string]> = [
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
    if (injected > 0) console.error(`[config] loaded ${injected} api key(s) from ${keysFile}`);
  } catch (e: any) {
    console.warn(`[config] keys.enc decrypt failed: ${e.message} — falling back to env/config.json`);
  }
}

loadEncryptedSecrets();

try {
  if (fs.existsSync(CONFIG_PATH)) {
    // 容忍 Windows 编辑器/PowerShell 写入的 UTF-8 BOM(否则 JSON.parse 直接失败,整份配置被忽略)
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8').replace(/^\uFEFF+/, ''));

    // v1.23.1-fix: 与文件头/web 端一致 —— 显式环境变量优先，config.json 只填充未设置的项。
    // 旧实现无条件覆盖 MEMORY_DB_DIR/EMBED_MODE 等，会造成“引擎读 B 库、控制台显示 A 库”的串库。
    if (!process.env.MEMORY_DB_DIR && cfg.db_dir && typeof cfg.db_dir === 'string' && cfg.db_dir.trim()) {
      process.env.MEMORY_DB_DIR = cfg.db_dir.trim();
    }

    // 嵌入模型配置
    const emb = cfg.embedding || {};
    // v1.25: 向量维度可配 —— 换嵌入模型(不同维度)不再需要改源码;
    // db.ts 的 vecDim() 惰性读取本值,首开库时按需重建 vec 表并标记重嵌。
    if (emb.dim != null && String(emb.dim).trim()) {
      // 2026-10-27 修复(E1):本段上方刚声明"显式环境变量优先",这里却无条件覆盖 ——
      // 于是 `EMBEDDING_DIM=4096` 的运行环境会被 config.json 里的 dim 压回 1024,
      // 触发 reconcileVecDim 静默降维清库(与控制台 E2 是同一后果的两个入口)。
      if (process.env.EMBEDDING_DIM || process.env.VEC_DIM) {
        console.warn(`[config] 已显式设置 EMBEDDING_DIM/VEC_DIM，忽略 config.json 的 embedding.dim=${emb.dim}（显式环境变量优先）`);
      } else {
        process.env.EMBEDDING_DIM = String(emb.dim).trim();
      }
    }
    const embMode = emb.mode ? String(emb.mode).toLowerCase().trim() : '';
    if (embMode && !process.env.EMBED_MODE) {
      if (['none', 'ollama', 'api'].includes(embMode)) process.env.EMBED_MODE = embMode;
      else console.error(`[config] 未知 embedding.mode=${embMode}，忽略`);
    }
    if (embMode === 'api') {
      if (emb.api_url && !process.env.OLLAMA_URL) process.env.OLLAMA_URL = emb.api_url.replace(/\/+$/, '');
      if (emb.api_model && !process.env.EMBEDDING_MODEL) process.env.EMBEDDING_MODEL = emb.api_model;
      if (emb.api_key && !process.env.EMBEDDING_API_KEY) process.env.EMBEDDING_API_KEY = emb.api_key;
    } else if (embMode && embMode !== 'none') {
      if (emb.ollama_url && !process.env.OLLAMA_URL) process.env.OLLAMA_URL = emb.ollama_url.replace(/\/+$/, '');
      if (emb.model && !process.env.EMBEDDING_MODEL) process.env.EMBEDDING_MODEL = emb.model;
    }

    // 反思 LLM 配置
    const ref = cfg.reflect || {};
    if (ref.llm_url && !process.env.REFLECT_LLM_URL) process.env.REFLECT_LLM_URL = ref.llm_url.replace(/\/+$/, '');
    if (ref.api_key && !process.env.REFLECT_LLM_API_KEY) process.env.REFLECT_LLM_API_KEY = ref.api_key;
    if (ref.model && !process.env.REFLECT_LLM_MODEL) process.env.REFLECT_LLM_MODEL = ref.model;
    if (ref.factExtraction) process.env.REFLECT_FACT_EXTRACTION = String(ref.factExtraction);
    if (ref.maxFacts != null) process.env.REFLECT_MAX_FACTS = String(ref.maxFacts);
    // 重路径(总反思/深度/整合)的输出预算;浅层(triage/reflect_auto)不受影响
    if (ref.maxTokens != null) process.env.REFLECT_DEEP_MAX_TOKENS = String(ref.maxTokens);
    // v1.9: 启动自动反思阈值(可选,给 admin 界面留路;没有则用 env/默认值)
    if (ref.minGapHours != null) process.env.REFLECT_MIN_GAP_HOURS = String(ref.minGapHours);
    if (ref.minUnanalyzed != null) process.env.REFLECT_MIN_UNANALYZED = String(ref.minUnanalyzed);
    // v1.12: 提示词文件覆盖(单个实例/项目自己的反思/整合提示词)
    if (ref.promptFile) process.env.REFLECT_PROMPT_FILE = String(ref.promptFile);
    if (ref.deepPromptFile) process.env.REFLECT_DEEP_PROMPT_FILE = String(ref.deepPromptFile);
    if (ref.intervalHours != null) process.env.REFLECT_INTERVAL_HOURS = String(ref.intervalHours);

    // v1.11: triage(LLM1 入站分拣)配置 — admin 第三个通道
    const tri = cfg.triage || {};
    if (tri.llm_url && !process.env.TRIAGE_LLM_URL) process.env.TRIAGE_LLM_URL = tri.llm_url.replace(/\/+$/, '');
    if (tri.api_key && !process.env.TRIAGE_LLM_API_KEY) process.env.TRIAGE_LLM_API_KEY = tri.api_key;
    if (tri.model && !process.env.TRIAGE_LLM_MODEL) process.env.TRIAGE_LLM_MODEL = tri.model;

    // v1.11 Part2: 渐进式临时反思配置(admin 留路;缺省用 env/默认值)
    if (tri.bufferSize != null) process.env.BUFFER_SIZE = String(tri.bufferSize);
    if (tri.bufferTokens != null) process.env.BUFFER_TOKENS = String(tri.bufferTokens);
    if (tri.sessionTtlDays != null) process.env.SESSION_MEMORY_TTL_DAYS = String(tri.sessionTtlDays);

    // v1.10: 记忆整合配置(可选,给 admin 界面留路;没有则用 env/默认值)
    const cons = cfg.consolidate || {};
    if (cons.minMemories != null) process.env.CONSOLIDATE_MIN_MEMORIES = String(cons.minMemories);
    if (cons.similarity != null) process.env.CONSOLIDATE_SIMILARITY = String(cons.similarity);
    if (cons.autoOnStart != null) process.env.CONSOLIDATE_AUTO_ON_START = (cons.autoOnStart === false || cons.autoOnStart === 0 || cons.autoOnStart === '0') ? '0' : '1';
    if (cons.promptFile) process.env.CONSOLIDATE_PROMPT_FILE = String(cons.promptFile);
  // 衰减范围(哪些分类库参与衰减/升华):默认只 general,四个语义分类库永不衰减
  if ((cons as any).decayMemTypes != null) {
    const dm = (cons as any).decayMemTypes;
    process.env.CONSOLIDATE_DECAY_MEMTYPES = Array.isArray(dm) ? dm.join(',') : String(dm);
  }
  // 衰减/升华参数(可自定义;详见 consolidate.ts 顶部默认值)
  const DECAY_MAP: Record<string, string> = {
    decaySteepness: 'CONSOLIDATE_DECAY_STEEPNESS',
    decayMidpointDays: 'CONSOLIDATE_DECAY_MIDPOINT_DAYS',
    decayMinImportance: 'CONSOLIDATE_DECAY_MIN_IMPORTANCE',
    decayMinAgeDays: 'CONSOLIDATE_DECAY_MIN_AGE_DAYS',
    promoteRefCount: 'CONSOLIDATE_PROMOTE_REF_COUNT',
    promoteBoost: 'CONSOLIDATE_PROMOTE_BOOST',
    promoteCap: 'CONSOLIDATE_PROMOTE_CAP',
  };
  for (const [k, envName] of Object.entries(DECAY_MAP)) {
    const v = (cons as any)[k];
    if (v != null) process.env[envName] = String(v);
  }

    console.error(`[config] loaded ${CONFIG_PATH} (embed=${emb.mode || 'ollama'}, reflect=${ref.model || 'unset'}, facts=${process.env.REFLECT_FACT_EXTRACTION || 'auto'}, consolidate=${process.env.CONSOLIDATE_MIN_MEMORIES || '15'}/${process.env.CONSOLIDATE_SIMILARITY || '0.88'}, triage=${tri.model || 'unset'}, buffer=${process.env.BUFFER_SIZE || '5'}, sessionTtl=${process.env.SESSION_MEMORY_TTL_DAYS || '7'}d)`);
  }
} catch (e: any) {
  console.error('[config] load failed:', e.message);
}
