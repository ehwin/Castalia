// 从仓库根 VERSION 生成 src/version.ts —— 版本号只有一个来源，构建前自动刷新。
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`[version] VERSION 内容不合法: ${JSON.stringify(version)}`);
  process.exit(1);
}
const out = path.join(root, 'src', 'version.ts');
const body = `// 由 scripts/gen_version.mjs 从仓库根 VERSION 生成，不要手改。\nexport const VERSION = '${version}';\n`;
fs.writeFileSync(out, body, 'utf8');
console.log(`[version] ${version} → ${path.relative(root, out)}`);
