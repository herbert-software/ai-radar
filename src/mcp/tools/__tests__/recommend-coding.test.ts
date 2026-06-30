/**
 * recommend_coding_subscription handler 单测（add-model-radar-recommender 组 C，task 4.7/4.8，**无 DB**）。
 *
 * `vi.mock('../../../mr/snapshot/build.js')` 让 `buildModelRadarSnapshot` 返合成快照（或抛错），不触真 DB/Redis/
 * 飞书/Telegram。验：
 * - 4.7 ① 正常：handler 返 structuredContent（经 outputSchema 形状）+ content[].text 含首选/stale；
 *        ② annotations.readOnlyHint:true；③ build 抛错 → fail-closed isError（不编推荐）。
 * - 4.8 退出标准用例：合成 GLM Coding Plan Lite（glm:4.6 + claude-code + ¥49 + 限额 value:null）与 GLM Pro（¥149）
 *        → 重度用 → 首选 GLM Lite、monthlyCost=49、fitsWindow='unknown'（现数据口径未知如实标），话术含月成本/依据/撞窗。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { setContext } from '../../context.js';
import { recommendCodingTool } from '../recommend-coding.js';
import { recommendationResultSchema } from '../../../mr/recommend/schema.js';
import type { McpDb } from '../../db.js';
import type { McpEnv } from '../../env.js';
import type { ModelRadarSnapshot, SnapshotLimit, SnapshotPlan } from '../../../mr/snapshot/dto.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// 动态 import 目标 env-clean build.ts —— mock 让 handler 现 build 取到合成快照（不触 DB）。
vi.mock('../../../mr/snapshot/build.js');
import { buildModelRadarSnapshot } from '../../../mr/snapshot/build.js';

const PROV = {
  sourceUrl: 'https://open.bigmodel.cn/pricing',
  sourceConfidence: 'official_pricing' as const,
  lastCheckedDate: '2026-06-20',
};

function mkLimit(limitType: SnapshotLimit['limitType'], value: string | null, window = 'monthly'): SnapshotLimit {
  return { limitType, value, window, provenance: PROV };
}

/** GLM Coding Plan 行（glm:4.6 + claude-code），价/限额可覆盖。 */
function mkGlmPlan(id: string, price: string, limits: SnapshotLimit[]): SnapshotPlan {
  return {
    id,
    vendorId: `vendor-${id}`,
    vendorName: '智谱 GLM',
    name: id,
    category: 'coding_plan',
    currentPrice: price,
    currency: 'CNY',
    priceStatus: 'known',
    provenance: PROV,
    freshness: { stale: false },
    reviewStatus: { pending: false },
    models: [{ modelId: `m-${id}`, family: 'glm', version: '4.6', provenance: PROV }],
    clients: [{ clientType: 'tool', clientId: 'claude-code', provenance: PROV }],
    limits,
    sources: [],
  };
}

function snap(...plans: SnapshotPlan[]): ModelRadarSnapshot {
  return { plans };
}

// 现数据桶2 限额全 rolling_5h_requests/credit/fast_pass 且 value:NULL → 撞窗恒 unknown。
const BUCKET2_LIMITS = [
  mkLimit('rolling_5h_requests', null, 'rolling_5h'),
  mkLimit('credit', null),
  mkLimit('fast_pass', null),
];

/** 退出标准合成快照：GLM Lite ¥49 + GLM Pro ¥149（同 glm:4.6 / claude-code）。 */
const exitSnapshot = snap(
  mkGlmPlan('GLM Coding Plan Lite', '49', BUCKET2_LIMITS),
  mkGlmPlan('GLM Coding Plan Pro', '149', BUCKET2_LIMITS),
);

const env: McpEnv = {
  DATABASE_URL: 'postgres://x:x@localhost:5432/x',
  PUSH_TIMEZONE: 'Asia/Shanghai',
  MR_STALENESS_THRESHOLD_DAYS: 30,
};
// handler 只把 db 透传给（被 mock 的）build；mock 忽略它，故空对象桩足矣（不触 DB）。
const db = {} as unknown as McpDb;

const mockedBuild = vi.mocked(buildModelRadarSnapshot);

beforeEach(() => {
  setContext({ env, db });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('4.7 recommend_coding_subscription handler（注入合成快照、不触 DB）', () => {
  it('正常：返 structuredContent（经 outputSchema 形状）+ content[].text 含首选/stale', async () => {
    const stalePlan = mkGlmPlan('GLM Coding Plan Lite', '49', BUCKET2_LIMITS);
    stalePlan.freshness = { stale: true };
    mockedBuild.mockResolvedValue(snap(stalePlan));

    const res = (await recommendCodingTool.handler(
      { model: 'glm:4.6', tool: 'claude-code', currency: 'CNY', usageProfile: 'heavy' },
      {},
    )) as CallToolResult;

    expect(res.isError).not.toBe(true);
    // structuredContent 经组 B 输出 schema（与 outputSchema 形状一致）。
    expect(recommendationResultSchema.safeParse(res.structuredContent).success).toBe(true);
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('首选');
    expect(text).toContain('数据陈旧'); // stale 标暴露
    // 现 build：每次调用都构建（不缓存）。
    expect(mockedBuild).toHaveBeenCalledTimes(1);
    expect(mockedBuild).toHaveBeenCalledWith(db, expect.any(Date), 30); // 显式 thresholdDays 取自 mcpEnv
  });

  it('annotations.readOnlyHint 为 true（只读、不写库）', () => {
    expect(recommendCodingTool.annotations.readOnlyHint).toBe(true);
  });

  it('快照不可用（build 抛错）→ fail-closed isError CallToolResult（不编推荐）', async () => {
    mockedBuild.mockRejectedValue(new Error('parseEnv boom'));

    const res = (await recommendCodingTool.handler(
      { tool: 'claude-code' },
      {},
    )) as CallToolResult;

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined(); // 绝不返编造推荐
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('snapshot unavailable');
  });

  it('快照可用但 recommend 抛错（非法 model 无冒号）→ 标「推荐生成失败」而非 snapshot unavailable', async () => {
    // 直调 handler 绕过 SDK inputSchema 校验，让 recommend() 见到坏 model → 内部 query.parse 抛。
    // build mock 返合法快照 → 故错误必归因到推荐阶段、不可误标快照不可用。
    mockedBuild.mockResolvedValue(exitSnapshot);

    const res = (await recommendCodingTool.handler(
      { model: 'glm' }, // 无冒号、过不了 modelRadarQueryParamsSchema
      {},
    )) as CallToolResult;

    expect(res.isError).toBe(true);
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('推荐生成失败');
    expect(text).not.toContain('snapshot unavailable');
  });
});

describe('4.8 退出标准用例：重度用 Claude Code + GLM-4.6 最便宜可用', () => {
  it('首选 GLM Lite、monthlyCost=49、fitsWindow=unknown（口径未知如实标），话术含月成本/依据/撞窗', async () => {
    mockedBuild.mockResolvedValue(exitSnapshot);

    const res = (await recommendCodingTool.handler(
      { model: 'glm:4.6', tool: 'claude-code', usageProfile: 'heavy' },
      {},
    )) as CallToolResult;

    expect(res.isError).not.toBe(true);
    const result = recommendationResultSchema.parse(res.structuredContent);

    const primary = result.candidates.find((c) => c.verdict === 'primary');
    expect(primary?.name).toBe('GLM Coding Plan Lite'); // 同 model/tool 内最便宜可用
    expect(primary?.monthlyCost).toBe(49);
    expect(primary?.fitsWindow).toBe('unknown'); // 现数据 value:NULL → 口径未知、不假装 fits/exceeds

    // GLM Pro（¥149）为更贵 eligible → alternative（unknown 属 eligible）。
    const pro = result.candidates.find((c) => c.name === 'GLM Coding Plan Pro');
    expect(pro?.verdict).toBe('alternative');

    // 话术含月成本 / 依据(provenance) / 撞窗结论。
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('49');
    expect(text).toContain('https://open.bigmodel.cn/pricing'); // per-fact 可溯源依据
    expect(text).toContain('额度口径未知'); // 撞窗结论（⚠ 估算）
  });
});

describe('3.1 inputSchema 边界校验（SDK 自动校验、handler 前拦非法入参）', () => {
  // 直接验 inputSchema raw shape——SDK 据此自校验，故 family:version 冒号/非空在 handler 前即拦下。
  const schema = z.object(recommendCodingTool.inputSchema);

  it('model 须 family:version：拒绝无冒号/空串、接受 glm:4.6、允许省略（FIX 2a 边界）', () => {
    expect(schema.safeParse({ model: 'glm' }).success).toBe(false); // 无冒号 → SDK 拒（不再下沉误标 snapshot unavailable）
    expect(schema.safeParse({ model: '' }).success).toBe(false); // 空串 → 拒
    expect(schema.safeParse({ model: 'glm:4.6' }).success).toBe(true); // 合法
    expect(schema.safeParse({}).success).toBe(true); // 省略 → optional 短路、合法
  });

  it('tool/protocol 非空（.min(1)）：拒绝空串', () => {
    expect(schema.safeParse({ tool: '' }).success).toBe(false);
    expect(schema.safeParse({ protocol: '' }).success).toBe(false);
    expect(schema.safeParse({ tool: 'claude-code' }).success).toBe(true);
  });
});
