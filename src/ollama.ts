/**
 * Embedding — SQLite 持久化缓存
 *
 * 支持两种嵌入来源(由环境变量 EMBEDDING_API_KEY 区分):
 *   - Ollama 兼容模式(默认): POST {OLLAMA_URL}/api/embed,无鉴权
 *   - OpenAI 兼容 API 模式: 设置 EMBEDDING_API_KEY 后走 POST {OLLAMA_URL}/embeddings + Bearer
 *
 * 改动：
 * - 内存 Map → SQLite embedding_cache 表
 * - 重启不丢失，重复文本 0ms 返回
 * - 暴露 getEmbeddingCached() 供 store.ts 使用
 */
import { DatabaseManager, VEC_DIM } from './db.js';
import { isEmbedEnabled } from './env.js';
import crypto from 'node:crypto';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';  // Ollama embed server (standard port)
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'yuan-embedding-2.0-zh';  // 1024 dim
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY || '';  // set → OpenAI-compatible /embeddings mode

// 嵌入服务超时(秒):防止嵌入服务挂起导致 saveMemory/search 永久阻塞
const EMBED_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.EMBED_TIMEOUT_MS || '30000', 10);
  return Number.isFinite(v) && v > 0 ? v : 30000;
})();

// 内存级 LRU 缓存（热数据，<1ms）
const memCache = new Map<string, number[]>();
const MEM_CACHE_MAX = 200;

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export async function embed(text: string, project?: string): Promise<number[]> {
  // EMBED_MODE=none → 禁用嵌入(调用方应已降级;这里兜底抛错避免静默外部调用)
  if (!isEmbedEnabled()) {
    throw new Error('embedding disabled: EMBED_MODE=none');
  }

  // 1. 内存缓存(全局 LRU,跨项目共享文本→向量)
  const memCached = memCache.get(text);
  if (memCached) return memCached;

  // 2. SQLite 缓存(project 为空 → 默认项目库;embedding_cache 按项目隔离)
  const db = DatabaseManager.getInstance(project);
  const hash = hashText(text);
  try {
    const row = db.prepare('SELECT embedding FROM embedding_cache WHERE text_hash = ?').get(hash) as any;
    if (row) {
      const vec = Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
      setMemCache(text, vec);
      return vec;
    }
  } catch {}

  // 3. 调嵌入服务(API key 模式 → OpenAI 兼容 /embeddings;否则 Ollama /api/embed)
  let vector: number[];
  const signal = AbortSignal.timeout(EMBED_TIMEOUT_MS);
  if (EMBEDDING_API_KEY) {
    const resp = await fetch(`${OLLAMA_URL}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${EMBEDDING_API_KEY}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
      signal,
    });
    if (!resp.ok) {
      throw new Error(`Embed API failed: ${resp.status} ${await resp.text()}`);
    }
    const data = (await resp.json()) as { data?: { embedding: number[] }[]; error?: string };
    if (data.error) throw new Error(`Embed API error: ${data.error}`);
    const item = data.data?.[0];
    if (!item || !Array.isArray(item.embedding) || item.embedding.length === 0) {
      throw new Error('Embed API: no embedding in response');
    }
    vector = item.embedding;
  } else {
    const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
      signal,
    });
    if (!resp.ok) {
      throw new Error(`Ollama embed failed: ${resp.status} ${await resp.text()}`);
    }
    const data = (await resp.json()) as { embeddings?: number[][]; error?: string };
    if (data.error) throw new Error(`Ollama embed error: ${data.error}`);
    const vec = data.embeddings?.[0];
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('Ollama embed: empty/invalid embedding response');
    }
    vector = vec;
  }

  // 维度护栏:向量维度与 vec 表(VEC_DIM)不符时给出清晰报错,而非后续 sqlite-vec 隐式失败
  if (vector.length !== VEC_DIM) {
    throw new Error(`Embedding dimension mismatch: got ${vector.length}, expected ${VEC_DIM}`);
  }

  // 写入缓存
  setMemCache(text, vector);
  try {
    const floatArr = new Float32Array(vector);
    db.prepare('INSERT OR IGNORE INTO embedding_cache (text_hash, embedding) VALUES (?, ?)').run(hash, floatArr);
  } catch {}

  return vector;
}

/** 带缓存的 embed 别名 */
export async function getEmbeddingCached(text: string, project?: string): Promise<number[]> {
  return embed(text, project);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function setMemCache(text: string, vec: number[]) {
  if (memCache.size >= MEM_CACHE_MAX) {
    // 删第一个（简易 LRU）
    const firstKey = memCache.keys().next().value;
    if (firstKey) memCache.delete(firstKey);
  }
  memCache.set(text, vec);
}
