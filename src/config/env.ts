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
 *
 * provider 经 Vercel AI SDK 抽象，本模块对具体 provider 无硬编码偏好；
 * key、model 名与 base URL 从 env 注入。
 * - LLM_BASE_URL：OpenAI 兼容端点，默认指向 OpenRouter（https://openrouter.ai/api/v1）。
 */
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
});

export type Env = z.infer<typeof envSchema>;

/**
 * 解析并校验环境变量。校验失败时抛出聚合了全部缺失/非法字段的明确错误，
 * 而非静默返回部分值。
 */
function parseEnv(source: NodeJS.ProcessEnv): Env {
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
