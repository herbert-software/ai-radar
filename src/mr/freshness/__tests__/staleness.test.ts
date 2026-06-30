/**
 * 陈旧度排程单测（task 7.6，design D9）——**注入 db 桩，无需真实 DB / 不触网**。
 *
 * 覆盖 spec「陈旧度排程覆盖所有事实表（含 NULL 与 junction）」核心路由逻辑：
 * - junction（mr_plan_models）/ limit 超期 → 经所属 plan 打 plan 级 flag（reason 注明）；
 * - source 超期 → source flag；
 * - 同 run 内多个陈旧 child 命中同 plan 去重（只打一次标）；
 * - 无陈旧行 → 不打标。
 *
 * 桩按表返回「已陈旧」夹具行（消费者的 `stale()` SQL 谓词由 DB 在真实跑时评估，桩侧直接给陈旧集 =
 * 复刻「该表 last_checked IS NULL OR < threshold 的行」，断言路由/去重/reason 而非 SQL 求值）。
 * NULL 语义与边界的真实 SQL 行为由同目录 staleness.integration.test.ts 在真实 DB 验。
 */
import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { runStaleness } = await import('../staleness.js');
const schema = await import('../../../db/schema.js');

interface FlagCall {
  targetType: string;
  targetId: string;
  reason: string | null;
}

/** 桩按表返回预陈旧行（消费者对每表发 `select(cols).from(table).where(stale)`）。 */
function makeStub(opts: {
  staleSources: Array<{ id: string }>;
  stalePlans: Array<{ id: string }>;
  staleLimits: Array<{ planId: string }>;
  staleClients: Array<{ planId: string }>;
  staleModels: Array<{ planId: string }>;
  stalePeriodPrices: Array<{ planId: string }>;
  flagCalls: FlagCall[];
  failTargetIds?: ReadonlySet<string>;
}) {
  return {
    select(_cols?: unknown) {
      return {
        from(table: unknown) {
          let rows: unknown[] = [];
          if (table === schema.mrSource) rows = opts.staleSources;
          else if (table === schema.mrPlans) rows = opts.stalePlans;
          else if (table === schema.mrPlanLimits) rows = opts.staleLimits;
          else if (table === schema.mrPlanClients) rows = opts.staleClients;
          else if (table === schema.mrPlanModels) rows = opts.staleModels;
          else if (table === schema.mrPlanPrices) rows = opts.stalePeriodPrices;
          else throw new Error('unexpected table in stub.select');
          return {
            innerJoin: () => ({
              where: async () => rows,
            }),
            where: async () => rows,
          };
        },
      };
    },
    insert(_table: unknown) {
      return {
        values(v: { targetType: string; targetId: string; reason: string | null }) {
          return {
            onConflictDoUpdate: async () => {
              if (opts.failTargetIds?.has(v.targetId)) {
                throw new Error('simulated flag write failure');
              }
              opts.flagCalls.push({
                targetType: v.targetType,
                targetId: v.targetId,
                reason: v.reason,
              });
            },
          };
        },
      };
    },
  };
}

const empty = {
  staleSources: [],
  stalePlans: [],
  staleLimits: [],
  staleClients: [],
  staleModels: [],
  stalePeriodPrices: [],
};

describe('runStaleness 路由 + 去重（注入桩）', () => {
  it('junction（model）超期 → 经所属 plan 打 plan 级 flag（reason 注明模型兼容陈旧）', async () => {
    const flagCalls: FlagCall[] = [];
    const result = await runStaleness(
      makeStub({ ...empty, staleModels: [{ planId: 'plan-1' }], flagCalls }) as never,
      { thresholdDays: 30 },
    );
    expect(result.planFlagged).toBe(1);
    expect(flagCalls).toHaveLength(1);
    expect(flagCalls[0]!.targetType).toBe('plan');
    expect(flagCalls[0]!.targetId).toBe('plan-1');
    expect(flagCalls[0]!.reason).toContain('模型兼容行陈旧');
  });

  it('limit 超期 → 经所属 plan 打标（reason 注明限额陈旧）', async () => {
    const flagCalls: FlagCall[] = [];
    await runStaleness(
      makeStub({ ...empty, staleLimits: [{ planId: 'plan-l' }], flagCalls }) as never,
      { thresholdDays: 30 },
    );
    expect(flagCalls).toHaveLength(1);
    expect(flagCalls[0]!.targetType).toBe('plan');
    expect(flagCalls[0]!.reason).toContain('限额行陈旧');
  });

  it('period price 超期 → 经所属 plan 打标（reason 注明周期价陈旧）', async () => {
    const flagCalls: FlagCall[] = [];
    await runStaleness(
      makeStub({ ...empty, stalePeriodPrices: [{ planId: 'plan-period' }], flagCalls }) as never,
      { thresholdDays: 30 },
    );
    expect(flagCalls).toHaveLength(1);
    expect(flagCalls[0]!.targetType).toBe('plan');
    expect(flagCalls[0]!.targetId).toBe('plan-period');
    expect(flagCalls[0]!.reason).toContain('周期价行陈旧');
  });

  it('source 超期 → source flag', async () => {
    const flagCalls: FlagCall[] = [];
    const result = await runStaleness(
      makeStub({ ...empty, staleSources: [{ id: 'src-1' }], flagCalls }) as never,
      { thresholdDays: 30 },
    );
    expect(result.sourceFlagged).toBe(1);
    expect(flagCalls).toHaveLength(1);
    expect(flagCalls[0]!.targetType).toBe('source');
    expect(flagCalls[0]!.targetId).toBe('src-1');
  });

  it('同 plan 经多个陈旧 child 命中 → 去重只打一次标', async () => {
    const flagCalls: FlagCall[] = [];
    const result = await runStaleness(
      makeStub({
        ...empty,
        stalePlans: [{ id: 'plan-x' }],
        staleLimits: [{ planId: 'plan-x' }],
        staleModels: [{ planId: 'plan-x' }],
        staleClients: [{ planId: 'plan-x' }],
        stalePeriodPrices: [{ planId: 'plan-x' }],
        flagCalls,
      }) as never,
      { thresholdDays: 30 },
    );
    expect(result.planFlagged).toBe(1);
    expect(flagCalls.filter((c) => c.targetId === 'plan-x')).toHaveLength(1);
    // 去重保留首次命中的 reason（plan 自身路径在前）。
    expect(flagCalls[0]!.reason).toContain('套餐价格信息陈旧');
  });

  it('无陈旧行 → 不打标', async () => {
    const flagCalls: FlagCall[] = [];
    const result = await runStaleness(
      makeStub({ ...empty, flagCalls }) as never,
      { thresholdDays: 30 },
    );
    expect(result.sourceFlagged).toBe(0);
    expect(result.planFlagged).toBe(0);
    expect(flagCalls).toHaveLength(0);
  });

  it('单 target 打标失败不 abort 全量扫描，返回 errors 反映隔离失败', async () => {
    const flagCalls: FlagCall[] = [];
    const result = await runStaleness(
      makeStub({
        ...empty,
        staleSources: [{ id: 'src-fail' }, { id: 'src-ok' }],
        stalePlans: [{ id: 'plan-ok' }],
        flagCalls,
        failTargetIds: new Set(['src-fail']),
      }) as never,
      { thresholdDays: 30, log: () => {} },
    );

    expect(result).toEqual({ sourceFlagged: 1, planFlagged: 1, errors: 1 });
    expect(flagCalls.map((c) => c.targetId).sort()).toEqual(['plan-ok', 'src-ok']);
  });
});
