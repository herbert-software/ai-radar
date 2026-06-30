/**
 * recommend_coding_subscription —— 编程订阅选型推荐（add-model-radar-recommender 组 C，design D5/D6，task 3.1–3.3）。
 *
 * 单工具：从 MCP 客户端（Claude/Cursor）给 `{model?, tool?, protocol?, currency?, maxMonthlyPrice?, usageProfile?}`
 * → 经组 B 纯函数 `recommend()`（vetted money-path 召回 + 撞窗判定 + 模板解释）产出结构化「首选/备选/不推荐/
 * 待核 + 月成本 + 撞窗 + stale + 依据」。**只读、不写任何 `mr_*`**。
 *
 * **env-clean 每次现 build（design D5 / N2 红线）**：MCP 进程只有 `DATABASE_URL`，故 `build.ts` 在
 * `query-chain-env.test.ts` 禁顶层 import 清单内——`buildModelRadarSnapshot` 必须 **handler 内 `await import`**
 * 动态加载（env-clean 化后不触 `db/index.ts`/`config/env.ts` 的全局 parseEnv），传 `getContext().db` + 显式
 * `thresholdDays`（取自 `mcpEnvSchema.MR_STALENESS_THRESHOLD_DAYS`、不硬编码）；**每次调用现 build**（不经
 * cache.ts、无 frozen-until-restart，随调随新）。陈旧由候选 plan 级 `stale` 标如实暴露。
 *
 * **顶层禁 import** `cache.js`/`build.js`/`db/index.js`/`config/env.js`（build 走动态）；`recommend.js` 图
 * 全 env-clean、可顶层 static import。
 *
 * 输出契约（design D5）：声明 outputSchema（复用组 B `schema.ts` 形状）+ 返回 structuredContent（即
 * `recommend()` 已 Zod 校验的 `RecommendationResult`）+ content[].text 人类可读摘要。annotations.readOnlyHint:true。
 * 入参由 SDK 依 inputSchema 自动校验（handler 内不再 parse）；快照不可用 → fail-closed isError（绝不编推荐）。
 */
import { z } from 'zod';
import { mrCurrencySchema } from '../../db/mr-schema.zod.js';
import { recommend, type RecommendInput } from '../../mr/recommend/recommend.js';
import {
  rankedCandidateSchema,
  recommendQuerySchema,
  usageProfileSchema,
  type RecommendationResult,
} from '../../mr/recommend/schema.js';
import { getContext } from '../context.js';
import { toIsError } from '../lib/errors.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolDescriptor } from './types.js';

/**
 * 入参 zod raw shape（design D5）：每参 `.optional()` + `.describe()` 枚举/示例合法值。
 * `maxMonthlyPrice` 为纯数值（`nonnegative().finite()`）、与 `plan.currentPrice` **同币种**比，**不**格式化任何
 * money-path 串；`currency`/`usageProfile` 走枚举（`mrCurrencySchema` / light|medium|heavy）。
 */
const inputSchema = {
  model: z
    .string()
    .refine((s) => s.includes(':'), 'model 须为「family:version」，冒号必带')
    .optional()
    .describe('模型「家族:版本」，如 "glm:4.6"（冒号必带、版本精确匹配）；省略=不限模型'),
  tool: z
    .string()
    .min(1, 'tool 不可为空串')
    .optional()
    .describe('工具 clientId，大小写敏感精确匹配，如 "claude-code"；省略=不限工具'),
  protocol: z
    .string()
    .min(1, 'protocol 不可为空串')
    .optional()
    .describe('协议 clientId，大小写敏感精确匹配，如 "anthropic-compatible"；省略=不限协议'),
  currency: mrCurrencySchema
    .optional()
    .describe('计价币种，默认 CNY；枚举 CNY|USD|EUR（不跨币比价，仅同币种组内排名/判预算）'),
  maxMonthlyPrice: z
    .number()
    .nonnegative()
    .finite()
    .optional()
    .describe('预算上限，纯数值、与 plan 月价同币种比；省略=无预算约束'),
  usageProfile: usageProfileSchema
    .optional()
    .describe('用量档：light|medium|heavy（映射 demandedRounds/tokensPerRound 估撞窗）；省略=medium'),
};

/** 出参 zod raw shape（复用组 B schema.ts 形状映射 RecommendationResult；声明 → handler 必返 structuredContent）。 */
const outputSchema = {
  query: recommendQuerySchema,
  candidates: z.array(rankedCandidateSchema),
  explanation: z.string(),
};

/** 人类可读摘要：首选行（含月成本/撞窗/stale）+ 推荐器解释（含 reasons/provenance/落选缘由依据）。 */
function summarize(result: RecommendationResult): string {
  const primary = result.candidates.find((c) => c.verdict === 'primary');
  const head = primary
    ? `首选：${primary.vendorName} ${primary.name} — 月成本 ${primary.monthlyCost} ${primary.currency}` +
      `（撞窗 ${primary.fitsWindow}${primary.stale ? '、数据陈旧' : ''}）`
    : '暂无可用首选';
  return [head, result.explanation].map((s) => s.trim()).filter(Boolean).join('\n\n');
}

export const recommendCodingTool: McpToolDescriptor = {
  name: 'recommend_coding_subscription',
  description:
    '只读：给定模型/工具/协议/币种/预算/用量档，推荐最划算的编程订阅（IDE会员/Coding Plan/Token包，仅 coding_plan 桶）。' +
    '价格/兼容/额度为 DB 精确事实、规则硬筛召回，撞窗为⚠估算；返回首选/备选/不推荐/待核 + 月成本 + 撞窗 + stale + 依据。' +
    '不跨币比价、不写库；快照不可用则返结构化错误（不编推荐）。',
  inputSchema,
  outputSchema,
  annotations: {
    readOnlyHint: true,
  },
  handler: async (args): Promise<CallToolResult> => {
    // 入参已由 SDK 依 inputSchema 自动校验，此处直接取值（不重复 parse）。
    const { db, env } = getContext();
    let snapshot;
    try {
      // 动态 import env-clean build.ts（避顶层触 db/index.ts/config/env.ts 的全局 parseEnv）；每次现 build。
      const { buildModelRadarSnapshot } = await import('../../mr/snapshot/build.js');
      snapshot = await buildModelRadarSnapshot(db, new Date(), env.MR_STALENESS_THRESHOLD_DAYS);
    } catch (e) {
      // fail-closed：快照构建/校验失败 → 结构化错误，绝不编造/降级假推荐。
      return toIsError(
        `快照不可用，无法生成推荐（snapshot unavailable）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      const result = await recommend(snapshot, args as RecommendInput);
      return {
        structuredContent: result,
        content: [{ type: 'text', text: summarize(result) }],
      };
    } catch (e) {
      // 推荐/召回阶段失败（如非法入参）≠ 快照不可用，单独标，避误导 agent 当快照故障。
      return toIsError(
        `推荐生成失败（无效参数或推荐错误）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};
