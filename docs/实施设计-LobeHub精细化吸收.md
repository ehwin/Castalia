# Castalia 吸收 LobeHub 精细化设计 — 实施文档(怎么做)

> 版本:v2.0(实施级)
> 日期:2026-08-23
> 依据:LobeHub 2.2.14 源码 + Castalia TECHNICAL.md + src 源码逐文件核对
> 状态:**待考查决策**;所有改动点已定位到文件/函数/SQL 级

---

## 0. 认知修正(先对齐,再动手)

逐项核实后:**LobeHub 五层在 Castalia 全部已有对应,不缺"层",缺的是"精细化"**:

| LobeHub 五层 | Castalia 已有 | 缺什么 |
|---|---|---|
| activity(事件) | type=episodic(category: milestone/conversation) | — |
| identity(身份) | type=entity/semantic + category=identity/relationship | **CRUD 维护**(防膨胀/重复) |
| context(情境) | mem_type=project(项目上下文) | — |
| preference(偏好) | type=preference | **触发条件/适用场景**(originContext/appContext) |
| experience(经验) | memory_log(decision/pattern/mistake,🎯/⚠️/📐)+ category=knowledge | — |

因此实施范围收窄为 **4 项精细化**,按价值排序:
- **A. identity CRUD**(最有价值,防身份记忆无限膨胀)
- **B. 四维评分**(importance → confidence/impact/priority/urgency)
- **C. preference 触发条件**(metadata:什么时候适用/不适用)
- **D. gatekeeper 预筛**(成本数学见 §5,有零成本替代方案)

---

## 1. 改动文件总览

| 文件 | 改动 |
|---|---|
| `src/db.ts` | migrations 数组加 8 条 ALTER(评分 4 列 + metadata + title + summary + status) |
| `src/store.ts` | StoreParams 扩展(4 评分 + metadata + title/summary/status);saveMemory/updateMemory 落新列;updateMemory 支持白名单校验 |
| `src/memType.ts` | (不改——type 枚举是自由 TEXT,entity 已存在) |
| `src/triage.ts` | 增量反思 prompt 输出契约加 extractLayers(可选 D2);identity 提取段(白名单注入 + add/update/remove 输出) |
| `src/reflect.ts` | ReflectAction 加 `identityUpdate` 动作(mergeStrategy: merge/replace);applyReflectActions 处理 identity 分支 |
| `src/index.ts` | 新工具 `memory_identity`(add/update/remove 专用入口,白名单校验);memory_search 支持评分排序 |
| `src/search.ts` | 排序支持 score_priority 加权;type=entity 白名单查询函数 |

---

## 2. 实施 A:identity CRUD(核心)

### 2.1 设计

身份记忆(type=entity)不再"只增不改",提取/反思时输出 **add / update / remove** 三类动作:
- `add`:全新身份事实
- `update`:对既有条目精化(合并策略 merge=字段级合并 / replace=整体替换)
- `remove`:删除过期/错误身份(软删 is_active=0)

### 2.2 数据库(db.ts migrations 数组追加)

```ts
const migrations = [
  // ...现有
  `ALTER TABLE memory ADD COLUMN metadata TEXT`,
  `ALTER TABLE memory ADD COLUMN title TEXT`,
  `ALTER TABLE memory ADD COLUMN status TEXT`,
  `ALTER TABLE memory ADD COLUMN score_confidence REAL`,
  `ALTER TABLE memory ADD COLUMN score_impact REAL`,
  `ALTER TABLE memory ADD COLUMN score_priority REAL`,
  `ALTER TABLE memory ADD COLUMN score_urgency REAL`,
  // identity CRUD 的锁定标记:true=禁止 LLM 自动删改(重要身份)
  `ALTER TABLE memory ADD COLUMN identity_locked INTEGER DEFAULT 0`,
];
```

### 2.3 StoreParams 扩展(store.ts)

```ts
export interface StoreParams {
  // ...现有字段
  metadata?: string;            // JSON:各层专属字段
  title?: string;
  status?: 'active'|'completed'|'cancelled'|'on_hold';
  scoreConfidence?: number;     // 0-1
  scoreImpact?: number;
  scorePriority?: number;
  scoreUrgency?: number;
  identityLocked?: boolean;     // identity CRUD 保护
}
```

saveMemory 的 INSERT 语句同步补列(参照现有 tier/expires_at 的写法,约 10 行)。

### 2.4 提取侧(triage.ts 增量反思 prompt 增加身份段)

在现有 INCREMENTAL_REFLECT_PROMPT 的 promoted 输出之外,新增身份维护段。prompt 草稿(插入现有 prompt 末尾):

```
【身份维护(第 5 节)】— 仅当对话涉及用户身份/关系/属性时才需要。
先看下面的【既有身份列表】,再决定动作:
- add:全新身份事实(之前列表没有的)
- update:既有条目变精化/变化(如角色变了)→ 必须用列表里的真实 id,
  mergeStrategy=merge(字段级合并,保留没变的字段)或 replace(整体替换)
- remove:条目已错误/过时/重复 → 必须用列表里的真实 id + reason
禁止发明 id;列表里找不到对应 → 用 add。
输出格式(空则给空数组):
{"identity":{"add":[{"text":"...","tags":[]}],
 "update":[{"id":"<真实id>","mergeStrategy":"merge","set":{"text":"...","tags":[]}}],
 "remove":[{"id":"<真实id>","reason":"..."}]}}
【既有身份列表】(最多 30 条,按 importance 降序):
{{identityList}}
```

`identityList` 由 triage 侧查询注入:`SELECT id, substr(text,1,120) FROM memory WHERE type='entity' AND is_active=1 AND project=? ORDER BY importance DESC LIMIT 30`。

### 2.5 应用侧(store.ts 新函数 + reflect.ts 动作)

```ts
// store.ts
export async function applyIdentityActions(
  actions: { add?: {text:string;tags?:string[]}[],
             update?: {id:string;mergeStrategy:'merge'|'replace';set:Partial<StoreParams>}[],
             remove?: {id:string;reason?:string}[] },
  project?: string,
): Promise<{ applied: number; rejected: string[] }> {
  // 1) 收集库内真实 entity id 白名单(SELECT id FROM memory WHERE type='entity' AND is_active=1)
  // 2) add → saveMemory({type:'entity', ...})
  // 3) update → id 不在白名单 → rejected(防幻觉);merge:读原记录,set 字段覆盖,其余保留;replace:直接覆盖
  // 4) remove → id 不在白名单 → rejected;identity_locked=1 → rejected;否则 forgetMemory 软删
  // 返回 {applied, rejected[]},rejected 记日志
}
```

```ts
// reflect.ts ReflectAction 扩展
action: 'identityUpdate';
identityActions?: { add?: [...]; update?: [...]; remove?: [...] };
// applyReflectActions 里 switch 加 case 'identityUpdate' → applyIdentityActions
```

### 2.6 MCP 工具(index.ts)

新增 `memory_identity`(harness 组):
```ts
'memory_identity': {
  description: '维护身份记忆(type=entity):add 新身份 / update 精化(merge|replace)/ remove 删除。id 必须来自 memory_search(type=entity)返回的真实 id,幻觉 id 会被拒绝。',
  inputSchema: { add: ..., update: ..., remove: ... },  // zod 同 applyIdentityActions
  handler: async (args, ctx) => applyIdentityActions(args, ctx.project)
}
```

---

## 3. 实施 B:四维评分

### 3.1 设计

importance(单维,已有)保留;**新增 confidence(置信)/impact(影响)/priority(优先级)/urgency(紧急)** 四维,默认 NULL,检索排序用 `score_priority DESC NULLS LAST, importance DESC`。

### 3.2 检索排序(search.ts)

```ts
// searchMemory 的 ORDER BY 支持模式:
// 默认:importance DESC(现状)
// sort=priority: score_priority DESC NULLS LAST, importance DESC
// sort=urgency:  score_urgency DESC NULLS LAST, importance DESC
const orderBy = {
  default: 'm.importance DESC',
  priority: 'COALESCE(m.score_priority,0) DESC, m.importance DESC',
  urgency:  'COALESCE(m.score_urgency,0) DESC, m.importance DESC',
}[options.sort ?? 'default'];
```

### 3.3 提取时打分(并入 A 的 prompt)

增量反思/promoted 输出每条记忆可带 `"score":{"confidence":0.8,"impact":0.6,"priority":0.7,"urgency":0.2}`,落库映射到 4 列;不给则 NULL。

---

## 4. 实施 C:preference 触发条件(metadata)

### 4.1 设计

type=preference 的记忆,metadata 存 **何时适用/何时不适用**,让偏好可执行:

```json
{ "originContext": {"trigger": "当用户说'简洁'时", "applicableWhen": "聊天场景",
   "notApplicableWhen": "技术评审场景"},
  "appContext": {"surface": "chat"},
  "conclusionDirectives": "回复要简洁,先结论后细节" }
```

### 4.2 prompt(并入 A 的提取 prompt,偏好段)

```
【偏好提取】— type=preference。若对话含持久偏好(always/never/from now on 等跨会话意图):
{"preferences":[{"text":"...","originContext":{"trigger":"...","applicableWhen":"...","notApplicableWhen":"..."},
  "conclusionDirectives":"...","score":{"priority":0.8}}]}
单次任务要求/一次性指令不是偏好,不要提取。
```

### 4.3 落库

saveMemory({type:'preference', metadata: JSON.stringify({...}), scorePriority})——metadata 列已在 A 加好。

### 4.4 注入时读取(memory_context)

`■ 偏好` 段组装时,metadata.originContext 渲染为「适用:`applicableWhen`;不适用:`notApplicableWhen`」,让 agent 知道何时该遵守。

---

## 5. 实施 D:gatekeeper 预筛(含成本数学,待拍板)

### 5.1 三种实现

| 方案 | 做法 | 每轮 LLM 调用 | 备注 |
|---|---|---|---|
| D1 独立调用 | 缓冲触发时先调 gatekeeper(小模型)判 6 层 shouldExtract,再决定是否跑提取 | 2 次 | 最清晰,多一次调用 |
| **D2 合并进增量反思(推荐)** | 现有增量反思调用输出加字段 `extractLayers:{activity:bool,...}`,同一次调用决定"本轮产出是否值得落库" | **1 次(零额外成本)** | 输出多 ~100 tokens,≈ 免费 |
| D3 不做 | 靠现有双查重 | 1 次 | 现状 |

### 5.2 D2 的成本数学(你全云端 API,按 DeepSeek 价)

增量反思单次:输入 ~5k tokens(缓冲消息+快照)+ 输出 ~2k tokens
- 输入 5k × ¥1/M ≈ ¥0.005;输出 2k × ¥4/M ≈ ¥0.008 → **单次 ≈ ¥0.013**
- D2 增加 `extractLayers` 输出约 100 tokens ≈ **+¥0.0004(3%)**,可忽略
- 价值:LLM 自己判断"这批对话没有长效干货"时,`extractLayers` 全 false → promoted 空,后续可不触发嵌入;质量上减少垃圾入库,非省钱项

### 5.3 结论

**不建议 D1**(云端多一次调用纯加钱,过滤率>60% 才回本);**D2 顺带做**(零成本);D3 是兜底。gatekeeper 的"预筛价值"在 Castalia 已由「双阈值缓冲 + 增量反思 + 双查重」覆盖,它本质不是新能力,是 LobeHub 因无缓冲/无查重才需要的补丁。

---

## 6. 验证清单(每个实施项独立复验)

1. **A identity CRUD**:喂对话(含身份新增+角色变化)→ 断言:add 1 条;再次喂同样对话 → update 而非 add(查 count 不变);幻觉 id → rejected 数组非空;identity_locked=1 → remove 被拒
2. **B 评分**:提取后查 `SELECT score_priority FROM memory WHERE type='preference'` 非空;search sort=priority 排序正确
3. **C metadata**:偏好记忆 metadata JSON 可解析;memory_context 输出含「适用/不适用」行
4. **回归**:存量 12 条检索结果不变;npm run build EXIT=0;smoke_test.py 29 工具全通
5. **三仓库**:通用版→Anima→主系统锚点补丁;情感 5 文件 diff 空;三实例 dist 同步

---

## 7. 实施顺序与工作量

| 步骤 | 内容 | 工作量 |
|---|---|---|
| 1 | db.ts migrations + store.ts StoreParams/INSERT(评分+metadata+title/status 列) | 0.5 天 |
| 2 | applyIdentityActions + reflect.ts identityUpdate 分支 + memory_identity 工具 | 0.5 天 |
| 3 | triage prompt 三段(身份白名单/偏好触发/评分输出) | 0.5 天 |
| 4 | search 排序 + memory_context 偏好段渲染 | 0.5 天 |
| 5 | 验证清单全跑 + 三仓库同步 | 0.5 天 |
| 合计 | — | **≈ 2.5 天** |
