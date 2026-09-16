# Changelog — Castalia(公共版)

> 本文件记录每次功能/架构变更,供 AIRI 主系统(`主系统`)吸收改进时快速对账。
> 格式:Keep a Changelog 简化版(Added / Changed / Fixed / Removed)。

## [v1.16.0] — 2026-09-11 cosmograph-org 宇宙图(星图在 Full)

> Lite 本仓无联邦星图。宇宙视图落在 **Castalia-Full**:顶栏「星系 / 宇宙」,嵌入 PCA 铺点,细丝连线。方案:`docs/吸收方案-Cosmograph.md`。
> 结论:吸收 cosmograph-org 的宇宙图语义,不搬 Obsidian 行星大陆,也不把引擎换成 cosmos.gl。


> **工程固化(2026-09-12)**:src/search.ts 补 decay 分级(与 Full 09-05 修复同源,build 0 error);dist 对齐当前 src;吸收方案文档入库;mock/备份目录入 gitignore。

## [v1.15.0] — 2026-08-24 LobeHub 精细化吸收(身份 CRUD + 四维评分 + 偏好触发条件)

> 调研 LobeHub 2.2.14 memory-user-memory 源码后确认:五层语义已由 type 性质维度(episodic/semantic/entity/preference)+ categories 查询表 + memory_log 覆盖;本次吸收其"精细化"设计(identity CRUD / 评分 / 偏好触发条件),gatekeeper 预筛经用户拍板不做(缓冲+增量反思+双查重已覆盖)。

### Added
- **身份记忆 CRUD**(applyIdentityActions):type=entity 支持 add/update/remove;update 带 mergeStrategy(merge 字段级合并 / replace 整体替换);幻觉 id 白名单校验拒绝(unknown-id / not-entity / inactive)
- **identity_locked 保护列**:锁定身份禁 LLM 自动删改(forgetMemory 与 applyIdentityActions 双重校验)
- **四维评分列**:score_confidence / score_impact / score_priority / score_urgency;memory_search 支持 sort=priority|urgency 排序
- **偏好触发条件**:增量反思新增 preferences 输出段(type=preference + metadata.originContext{trigger/applicableWhen/notApplicableWhen} + score.priority);memory_context 新增「■ 用户偏好」段(触发条件渲染、priority 排序、最先展示)
- **增量反思身份段**:prompt 注入既有身份白名单(≤30,importance 降序),输出 identity{add/update/remove};偏好段仅提取跨会话意图(单次任务约束明确排除)

### Changed
- memory 表新增 8 列(metadata/title/status/四评分/identity_locked)+ idx_memory_type 索引(ALTER 迁移,存量无损)
- StoreParams/MemoryRecord 扩展;saveMemory / updateMemory(含跨分类搬移分支)落新列
- reflect.ts:ReflectAction 新增 identityUpdate 动作(applyReflectActions 分支,rejected 进 errors)

### 验证
- `npm run build` EXIT=0;scripts/verify_v115.mjs 19 项行为断言全过(幻觉 id 拒 / merge 更新 / locked 保护 / 偏好 metadata);smoke_test.py 全 PASS
- gatekeeper 预筛**未做**(用户拍板:不增加不必要的模块)

## [v1.14.0] — 2026-08-17 星图星系化大版本(布局重构 + 视觉升级 + 全项目审计)

> 大版本修复:星图从"力导向乱图"重构为"三层固定星系布局",修复 3D 渲染崩溃(黑屏根因),完成六项目开源分析吸收,并对全项目做安全/一致性审计。技术报告:`docs/tech-report-v1.14.md`。

### Fixed(渲染崩溃根因链)
- **3D 全黑屏**:vendor `fg-1.80-full.mjs` 打了两份 three.js(警告 Multiple instances),`renderBufferDirect` 调 `matrixWorld.determinantAffine()` 但节点矩阵来自另一份 three 实例(无该方法)→ TypeError 渲染挂死。修复:缺失时回退 `determinant()`(数学等价),vendor 改名 `fg-1.80-full-v2.mjs` 防 1h 缓存
- **「记忆库为空」误报**:`/api/status` 的 `dbExists` 仍按旧单库路径 `project-default.sqlite` 判断,memdir 改造后恒 false → 前端错误提示盖住星图。修复:`dbDirHasData()` 扫描 memdir 结构
- **管理面板空数据**:`/api/stats`/`/api/memory` 用 `openDb` 读不存在的旧库 → 恒 0/空。修复:`currentInstanceLibs()` 聚合当前实例全部分类库
- **d3ReheatSimulation 崩溃**:vendor 64511 行 `state.layout` undefined → 移除该调用

### Changed(星图布局:力导向 → 三层固定星系)
- **L0 项目星系**:按 project 分组,球面分布(R=210),项目核心大星(点击看详情),星系桥按方向规则——主节点 {airi,reflect} 双向互联(双 link 双向粒子),reflect 单向读取子节点(箭头指向 reflect,`linkDirectionalArrowLength=6`),子节点间不连
- **L1 分类小星系**:项目内按 memType 细分,小核心围绕项目核心(SUB_SHELL_R=70),spoke/bridge 层级边
- **L2 节点固定球壳**:斐波那契均匀分布在小核心周围(半径 16+√n×4),`fx/fy/fz` 全锁定,力模拟不再移动节点——彻底解决"吸成团"(此前 charge/collide 调参均无效,改锁定才根治)
- 节点斥力增强(charge.strength 按 size `-(45+size×14)`、collide.radius 按 size×0.8)作为拖拽兜底

### Added(六项目分析落地:视觉/交互/聚类)
- **V1 连线语义编码**(ContextOS):关系边按类型着色(causes/caused_by/leads_to/sequence 暖色,same_subject/related_to/follows 冷色)+ 强度估算 `linkStrength`(server 已返回 strength 优先)
- **V3 重要节点发光**:importance≥0.85 光晕放大(1.15×)+ 增强(0.42 透明度);文字标签默认隐藏,选中/悬停才显示(防密集)
- **星空背景**(3d-force-graph `scene()` 方案):Three.js Points 星空,替代 Bloom(vendor 无 UnrealBloomPass,已验证)
- **相机自动环绕**:30s 无操作自动慢转,交互即停
- **I1 悬停邻居高亮**(memory-visualizer):悬停一跳邻居亮、其余 dim,连线只保留两端都在集合内
- **连线粒子流 + 点击脉冲**:`linkDirectionalParticles` 按强度,`onLinkClick → emitParticle`
- **语义簇聚类**(supermemory BFS 连通分量):强关系边(排除 similarity)上做连通分量,同簇节点光晕 + 簇内连线共享簇色(10 色板)——"扎堆"一眼可见;实测 5 簇 26 节点(13/5/4/2/2)
- **后端路由拆分**:server.mjs(1101 行)→ `routes/{lib,graph,memory,config,reflect,aggregate}.js`(69 行入口),`/api/graph` 链接带 `strength` 字段

### Fixed(全项目审计,dsh 任务7)
- **S1 安全**:viz server 原监听 `0.0.0.0`(局域网可读写)→ 绑定 `127.0.0.1`
- **S2** `move` 接口走 memdir(原按旧路径搬移)
- **M1** `updateMemory` 跨 memType 丢 `expires_at`/`locked` → 保留
- **M2** reflect 破坏性动作缺 `locked=1` 护栏 → 补
- **M3** embed 无超时 + 空 embedding 崩溃 → 30s 超时/空值/维度护栏
- **M4** 维护任务(清理/升格/清扫/衰减/critical 恢复)只作用 general → memdir 遍历
- **M5** `listProjectNames` 把 `receipts` 当项目 → 目录判据
- **M6** `textFallbackSearch` 漏 4 个过滤条件 → 补齐
- **M7** `mcpCall` ESM 里 `require('node:fs')` 必抛错(死代码)→ 移除
- **M8** viz 缺 `busy_timeout`(多进程写锁)→ 补
- 审计正面结论:全项目 SQL 参数化(无注入)、项目名经 `safeFilePart` 消毒(无路径穿越)、`/api/config` 已掩码 api_key

### 工程
- 四仓库同步铁律(castalia-run / ai-memory / AIRI/memory / lobehub-run 的 index.html+server.mjs+routes/)md5 一致;`npm run build` EXIT=0;dist 同步三实例
- Node 版本坑固化:必须用 `node`(v24 ABI 137;PATH 的 v22 因 better-sqlite3 ABI 不匹配致 /api/graph 返回 0 节点)

## [v1.13.0] — 2026-08-16 memdir 存储架构(项目 → 四分类文件夹)

> 用户拍板 B 方案:以项目为最外层,内部 user/feedback/project/reference 四个分类文件夹(memdir 风格)。
> 反思按分类填入,总反思(reflect_all)从全部分类库提炼。AIRI 侧同一架构特化为人格维度。

### Changed
- **存储结构**:`memory/<项目>/<memType>/memory.sqlite`(user/feedback/project/reference/general 五文件夹),替代旧 `project-<name>.sqlite`
- `DatabaseManager.getInstance(project, memType)` 双维度路由;`listMemTypeDirs()` 分类扫描;兼容旧结构读取
- **写路由**:`saveMemory`/`promoteToProject`(反思晋升)按 memType 落对应分类库;`updateMemory` 改 memType 时跨库搬移(含向量)
- **读聚合**:`searchMemory`/`getRecentMemories`/`listAllMemories`/`stats_get`/`project_list` 聚合项目全部分类库(指定 memType 时单分类)
- **按 id 操作**:`memory_get`/`forget`/`restore`/`update` 遍历分类库定位
- **联邦**:`resolveFedLibraries` 扫描新结构;viz libFiles/openDbByProject 适配
- **迁移脚本** `scripts/migrate_memdir.py`:旧库按 mem_type 拆入新结构(显式 rowid 保 vec 关联;vec0 虚拟表由引擎重建 + batch_embed 补嵌入)
- 三仓库同步(Anima/主系统锚点补丁保留情感层)+ 三实例 + 桥 + viz 全链路

### Verified
- 存量 121 条全迁移(hermes 12/reflect 11/airi 98 按分类落位)
- viz 联邦 121 节点纯新结构;project_list 聚合 11 条;联邦搜索 50 库;memType=user 写入精确落 hermes/user/
- 补嵌入:hermes 12/12、reflect 9/11、airi 79/98(batchEmbedPending 遍历全部分类库;3 条旧模型名 404 待下次反思重试)

## [v1.12.9] — 2026-08-16 星图联邦化(记忆星图显示全机记忆)

> 用户反馈:星图没有记忆要素。根因:星图原只读当前实例 default 库(0 条),记忆实际分散在 hermes/reflect/airi 库。

- `/api/graph` 联邦化:聚合 AGGREGATE_DIRS 下所有实例所有库的活跃记忆(只读),节点 id `project:rawId` 唯一化(带库前缀),edges/库内相似度链接保留,stats 跨库汇总
- 新增 `openDbByProject(project)`:按库定位可写连接;delete/toggle_important/update 支持 `project` 参数(缺省回退当前实例 default 库)
- 前端 toggleStar/deletePanelNode 传 `rawId + lib` 跨库路由;节点查找改用完整 id
- 实测:121 节点/224 边(hermes 12 + reflect 11 + airi 98),总成视图不受影响

## [v1.12.8] — 2026-08-16 viz 布局修正:搜索框入顶栏,统计宫格挪右上角

> 用户反馈:搜索框与统计宫格悬浮在 3D 图上方遮挡视图。

- 搜索框 `#search-bar` 从悬浮(`top:56px` 居中)移入 `#top-bar` 内(logo/统计之后,flex:1 自适应,pointer-events 放行)
- 统计宫格 `#stats-bar` 从顶部中央移到右上角(`top:52px; right:16px`),不再遮挡 3D 图;图例保持左下角
- 三处同步(主仓库 + castalia-run/lobehub-run viz),index.html 实时读盘无需重启

## [v1.12.7] — 2026-08-16 3D 依赖升级最新版(three r160 + 3d-force-graph 1.80)

> 用户要求"完全用最新版"。esbuild 将 three r160(ESM) + fg 1.80 全打进单文件,页面改 ES Modules 加载。

### Changed
- `vendor/fg-1.80-full.mjs`(2.8MB 自包含,零外部 import):three r160 + 3d-force-graph 1.80 + 全部 jsm 依赖(OrbitControls/TrackballControls/FlyControls/DragControls/EffectComposer/RenderPass)打包为单文件,导出 `default`(ForceGraph3D) + `THREE` namespace
- 页面加载: `<script type="module">` import 单文件 → 设 `window.THREE/ForceGraph3D` → 派发 `viz-libs-ready` → 主逻辑初始化包进 `__init()` 等事件后执行(普通 script 的全局函数/onclick 不受影响)
- 诊断保留 + 4s 超时兜底(浏览器不支持 ESM 时页面给出明确提示)

### Fixed(升级路上踩掉的坑)
- fg 1.80 的 UMD(min.js)在全局 THREE 注入场景下顶层崩(`Ak.Timer is not a constructor`)→ 弃 UMD 走 esbuild ESM bundle
- `three/webgpu` 子路径在 three r160 npm 包**不存在**(jsdelivr 返回 404 文本)→ esbuild `--alias` 到 stub(useWebGPU 默认 false,安全)
- three-forcegraph 包带 `window.THREE ? window.THREE : bundled` 兼容包装,浏览器里正常 fallback 内置 three

### Verified
- node ESM 导入实测: `ForceGraph3D=function` | `THREE=object (REVISION=160)` | `WebGLRenderer/Group=function` | 零外部 import
- 三处(主仓库 + castalia-run/lobehub-run viz)同步 SHA 一致;index.html 实时读盘,服务端无需重启

## [v1.12.6] — 2026-08-16 3D 依赖本地化(离线可用,修复 3D 视图无法渲染)

> 浏览器实测报 `ForceGraph3D is not defined`(v1.12.3 MNEMO 改造后页面仍从 jsdelivr CDN 加载 3D 库,网络受限时加载失败)。

### Fixed
- 3D 依赖改为本地 vendor:`web/public/vendor/three-r149.min.js` + `3d-force-graph-1.78.min.js`,离线可用、不依赖外网
- **坑1:three r160 的 `build/three.min.js` 是弃用 stub(仅 console.warn,无 THREE 库)→ 必须用 r149(最后一个完整 UMD 构建)**,r160 下 `typeof THREE === undefined`
- **坑2:3d-force-graph 1.80 顶层 `new THREE.Timer`(r150+ 才有)→ r149 下加载即崩,ForceGraph3D 不定义;批量沙箱实测 r149 兼容 1.78/1.76/1.72/1.70,选 1.78.0**——生态版本错位:新库走 ESM 时代,老全局 `<script>` 用法需旧库
- server.mjs 加 `/vendor` 静态路由;vendor 文件名带版本号(升级即换名防缓存,maxAge 1h);页面/API `Cache-Control: no-cache`
- 页面内置 `[viz-diag]` 诊断(three/ForceGraph3D 加载状态显示),排查定位用
- 三处(主仓库 + castalia-run/lobehub-run viz)已同步;托盘管理 3345(杀进程自动拉起),改 server.mjs 后需重启生效

## [v1.12.5] — 2026-08-16 全项目优化(嵌入补全/联邦去重/配置加固) + 反思面板

> 用户要求整体优化。反思面板经 dsh(pro 模型)开发,优化项 Hermes 实施(避开并发区)。

### Added(反思面板,3345/3346 库管理页)
- `POST /api/reflect/run`:mode=all(总反思)/project(项目级)+dryRun 预演+maxTotal/maxPerLib;调 reflect_all(mcpCall 超时放宽 300s);结果附历史
- `GET /api/reflect/history`:反思历史倒序(时间/模式/洞察全文/来源/dryRun 标记),存 `<DB_DIR>/reflect_history.jsonl` 上限 200 条——**防误提交可回看**
- manage.html「🧠 反思」面板:模式选择+dryRun 默认勾选(取消红字警告)+文本框输出洞察全文+历史列表展开
- **mcpCall 子进程补 CASTALIA_KEYS_FILE/KEY_FILE**(此前缺失致 keys.enc 不解密→反思/嵌入无 key)+**stderr 落盘** `mcp_call_stderr.log`(排障)

### Fixed / Improved
- **reflect_batch_embed 加 characterId 参数**('any' 不过滤角色):reflect 库(character_id NULL)与跨角色记忆可补嵌入;Anima/主系统保留 charFor(project)
- **resolveFedLibraries 按目录去重**(ownDir 与 FEDERATION_DIRS 同目录不重复扫描)
- **reflect_all 支持 REFLECT_DIR env**:统一多实例总库位置(托盘 3345/3346 配 D:/AI/lobehub-run/memory → 所有反思写同一总库,不再分叉);db.ts export initProjectSchema
- **FEDERATION_DIRS 统一正斜杠**(托盘 viz+桥、unified-proxy):反斜杠 JSON env 传递减半致 JSON.parse 失败静默回退(与误移事故同根因)
- **anima-run keys.enc 补 embedding.api_key**:AIRI 嵌入通道此前缺 key 走 Ollama 分支 → 硅基 404

### Data
- 补嵌入(reflect 9/hermes 3/airi 4,conversation_log 按设计不嵌入);AIRI 嵌入通道修复
- 反思面板真实提交 1 次(hermes 12 条→3 洞察,2 新写入统一总库);总库现 11 条洞察

### Verified
- 三仓库 build exit 0 + dist 同步;服务全重启;3345 API dryRun/真实提交/历史实测全过;REFLECT_DIR 生效(lobehub 总库 9→11,castalia/anima 无分叉);anima 空壳 reflect 库清理

## [v1.12.4] — 2026-08-16 库管理设置页 + reflect_all projects 参数 + 首次人工分拣

> 用户需求:手动调整库归属(清理 AIRI 混杂的 Hermes 记忆、分离尤诺身份叙事、分别做项目级/总反思)。管理页经 dsh(pro 模型)开发 + Hermes 独立复验。

### Added(库管理)
- `web/public/manage.html`:库总览卡片(库名/实例/活跃/总数)→ 库内记忆列表(搜索/类型徽章/时间)→ 勾选/批量移动 → 改 mem_type → 软删,全部 confirm 确认,事件委托防 XSS
- 后端:`GET /api/manage/libraries`(计数)、`GET /api/manage/memories`(库内列表+搜索)、`POST /api/memory/move`(跨库移动:全字段+向量行原样复制不重嵌入、created_at 保留、目标库 schema 自动创建、幂等跳过、逐条事务)、`POST /api/manage/memory/update`(改 mem_type)
- `index.html` 顶部加「🗂 库管理」入口;server.mjs 加 /manage.html 静态路由

### Added(反思)
- `reflect_all` 新增 `projects` 参数:只反思指定 project 库(如 ['hermes']),三仓库(通用/Anima/主系统)同步 + 三实例 dist 同步

### Changed(2026-08-16 实际整理)
- 12 条 Hermes 开发测试记忆(8-08/8-15 测试/架构讨论类,含 session_promoted)从 airi 库移入 hermes 库(facts 外键问题:facts 随迁 + 源副本软删)
- 4 条尤诺身份叙事(identity)从 project 类改 general,**保留在 airi 库**(尤诺身份/感情/人设不迁移)
- 项目级反思(hermes 12 条→3 条洞察)+ 总反思(7 库 110 条→6 条洞察)写入 reflect 库(现 9 条)
- 最终:hermes 12 条 / airi 98 条 / reflect 9 条 / 其余库 0

### Verified(独立复验)
- 副本库移动实测(21 PASS:向量复制/幂等/改类/软删;期间一次 AGGREGATE_DIRS env 失效事故→误移 2 条已完整恢复,教训:测试须先验证库列表只含测试库)
- node --check exit 0;6 文件 SHA256 三处 MATCH;reflect_all projects 经桥实测(锁定 1 库)

## [v1.12.3] — 2026-08-16 3D 可视化全面改造(MNEMO 外貌:星座节点+Auto-Tour+全屏+详情卡+统计宫格)

> 用户指定:以 mnemo-memory-os 为设计外貌、supermemory 为架构思维。实现经 dsh(pro 模型)编写 + Hermes 独立复验。

### Added(前端 web/public/index.html)
- **节点渲染升级**:THREE.Group 自定义节点(核心球+半透明光晕+3D 空间文字 Sprite 标签),按 mem_type 五色着色(user 青/feedback 琥珀/project 紫/reference 蓝/general 灰,type 回退);星标红球;选中光晕 0.7;几何/纹理缓存(球体按半径、标签按 text|color,cap 800)防内存泄漏;THREE CDN 失败回退默认球体不崩
- **Auto-Tour 自动导览**:60s 随机飞近 + 金色高亮 + 顶部指示条显示当前记忆;手动点击节点即停;仅星图生效(总成视图禁用)
- **沉浸全屏**:document.body Fullscreen API(工具栏保持可用),全屏背景转黑
- **详情卡片升级**:右侧滑出(mnemo 风:类型色左边框 星标 2px/普通 1px、blur 背景);类型徽章/全文/时间/来源·项目/重要度条/标签;「⭐ 星标」与「🗑 删除」按钮
- **统计宫格**:星图 6 宫格(TOTAL+五类 mem_type)/总成 2 宫格(SOFTWARE/LIBRARY),可折叠
- 搜索过滤改为直接改材质(dimmed 变灰)不重建;图例切换为 mem_type 五色

### Added(后端 web/server.mjs)
- `/api/graph` 节点新增 `project/memType/starred(importance≥0.9)` 字段;stats 新增 `byMemType`
- `POST /api/memory/toggle_important`:importance 1.0↔0.5 切换星标(带 id 校验/不存在处理)
- 依赖:`three@0.160.0`(最后带 UMD 版)+ `3d-force-graph@1.80.0` 锁定 CDN

### Verified(独立复验)
- git status 仅 2 目标文件;node --check(137) exit 0;三处 SHA256 全 MATCH(主仓库/castalia-run/lobehub-run)
- 实测(3347+anima-run 库):/api/graph 110 nodes/118 links,byMemType={general:51,project:16,user:43},节点字段齐全;aggregate 7/7;页面 200
- 真实库零改动(仅下午自检软删记忆,WAL 痕迹非本次);toggle_important 在副本库测过三态
- 8 个新元素 id 齐全;THREE 守卫;代码审查通过(缓存/材质直改/不每帧重建)

## [v1.12.2] — 2026-08-16 3D 总成视图(二分图:软件团 ↔ 库团)

> 用户拍板"全权交给 dsh + pro 模型"独立开发(完全权限 danger-full-access),Hermes 独立复验后上线。

### Added
- `GET /api/aggregate/graph`(只读):二分图数据——software 节点=AGGREGATE_DIRS 各实例(value=该实例记忆总数),library 节点=跨实例去重 project(value=跨实例总数),links=实例拥有库(value=该实例该库记忆数);复用 libFiles()+openLibDb() 只读计数,单库异常降级 0,库文件即开即关
- `index.html`「🗂 总成视图」切换按钮:software 左团(fx=-250,青绿 #00A89A)/library 右团(fx=+250,紫 #7c6ff7),节点大小 4+√value×2、连线粗细按 value、label 显示 `group · value 条`;图例/统计随视图切换;空库提示不崩;搜索框总成视图下失效保护;切回「记忆星图」完整恢复(清 fx/fy/fz 重算分类锚点,复用同一 graphInstance)

### Verified(独立复验)
- git status 仅 3 目标文件;node --check(137) exit 0;SHA256 主仓库 vs castalia-run/lobehub-run 四文件全 MATCH
- 临时 3347 实测:8 节点 8 边,AIRI/default=110,原 /api/graph 与静态页不受影响
- 3345(castalia-run viz)已重启加载新代码(7 节点);lobehub-run viz 文件已同步(未启动服务)

## [v1.12.1] — 2026-08-16 末端反思模块 reflect_all(跨库反思 → reflect 总库)

> 用户拍板"末端互通":日常各库隔离,反思时全量聚合。实现经 dsh(DeepSeek Harness)编写 + Hermes 独立复验。

### Added
- **`reflect_all`(admin)**:跨库记忆反思整合——扫描全机所有记忆库(本实例 + FEDERATION_DIRS 外部实例,只读),LLM 跨库去重合并/提炼洞察(五类 memType + 硬性禁止 + 严格 JSON),写入专用总库 `project=reflect`(非破坏:源库只读;查重跳过已存在文本;tags 附来源 `instance:project` 标记)
- **`src/reflectAll.ts`**:scanLibrary 逐库只读 + 预算上限(maxTotal 默认 300 / maxPerLib 100)+ 单库失败隔离;系统提示仿 REFLECT_SYSTEM_PROMPT;JSON 容错解析(围栏/尾逗号);dryRun 只分析不写入;REFLECT LLM 通道未配置时明确报错不崩
- 托盘 BRIDGES 双桥(3310/3312)env 加 `FEDERATION_DIRS`(Hermes/AIRI 实例目录)→ 桥侧 reflect_all / memory_search_all 可见全机 7 库

### Verified(独立复验,非自报)
- 三仓库 build exit 0 + smoke 32 工具全 PASSED(主仓库);Anima/主系统锚点补丁(保 charFor/mood_journal),脚本 `scripts/sync_reflect_all.py`
- dist 全量同步 3 运行实例(anima-run 用 Anima 构建)+ 双桥重启
- 桥端到端:tools/list 32;reflect_all dryRun 扫 7 库 → LLM 出 3 条洞察、sources 标注 AIRI/default、0 错误;测试数据未写入(dryRun)

## [v1.12.0] — 2026-08-16 多库管理 + 跨库互通接口 + 记忆总成

> 用户需求:管理不同库、库间记忆互通、全机记忆总成。互通语义用户尚未定稿 → **接口先行**(显式语义,引擎不做隐式合并),总成界面做完整版。

### Added
- **`memory_search.projects` 参数(agent)**:一次搜多个库,结果每行带 `project` 来源标注;`["*"]`/`["all"]` = 本实例全部库;缺省保持单库(完全向后兼容)
- **`project_create`(admin)**:建新库(项目命名空间),`safeFilePart` 消毒,立即可用于读写
- **`memory_search_all`(admin)**:联邦搜索接口(只读),搜本实例全部库 + `FEDERATION_DIRS` env 声明的外部实例目录(`[{"name","dir"}]`);结果带 `instance`/`project` 标注;`mode` 参数预留 vector(当前 text 实现,vector 回退 text)
- **`shared` 共享层约定**(env.ts `SHARED_PROJECT`):保留库名 `shared` 为"全库共知"候选;引擎不自动合并,互通规则由上层决定
- **viz 记忆总成页 `/aggregate.html`**:全机库总览卡片(实例/库/记忆/事实/最近活动)+ 聚合搜索(按库分组)+ 最近动态流 + 建库表单;index.html 顶部入口;`AGGREGATE_DIRS` env 可覆盖(默认 Hermes/LobeHub/AIRI/当前实例,按目录去重)
- **viz API**:`/api/aggregate/overview` `/api/aggregate/search` `/api/aggregate/recent` `/api/aggregate/projects`(建库经 MCP 调 project_create,保证 schema 正确)

### Changed
- `src/search.ts` 新增 `searchMemoryAcross()`:跨库循环搜索 + 合并排序去重,单库失败不影响其他库
- `src/federation.ts`(新):只读联邦库解析 + LIKE 文本检索(LIKE 子串 + 命中比例评分,中文整句可搜)
- `src/db.ts` 导出 `currentMemDir()`;`src/env.ts` 加 `SHARED_PROJECT`
- `web/server.mjs`:`NODE_BIN` 默认优先本机 137 node(否则 mcpCall 子进程 ABI 崩溃挂起)
- `scripts/smoke_test.py`:`NODE` 优先 137 绝对路径(PATH 第一个是 Hermes 127 时 better-sqlite3 ABI 崩溃,脚本曾因此拿到空输出)

### Verified(独立复验,非自报)
- 三仓库(通用/Anima/主系统)同源补丁 + 各自 `npm run build` exit 0(Anima 保留 charFor/情感列,补丁脚本 `scripts/sync_libs_feature.py`)
- 运行实例 dist 全量同步(castalia-run/lobehub-run/anima-run);双桥(3310/3312)重启后新 dist 生效
- 桥端到端:tools/list = 31 工具;`memory_search(projects=['default','shared'])` 参数接受;`project_create('shared')` ok;`memory_search_all` libraries=3
- 隔离性实测:存 shared → 单库搜 default=0 条;跨库搜=1 条且标注 `project=shared`;联邦搜=1 条且标注 `local/shared`;测试数据已清理
- viz 总成页 API:overview 6 库(Hermes×2 + LobeHub×3 + AIRI×1,目录去重生效);聚合搜「记忆」命中 AIRI 5 条;recent 正常;建库 shared(Hermes 侧)成功

## [v1.11.5] — 2026-08-05 web 管理界面青绿主题改版

> 用户指定配色系统(logo 青绿系):Primary #00A89A / Deep Teal #008880 / Mid Teal #45B9AC / Light Mint #7AE8D8 / Highlight #A0F8E8 / Dark BG #15161B / Surface #1F2229-2A2E38。

### Changed
- CSS 变量区换青绿主题:--bg #15161B、--panel/card #1F2229/#2A2E38、--accent #00A89A + deep/mid/light/hi 五档;--green 调为青绿 #57E6C4
- 全部紫色(约 30 处 rgba(124,111,247)/#7c6ff7)替换为青绿对应;旧面板色 #0f1117/#1a1d27/#0a0c12/#2a2d3a 全部收敛到新变量
- 按钮体系:btn-primary 深青 #008880;成功态薄荷系
- CATEGORY_COLORS:conversation 紫→青绿 #26C6DA;decision/mistake/preference 保留暖色对比(语义可区分)

### Verified(独立验证,非自报)
- 页面 200 完整渲染;新主题 8 色全就位;紫色/旧色 0 残留;JS 逻辑未动

## [v1.11.4] — 2026-08-05 debug:web 控制台两个 bug(空库 500 + 旧列引用)

> 用户检查管理界面(3345)时触发,实测复现。

### Fixed
- **空库 500**:`memory/` 目录无项目库文件时,`new Database(path, {readonly:true})` 对不存在文件抛错 → /api/graph /api/stats /api/memory 全部 500。修复:openDb 检查 `existsSync(DB_PATH)`,不存在返回 null,各端点优雅返回空结构;前端显示「📭 记忆库为空或未创建」提示而非裸报错
- **`no such column: emotional_impact`**:server.mjs 查询了 AIRI 旧版情感列(公共版 v1.4 已删),v1.7 分库后库真实建起才暴露。已从 SELECT 和节点对象移除,前端"情绪影响"元数据行删除
- **`/api/stats` edges 表容错**:edges 表可能未创建,查询加保护

### Verified(独立复验,非自报)
- 空库:/api/graph 200 {nodes:[]}、/api/stats 200 {total:0};有库(1 条测试记忆):graph 返回节点、stats {total:1};主页 200
- 测试数据已清理;node --check 通过

## [v1.11.3] — 2026-08-05 debug:修复空文本记忆落库 + 边界测试

### Fixed
- **空文本记忆被接受**:`memory_save({text:""})` 之前返回 ok 并落库空记录(污染注入/搜索/统计)。schema 加 `z.string().min(1)` + saveMemory 入口防御校验(trim 空也拒);非法 memType 由 zod 拒绝(行为一致)
- conversation_save/auto_process **不改**:对话原文拼装后不会是字面空文本,且 conversation_log 源已排除出向量/注入,保留原文日志用途

### Verified(独立复验,非自报)
- 边界 e2e:空文本/纯空白拒绝、非法 memType 拒绝、正常记忆成功、库内无空记录(5/5);路径逃逸 project 名安全化(../evil → project-.._evil.sqlite)、特殊字符/10万字符/并发 10 写、空白 project → 默认、空项目 memory_context 不崩
- npm run build exit 0;smoke_test 全 PASS(29 工具)

## [v1.11.2] — 2026-08-05 README 全面重写(v1.11 架构对齐)

- 工具数 23→29、存储从 MEMORY_DB_PATH 单库 → MEMORY_DB_DIR 分库、三通道(triage/embedding/reflect)、记忆分层(项目级/会话级/4 封闭类型)、渐进式临时反思、整合子进程、Snapshot Warning 全部入文档
- 清理旧版残留实例重建的根目录 memory.sqlite(旧代码与新架构冲突,已在 Troubleshooting 注明)

## [v1.11.1] — 2026-08-05 三通道架构 Part2:渐进式临时反思(缓冲+晋升+TTL)

> 吸收 Claude Code session/progressiveMemory + reflectDriver + cleaner 原厂逻辑,接在 Part1 的 triage 通道上。

### Added
- **`SessionMemoryBuffer`**(src/buffer.ts):N 轮攒批(默认 5,`BUFFER_SIZE` env 可配)——每轮对话 `onNewMessage()` → count++,达阈值后台异步触发(绝不 await 阻塞,错误静默捕获);进程内单例 per (project, sessionId)
- **`runIncrementalReflection`**(src/triage.ts):`INCREMENTAL_REFLECT_PROMPT`(中文,会话记忆维护子代理)+ 快照+增量(最近 10 条)喂 triage 通道 LLM → 输出 {sessionMemory, promoted};promoted 白名单校验(4 封闭类型)+ Markdown 包装;失败/无 key 静默跳过
- **晋升链**(src/store.ts):`upsertSessionMemory`(滚动覆盖同 session_id)、`promoteToProject`(晋升落项目级 session_id=NULL,仅项目级去重)、`deleteSessionFragments`(晋升即删,顺序:promote→delete→upsert 防误删)
- **TTL 孤儿清理**(src/db.ts):`sweepExpiredSessionMemories`(默认 7 天,`SESSION_MEMORY_TTL_DAYS`),启动时对默认项目+所有项目库静默清扫(兜底,正常流程晋升即删)
- **接线**:auto_process 加 `sessionId` 参数(不传保持旧行为向后兼容)、memory_context 加 `sessionId` 注入「会话滚动状态」分节、configLoader 支持 `triage.bufferSize/sessionTtlDays`

### Verified(独立复验,非自报)
- 12 项独立 e2e 全过:3 轮攒批触发(BUFFER_SIZE=3)、LLM 调用、晋升落库(user 项目级+Markdown)、滚动覆盖带 session_id、memory_context 注入会话状态、TTL 清 8 天前孤儿
- npm run build exit 0;smoke_test 全 PASS(29 工具,不传 sessionId 行为不变)

## [v1.11] — 2026-08-05 三通道架构 Part1:LLM1(triage)通道 + session_id 激活

> 用户确认三通道:① LLM1(triage)=入站分拣+临时反思 ② 向量模型=嵌入(已有) ③ LLM2(reflect)=每日反思(已有)。Part1 做基础设施,Part2(缓冲/晋升/TTL)待做。

### Added
- **src/triage.ts**(新):`triageChannel()`(TRIAGE_LLM_* 配置,逐字段回退 REFLECT_* 再回退内置默认)、`isTriageConfigured()`、`classifyMemTypeLLM(text, project?)` — 极简中文分类 prompt(Claude 原厂封闭类型语义),输出 JSON `{"memType":...}`,白名单校验(JSON/裸词双解析),失败/无 key → `{memType:general, skipped:true}`(不阻塞入站)
- **makeLlmChannel(prefix) + callLlm 参数化**(reflectDriver.ts):通道构造器(前缀通道缺省回退 REFLECT_*),callLlm 加可选 channel 参数,现有 reflect 行为不变
- **session_id 激活**(store.ts/index.ts):SaveParams.sessionId、memory_save 加 sessionId 参数、INSERT 带 session_id 列(v6.0 预留列正式启用)
- **configLoader + web**:triage.llm_url/api_key/model → TRIAGE_* env;admin 界面新增「分拣 LLM (triage)」配置组

### Verified(独立复验,非自报)
- 11 项独立 e2e 全过:triage 通道分类(feedback)、请求走 triage-model、无 key → general+skipped、sessionId 落库/不传 NULL、无 TRIAGE 回退 REFLECT 通道
- npm run build exit 0;smoke_test 全 PASS(29 工具)

### Note
- Part2(待做):会话缓冲(N 轮攒批默认5)+ 增量临时反思(LLM1)+ 晋升项目级 + TTL 7天清理

## [v1.10.1] — 2026-08-05 Memory Snapshot Warning(记忆快照警告)

> 补齐吸收 Claude Code 四主文件的最后缺口(retriever.ts formatRetrievedMemoryForPrompt)。

### Added
- **`memorySnapshotWarn(createdAt)`**(index.ts):记忆年龄 ≥ 1 天(24h)注入时追加 `> ⚠️ [Memory Snapshot Warning] 该记忆记录于 X 天前,属于历史快照,引用前请以最新对话/代码为准`;自然语言(今天/N 天前,对齐原厂 today/N days ago);< 1 天或字段缺失返回 null
- **recent/related 两个分节**追加快照警告(每条旧记忆后独立换行,2 空格缩进)
- 防止 LLM 把旧记忆当"当前事实"硬依赖(如端口已改但记忆还是旧值)

### Verified(独立复验,非自报)
- 6 项独立 e2e 全过:2 天前旧记忆命中 → 带警告 + "2 天前";今天新记忆 → 无警告;引用块格式正确
- npm run build exit 0;smoke_test 全 PASS(29 工具)

## [v1.10] — 2026-08-05 记忆整合子进程(Memory Consolidator)

> 直接吸收 Claude Code 原厂 Consolidator 方案(用户确认,不自定义):重量级"去重+矛盾消解+主题归并",由独立 LLM 实例执行。

### Added
- **`findSimilarCandidates(project, threshold=0.88, limit)`**(consolidate.ts):向量预筛相似对——KNN 取候选 + 二段过滤同项目(规避 vec0 禁 JOIN),cosine 相似度 > 阈值,去重对 + 上限防爆炸;EMBED_MODE=none 返回空(LLM 全量扫兜底)
- **`MEMORY_CONSOLIDATION_PROMPT`**(reflectDriver.ts):忠实还原原厂规则——矛盾消解(ALWAYS 偏最新用户决定,被取代规则 REMOVE)/ 去重归并(保持 4 种封闭类型)/ 剪枝压缩(删临时调试与误存代码,相对日期转绝对日期)/ **NEVER invent new facts** 铁律;输出 merge/delete/keep JSON 动作
- **`consolidate_deep` 工具**(admin 组,28→29):向量预筛 → LLM 整合 → applyReflectActions 原子执行;无候选不调 LLM(省 token);无 API key 报错
- **启动自动整合**:`shouldAutoConsolidate()`(active 记忆 > `CONSOLIDATE_MIN_MEMORIES` 默认 15)+ 启动异步检查(开关 `CONSOLIDATE_AUTO_ON_START` 默认 1)
- config.json 支持 `consolidate.minMemories/similarity`(admin 留路)

### Verified(独立复验,非自报)
- 8 项独立 e2e 全过:29 工具注册、mock LLM 调用、prompt 含原厂规则、3 条相似 → 2 条(merge 原子落库)、合并文本 Markdown 格式、无 key 报错
- npm run build exit 0;smoke_test 全 PASS(29 工具)

## [v1.9] — 2026-08-05 启动时自动反思(条件达成后下次启动执行)

> 用户确认:不做计划任务/常驻 watcher,改为"双条件达成后,下次启动 MCP server 时自动执行一次反思"。

### Added
- **`shouldAutoReflect(charId, project?)`**(reflectDriver.ts):双条件检查
  - 距上次反思 ≥ `REFLECT_MIN_GAP_HOURS`(默认 24h;从未反思视为超时,满足)
  - 未分析对话数 > `REFLECT_MIN_UNANALYZED`(默认 5)
  - 返回 {should, reason};未配 API key 直接跳过
- **启动自动反思**(index.ts main):server 启动后 setTimeout 异步检查,条件达成 → `runAutoReflect`,打印条件/结果日志;失败 catch 不崩、不阻塞启动
- **config.json 支持** `reflect.minGapHours` / `reflect.minUnanalyzed`(configLoader 映射 env)
- 现有 `REFLECT_INTERVAL_HOURS` 周期定时器保留(默认 0 = 关)

### Verified(独立复验,非自报)
- 4 场景 e2e 全过:6 条未分析+从未反思 → 触发并调用 LLM;1h 前反思 → 跳过;2 条 → 跳过;无 key → 跳过
- npm run build exit 0;smoke_test 全 PASS(28 工具)

## [v1.8] — 2026-08-05 融合 Claude Code 封闭记忆类型 + Markdown 内容格式

> 只改通用版公共代码,不迁移不改造 AIRI 情感数据。SQLite 物理存储 + content 字段 Markdown 格式化(不生成实体 .md 文件)。

### Added
- **`mem_type` 字段**(用途维度,与现有 `type` 性质维度正交):`user`(用户画像)/ `feedback`(行为纠正,正负双向)/ `project`(项目上下文,相对时间转绝对日期)/ `reference`(外部指针)/ `general`(默认)
- **Markdown 内容规范化**(src/memType.ts):4 种封闭类型写入时 text 自动包装为 `# <Label>: <标题>` + `- ` 列表结构(已含 `#` 标题则不重复包装;general 不强制转换)
- **`memory_index` 工具**(agent 组,27→28):轻量索引 `SELECT id, mem_type, substr(text,1,150)` — 只返回摘要行,命中后 `memory_get(id)` 拉详情(对齐 Claude Code MEMORY.md "先索引后详情"召回,省 token)
- **`memory_context` 记忆索引分节**:注入层只带 150 字摘要 + 提示 memory_get 展开(指令分节未动)
- **提取子代理 prompt 融合**(reflectDriver):4 种封闭类型分类规则、feedback 正负都记、硬性禁止代码片段/文件路径/git hash、project 相对时间转绝对日期、extract 动作支持 `newMemType`
- `memory_save/update/search/list/recent` 加 `memType` 参数;`stats_get` 加 byMemType;`memory_get` 返回 memType

### Verified(独立复验,非自报)
- 16 项独立 e2e 全过:Markdown 规范化(# 标题 + 列表)、mem_type 落库、general 不强制转换、索引 150 字摘要与过滤、search 按 memType 隔离、stats byMemType、memory_context 索引分节
- npm run build exit 0;smoke_test 全 PASS(28 工具)

## [v1.7.1] — 2026-08-05 记忆存储统一收敛到 memory/ 目录

### Changed
- **config.json 默认路径**:`<cwd>/config.json` → `<cwd>/memory/config.json`(configLoader + web/server.mjs 同步;`MEMORY_CONFIG` env 仍优先)
- **反思回执目录**:`<cwd>/reflect-receipts/` → `<cwd>/memory/receipts/`(`REFLECT_RECEIPT_DIR` env 仍优先)
- **清理项目根残留**:旧版 `memory.sqlite / -shm / -wal`、根目录 `reflect-receipts/` 已删除

### Verified
- 独立复验:启动后 global.sqlite/project-default.sqlite 均在 memory/ 内;config/receipts 路径常量已收敛;项目根无记忆残留文件
- npm run build exit 0;smoke_test 全 PASS

### Note
- 杀掉了两个运行旧代码的 MCP server 实例(旧代码会把 memory.sqlite 写回项目根);**需用新代码重启 MCP server 才能生效**

## [v1.7] — 2026-08-05 按项目分库存储(Project-per-DB)

> 架构级改造:单库(project 列)→ 每项目一个 .sqlite 文件,物理隔离。用户确认"现有记忆可丢弃,直接一劳永逸"。

### Changed
- **DatabaseManager 单例 → 按项目路由**:`getInstance(project)` 空→`project-default.sqlite`,项目名经 `safeFilePart` 安全化(`../` 逃逸防护);全局库 `global.sqlite`(仅 instructions + projects 注册表);项目库含全部现有表(记忆/向量/facts/指令 L3)
- **39 处调用点改造**:store/search/reflect/digest/category/consolidate/ollama/index 全部传 project 路由;`embed()` 增加可选 project 参数(embedding_cache 按项目)
- **指令跨库路由**:L1/L2(global/user)和 rule 规则组 → global.sqlite;L3(scope=project) → 对应项目库;`listInstructions`/`deleteInstruction` 聚合全局+各项目
- **web/server.mjs + configLoader**:`MEMORY_DB_PATH` → `MEMORY_DB_DIR`(兼容 config.json `db_dir` 字段)
- **启动流程**:创建 memory/ 目录 + global.sqlite + L1 种子;项目库懒加载(首访才建)

### Added
- **memory 表 `session_id` 列**(默认 NULL = 项目级):预留给独立小模型做会话级/项目级区分,**本次无任何判断逻辑**(晋升机制留空,用户确认由专门小模型处理)
- `memory_get`/`memory_update`/`memory_delete` 新增可选 `project` 参数(否则只路由默认库,agent 读不到其他项目)
- 旧 `MEMORY_DB_PATH` 显式设置时走单库兼容模式(弃用警告);smoke_test 兼容验证

### Note(设计取舍,供复核)
- 维护性周期任务(consolidate/cleanup/digest)只作用于默认库;Web 控制台数据接口只读默认库——多项目遍历聚合未做(最小化)
- project_list 遍历 memory/ 下 project-*.sqlite 汇总(无库文件的项目不算)
- README 中 MEMORY_DB_PATH 引用待后续同步

### Verified(独立复验,非自报)
- 17 项独立 e2e 全过:global.sqlite 种子、alpha 库生成与懒加载、物理隔离(alpha 库只有 alpha 记忆,默认库搜不到)、指令跨库路由(L3 在 alpha 库不在 global)、project_list 汇总、memory_context 三层拼接
- npm run build exit 0;smoke_test 全 PASS(27 工具 + 旧单库兼容 + 项目隔离)

## [v1.6.1] — 2026-08-05 上下文路由:include 递归 + picomatch Glob 过滤

> 对齐 Claude Code 上下文路由设计。JIT 工具加载**有意不做**(tools/list 每连接只发现一次、stdio 无重注册通道、动态隐藏工具会破坏 harness 白名单)——路径控制改在数据层实现。

### Added
- **`scope='rule'` 规则组**:可复用指令块(project=组名),仅被 include 引用时加载,不独立注入
- **`@include` 递归展开**:任意指令 content 支持 `include: "rule:typescript-core"` / `include: ["rule:a","rule:b"]`;递归展开,深度上限 5(超限截断+⚠️),seenSet 环路检测(A→B→A 截断不挂死)
- **Glob 条件过滤(picomatch)**:指令可带 `paths`(JSON 数组),`memory_context` 新增 `path` 参数——只注入 paths 为空或匹配的指令;`!` 前缀取反(last-match-wins);Windows 反斜杠归一化;matcher 编译缓存
- 规则组自身 paths 过滤:被 include 的规则组也受调用方 path 过滤(为空则跟随引用方)

### Changed
- `instructions` 表加 `paths` 列 + CHECK 扩 4 值(事务重建迁移,幂等,旧数据保留)
- `instruction_save` 支持 scope=rule + paths 参数;`memory_context` 加 path 参数,命中指令打标 `[全局 src/components/**/*.tsx]`
- README 新增 Instruction Routing 章节(三种机制 + JIT 未做的原因)

### Verified(独立复验,非自报)
- include 展开/环路截断/深度上限/glob 命中与取反/规则组路径过滤,13 项全过
- 迁移实测:旧表数据保留 + 新列/新索引生成,重启幂等
- npm run build exit 0;smoke_test 全 PASS(工具数仍 27)

## [v1.6] — 2026-08-05 三层指令记忆(Instruction Memory)

> 类比 Claude Code 的 CLAUDE.md 层级机制,DB 版实现。用户确认设计:查找从近到远 L3→L2→L1,拼接喂 LLM 从远到近 L1→L2→L3,L3 落 Prompt 末尾约束最高(近因效应 + 规则覆盖)。

### Added
- **`instructions` 表**:scope(`global`/`user`/`project`) + project + content;partial unique index(global/user 每层一条,project 按项目一条)
- **L1 全局种子**:首次启动自动写入用户提供的全局规范(代码风格/工具约束/提交规范),表非空则跳过
- **`instruction_save`**(harness):三层 upsert,同 scope+project 覆盖更新
- **`instruction_list` / `instruction_delete`**(admin):查看/删除各层指令
- **`memory_context` 扩展**:指令分节拼在 Prompt 最前(`【指令(全局→项目,项目约束最高)】`),每层 `[全局]/[用户]/[项目]` 标头,bundle 新增 `instructions` 字段,asText=false 也带

### Verified(独立复验,非自报)
- L1 种子首启自动写入(内容=全局规范全文);L2/L3 可存;memory_context 顺序 global→user→project 且分节在记忆上下文之前;同层覆盖不新增;L3 可删
- npm run build exit 0;smoke_test 全 PASS(工具数 24→27);临时文件已清理

## [v1.5.4] — 2026-08-05 facts 写入链路打通(独立反思 agent 提取)

> 对齐 Claude Code 记忆模式:独立小模型 agent(反思)提取 facts,引擎确定性去重落库。选择项全部收进 admin 界面,不硬编码。

### Fixed(三层断链根因)
- **prompt 未要求 facts**:REFLECT_SYSTEM_PROMPT 原要求"只返回 JSON 数组"(纯 actions)→ 改为要求输出完整对象 `{summary, highlights, facts, insights, actions}`,facts 规则(SPO 定义/置信度/上限)拼入 prompt
- **parseJsonRobust 只认数组**:`[...]` 数组、`{...}` 对象、markdown 围栏 + 前后废话全部支持;数组自动包成 `{actions:[...]}` 兼容老格式
- **编排只传 actions**:runAutoReflect/runDeepReflect 现把完整结果传给 applyReflectResult,facts 真正落库;返回新增 `factsInserted`/`factsUpdated` 统计

### Added(admin 界面可选,不硬编码)
- `reflect.factExtraction`: `auto`(默认,反思时提取 facts) | `off`(只做 actions 整理,不写 facts 表)——off 时 prompt 不含 facts 字段,落库为 0
- `reflect.maxFacts`: 每轮最多提取条数(默认 15)
- configLoader 映射 `REFLECT_FACT_EXTRACTION` / `REFLECT_MAX_FACTS`;web/server.mjs 默认值合并 + GET/POST 透传;web/public 配置表单加"事实提取"下拉 + "单轮上限"输入
- 独立小模型选择:`reflect.model`(已有,如 deepseek-chat)即反思 agent 的模型,与主对话解耦

### Verified(独立复验,非自报)
- mock LLM e2e:auto → facts 表实际写入 3 条;off → 0 条;mock 收到独立模型名
- npm run build exit 0;smoke_test 全 PASS;临时文件已清理

## [v1.5.3] — 2026-08-05 嵌入管线三档可选(EMBED_MODE)

### Added
- **`EMBED_MODE` 环境变量**三档可选:
  - `none` → **纯本地**:标签/正则 + 文本回退检索,零外部服务(不调 Ollama/API,记忆照常存取)
  - `ollama` → 本地嵌入服务(默认,`OLLAMA_URL`,零 API 成本)
  - `api` → OpenAI 兼容 API(`EMBEDDING_API_KEY`)
- `isEmbedEnabled()`(env.ts):全链路统一开关;`embed()` 在 none 模式直接抛错兜底
- 语义降级:`EMBED_MODE=none` 时搜索跳过向量 KNN 走文本回退、saveMemory 跳过向量去重、batchEmbedPending 返回 disabled、saveFacts 跳过向量回写——**全部实测通过**(嵌入服务指向死端口也不报错)

### Changed
- search.ts Phase 2 / searchFacts / store.ts 向量路径全部加 `isEmbedEnabled()` 守卫

## [v1.5.2] — 2026-08-05 memory_save 支持自定义过期时间

### Added
- `memory_save` 新增可选 `expiresAt` 参数(ISO datetime):temporary 记忆可覆盖默认 3 天 TTL;standard/critical 显式传入时也生效(语义更灵活)
- 底层 `saveMemory` 原本已支持 `expiresAt`(SQL 列 + 清理逻辑都在),仅工具 schema 未暴露 — 已实测:自定义过期时间正确落库

## [v1.5.1] — 2026-08-05 项目隔离边界修复(opencode 全项目测试发现)

### Fixed
- **fact_search 事实跨项目泄漏**(真 bug):二段查询漏 `f.project = ?`,`proj` 变量算了但从未用于查询 → 项目 A 搜索能返回项目 B 的事实,与隔离承诺相悖(openCode 边界测试发现,已实测无重叠)
- **batchEmbedPending 隐藏 bug**:`m.source != 'conversation_log'` 对 `source=NULL` 恒为假,`memory_save`(source 默认 null)的记忆**永远无法被批量嵌入**;改为 `COALESCE(m.source,'') != 'conversation_log'`
- **saveFacts 向量回写跨项目**:同 SPO 事实跨项目会被重复 embed,补 `project = ?`
- **reflect 流水线跨项目批量嵌入**:`applyReflectActions` 末尾 `batchEmbedPending` 未透传 project

### Changed
- **`normalizeProject()`**(env.ts):项目名 trim + 空/空白回退默认项目,应用于全部写/读入口,消除 `''`/`' '`/`' alpha '` 脏命名空间
- **`reflect_batch_embed` 工具**新增可选 `project` 参数;`batchEmbedPending(characterId, project?)` 支持项目过滤
- `batchEmbedPending` 不传 project 时只处理默认项目(隔离语义一致;跨项目 pending 记忆不自动嵌入,不会串项目,仅漏嵌)

### Note(设计内,不改)
- `memory_get`/`delete`/`update` 凭全局唯一 UUID 操作,无 project 参数是刻意的(ID 即能力令牌,风险仅当 ID 泄露)
- digest 过期清理 / promoteByAccess / restore-critical 全局执行:`expires_at` 是时间语义,与项目正交

## [v1.5] — 2026-08-05 项目隔离(Project Namespace)

> 对齐 Hermes Project 概念:记忆按项目分区,不同项目调用各自的记忆空间,互不串扰。默认 `default` 项目完全向后兼容(老数据/老调用不受影响)。

### Added
- **`project` 维度**:`memory` / `facts` 表新增 `project` 列(默认 `'default'`),索引 `idx_memory_project` / `idx_facts_project`;facts 唯一去重索引改为 `(subject, predicate, object, project)` — 同一事实允许在不同项目各自存在
- **`project_list` 工具**(admin):列出所有项目 + 各项目记忆数/事实数 + 当前项目(`CASTALIA_PROJECT` env)
- **环境变量 `CASTALIA_PROJECT`**:全局默认项目,工具不传 `project` 参数时使用(默认 `'default'`)
- **所有 23 个现有工具新增可选 `project` 参数**(search/save/list/recent/get/stats/context/graph/reflect/auto_process/conversation_save/daily_summary 等),传参即切换到该项目的记忆空间

### Changed
- **去重按项目隔离**:精确去重与向量近重复判定都限定同项目 — 同一文本在不同项目各自落库(不误判重复)
- **向量检索按项目过滤**:vec0 KNN 保持全库候选(候选集放大 topK×8/60 保证单项目召回),在 memory/facts 查询层用 `project=?` 过滤 — 项目 A 的语义查询永远看不到项目 B 的记忆
- **全链路透传**:store / search / reflect(applyReflectActions / applyReflectResult / getUnanalyzedConversations / listAllMemories / getMemoryGraph)/ digest / autoProcessor / reflectDriver 均支持 project 参数

### Fixed
- vec0 虚拟表 KNN 查询不能 JOIN(silent 失败被 catch 吞掉 → 向量搜索返回空);改为 KNN 后按 project 过滤

## [2026-08-05] 全库改名 + Hermes 接入支持

### Changed
- **内部名称统一为 Castalia**:package.json / MCP_SERVER_NAME 默认值 / web console / 示例配置 / 文档全部 `ai-memory → castalia`(GitHub 仓库名同步,`github.com/ehwin/Castalia`)
- **测试脚本路径动态化**:smoke_test / vec_test 不再写死 `D:\AI\...` 本机路径,改为基于脚本位置推导(公共版可在任意 clone 位置运行);node 探测优先 PATH,本机路径仅作 fallback
- **mcp-config.example.json** 改为通用占位符路径,不再泄露作者机器路径

### Added
- **Hermes Agent 安装支持**:`python scripts/setup.py hermes` 输出 `hermes config set mcp_servers '...'` 命令;README 新增 Hermes 安装章节(含 Windows node 不在 PATH 的绝对路径坑、重启生效说明、MCP_TOOLS 建议)

### Fixed
- `memory_save` INSERT 语句 VALUES 19 个占位符 vs 18 列,所有写入报 `19 values for 18 columns` → 已修正为 18 个(影响全部写入路径,冒烟测试因此从 save 开始全挂)

## [2026-08-04] 协议统一 + 上 GitHub

### Changed
- **License: Apache-2.0 → MIT**(统一协议;JPlag 已验证无代码级复制,上游致谢保留在 README Credits)
- 仓库改名 **Castalia**,推至 `github.com/ehwin/Castalia`(Private),默认分支 main
- AIRI 版仓库名规划:**Castalia Anima**(情感线,自用版暂不上传,改完吸收进主项目后转通用情感支线)

## [v1.4] — 2026-08-04 彻底去情感(Castalia = harness 定位)

### Removed
- `mood_journal` 工具(无情绪写入方的死工具)
- `emotional_impact` / `agent_mood` / `agent_desire` 列 + v6.0 VAD 迁移块(建表与迁移)
- 评分公式的情绪维度:`WEIGHT_EMOTION` 删除,权重归一 **一致性 0.65 + 时间衰减 0.35**
- `memory_save` / `memory_get` 的 emotionalImpact 参数与返回字段
- 预设分类 `emotional` / `mood_snapshot`;`VALID_CATEGORIES` 白名单同步清理

> 情感能力完整保留在 AIRI 版(未来情感特化,仓库名规划 Castalia Anima);Castalia 定位纯 harness 记忆后端,零情感残留(全 src 0 处)。

## [v1.3] — 2026-08-04 热度升格 + reflect 回执

### Added
- **热度升格**(借鉴 UPSP memory_heat):`promoteByAccess()` — accessed_count ≥ `HEAT_PROMOTE_THRESHOLD`(默认 5)的 temporary 记忆自动升 standard(免清理)。清理前先升格(cleanupExpiredMemories 内)。`memory_get` 访问 +1 热度
- **reflect 逐动作回执**:`applyReflectActions` 返回 `receipts[]` — 每条动作 {action, status: applied/failed/skipped, targetId, reason, rowsAffected}。UPDATE 影响 0 行 = failed("target not found"),不再静默算成功
- **回执落盘**:`reflect-receipts/reflect-receipt-<ts>.json`(目录可用 `REFLECT_RECEIPT_DIR` 配置)— 含动作原文 + 每条回执,失败动作可事后人工修正

### Fixed
- reflect 幻觉 id 动作此前误计 applied(静默成功),现在 failed + errors 明确原因

## [Unreleased] — 2026-08-04 工具分级与暴露面矫正

### Added
- **工具分级机制**(借鉴 engram ProfileAgent/ProfileAdmin):环境变量 `MCP_TOOLS` 控制注册集(逗号分隔 profile 或工具名)。
  - `agent`(默认,5 个只读):memory_search / fact_search / memory_get / memory_recent / memory_graph
  - `harness`(10 个):写入 + 对话管线 + 反思
  - `admin`(9 个):管理 + context + 手动反思
  - `all`(24 个):全部注册,向后兼容
- `memory_get(id)` 按 id 展开全文(上一版已加,本版归入 agent 组)
- `memory_log(kind: decision|pattern|mistake)` 单一认知记录工具(替代三个 log_*)
- `reflect_auto` 新增 `mode: daily|deep` 参数(deep=原 reflect_deep,合并入口)

### Changed
- **默认暴露面**:主 Agent 只见 5 个只读工具(之前 25 个全暴露)——MCP 回归"记忆后端"职责,上下文组装交给 harness
- `memory_context` / `context_get` 降级为 admin 组(不再给主 Agent)——避免"第二个 harness"架构风险
- `memory_list` 硬上限 50 条(之前默认 200,易灌爆上下文)
- `memory_graph` 默认只返回邻域(节点上限 50,边仅保留两端都在的),不再 dump 全图
- `reflect_deep` 标注 [Legacy],建议改用 `reflect_auto(mode="deep")`
- 统一信封 `{ok, op, count, results:[{id, text(截断200), truncated, kind, score, createdAt}]}` + 失败 `{ok:false, error:{code, message}}`(v1.1 起)

### Fixed
- `stats_get` 未按 CHAR_ID 分区——多实例共用 DB 时统计全库串数据(已加 `AND character_id=?`)

### Removed
- `memory_log_decision` / `memory_log_pattern` / `memory_log_mistake` 三个工具 → 合并为 `memory_log`

## [v1.1] — 2026-08-03 返回格式对齐主流规范

### Added
- 统一信封:读类工具 `{ok, op, query?, count, results, hint}`;失败 `{ok:false, error:{code, message}}`
- 每条 result 带 `id` + `text` 截断 200 字 + `truncated` 标志
- `memory_get(id)` 全文展开(短证据 + 可回查 id 模式)
- `kind` 字段映射(episodic→episode / semantic→reflection)

### Changed
- `ok()`/`err()` 辅助函数:信封化,err 支持错误码(默认 ERROR)
- memory_search / fact_search / memory_recent / memory_list 返回结构统一

## [v1.0] — 2026-08-03 接入体验与上下文包

### Added
- `scripts/setup.py` 一键接入(借鉴 engram setup):claude/opencode/cursor/vscode/codex/json
- `memory_context` 注入包工具(近期+相关+认知+事实+GroundTruth,借鉴 engram mem_context / memory-os fabric_brief)
- `docs/TECHNICAL_REPORT.md` 技术报告(架构/运行机制/评分/配置全量)
- Web Console `web/`(3345):3D 星图主界面 + 管理抽屉副界面,内嵌 MCP client,config.json 持久化
- `configLoader.ts`:启动时读 config.json 覆盖环境变量(嵌入/反思配置双通道)
- ollama.ts 双模式嵌入:Ollama `/api/embed` / 云端 API key `/embeddings`

### Changed
- 25 工具(基础 19 + reflect_auto/reflect_deep + 认知记录×3 + memory_context)

## [v0.9] — 2026-08-03 独立分支建立

### Added
- 从 AIRI 分支剥离:删除 emotion/agentState/bias/userLearning 四模块
- 中性化:CHAR_ID 默认 'default'、SERVER_NAME 'castalia'、subject 枚举 ['user','agent','environment']
- `reflectDriver.ts` 反思驱动打包进 server(日常+深度,LLM 环境变量配置,无 key 优雅跳过)
- 19 工具 + reflect_auto/reflect_deep

### Changed
- 评分中性化:一致性 60% + 时间衰减 30% + 情绪标记 10%(权重全可环境变量调)
- `digest.ts`/`autoProcessor.ts` 去 VAD 简化

### Removed
- `user_observe` 工具(人格化,公共版删)
