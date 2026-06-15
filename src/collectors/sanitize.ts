/**
 * store 层统一文本净化纯函数（add-semantic-dedup-and-store-hardening，design D8 /
 * spec「store 层统一文本净化（全源收口）」）。
 *
 * 唯一净化实现（SOT）：剔除 NUL 与 C0 控制字符（**保留** `\t`/`\n`/`\r`）+ 剔除 lone surrogate
 * （**保留**合法 emoji 代理对）。store.ts 是 raw_items 的唯一 text sink，对**所有源**入库的
 * `title`/`content`/`url` 及 `metadata` 字符串值统一过本函数后再 INSERT。
 *
 * 动因（spec 动因 / memory store-layer-text-sanitization-followup）：
 * - Postgres `text` 列遇 NUL 在 INSERT 抛错；`jsonb` 遇 `\0` 同样报错；
 * - lone surrogate 会破坏下游 `JSON.stringify`；
 * - 任一源（不仅 sitemap）的一条坏文本若未净化会中止整批入库。
 *
 * 纯函数：同输入恒同输出，无 I/O、无随机、无时钟依赖。`stripUnsafeChars`（collectors/types.ts）
 * 现委托到本函数作单一实现，既有 sitemap / hf-papers 采集器的自层净化保留作纵深防御、行为不变。
 */

// 剔 NUL 与 C0 控制字符（U+0000–U+0008、U+000B、U+000C、U+000E–U+001F），
// **保留** \t(U+0009) \n(U+000A) \r(U+000D)。
// eslint-disable-next-line no-control-regex -- 有意匹配 C0 控制字符以剔除（防 NUL 致 Postgres text/jsonb INSERT 中止整批）
const UNSAFE_CTRL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]', 'g');

// 剔 lone surrogate（无配对的高/低代理项），**保留**成对的合法代理对（emoji 等补充平面字符）。
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * 净化单个字符串：剔 NUL/C0 控制符（保留 \t\n\r）+ lone surrogate（保留合法 emoji 代理对）。
 * 同输入恒同输出，无副作用。
 */
export function sanitizeText(s: string): string {
  return s.replace(UNSAFE_CTRL, '').replace(LONE_SURROGATE, '');
}

/**
 * 递归净化任意值中的**字符串值**，用于 store 层在 `JSON.stringify(metadata)` **之前**净化
 * metadata（spec：坏码点若留到 stringify 之后，jsonb 写入仍会因 NUL 报错；且直接净化序列化整串
 * 会误伤 JSON 结构字符或漏掉嵌套值，故须先净化对象内各层字符串值、再序列化）。
 *
 * - string：过 `sanitizeText`；
 * - 数组：逐元素递归（保结构）；
 * - 普通对象：逐值递归（key 不动——key 来自程序常量/源字段名，非用户危险文本，且改 key 会破坏结构语义）；
 * - 其余（number/boolean/null/undefined/bigint/symbol/function）：原样返回（无字符串码点风险）。
 *
 * 不改变结构：数组仍是数组、对象仍是对象，仅替换其中的字符串叶子值。
 */
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return sanitizeText(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeDeep(v)) as unknown as T;
  }
  // 仅对「普通对象」递归净化值；非普通对象（Date/Map/Set 等）原样返回，避免破坏其内部结构。
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** 是否为「普通对象」（`{}` 字面量 / `Object.create(null)`），排除 Date/Map/Set/类实例等。 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
