/**
 * Castalia Web Console — 3D 可视化主界面 + 管理副界面(入口)
 *
 * 独立 Express 服务器。路由已拆分到 routes/*.js:
 *   - routes/graph.js     /api/graph /api/stats /api/status
 *   - routes/memory.js    /api/memory CRUD /move /toggle_important /update
 *   - routes/config.js    /api/config GET/POST
 *   - routes/reflect.js   /api/reflect/run /api/reflect/history
 *   - routes/aggregate.js /api/aggregate/* /api/manage/*
 *
 * 环境变量:
 *   WEB_PORT         默认 3345
 *   MEMORY_DB_DIR    默认 <项目根>/memory/(按项目分库)
 *   MEMORY_DB_PATH   旧单库路径(兼容模式)
 *   NODE_BIN         默认 node(PATH)
 */
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { PORT, DB_DIR } from './routes/lib.js';

import graphRouter from './routes/graph.js';
import memoryRouter from './routes/memory.js';
import configRouter from './routes/config.js';
import reflectRouter from './routes/reflect.js';
import aggregateRouter from './routes/aggregate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));

// API 路由
app.use('/api', graphRouter);
app.use('/api', memoryRouter);
app.use('/api', configRouter);
app.use('/api', reflectRouter);
app.use('/api', aggregateRouter);

// ═══ 静态服务 ═══
// 本地 3D 依赖(three.js / 3d-force-graph)——离线可用;文件名带版本号,升级即换名防缓存
app.use('/vendor', express.static(join(__dirname, 'public', 'vendor'), { maxAge: '1h' }));
// 拆分后的前端模块(普通 script,no-cache 防开发期缓存)
// 页面/API 不缓存
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-cache'); next(); });
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(readFileSync(join(__dirname, 'public', 'index.html'), 'utf-8'));
});
app.get('/aggregate.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(readFileSync(join(__dirname, 'public', 'aggregate.html'), 'utf-8'));
});
app.get('/manage.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(readFileSync(join(__dirname, 'public', 'manage.html'), 'utf-8'));
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║   Castalia Web Console                  ║
  ║   http://127.0.0.1:${PORT}                  ║
  ║   DB_DIR: ${DB_DIR}  ║
  ╚══════════════════════════════════════════╝
  `);
});
