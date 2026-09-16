/**
 * 联邦接口定义 —— 横跨多个记忆体的可扩展收纳层 (v1.14, 2026-09-16)
 *
 * 设计目标:联邦不再是"写死的一组本地目录",而是一组 **provider**。
 * 想接入一种新的记忆体形态 → 新增一个 provider 文件,聚合层不用改。
 *
 * ── 两个角色 ─────────────────────────────────────────────────────────
 *
 * ① 被收纳方(任何 Castalia 实例,含 Lite / Anima / 第三方实现)
 *    不需要任何代码。满足下面任一条即可被收纳:
 *      · 库目录符合标准结构:project-<name>.sqlite
 *        或 <project>/<memType>/memory.sqlite      → transport = 'local-dir'
 *      · 暴露一个 MCP 端点(如 Castalia 记忆桥)提供 memory_search
 *                                                  → transport = 'mcp-http'
 *    可选:在 MCP 端点或成员配置里声明 variant / capabilities,让收纳方知道
 *    "这个成员有什么"(如情感层 emotion、联邦 federation)。
 *
 * ② 收纳方(聚合实例,如联合版)
 *    实现/使用下面的 FedProvider:发现成员 → 取数据 → 合并排序。
 *    引擎仍不做合并策略判断 —— 互通语义由调用方决定(接口先行原则不变)。
 *
 * ── 原则 ─────────────────────────────────────────────────────────────
 *  · **只读**:provider 绝不修改对端数据。
 *  · **单成员失败不影响整体**:每个 provider 自己 try/catch,聚合层跳过失败者并在
 *    结果里保留错误信息。
 *  · **传输与接口解耦**:同机成员用 local-dir(微秒级),跨进程/跨机用 mcp-http
 *    (毫秒级)。接口一致,配置决定走哪条路。
 */

/** 一条联邦命中 */
export interface FedHit {
  instance: string;
  project: string;
  id: string;
  text: string;
  score: number;
  createdAt: string | null;
  /** memdir 分类(user/feedback/project/reference/general),旧结构库没有 */
  memType?: string;
  /** 该命中来自哪个成员(provider id),便于上层按成员过滤/加权 */
  member?: string;
}

/** 一个可直读的记忆库(local-dir 类成员专有) */
export interface FedLibrary {
  instance: string;
  project: string;
  memType?: string;
  file: string;
}

/** 一个成员的自我描述(能力协商用) */
export interface FedMemberInfo {
  id: string;
  label?: string;
  /** 品牌/能力线索:lite | anima | max | 自定义 */
  variant?: string;
  /** 能力标签,如 ['emotion'] / ['federation'] / ['reflect'] */
  capabilities: string[];
  transport: string;
  /** 统计信息(库数/记忆数等),允许缺省 */
  counts?: Record<string, number>;
  /** 端点或目录,便于排障展示 */
  target?: string;
  ok: boolean;
  error?: string;
}

/**
 * 联邦成员 provider。
 * 实现类只需保证 search() 与 available();libraries() 仅对能直读文件的成员有意义。
 */
export interface FedProvider {
  readonly id: string;
  readonly label?: string;
  readonly variant?: string;
  readonly capabilities: string[];
  readonly transport: string;
  readonly target?: string;

  /** 成员当前是否可达(目录存在 / 端点能握手) */
  available(): Promise<boolean>;

  /** 自我描述:变体、能力、规模。失败不抛异常,返回 ok=false + error */
  describe(): Promise<FedMemberInfo>;

  /** 检索:失败返回空数组(不抛),由聚合层汇总 */
  search(query: string, topK: number): Promise<FedHit[]>;

  /**
   * 列出可直读的库文件。只有 local-dir 类成员实现它;
   * 远程成员返回 undefined(跨库反思等需要逐库直读的流程会自动跳过它)。
   */
  libraries?(): FedLibrary[];
}

/**
 * 成员配置项 —— 出现在 FEDERATION_MEMBERS / FEDERATION_DIRS 里。
 *
 * 老写法(仍然支持):
 *   FEDERATION_DIRS = [{"name":"Hermes","dir":"D:/banks/hermes"}]
 * 新写法:
 *   FEDERATION_MEMBERS = [{
 *     "id":"airi", "label":"Castalia Anima", "variant":"anima",
 *     "capabilities":["emotion"], "transport":"mcp-http",
 *     "target":"http://127.0.0.1:3320/mcp"
 *   }]
 * transport 缺省时自动推断:给了 dir → local-dir;给了 http(s) target → mcp-http。
 */
export interface FedMemberConfig {
  id: string;
  label?: string;
  variant?: string;
  capabilities?: string[];
  transport?: 'local-dir' | 'mcp-http' | string;
  /** local-dir:目录路径;mcp-http:端点 URL */
  target?: string;
  /** 老字段:等价于 transport=local-dir + target */
  dir?: string;
  /** 老字段:等价于 id */
  name?: string;
  /** mcp-http 专用:调用工具名与超时(毫秒) */
  tool?: string;
  timeoutMs?: number;
}
