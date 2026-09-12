# Cosmograph → Castalia 吸收方案

日期：2026-09-11（修订：宇宙图，不是行星大陆）  
来源：https://github.com/cosmograph-org/  （`cosmos.gl` / Cosmograph widget / embedding scatter）

---

## 这次到底吸收的是什么

**cosmograph-org 的宇宙图**：点是星，边是细丝，位置来自 **embedding 投影**（`point_x_by` / `point_y_by`）或 GPU 力导向。看起来像一张从斜上方看过去的宇宙网，**不是一颗有大陆的行星**。

上一版误把 `n1ghtmare-dev/obsidian-cosmograph` 的球面大陆当主轴，已撤回。

---

## 落地（星图顶栏：星系 / 宇宙）

| cosmograph-org | Castalia 宇宙视图 |
|---|---|
| `point_x_by` / `point_y_by` + `enableSimulation: false` | `/api/graph` 全库向量 PCA → `universeX/Y/Z`，点锁在嵌入平面上 |
| `point_color_by` 类别色 | 按 `memType` 着色 |
| `point_size_by` | 度数 + importance，范围贴近官方 `[3, 11]` |
| `showDynamicLabels` + sampling | 高 degree 预算 `clamp(round(√N·2.8), 8, 15)` 常驻标签 |
| `linkDefaultColor: #2d3f5c`、opacity 0.65 | 细丝连线；无焦点时画出整张宇宙网 |
| `selectPointOnClick` 高亮连通 | 悬停/选中灰显其余点，只留邻边 |
| `fitViewOnInit` | 相机从斜上方看 XY 平面（2D 宇宙图的 3D 观察角） |

**不换引擎。** `@cosmos.gl/graph` 3.4.1 是 2D GPU 力模拟，没有 3D 轨道相机；Castalia 星图仍用 3d-force-graph。宇宙视图只搬它的**布局语义和视觉**（嵌入散点 + 细丝网），不搬 DuckDB / Mosaic / 行星地形。

---

## 明确不做

- Obsidian CosmoGraph 的球面大陆、陨石坑、hub 辐条
- 把 3d-force-graph 整表换成 cosmos.gl
- 装饰假边、上万壳尘
