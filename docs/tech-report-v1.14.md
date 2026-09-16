# Castalia v1.14 技术报告 — 星图星系化大版本

> 日期:2026-08-17
> 范围:星图渲染崩溃修复 → 布局重构(力导向→固定星系)→ 六项目开源分析吸收 → 全项目安全/一致性审计
> 涉及:前端 index.html(1547 行)、后端 server.mjs + routes/*.js、src/*.ts(审计修复)、三实例 + 四仓库

---

## 一、问题背景:星图为什么"什么都没有"

用户反复反馈星图空白。排查链路(按证据而非猜测):

1. 后端 `/api/graph` 数据完整(121 节点/178 边)→ **排除数据问题**
2. 静态资源 200(index.html/vendor)→ **排除加载问题**
3. headless Edge 打开页面 → 控制台抓到关键错误:
   ```
   Uncaught TypeError: object.matrixWorld.determinantAffine is not a function
   WARNING: Multiple instances of Three.js being imported
   ```
   → 定位到 **3D 渲染器崩溃**

## 二、根因分析(三层)

### 2.1 渲染崩溃:vendor 双 three 实例(黑屏直接原因)
`fg-1.80-full.mjs`(esbuild 打包 three r160 + 3d-force-graph 1.80)内部混入了**两份 three.js**。渲染管线 `renderBufferDirect` 调用 `object.matrixWorld.determinantAffine()`,但节点矩阵对象来自**另一份 three 实例**的 `Matrix4` 类——r160 中该方法已不存在于该类 → TypeError → 整个 WebGL 渲染循环挂死,canvas 全黑。

**修复**:调用点改为特性检测回退:
```js
object.matrixWorld.determinantAffine
  ? object.matrixWorld.determinantAffine()
  : object.matrixWorld.determinant()   // 仿射矩阵行列式,数学等价
```
vendor 改名 `fg-1.80-full-v2.mjs` 强制浏览器绕过 `max-age=3600` 缓存。

### 2.2 假报错:status 的 dbExists 按旧路径判断
memdir 改造后库在 `memory/<项目>/<memType>/memory.sqlite`,但 `/api/status` 仍检查旧单库 `project-default.sqlite` → 恒 `dbExists:false` → 前端把「📭 记忆库为空」错误提示(z-index 5 居中)盖在已渲染的星图上。

**修复**:`dbDirHasData()` 扫描 memdir 结构;`/api/stats`、`/api/memory` 同样改用 `currentInstanceLibs()` 聚合当前实例全部分类库。

### 2.3 布局缺陷:力导向"吸成团"
- 尝试 1:调 charge/collide 参数(charge -60→按 size,collide 5→按 size×0.8)——仍有局部堆积
- 尝试 2:减弱向心力(subgalaxy-attract 0.13→0.06)——治标不治本
- **最终方案:放弃力模拟,节点 `fx/fy/fz` 全锁定**。位置由代码直接计算(斐波那契球面分布),力引擎对锁定节点完全无效 → 结构静态、永不重叠

## 三、新架构:三层固定星系

```
L0 项目星系         project → 球面分布(R=210),核心大星 buildGalaxyCore
  └─ L1 分类小星系  memType → 小核心围绕项目核心(SUB_SHELL_R=70)buildSubGalaxyCore
      └─ L2 节点    斐波那契球面分布(半径 16+√n×4)fx/fy/fz 锁定
```

**星系桥方向规则**(用户拍板):
- 主节点 {airi, reflect}:双向互联(两条反向 link → 双向粒子光流,金色)
- reflect 单向读取子节点(hermes 等):单方向粒子 + 箭头(`linkDirectionalArrowLength=6`)指向 reflect
- 子节点间不连

**关键机制**(3d-force-graph 源码级确认):渲染循环与物理引擎解耦——节点锁死后,粒子流/箭头/相机/Bloom 照常动。"固定布局 + 有生命感"兼得。

## 四、六项目开源分析吸收清单

分析对象:mnemo-memory-os / memory-graph-interface(aaronsb)/ supermemory / memory-visualizer / 3d-force-graph / ContextOS(源码抓取 + 逐行对比,非 README 级)

| 吸收项 | 来源 | 实现 |
|--------|------|------|
| 连线语义编码(暖/冷色 + strength) | ContextOS + aaronsb | `LINK_TYPE_COLORS` + `linkStrength()` |
| 重要节点发光 | mnemo | importance≥0.85 光晕 1.15×/0.42 |
| 星空背景 | 3d-force-graph `scene()` | Three.js Points(Bloom 因 vendor 无 UnrealBloomPass 跳过) |
| 相机自动环绕 | 3d-force-graph 官方 example | 30s 无操作慢转 |
| 悬停邻居高亮 | memory-visualizer | BFS 一跳邻居亮,其余 dim |
| 连线粒子流 + 点击脉冲 | aaronsb / 3d-force-graph | `linkDirectionalParticles` + `emitParticle` |
| **语义簇聚类** | supermemory BFS 连通分量 | 强关系边聚类,同簇共享簇色(10 色板) |
| 后端路由拆分 + 边 strength | aaronsb 独立边表 | server.mjs → routes/*.js,`/api/graph` 带 strength |
| 标签 sprite(字体/阴影/截断) | mnemo(对比后确认与我们同源) | 已有,无需改 |

**明确放弃**:strength 驱动节点间距(aaronsb 式)——固定球壳布局下会破坏层级结构导致混乱;force 管理三件套(拖拽禁力/降力/恢复)——我们已禁力。

## 五、全项目审计(dsh 任务7)

### 安全(严重)
- S1:viz server 原监听 `0.0.0.0`(局域网可读写)→ 绑定 `127.0.0.1`
- S2:`move` 接口走 memdir

### 功能(中等,M1-M8)
见 CHANGELOG v1.14.0 Fixed 段。核心:updateMemory 保留 expires_at/locked、reflect locked 护栏、embed 30s 超时 + 空值护栏、维护任务 memdir 遍历、receipts 假项目排除、textFallback 补过滤、require 死代码、busy_timeout。

### 审计正面结论
- ✅ SQL 全部参数化(无注入面)
- ✅ 项目名经 `safeFilePart` 消毒(无路径穿越)
- ✅ `/api/config` 已掩码 api_key(响应体不泄漏)

## 六、工程铁律(本轮固化)

1. **四仓库同步**:castalia-run / ai-memory / AIRI/memory / lobehub-run 的 index.html + server.mjs + routes/*.js 必须 md5 一致
2. **Node 版本**:必须 `node`(v24 ABI 137);PATH 的 v22 因 better-sqlite3 ABI 不匹配致 `/api/graph` 返回 0 节点
3. **vendor 缓存**:改 vendor 必须换文件名(`-v2` 后缀);纯前端改动不受 1h 缓存影响
4. **禁止调用** `d3ReheatSimulation()`(vendor 64511 行 state.layout undefined 崩溃)
5. **验证方法**:headless Edge 截图 + Python 像素分析(颜色分布验证渲染非空 + 聚类生效)

## 七、验证证据汇总

| 验证项 | 方法 | 结果 |
|--------|------|------|
| 渲染恢复 | headless 像素分析 | 黑屏 0 像素 → teal 403/purple 117/gray 582 各色正常 |
| 后端拆分生效 | curl /api/graph | 178 条链接全部带 strength |
| 语义簇生效 | 前端 BFS 复现 | 5 簇 26 节点(13/5/4/2/2),簇色像素可见(散布 44px=紧密) |
| 四仓库一致 | md5sum | index.html/server.mjs/routes 全部单一哈希 |
| 构建 | tsc | ai-memory + memory-fused EXIT=0 |
| 无 JS 错误 | headless console | 无 error/uncaught/ReferenceError |

## 八、遗留与后续

- AIRI 侧 12 个 src 同源文件对齐 + 架构吸收审计 → 任务10(dsh 执行中)
- 语义簇聚类目前按"强关系边"定义;若节点持续增长,可考虑 supermemory 式 LOD(低缩放只渲染亮星)
- Bloom 泛光待 vendor 升级后补(需 UnrealBloomPass)
