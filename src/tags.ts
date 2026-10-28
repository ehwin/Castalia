/**
 * tags 列的安全解析 / 写入归一化 —— 全仓唯一实现。
 *
 * 背景:memory.tags 是 TEXT 列,历史脏数据(列错位、手写 SQL、截断)可能不是 JSON 数组。
 * 过去多条读写路径直接 `JSON.parse(row.tags || '[]')`,且多数在 try/catch 之外:
 * 只要库里有一行脏 tags,`JSON.parse` 抛错(或解析出字符串后 `.some` 抛 TypeError),
 * 调用方的 try/catch 就把整个 memType 库静默吞成 0 条。
 *
 * 后置条件(强约束,downstream 可直接依赖):
 *   返回值**一定是 `string[]`**,且每个元素都是 trim 后非空的字符串。
 *   - 非法 JSON / 非数组 / null / undefined / 非字符串且非数组 → []
 *   - 数组元素里只有 typeof === 'string' 的保留(数字/布尔/null/对象一律丢弃,不做 String() 强转)
 *   - 嵌套数组拍平一层后再过滤(如 [["a"],["b"]] → ["a","b"])
 *   - 元素 trim,trim 后为空串的丢弃
 * 合法数据(字符串数组)的取值保持不变;仅空白被规范化。
 */
export function parseTagsSafe(raw: unknown): string[] {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length === 0) return [];
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  // Postcondition enforcement: flatten one level, keep strings only, trim, drop empties.
  return normalizeTags(parsed);
}

/**
 * 数组形态的归一化（不做 JSON 解析）：只接受数组，非数组一律 []。
 *
 * parseTagsSafe 的内核；Full 的总反思模块（reflectAll.ts）直接 import 这个函数，
 * 所以它是 core 与 bus 之间的共享契约，改名/删除会直接让总线编译不过。
 */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of (value as unknown[]).flat(1)) {
    if (typeof item !== 'string') continue;
    const tag = item.trim();
    if (tag.length > 0) out.push(tag);
  }
  return out;
}

/**
 * 写入前归一化:保证落库的 tags 一定是 JSON 数组(元素均为 trim 后非空字符串)。
 *
 * 走写入路径的值可能来自外部调用(internal caller / LLM),不保证是数组;
 * 若直接 JSON.stringify("a,b") 会落成 JSON 字符串 —— 正是本轮脏数据的形态。
 * 这里复用 parseTagsSafe 的同一后置条件,所有非数组输入收敛为 []。
 */
export function normalizeTagsForWrite(raw: unknown): string[] {
  return parseTagsSafe(raw);
}

/**
 * 统一序列化写入:所有会写 memory.tags 列的绑定值都必须经过这里。
 *
 * `serializeTags(x)` 恒等于 `JSON.stringify(normalizeTagsForWrite(x))`,
 * 因此无论调用方传的是脏数组、JSON 字符串还是非数组,落库的都只会是
 * 合法 JSON 数组(元素为 trim 后非空字符串)。
 */
export function serializeTags(raw: unknown): string {
  return JSON.stringify(normalizeTagsForWrite(raw));
}
