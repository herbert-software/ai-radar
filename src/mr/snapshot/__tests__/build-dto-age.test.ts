/**
 * per-fact age（5d-B / design D1）哈希稳定性纯单测（**无 DB**，task 1.3）。
 *
 * 经**真** `buildModelRadarSnapshot` + `computeSnapshotVersion`、注入内存 fake db（不触 Postgres）钉死：
 * ① 无 DB 写、注入 now 推进**即便跨 UTC 午夜** → 各 `lastCheckedDate` 不变、内容哈希/version 稳定
 *    （`lastCheckedDate=trunc_UTC(last_checked)` 完全 now 无关，防回归到 now-leaky 实现 / 每日过度失效）；
 * ② 某事实 `last_checked` 被**写**到新 UTC 日 → 其 `lastCheckedDate` 变 + 哈希变；
 * ③ 跨进程 TZ 一致性：近 UTC 午夜的 `last_checked`（在 Shanghai 属次日）按**固定 UTC** 截出其 UTC 日字符串
 *    （`toISOString()` 恒 UTC、与 `process.env.TZ` 无关 → 任何进程 TZ 同 date 同哈希）；附带翻转 `process.env.TZ`
 *    再构建断言 date/version 不变（toISOString 不受本地 TZ 影响，无论 Node 是否运行时拾取 TZ 改动均绿）；
 * ④ DTO 不含 raw 秒级 `last_checked`（provenance date 为日粒度 `YYYY-MM-DD`、无时分秒）、不含 plan 级聚合 date
 *    （仅 per-provenance / per-source 带 date）；关联源行 date 可 null。
 */
import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const schema = await import('../../../db/schema.js');
const { buildModelRadarSnapshot } = await import('../build.js');
const { computeSnapshotVersion } = await import('../cache.js');

/** 远超任何注入 now − last_checked 间隔的阈值 → stale 恒 false，隔离出 lastCheckedDate 对哈希的唯一影响。 */
const HUGE_THRESHOLD_DAYS = 36_500;

interface Rows {
  planLastChecked: Date;
  periodPriceLastChecked: Date;
  modelLastChecked: Date;
  clientLastChecked: Date;
  limitLastChecked: Date;
  sourceLastChecked: Date | null;
}

/** 构造覆盖 plan 价格事实 + period/model/client/limit 事实 + 关联源的最小一致行集。 */
function makeRows(o: Rows) {
  return new Map<unknown, unknown[]>([
    [schema.mrVendors, [{ id: 'v1', name: 'Vendor', normalizedName: 'vendor' }]],
    [
      schema.mrPlans,
      [
        {
          id: 'p1',
          vendorId: 'v1',
          name: 'Coding Plan Pro',
          category: 'coding_plan',
          availability: 'unknown',
          currentPrice: '20.00',
          currency: 'USD',
          sourceUrl: 'https://x/pricing',
          sourceConfidence: 'official_pricing',
          lastChecked: o.planLastChecked,
        },
      ],
    ],
    [schema.mrModels, [{ id: 'm1', vendorId: 'v1', family: 'glm', version: '5.2' }]],
    [
      schema.mrPlanModels,
      [
        {
          id: 'pm1',
          planId: 'p1',
          modelId: 'm1',
          sourceUrl: 'https://x/model',
          sourceConfidence: 'official_community',
          lastChecked: o.modelLastChecked,
        },
      ],
    ],
    [
      schema.mrPlanClients,
      [
        {
          id: 'pc1',
          planId: 'p1',
          clientType: 'tool',
          clientId: 'claude-code',
          sourceUrl: 'https://x/client',
          sourceConfidence: 'official_doc',
          lastChecked: o.clientLastChecked,
        },
      ],
    ],
    [
      schema.mrPlanLimits,
      [
        {
          id: 'pl1',
          planId: 'p1',
          limitType: 'monthly_tokens',
          value: '1000000',
          window: 'month',
          sourceUrl: 'https://x/limit',
          sourceConfidence: 'official_pricing',
          lastChecked: o.limitLastChecked,
        },
      ],
    ],
    [
      schema.mrPlanPrices,
      [
        {
          id: 'pp1',
          planId: 'p1',
          billingPeriod: 'annual',
          price: '120.00',
          currency: 'USD',
          sourceUrl: 'https://x/annual',
          sourceConfidence: 'official_pricing',
          lastChecked: o.periodPriceLastChecked,
        },
      ],
    ],
    [
      schema.mrSource,
      [
        {
          id: 's1',
          vendorId: 'v1',
          sourceUrl: 'https://x/src',
          fetchStrategy: 'http',
          lastChecked: o.sourceLastChecked,
        },
      ],
    ],
    [schema.mrPlanSources, [{ id: 'ps1', planId: 'p1', sourceId: 's1' }]],
    [schema.mrReviewFlag, []],
  ]);
}

/** 内存 fake db：复刻 builder 用到的 `transaction(cb)` + `select().from(table).orderBy()` 形状，不触 Postgres。 */
function fakeDb(tableRows: Map<unknown, unknown[]>) {
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        orderBy: async () => tableRows.get(table) ?? [],
      }),
    }),
  };
  return { transaction: async (cb: (t: typeof tx) => unknown) => cb(tx) } as never;
}

function build(rows: Rows, now: Date) {
  return buildModelRadarSnapshot(fakeDb(makeRows(rows)), now, HUGE_THRESHOLD_DAYS);
}

const baseRows = (): Rows => ({
  planLastChecked: new Date('2026-06-20T12:00:00Z'),
  periodPriceLastChecked: new Date('2026-06-20T12:00:00Z'),
  modelLastChecked: new Date('2026-06-20T12:00:00Z'),
  clientLastChecked: new Date('2026-06-20T12:00:00Z'),
  limitLastChecked: new Date('2026-06-20T12:00:00Z'),
  sourceLastChecked: new Date('2026-06-20T12:00:00Z'),
});

describe('1.3 per-fact lastCheckedDate 哈希稳定性（无 DB）', () => {
  it('① now 推进跨 UTC 午夜、无 DB 写 → lastCheckedDate 不变、version 稳定', async () => {
    const rows = baseRows();
    // 两个 now 跨 UTC 自然午夜（23:00Z → 次日 01:00Z），阈值巨大 → stale 两侧均 false。
    const before = await build(rows, new Date('2026-06-24T23:00:00Z'));
    const after = await build(rows, new Date('2026-06-25T01:00:00Z'));

    const p1 = before.plans[0]!;
    const p2 = after.plans[0]!;
    // 各 provenance date 完全由 last_checked（2026-06-20）派生，与 now 无关。
    expect(p1.provenance.lastCheckedDate).toBe('2026-06-20');
    expect(p2.provenance.lastCheckedDate).toBe('2026-06-20');
    expect(p1.periodPrices[0]!.provenance.lastCheckedDate).toBe('2026-06-20');
    expect(p1.models[0]!.provenance.lastCheckedDate).toBe('2026-06-20');
    expect(p1.sources[0]!.lastCheckedDate).toBe('2026-06-20');
    expect(p1.freshness.stale).toBe(false);
    // version 完全不因 now 跨午夜而漂移（防 now-leaky / 每日过度失效）。
    expect(computeSnapshotVersion(after)).toBe(computeSnapshotVersion(before));
  });

  it('② 价格事实 last_checked 写到新 UTC 日 → 其 lastCheckedDate 变 + version 变', async () => {
    const now = new Date('2026-06-25T01:00:00Z');
    const v0 = await build(baseRows(), now);
    const moved = { ...baseRows(), planLastChecked: new Date('2026-06-22T08:00:00Z') };
    const v1 = await build(moved, now);

    expect(v0.plans[0]!.provenance.lastCheckedDate).toBe('2026-06-20');
    expect(v1.plans[0]!.provenance.lastCheckedDate).toBe('2026-06-22'); // 价格事实 date = trunc(plan.last_checked)
    expect(computeSnapshotVersion(v1)).not.toBe(computeSnapshotVersion(v0));
  });

  it('③ 固定 UTC 截断 → 近午夜瞬间产出 UTC 日字符串（跨进程 TZ 同 date 同 version）', async () => {
    // 2026-06-24T20:00Z 在 Asia/Shanghai(UTC+8) 已是 2026-06-25 04:00；按本地 TZ 截会得 06-25，
    // 按固定 UTC 截得 06-24。toISOString() 恒 UTC、与 process.env.TZ 无关 → 任何进程同此结果。
    const nearMidnight = new Date('2026-06-24T20:00:00Z');
    const rows: Rows = {
      planLastChecked: nearMidnight,
      periodPriceLastChecked: nearMidnight,
      modelLastChecked: nearMidnight,
      clientLastChecked: nearMidnight,
      limitLastChecked: nearMidnight,
      sourceLastChecked: nearMidnight,
    };
    const now = new Date('2026-06-25T01:00:00Z');
    const utcBuilt = await build(rows, now);
    expect(utcBuilt.plans[0]!.provenance.lastCheckedDate).toBe('2026-06-24'); // UTC 日，非 Shanghai 的 06-25
    expect(utcBuilt.plans[0]!.periodPrices[0]!.provenance.lastCheckedDate).toBe('2026-06-24');
    const utcVersion = computeSnapshotVersion(utcBuilt);

    // 翻转 process.env.TZ 再构建：toISOString 不受本地 TZ 影响 → date/version 不变（无论 Node 是否运行时拾取 TZ）。
    const savedTz = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      const shBuilt = await build(rows, now);
      expect(shBuilt.plans[0]!.provenance.lastCheckedDate).toBe('2026-06-24');
      expect(shBuilt.plans[0]!.periodPrices[0]!.provenance.lastCheckedDate).toBe('2026-06-24');
      expect(computeSnapshotVersion(shBuilt)).toBe(utcVersion);
    } finally {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
  });

  it('④ DTO 仅含日粒度 lastCheckedDate：无 raw 秒级 last_checked、无 plan 级聚合 date；源行 date 可 null', async () => {
    const rows: Rows = { ...baseRows(), sourceLastChecked: null }; // 从未抓源 → date null
    const built = await build(rows, new Date('2026-06-25T01:00:00Z'));
    const plan = built.plans[0]!;

    // plan 顶层无 raw last_checked、无 plan 级聚合 date（date 仅在 per-provenance / per-source）。
    expect(plan).not.toHaveProperty('lastChecked');
    expect(plan).not.toHaveProperty('lastCheckedDate');
    // provenance date 为日粒度（YYYY-MM-DD，无时分秒）→ 不泄露 raw 秒级 last_checked。
    for (const date of [
      plan.provenance.lastCheckedDate,
      plan.periodPrices[0]!.provenance.lastCheckedDate,
      plan.models[0]!.provenance.lastCheckedDate,
      plan.clients[0]!.provenance.lastCheckedDate,
      plan.limits[0]!.provenance.lastCheckedDate,
    ]) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // 关联源 last_checked NULL → date 缺省 null（仅 source 行 date 可 null）。
    expect(plan.sources[0]!.lastCheckedDate).toBeNull();
    // 整个序列化表征里不出现 raw 秒级时间戳键名。
    expect(JSON.stringify(built)).not.toContain('lastChecked"');
  });
});
