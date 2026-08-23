# Castalia 吸收 LobeHub 记忆设计:存储 + 提取结合方案

> 版本:v1.1(考查稿,修正版——基于 Castalia 现有 type 维度对齐)
> 日期:2026-08-23
> 依据:LobeHub 2.2.14 源码 + Castalia TECHNICAL.md(v1.11/1.14)与源码实测
> 状态:**待用户考查决策,未实施**

---

## 0. 一句话结论

**Castalia 已有「type 性质维度(episodic/semantic/entity/preference)+ categories 层级查询表」,与 LobeHub 五层高度同构。方案 = 对齐映射 + 补 3 个缺口(type 扩展、gatekeeper、评分/CRUD/元数据),而非引入全新体系。工作量比 v1.0 草案更小。**

---

## 1. 现状盘点(修正版,实测)

### 1.1 Castalia 已有(本方案的基础,勿重复造)

| 已有能力 | 位置/实现 | 与 LobeHub 的对应 |
|---|---|---|
| **type 性质维度** | memory 表 `type` 列:episodic/semantic/entity/preference,默认 episodic | = 五层的语义分类雏形 |
| **categories 查询表** | 每库 categories 表,SynaBun 灵感:episodic→(milestone/conversation)、semantic→(identity/knowledge)、preference、entity→(relationship),带 parent/color 层级 | ≈ LobeHub 的 taxonomy(分类/标签词汇表) |
| **mem_type 用途维度** | user/feedback/project/reference/general(Claude Code 四封闭类型) | LobeHub 无对应(它有 memory_category/memory_type) |
| **检索 type/memType 过滤** | search.ts `options.type` / `options.memType` | = LobeHub searchUserMemory 的 layers/types 过滤 |
| **Consolidator 整合** | cos>0.88 向量预筛 → LLM 矛盾消解/归并/剪枝 → 原子应用 | ❌ LobeHub 完全没有(它的最大短板) |
| **渐进式反思 + 晋升 + TTL** | session buffer 双阈值 + promoted 晋升 + 7 天 TTL | ≈ LobeHub 异步提取,但更省 |
| **三层注入模型** | 层1 系统级 / 层2 memory_context 主动召回 / 层3 context_get 被动挂载 | = LobeHub UserMemoryInjector 的对应物(实现方式不同) |
| **指令四层** | global/user/project/rule | ❌ LobeHub 无(它有 skill 体系) |
| **facts + 图 + 联邦** | SPO 三元组 / edges / memory_search_all | ❌ LobeHub 无 |

### 1.2 LobeHub 五层 vs Castalia type 维度(映射表)

| LobeHub 层 | Castalia 现状 | 缺口 |
|---|---|---|
| **activity**(时间事件) | type=episodic ✅ 已覆盖(category: milestone/conversation) | 无 |
| **identity**(身份/关系) | type=entity/semantic + category=identity/relationship ✅ 已覆盖 | **无 CRUD 维护**(只有 upsert,会膨胀/重复) |
| **context**(进行中情境) | 部分:mem_type=project(项目上下文) | **无独立 type**;LobeHub 的"正在进行的研究线/长期目标/紧迫度"没有专门维度 |
| **preference**(偏好) | type=preference ✅ 已覆盖 | **无触发条件/适用场景**(originContext/appContext)、**无优先级权重** |
| **experience**(经验教训) | 部分:category=knowledge + semantic | **无独立 type**;S-R-A-O 结构、置信度未结构化 |

### 1.3 其他缺口(提取侧)

- **无 gatekeeper 预筛**(每次反思直接跑 LLM,没有"值不值得提取"的过滤层)
- **只有 importance 单维评分**,无四维(confidence/impact/priority/urgency)
- **无 title/summary 分离**(单 text 字段)
- **无 metadata JSON**(各层专属字段无处放)
- **无 status 状态机**(activity/context 的 completed/cancelled/on_hold)

---

## 2. 结合设计总览

```
对话消息
   │
   ▼
[现有] conversation_save → auto_process(入站分拣 mem_type)→ session buffer(双阈值)
   │
   ▼
[新增] gatekeeper 预筛(小模型,可选开关,检索 topK 去重上下文)
   │
   ▼
[改造] 分层提取:输出 = type 分类(episodic/semantic/entity/preference/context/experience)
        + identity CRUD(add/update/remove)
        + 四维评分 + metadata(触发条件/S-R-A-O/状态)
   ▼
[现有] 双查重 → 落库(现有表 + 新增列)→ [现有] Consolidator 定期整合
   ▼
[增强] 检索:type 过滤已有;注入优先级(identity+preference 先)
```

**设计原则**:
1. **不新建五层体系**——扩展现有 `type` 枚举(加 context/experience 两值)+ categories 表加对应分类,与现有数据无缝共存
2. **不搞 6 次 LLM 调用**——gatekeeper 1 次(可本地免费)+ 分层提取 1 次
3. 现有 mem_type/categories/反思/指令/联邦全保留,type 扩展是增量
4. 双向量、5 子表、自动注入不照搬(理由同 v1.0)

---

## 3. 存储层设计(Phase 1,增量加列)

### 3.1 type 枚举扩展

```sql
-- 现有:episodic/semantic/entity/preference
-- 新增:context(进行中情境:项目/研究线/长期目标/紧迫度)
--        experience(经验教训:S-R-A-O 结构化)
-- 无 CHECK 约束(type 是自由 TEXT,直接可用,无需迁移)
```

categories 表补两行:
```sql
INSERT INTO categories (name, description, parent, is_parent) VALUES
  ('context',    '进行中情境 — 项目/研究线/长期目标/紧迫度', 'semantic', 0),
  ('experience', '经验教训 — S-R-A-O 可复用知识', 'semantic', 0);
```

### 3.2 新增列(ALTER TABLE,走 `_schema_version` 迁移)

```sql
ALTER TABLE memory ADD COLUMN title TEXT;             -- 提取时 LLM 生成短标题
ALTER TABLE memory ADD COLUMN summary TEXT;           -- 短摘要(可选嵌入,Phase 3)
ALTER TABLE memory ADD COLUMN status TEXT;            -- active|completed|cancelled|on_hold
ALTER TABLE memory ADD COLUMN metadata TEXT;          -- JSON:各层专属字段
ALTER TABLE memory ADD COLUMN score_confidence REAL;  -- 0-1
ALTER TABLE memory ADD COLUMN score_impact REAL;      -- 0-1
ALTER TABLE memory ADD COLUMN score_priority REAL;    -- 0-1
ALTER TABLE memory ADD COLUMN score_urgency REAL;     -- 0-1
CREATE INDEX idx_memory_type ON memory(type);         -- 已有检索过滤,补索引
```

### 3.3 metadata JSON(各层专属字段)

```jsonc
// type=preference
{ "originContext": {"trigger":"...","applicableWhen":"...","notApplicableWhen":"..."},
  "appContext": {"app":null,"surface":"chat"},
  "conclusionDirectives":"..." }
// type=entity(identity)
{ "role":"...", "relationship":"self|mentor|teammate|...", "episodicDate":"2026-08-01" }
// type=context
{ "actors":[...], "resources":[...], "currentStatus":"...", "urgency":0.3 }
// type=experience
{ "situation":"...", "action":"...", "outcome":"..." }   // S-R-A-O
// type=episodic(activity)
{ "startAt":"...", "endAt":"...", "location":"...", "status":"completed" }
```

### 3.4 存量迁移(规则映射,type 已存在的不动)

| 现有(type, category, mem_type) | 迁移目标 |
|---|---|
| type=episodic | 保留(≈activity)✅ |
| type=semantic + category=knowledge | → type=experience(经验教训) |
| type=semantic + category=identity / type=entity | 保留(identity)✅ |
| mem_type=project(进行中项目,type=episodic) | → type=context |
| type=preference | 保留 ✅ |
| 其余 | 保留原值 |

存量 ~12 条,规则映射即可,拿不准保留原值(零风险)。

### 3.5 双向量取舍(同 v1.0)

- text 单向量保留;`summary` 列嵌入为 Phase 3 可选(增量,成本可忽略)

---

## 4. 提取层设计(Phase 2)

### 4.1 gatekeeper 预筛(新增,可开关)

```
输入:session buffer 消息 + 检索 topK(5-8 条)相似已有记忆
模型:gatekeeper.model(默认本地 Ollama 免费 / 可配便宜云模型)
输出:{"episodic":{"shouldExtract":true,...}, "semantic":{...}, "entity":{...},
      "preference":{...}, "context":{...}, "experience":{...}}
执行:shouldExtract=true 的类别才进提取;全 false 本轮跳过
```

- reflect-config.json 三通道 → 四通道(`gatekeeper` 通道,默认 enabled:true)
- 省 token 逻辑:gatekeeper 用小模型(本地免费)过滤,避免主模型空跑

### 4.2 分层结构化提取(改造 reflect_auto 输出契约)

一次 LLM 调用(主模型),输出按 type 分组的 JSON:

```jsonc
{
  "episodic":   [{"title","summary","details","tags":[],"scorePriority":0.5,"metadata":{...}}],
  "entity":     {"add":[{"title","summary","details","role","relationship","episodicDate","scoreConfidence":0.7}],
                 "update":[{"id":"<白名单id>","mergeStrategy":"merge|replace","set":{...}}],
                 "remove":[{"id":"<白名单id>","reason":"..."}]},
  "context":    [{"title","summary","details","scorePriority":0.5,"scoreUrgency":0.3,"metadata":{...}}],
  "preference": [{"title","summary","details","conclusionDirectives","originContext":{...},"appContext":{...},"scorePriority":0.8,"metadata":{...}}],
  "experience": [{"title","summary","details","situation","action","outcome","scoreConfidence":0.7,"metadata":{...}}],
  "semantic":   [{"title","summary","details","tags":[]}]
}
```

**关键差异 vs LobeHub 原版**:
- LobeHub 6 次付费调用/轮;本方案 **1 次付费 + 1 次可选免费** ≈ 省 80%
- type 输出沿用现有六类(4 现有 + 2 新增),与现有存储/检索/反思全兼容
- identity CRUD 只作用于 type=entity(身份),其他类仍走追加

### 4.3 identity CRUD 防幻觉硬约束(v1.0 保留)

1. 提取 prompt 注入「既有身份白名单」(id + title + 摘要,≤30 条,按 score_priority 排序)
2. `update.id`/`remove.id` 只能从白名单选,禁止发明;找不到 → add
3. 服务端校验:白名单外的 id 整条丢弃 + 记日志
4. 拿不准 → add(宁可多一条,不覆盖错)

### 4.4 查重增强(v1.0 保留)

现有双查重(文本归一化 + cosine>0.92)保留;gatekeeper 的 topK 作为提取 prompt 的 retrievedContext,指令"重复/无新意跳过,有更新走 update/merge"。

### 4.5 评分产出

- 提取时 LLM 打四维分(0-1),存新列;未打分保持 NULL,检索排序用 importance 兜底
- Consolidator/reflect_deep 可对存量补分

---

## 5. 检索/注入增强(Phase 3,可选)

1. `memory_context` 注入优先级:**type=preference + entity(identity) 最先**(行为指令+画像)→ context → experience → episodic
2. `memory_list`/admin/viz 按 type 筛选与着色
3. (可选)categories 查询表通过工具暴露给 agent(现有 taxonomy 能力增强)

---

## 6. 实施计划

| 阶段 | 内容 | 工作量 | 验证 |
|---|---|---|---|
| P1 存储 | type 扩展 + categories 补行 + 加 8 列 + 索引 + 存量映射 | 0.5 天 | 备份→迁移→存量 type 正确→检索回归不变 |
| P2 提取 | gatekeeper 通道 + 分层输出 prompt + identity CRUD 校验 + 评分 | 1-2 天 | 行为测试:喂含 6 类信号对话→落位正确;重复→不重复;幻觉 id→被拒 |
| P3 检索 | 注入优先级 + viz 分层 | 0.5 天 | memory_context 输出顺序;UI 显示 |
| 同步 | 通用版→Anima→主系统(锚点补丁法)+ 实例 dist | 0.5 天 | 三边 build 0 error;情感 5 文件 diff 空 |

总计 ≈ 2.5-4 天。

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| LLM 幻觉 id(identity CRUD) | 白名单 + 服务端校验丢弃 + 拿不准走 add |
| 单次六类 JSON 过大 | 每类 ≤5 条;超长先 gatekeeper 过滤;可分两批 |
| type=context 与 mem_type=project 语义重叠 | 文档固化:type=性质(情境是啥),mem_type=用途(给谁用);gatekeeper prompt 写清边界 |
| 现有 12 条存量迁移误伤 | 规则映射 + 拿不准保留原值;备份先行 |
| 三仓库同步破坏情感定制 | 锚点补丁法;情感 5 文件不动 |

---

## 8. 成本核算(每轮提取)

| 项 | LobeHub 原版 | 本方案 |
|---|---|---|
| gatekeeper | 1 次付费 | 1 次(本地 Ollama = 0 元) |
| 层提取 | 5 次付费 | 1 次付费 |
| 嵌入 | 每次重嵌 | 增量 |
| 合计 | ~6 次付费 | **1 次付费 + 1 次免费** |

---

## 9. 待用户拍板的点

1. **type 枚举扩展**:加 context/experience 两个新值(推荐)还是用 categories 子类替代(不改 type)?
2. **gatekeeper 默认开还是关?**
3. **identity CRUD 要不要?(推荐要)**
4. **Phase 3 检索增强做不做?**
