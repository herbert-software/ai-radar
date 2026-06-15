/**
 * MCP 自带 `getPushDate` 等价（design D6/D8，task 2.6）。
 *
 * **复刻** `src/push/push-date.ts` 的 `dateInTimeZone` 时区算日逻辑，但**不 import 它**——
 * 那里 top-level `import { env } from '../config/env.js'`，import 即触发全局 parseEnv 崩纯查询。
 * 此处时区由调用方传入（来自 MCP 宽松 env 的 `PUSH_TIMEZONE`、default `Asia/Shanghai`），
 * 与主链 push_date 写入口径**同源**，保证 get_today 的「今天」与实际已推 push_date 不漂移。
 *
 * 输出形如 `YYYY-MM-DD` 的纯日期串，正好匹配 push_records.push_date（DATE 列）。
 */

/**
 * 把给定时刻按指定 IANA 时区折算成 `YYYY-MM-DD` 本地日期串。
 *
 * 用 `Intl.DateTimeFormat` 的 en-CA locale（天然产出 `YYYY-MM-DD`）做时区换算，
 * 不引第三方时区库、不依赖宿主机时区。逻辑与主链 `push-date.ts:dateInTimeZone` 一致。
 *
 * @param at       要折算的时刻（默认当前时刻）。
 * @param timeZone IANA 时区名（来自 MCP 宽松 env PUSH_TIMEZONE）。
 */
export function dateInTimeZone(at: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(at);
}

/**
 * 计算「今天」的 push_date（`YYYY-MM-DD`），时区取 MCP 宽松 env 的 PUSH_TIMEZONE。
 *
 * @param at       参考时刻（默认当前时刻；测试可注入固定时刻验证跨 UTC 零点行为）。
 * @param timeZone IANA 时区名（来自 MCP 宽松 env PUSH_TIMEZONE、default Asia/Shanghai）。
 */
export function getPushDate(at: Date, timeZone: string): string {
  return dateInTimeZone(at, timeZone);
}
