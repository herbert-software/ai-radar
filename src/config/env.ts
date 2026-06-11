// 先加载 .env（若存在）到 process.env，再做下方校验。
// dotenv 默认不覆盖已存在的 process.env，故 CI / shell 注入的变量仍优先，
// 本地 `cp .env.example .env` 填好后 `npm run dev` 等脚本即可读到（修复 README 快速开始）。
import 'dotenv/config';
import { z } from 'zod';

/**
 * 环境配置 schema（承载 spec「环境配置校验」需求）。
 *
 * 关键不变量：缺关键变量启动即报错，禁止静默用空值/默认值继续运行。
 * - DATABASE_URL / REDIS_URL：基础设施连接串，必填。
 * - LLM_API_KEY / LLM_MODEL：LLM provider 凭据与模型名，Value Judge 往返必需。
 * - TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID：Telegram 单通道推送凭据与目标，必填
 *   （P1 推送链路上线，缺则无法发日报）。
 *
 * provider 经 Vercel AI SDK 抽象，本模块对具体 provider 无硬编码偏好；
 * key、model 名与 base URL 从 env 注入。
 * - LLM_BASE_URL：OpenAI 兼容端点，默认指向 OpenRouter（https://openrouter.ai/api/v1）。
 *
 * P1 流水线配置（组合分权重 / Top N / 闸值 / 时区 / 源清单）以默认值兜底，
 * 但所有 number/ratio 都经 coerce + 范围校验，非法值（NaN / 负数 / 越界）启动即报错，
 * 不静默退化。
 */

/**
 * 把逗号分隔串解析为去空白的非空字符串数组（RSS 源清单用）。
 * 空串或仅空白 → 空数组。
 */
const csvList = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL 缺失：需提供 PostgreSQL 连接串')
    .url('DATABASE_URL 必须是合法 URL（如 postgres://user:pass@host:5432/db）'),
  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL 缺失：需提供 Redis 连接串')
    .url('REDIS_URL 必须是合法 URL（如 redis://localhost:6379）'),
  LLM_API_KEY: z
    .string()
    .min(1, 'LLM_API_KEY 缺失：需提供 LLM provider API key'),
  LLM_MODEL: z
    .string()
    .min(1, 'LLM_MODEL 缺失：需提供模型名（如 openai/gpt-4o-mini）'),
  LLM_BASE_URL: z
    .string()
    .url('LLM_BASE_URL 必须是合法 URL（OpenAI 兼容端点，如 https://openrouter.ai/api/v1）')
    .default('https://openrouter.ai/api/v1'),
  // 单次 LLM 调用（generateObject）超时毫秒数；防一条挂起的响应卡死 Value Judge / 摘要阶段。
  // LLM 比普通 fetch 慢，默认给 60s。
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),

  // --- Telegram 推送（telegram-push）---
  TELEGRAM_BOT_TOKEN: z
    .string()
    .min(1, 'TELEGRAM_BOT_TOKEN 缺失：需提供 Telegram bot token（@BotFather 获取）'),
  TELEGRAM_CHAT_ID: z
    .string()
    .min(1, 'TELEGRAM_CHAT_ID 缺失：需提供目标 chat id（推送日报的目标会话）'),

  // --- 推送时区（daily-intel-pipeline / telegram-push）---
  // push_date 与候选窗口「今天」同源此时区，钉死防跨 UTC 零点重复推送（design D6）。
  PUSH_TIMEZONE: z.string().min(1).default('Asia/Shanghai'),

  // --- Top N 与组合分权重（daily-intel-pipeline D5）---
  TOP_N: z.coerce.number().int().positive().default(8),
  RANK_WEIGHT_IMPORTANCE: z.coerce.number().min(0).default(0.45),
  RANK_WEIGHT_DEVELOPER_RELEVANCE: z.coerce.number().min(0).default(0.25),
  RANK_WEIGHT_NOVELTY: z.coerce.number().min(0).default(0.2),
  // hype_risk 为减项（rank_score 里以负权重计），此处取其非负幅度，组合分时作减项。
  RANK_WEIGHT_HYPE_RISK: z.coerce.number().min(0).default(0.1),
  // importance 下限闸：宁可某天少于 N 条也不凑数推垃圾（design D5）。
  IMPORTANCE_FLOOR: z.coerce.number().min(0).max(100).default(60),

  // --- 降级率熔断（daily-intel-pipeline D8）---
  // 任一阶段分母 > 0 且其降级率严格 > 此值 → 中止 + 告警，不推残缺日报。
  DEGRADE_ABORT_RATIO: z.coerce.number().min(0).max(1).default(0.5),

  // --- 候选窗口（daily-intel-pipeline D5）---
  // first_seen_at 在近 N 天的事件才进候选。
  FIRST_SEEN_WINDOW_DAYS: z.coerce.number().int().positive().default(3),

  // --- BullMQ 每日定时触发（daily-intel-pipeline D7）---
  // cron 表达式（BullMQ repeat.pattern）触发 daily-digest 任务，默认每日 08:00。
  // cron 时区由 DAILY_DIGEST_CRON_TZ 指定（默认与 push 同源 Asia/Shanghai），
  // 防触发时区与 push_date 口径漂移。
  DAILY_DIGEST_CRON: z.string().min(1).default('0 8 * * *'),
  DAILY_DIGEST_CRON_TZ: z.string().min(1).default('Asia/Shanghai'),
  // 整 job 重试次数（BullMQ 作整 job 重试外壳，不拆阶段队列，design D7）。
  DAILY_DIGEST_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),

  // --- Collector 源清单（source-collectors）---
  // 逗号分隔的 RSS feed URL 列表，可为空（空则该源不采）。
  RSS_FEEDS: csvList,
  // GitHub API token，用于提额（带 token 提速率上限）；可空，空则匿名调用受更严限流。
  GITHUB_TOKEN: z.string().default(''),
  // 单次源网络调用（fetch / RSS parseURL）超时毫秒数；防实网挂起无限期卡死整个采集。
  COLLECTOR_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
});

export type Env = z.infer<typeof envSchema>;

/**
 * 解析并校验环境变量。校验失败时抛出聚合了全部缺失/非法字段的明确错误，
 * 而非静默返回部分值。
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `环境配置校验失败，应用无法启动。请对照 .env.example 补齐以下变量：\n${details}`,
    );
  }
  return result.data;
}

/**
 * 类型化、已校验的 env。其他模块直接 `import { env }`。
 * 模块首次被 import 时即执行校验——缺关键变量则在启动阶段立即 throw。
 */
export const env: Env = parseEnv(process.env);
