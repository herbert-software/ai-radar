/**
 * 事件流触发复核消费者单测（task 7.4，design D8）——**注入 db 桩 + now，无需真实 DB / 不触网**。
 *
 * 覆盖 spec「ai-radar 事件流触发复核（独立队列、published_at、排 tombstone、不改事实）」：
 * - published_at **闭区间**：下界拦回填（backfill）+ **上界拦未来值** + **windowDays=0 被 env 校验拒**；
 * - 排 `merged_into IS NOT NULL` tombstone；
 * - **三列文本任一为 NULL 跳过该列、不抛**；
 * - 命中打标（setReviewFlag）但**不改事实**（桩不暴露任何 mr_* 事实写）；
 * - 冷启动不批量误标（窗口下界挡住历史回填）。
 *
 * 桩按消费者计算的 `lowerBound`/`now` 在 JS 侧复刻 `gte/lte/isNull(merged_into)` 候选门，
 * 使闭区间边界由消费者的 windowDays/now 真实驱动（而非测试预筛），断言才有意义。
 */
import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { runEventReview } = await import('../event-consumer.js');
const { startOfDayInTimeZone } = await import('../../../push/push-date.js');
const schema = await import('../../../db/schema.js');
const { parseEnv } = await import('../../../config/env.js');

/** 事件夹具（含候选门所需 published_at/merged_into，桩侧复刻 SQL 过滤）。 */
interface EventFixture {
  eventId: string;
  representativeTitle: string | null;
  summaryZh: string | null;
  headlineZh: string | null;
  publishedAt: Date | null;
  mergedInto: string | null;
}

interface VendorFixture {
  id: string;
  normalizedName: string;
}

/** 一次 setReviewFlag 调用的记录（断言打标，不改事实）。 */
interface FlagCall {
  targetType: string;
  targetId: string;
  reason: string | null;
}

/**
 * 最小 db 桩：支持 `select().from(table).where()` 三种读（events/vendors/plans）+
 * setReviewFlag 的 `insert().values().onConflictDoUpdate()` 写（仅记录，不落库）。
 *
 * @param now / lowerBound 由测试传入消费者同款值，桩据此复刻候选门 SQL（gte/lte/isNull）。
 */
function makeStub(opts: {
  events: EventFixture[];
  vendors: VendorFixture[];
  plansByVendor: Record<string, Array<{ id: string }>>;
  now: Date;
  lowerBound: Date;
  flagCalls: FlagCall[];
  failPlanId?: string;
}) {
  const candidateEvents = opts.events
    // 复刻候选门：gte(lowerBound) ∧ lte(now) ∧ isNull(merged_into)；NULL published_at 经 gte/lte 排除。
    .filter(
      (e) =>
        e.publishedAt !== null &&
        e.publishedAt.getTime() >= opts.lowerBound.getTime() &&
        e.publishedAt.getTime() <= opts.now.getTime() &&
        e.mergedInto === null,
    )
    .map((e) => ({
      eventId: e.eventId,
      representativeTitle: e.representativeTitle,
      summaryZh: e.summaryZh,
      headlineZh: e.headlineZh,
    }));

  // 桩无法解析消费者反查 plan 的 SQL 片段（`mrPlans.vendorId = vendor.id`）；本套件每事件至多命中
  // 单个被跟踪厂商（acme），故 select(mrPlans) 直接返回该厂商 plan 集（顺序由消费者「命中即查」保证）。
  const allPlans = Object.values(opts.plansByVendor).flat();

  const stub = {
    select(_cols?: unknown) {
      return {
        from(table: unknown) {
          if (table === schema.aiNewsEvents) {
            return { where: async () => candidateEvents };
          }
          if (table === schema.mrVendors) {
            // vendors 整表读（无 where 链）。
            return Promise.resolve(
              opts.vendors.map((v) => ({ id: v.id, normalizedName: v.normalizedName })),
            );
          }
          if (table === schema.mrPlans) {
            return { where: async () => allPlans };
          }
          throw new Error('unexpected table in stub.select');
        },
      };
    },
    insert(_table: unknown) {
      return {
        values(v: { targetType: string; targetId: string; reason: string | null }) {
          return {
            onConflictDoUpdate: async () => {
              if (opts.failPlanId && v.targetId === opts.failPlanId) {
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
  return stub;
}

const TZ = 'Asia/Shanghai';

describe('runEventReview 候选闭区间 + 排 tombstone + NULL 文本 + 打标不改事实', () => {
  // 固定 now：2026-06-24T12:00:00+08:00（=04:00:00Z）。windowDays=1 → lowerBound=当天 00:00（+08）。
  const now = new Date('2026-06-24T04:00:00.000Z');
  const windowDays = 1;
  const lowerBound = startOfDayInTimeZone(now, windowDays - 1, TZ);

  const vendors: VendorFixture[] = [{ id: 'vendor-acme', normalizedName: 'acme' }];

  /** 跑消费者（注入桩 + 固定 now/windowDays）；返回打标调用与结果。 */
  async function run(
    events: EventFixture[],
    plansByVendor: Record<string, Array<{ id: string }>>,
    failPlanId?: string,
  ): Promise<{ flagCalls: FlagCall[]; result: Awaited<ReturnType<typeof runEventReview>> }> {
    const flagCalls: FlagCall[] = [];
    const stub = makeStub({
      events,
      vendors,
      plansByVendor,
      now,
      lowerBound,
      flagCalls,
      ...(failPlanId ? { failPlanId } : {}),
    });

    const result = await runEventReview({
      now,
      windowDays,
      db: stub as never,
      log: () => {},
    });
    return { flagCalls, result };
  }

  it('命中当窗事件 → 给厂商 plan 打标（plan 级，reason 含 event/vendor），不改事实', async () => {
    const events: EventFixture[] = [
      {
        eventId: 'e-hit',
        representativeTitle: 'Acme raises pricing for its Pro plan',
        summaryZh: null,
        headlineZh: null,
        publishedAt: new Date('2026-06-24T03:00:00.000Z'), // 当窗内
        mergedInto: null,
      },
    ];
    const { flagCalls, result } = await run(events, {
      'vendor-acme': [{ id: 'plan-1' }, { id: 'plan-2' }],
    });
    expect(result.matchedEvents).toBe(1);
    expect(result.flaggedPlans).toBe(2);
    expect(flagCalls.map((c) => c.targetId).sort()).toEqual(['plan-1', 'plan-2']);
    expect(flagCalls.every((c) => c.targetType === 'plan')).toBe(true);
    expect(flagCalls[0]!.reason).toContain('e-hit');
    expect(flagCalls[0]!.reason).toContain('acme');
  });

  it('下界拦回填：published_at 在 lowerBound 之前的历史事件不打标（冷启动不批量误标）', async () => {
    const events: EventFixture[] = [
      {
        eventId: 'e-old',
        representativeTitle: 'Acme changed its pricing',
        summaryZh: null,
        headlineZh: null,
        publishedAt: new Date('2026-06-20T03:00:00.000Z'), // 早于当天下界
        mergedInto: null,
      },
    ];
    const { flagCalls, result } = await run(events, {
      'vendor-acme': [{ id: 'plan-1' }],
    });
    expect(result.scanned).toBe(0);
    expect(result.matchedEvents).toBe(0);
    expect(flagCalls).toHaveLength(0);
  });

  it('上界拦未来值：published_at 在 now 之后的事件不打标（拦 AI 推断的未来值）', async () => {
    const events: EventFixture[] = [
      {
        eventId: 'e-future',
        representativeTitle: 'Acme pricing update',
        summaryZh: null,
        headlineZh: null,
        publishedAt: new Date('2026-06-24T20:00:00.000Z'), // 晚于 now
        mergedInto: null,
      },
    ];
    const { flagCalls, result } = await run(events, {
      'vendor-acme': [{ id: 'plan-1' }],
    });
    expect(result.scanned).toBe(0);
    expect(flagCalls).toHaveLength(0);
  });

  it('排 tombstone：merged_into 非 NULL 的合并事件不打标', async () => {
    const events: EventFixture[] = [
      {
        eventId: 'e-tomb',
        representativeTitle: 'Acme pricing change',
        summaryZh: null,
        headlineZh: null,
        publishedAt: new Date('2026-06-24T03:00:00.000Z'),
        mergedInto: 'e-survivor', // tombstone
      },
    ];
    const { flagCalls, result } = await run(events, {
      'vendor-acme': [{ id: 'plan-1' }],
    });
    expect(result.scanned).toBe(0);
    expect(flagCalls).toHaveLength(0);
  });

  it('NULL published_at 自然排除（无日期事件不打标）', async () => {
    const events: EventFixture[] = [
      {
        eventId: 'e-nulldate',
        representativeTitle: 'Acme pricing change',
        summaryZh: null,
        headlineZh: null,
        publishedAt: null,
        mergedInto: null,
      },
    ];
    const { flagCalls, result } = await run(events, {
      'vendor-acme': [{ id: 'plan-1' }],
    });
    expect(result.scanned).toBe(0);
    expect(flagCalls).toHaveLength(0);
  });

  it('三列文本任一为 NULL 跳过该列、不抛；命中 summary_zh 仍打标', async () => {
    const events: EventFixture[] = [
      {
        eventId: 'e-nulltext',
        representativeTitle: null, // NULL 列跳过
        summaryZh: 'Acme 发布了新模型', // 命中：厂商 + 模型关键词
        headlineZh: null, // NULL 列跳过
        publishedAt: new Date('2026-06-24T03:00:00.000Z'),
        mergedInto: null,
      },
    ];
    const { flagCalls, result } = await run(events, {
      'vendor-acme': [{ id: 'plan-1' }],
    });
    expect(result.matchedEvents).toBe(1);
    expect(flagCalls).toHaveLength(1);
    expect(flagCalls[0]!.targetId).toBe('plan-1');
  });

  it('全 NULL 文本 → 不命中、不抛', async () => {
    const events: EventFixture[] = [
      {
        eventId: 'e-allnull',
        representativeTitle: null,
        summaryZh: null,
        headlineZh: null,
        publishedAt: new Date('2026-06-24T03:00:00.000Z'),
        mergedInto: null,
      },
    ];
    const { flagCalls, result } = await run(events, {
      'vendor-acme': [{ id: 'plan-1' }],
    });
    expect(result.matchedEvents).toBe(0);
    expect(flagCalls).toHaveLength(0);
  });

  it('命中厂商但无关键词 → 不打标（误召收敛）', async () => {
    const events: EventFixture[] = [
      {
        eventId: 'e-nokw',
        representativeTitle: 'Acme hires a new VP of marketing', // 含厂商但无价格/模型关键词
        summaryZh: null,
        headlineZh: null,
        publishedAt: new Date('2026-06-24T03:00:00.000Z'),
        mergedInto: null,
      },
    ];
    const { flagCalls } = await run(events, { 'vendor-acme': [{ id: 'plan-1' }] });
    expect(flagCalls).toHaveLength(0);
  });

  it('per-target 失败隔离：一个 plan 打标抛错不拖垮兄弟 plan', async () => {
    const events: EventFixture[] = [
      {
        eventId: 'e-hit',
        representativeTitle: 'Acme pricing change for all plans',
        summaryZh: null,
        headlineZh: null,
        publishedAt: new Date('2026-06-24T03:00:00.000Z'),
        mergedInto: null,
      },
    ];
    const { flagCalls, result } = await run(
      events,
      { 'vendor-acme': [{ id: 'plan-fail' }, { id: 'plan-ok' }] },
      'plan-fail',
    );
    // plan-fail 抛错被隔离，plan-ok 仍打标。
    expect(result.flaggedPlans).toBe(1);
    expect(flagCalls.map((c) => c.targetId)).toEqual(['plan-ok']);
  });
});

describe('windowDays=0 被 env 校验拒（positive()）', () => {
  it('parseEnv 对 MR_EVENT_REVIEW_WINDOW_DAYS=0 抛错', () => {
    expect(() =>
      parseEnv({
        ...process.env,
        MR_EVENT_REVIEW_WINDOW_DAYS: '0',
      }),
    ).toThrow();
  });
});
