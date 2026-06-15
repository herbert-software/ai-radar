/**
 * LIKE / ILIKE 元字符转义（design D3，spec「limit 上限与 LIKE 元字符防滥用」）。
 *
 * 关键词查询把用户输入拼成 `%q%` 走 ILIKE。注入由参数化占位符（drizzle）挡住，但用户输入里的
 * LIKE 元字符（`%` `_`）若不转义会被当通配符——一个字面 `%` 即触发全表扫描、`_` 误配单字符。
 * 故拼 `%q%` 前用本函数把 `\` `%` `_` 转义为字面量（反斜杠须先转，避免二次转义自身）。
 *
 * 与之配套：调用方在 SQL 端须声明 `ESCAPE '\'`（drizzle `ilike` 默认即用反斜杠转义符），
 * 使本处的 `\%` `\_` 被按字面匹配。
 *
 * 本模块零外部依赖、零副作用，查询链 top-level 可安全 import。
 */

/**
 * 转义 LIKE/ILIKE 模式里的元字符（`\` `%` `_`），使其按字面匹配。
 *
 * @param s 用户原始关键词。
 * @returns 转义后的串（可安全拼入 `%...%` 作 ILIKE 模式）。
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
