/**
 * Model Radar（P5 / 5b，design D7 / 合规）`manual` 档 = 跳过、不发任何请求。
 *
 * `fetch_strategy='manual'` 的源（登录墙事实、`needs_login_recheck` 占位等）抓取链**不出站**：
 * 由人工策展刷新 last_checked / 改价，陈旧度排程（D9，last_checked IS NULL 也进复核）兜底提醒复核。
 */

/** manual 档「抓取」结果：永不发请求。返回 null 让上层 fingerprint 流程 no-op（不打标、不刷指纹）。 */
export function fetchManual(): null {
  // ponytail: 故意空实现——manual 档的语义就是「不抓」（design D7/合规需求）。
  return null;
}
