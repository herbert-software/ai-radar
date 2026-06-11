/**
 * push_date 时间源（telegram-push 9.1，design D6）—— 全仓库唯一的「今天」口径。
 *
 * 关键不变量（绝不可违背）：
 * - push_date 必须以 **Asia/Shanghai**（env.PUSH_TIMEZONE）时区计算「今天」，
 *   禁止用 UTC 或机器本地时区，否则跨 UTC 零点会把一份日报算成两天而重复推送
 *   （与退出标准②「同一天不重复」直接挂钩）。
 * - 这是**唯一**的 push_date / 候选窗口「今天」时间源：Top N 候选窗口（8.1）必须
 *   `import` 本模块的同一函数，禁止另起一套时区计算导致两处口径漂移。
 *
 * 输出形如 `YYYY-MM-DD` 的纯日期串，正好匹配 push_records.push_date（DATE 列）
 * 与 Postgres DATE 字面量，无需再做时区换算。
 */
import { env } from '../config/env.js';

/**
 * 把给定时刻按指定 IANA 时区折算成 `YYYY-MM-DD` 本地日期串。
 *
 * 用 `Intl.DateTimeFormat` 的 en-CA locale（天然产出 `YYYY-MM-DD`）做时区换算，
 * 不引第三方时区库；不依赖宿主机时区。
 *
 * @param at       要折算的时刻（默认当前时刻）。
 * @param timeZone IANA 时区名（默认 env.PUSH_TIMEZONE）。
 */
export function dateInTimeZone(
  at: Date = new Date(),
  timeZone: string = env.PUSH_TIMEZONE,
): string {
  // en-CA 的 `numeric` 风格输出即 `YYYY-MM-DD`，跨实现稳定，避免手工拼装月/日补零。
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(at);
}

/**
 * 计算「今天」的 push_date（`YYYY-MM-DD`，Asia/Shanghai 口径）。
 * 这是 dispatcher 与 Top N 候选窗口共用的唯一时间源。
 *
 * @param at 参考时刻（默认当前时刻；测试可注入固定时刻验证跨 UTC 零点行为）。
 */
export function getPushDate(at: Date = new Date()): string {
  return dateInTimeZone(at, env.PUSH_TIMEZONE);
}

/**
 * 计算「`at` 所在的本地自然日，往前推 `daysBack` 个自然日」的 00:00（本地时间）对应的 UTC 时刻。
 *
 * 与 push_date 共用同一时区源（默认 env.PUSH_TIMEZONE = Asia/Shanghai），供 Top N 候选窗口
 * 计算「近 N 天」下界，保证窗口「今天」与 push_date 不漂移（design D5/D6）。
 * `daysBack=0` 即 `at` 当天的 00:00。
 *
 * @param at        参考时刻。
 * @param daysBack  往前推的自然日数（非负）。
 * @param timeZone  IANA 时区名（默认 env.PUSH_TIMEZONE）。
 */
export function startOfDayInTimeZone(
  at: Date,
  daysBack: number,
  timeZone: string = env.PUSH_TIMEZONE,
): Date {
  // 取 at 所在本地自然日，按 UTC 日历减 daysBack 天得到目标本地日的 Y/M/D。
  const [y, m, d] = dateInTimeZone(at, timeZone)
    .split('-')
    .map((part) => Number(part));
  const utcMidnightGuess = new Date(
    Date.UTC(y!, m! - 1, d! - daysBack, 0, 0, 0),
  );
  // utcMidnightGuess 被错当成 UTC 午夜：求其在 timeZone 的实际墙钟偏移，回推真正的本地午夜 UTC 时刻。
  const offsetMs =
    tzOffsetMs(utcMidnightGuess, timeZone);
  return new Date(utcMidnightGuess.getTime() - offsetMs);
}

/** 给定时刻在指定时区相对 UTC 的偏移（毫秒，东区为正）。 */
function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return asUtc - at.getTime();
}
