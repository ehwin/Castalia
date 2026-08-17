/**
 * API key 加密存储工具(零依赖,node:crypto)
 *
 * 生成/更新 <项目根>/memory/keys.enc(AES-256-GCM 加密的 API keys)与密钥 keys.key。
 * keys.key 不存在时自动生成 32 字节随机 hex;已存在则复用(保证已加密数据可解密)。
 *
 * 用法:
 *   node scripts/keygen.js                                       # 交互式,Enter 跳过保持原值
 *   node scripts/keygen.js --reflect-api-key sk-xxx \            # 命令行传入,未传的保持 keys.enc 原值
 *                          --triage-api-key sk-xxx \
 *                          --embedding-api-key sk-xxx
 *
 * 输出文件(均在 memory/ 下,与代码分离,已 .gitignore):
 *   keys.key  — 32 字节密钥(hex,切勿泄露/提交)
 *   keys.enc  — 加密负载 JSON {iv, tag, data}
 *
 * 启动时 src/configLoader.ts 自动解密 keys.enc 注入环境变量
 * (REFLECT_LLM_API_KEY / TRIAGE_LLM_API_KEY / EMBEDDING_API_KEY),显式环境变量优先。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const memoryDir = path.join(path.resolve(__dirname, '..'), 'memory');
const KEY_FILE = path.join(memoryDir, 'keys.key');
const KEYS_FILE = path.join(memoryDir, 'keys.enc');

const CHANNELS = ['reflect', 'triage', 'embedding'];
const CHANNEL_FLAGS = {
  'reflect-api-key': 'reflect',
  'triage-api-key': 'triage',
  'embedding-api-key': 'embedding',
};

function parseArgs(argv) {
  const overrides = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) continue;
    const channel = CHANNEL_FLAGS[flag.slice(2)];
    if (!channel) {
      console.error(`[keygen] 未知参数 ${flag}(支持:--reflect-api-key / --triage-api-key / --embedding-api-key)`);
      process.exit(1);
    }
    if (i + 1 >= argv.length) {
      console.error(`[keygen] 参数 ${flag} 缺少取值`);
      process.exit(1);
    }
    overrides[channel] = argv[++i];
  }
  return overrides;
}

function ensureKeyFile() {
  const existing = fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf-8').trim() : '';
  if (existing && /^[0-9a-fA-F]{64}$/.test(existing)) return existing;
  if (existing) console.warn(`[keygen] 现有 ${KEY_FILE} 不是合法的 32 字节 hex,将重新生成`);
  const keyHex = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(KEY_FILE, keyHex + '\n', { mode: 0o600 });
  console.log(`[keygen] 已生成密钥文件 ${KEY_FILE}`);
  return keyHex;
}

function loadExistingKeys(keyHex) {
  if (!fs.existsSync(KEYS_FILE)) return {};
  try {
    const { iv, tag, data } = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf-8');
    return JSON.parse(plain);
  } catch (e) {
    console.warn(`[keygen] 现有 ${KEYS_FILE} 无法解密(${e.message}),将按空值重新加密`);
    return {};
  }
}

function buildData(existing, values) {
  const data = {};
  for (const ch of CHANNELS) {
    const v = values[ch] !== undefined ? values[ch] : existing[ch]?.api_key ?? '';
    const t = String(v ?? '').trim();
    if (t) data[ch] = { api_key: t };
  }
  return data;
}

function encryptAndSave(keyHex, data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(data), 'utf-8')), cipher.final()]);
  const payload = JSON.stringify({
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: enc.toString('hex'),
  });
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(KEYS_FILE, payload, { mode: 0o600 });
  return payload;
}

function mask(v) {
  const s = String(v ?? '');
  if (!s) return '(空)';
  return s.length <= 6 ? '****' : s.slice(0, 3) + '****' + s.slice(-3);
}

/**
 * 健壮的行读取:管道输入/TTY 均可用。
 * 输入的每行进入队列;getLine 消费队首,队列空则等待下一行。
 */
function createLineReader(rl) {
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (l) => {
    const resolve = waiters.shift();
    if (resolve) resolve(l);
    else queue.push(l);
  });
  rl.on('close', () => {
    closed = true;
    for (const resolve of waiters.splice(0)) resolve('');
  });
  const getLine = () => new Promise((resolve) => {
    if (queue.length) return resolve(queue.shift());
    if (closed) return resolve('');
    waiters.push(resolve);
  });
  return getLine;
}

async function run() {
  const overrides = parseArgs(process.argv.slice(2));
  const interactive = Object.keys(overrides).length === 0;

  const keyHex = ensureKeyFile();
  const existing = loadExistingKeys(keyHex);

  let data;
  if (!interactive) {
    data = buildData(existing, overrides);
    console.log('[keygen] 命令行模式:未传参数已保持 keys.enc 原值');
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const getLine = createLineReader(rl);
    console.log('[keygen] 交互模式:直接回车 = 跳过,保持原值');
    const values = {};
    for (const ch of CHANNELS) {
      const cur = existing[ch]?.api_key ?? '';
      process.stdout.write(`  ${ch} api_key [${mask(cur)}]: `);
      const answer = await getLine();
      process.stdout.write('\n');
      const t = answer.trim();
      values[ch] = t ? t : cur;
    }
    rl.close();
    data = buildData({}, values);
  }

  encryptAndSave(keyHex, data);
  const fields = Object.keys(data);

  console.log('');
  console.log(`[keygen] 已加密字段(${fields.length}): ${fields.join(', ') || '(无)'}`);
  console.log(`  密钥文件: ${KEY_FILE}`);
  console.log(`  加密文件: ${KEYS_FILE}`);
  console.log('  说明:重启 server 后 configLoader 会自动解密注入环境变量(显式环境变量优先)。');
  return 0;
}

run().catch((e) => {
  console.error('[keygen] 失败:', e.message);
  process.exit(1);
});
