/**
 * Model Radar（P5 / 5b，design D10）抓取域名白名单 = **checked-in 常量**（非 env，仿 collectors 的常量）。
 *
 * 这是 SSRF chokepoint（`ssrf-guard.ts`）的第二道闸：抓取目标 host 的 registrable domain
 * 必须 ∈ 本白名单。**独立于 `source_url`**——`mr_vendors` 仅 `id/normalized_name/name`，无域名列，
 * 「从 mr_vendors 派生」不可实现；从录入的不可信 URL 自取 host 是自授权循环（design D10）。
 * 故白名单是 checked-in 常量、**PR 评审维护**：新增源域名走 PR diff，可审计。
 *
 * 录入时 Zod 拒 registrable domain ∉ 白名单的 `source_url`（5b 录入路径调本判定），抓取时再验。
 *
 * registrable domain 用「eTLD+1 的保守近似」匹配：host 等于白名单项，或以 `.<白名单项>` 结尾
 * （子域 `pricing.openai.com` 命中 `openai.com`）。**不引 public-suffix-list 依赖**——白名单全是
 * 已知厂商裸域，保守后缀匹配足够；要精确 eTLD 处理（如多段公共后缀）再引 psl（YAGNI，design）。
 */

/**
 * 已 seed 厂商官方域（PR 评审维护）。新增源前先在此加裸域，再录入对应 source_url。
 * 此白名单须覆盖 `seed-data.ts` 所有 `fetchStrategy∈{http,browser}` 源 host 的 registrable domain
 * （`allowlist.drift.test.ts` 机械守护）；新增抓取源时同步本表。
 * ponytail: 裸域常量；要 per-vendor 绑定 host（防 A 厂源用 B 厂域）须 mr_vendors 加域名列 = 越界留后。
 */
export const MR_SOURCE_DOMAIN_ALLOWLIST: readonly string[] = [
  'openai.com',
  'anthropic.com',
  'google.com', // Gemini / Google AI pricing
  'x.ai', // xAI / Grok
  'deepseek.com',
  'moonshot.cn', // Kimi（platform.moonshot.cn）
  'bigmodel.cn', // 智谱 GLM / Z.ai
  'alibabacloud.com', // 通义千问 / DashScope
  'minimaxi.com', // MiniMax（platform.minimaxi.com）
  'stepfun.com', // Step 阶跃星辰（platform.stepfun.com）
  'trae.ai', // Trae（www.trae.ai）
  'qoder.com', // Qoder
  'baidu.com', // Comate（comate.baidu.com）
  'tencent.com', // CodeBuddy（copilot.tencent.com）
];

/**
 * host 的 registrable domain 是否 ∈ 白名单（保守后缀匹配：相等或以 `.<域>` 结尾）。
 * host 须已为小写裸主机名（无端口/无路径）——调用方（ssrf-guard）传 `URL.hostname`。
 */
export function isHostAllowlisted(
  host: string,
  allowlist: readonly string[] = MR_SOURCE_DOMAIN_ALLOWLIST,
): boolean {
  const h = host.toLowerCase().replace(/\.$/, ''); // 去 FQDN 尾点
  if (h.length === 0) return false;
  return allowlist.some(
    (domain) => h === domain || h.endsWith(`.${domain}`),
  );
}
