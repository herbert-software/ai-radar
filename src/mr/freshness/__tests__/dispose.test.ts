/**
 * 人工 dispose 面单测（task 7.3，design D6）——**注入 db 桩，无需真实 DB / 不触网**。
 *
 * 覆盖 spec「人工 dispose 最小面闭环」的路由/原子契约：
 * - `markChecked(plan)`：同事务内 resolveFlag + 刷 `mr_plans` **及全部 child 事实行**
 *   （limit/client/model/period price）last_checked → 断言五张表都被 UPDATE（闭合「junction 触发 plan flag → 只刷
 *   mr_plans → 复打标跑步机」）；
 * - `markChecked(source)`：只刷 `mr_source`，不碰 plan child；
 * - markChecked 全程在 `db.transaction` 内（resolve + 刷 last_checked 原子）；
 * - 非法 target_type 经 resolveFlag 内 Zod 闸先拒（不发任何 UPDATE）；
 * - `listPendingFlags` 链路（select→from→where→orderBy）成形。
 *
 * 真实 SQL（now() 时戳、并发收敛、重开 opened_at）由同目录 dispose.integration.test.ts 在真实 DB 验。
 */
import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { markChecked, listPendingFlags } = await import('../dispose.js');
const schema = await import('../../../db/schema.js');

/** 记录一次 update 命中的表。 */
interface TableHit {
  op: 'update';
  table: unknown;
}

/** tx 桩：记录 update/insert 命中的表，并执行 set/where/values/onConflict 链不报错。 */
function makeTxStub(hits: TableHit[], resolveAffectedRows: number) {
  return {
    update(table: unknown) {
      return {
        set(_v: unknown) {
          return {
            where(_cond: unknown) {
              hits.push({ op: 'update', table });
              return {
                returning: async () =>
                  table === schema.mrReviewFlag && resolveAffectedRows > 0
                    ? [{ id: 'flag-1' }]
                    : [],
              };
            },
          };
        },
      };
    },
  };
}

/** db 桩：transaction 把 tx 桩传给回调；裸 select 给 listPendingFlags。 */
function makeDbStub(
  hits: TableHit[],
  pendingRows: unknown[] = [],
  opts: { resolveAffectedRows?: number } = {},
) {
  return {
    async transaction<T>(cb: (tx: unknown) => Promise<T>): Promise<T> {
      return cb(makeTxStub(hits, opts.resolveAffectedRows ?? 1));
    },
    select(_cols?: unknown) {
      return {
        from(_table: unknown) {
          return {
            where(_cond: unknown) {
              return { orderBy: async () => pendingRows };
            },
          };
        },
      };
    },
  };
}

function tableNames(hits: TableHit[]): Set<unknown> {
  return new Set(hits.filter((h) => h.op === 'update').map((h) => h.table));
}

describe('markChecked 粒度刷新（注入桩）', () => {
  it('markChecked(plan)：刷 mr_plans + 全部 child 事实行（含 mr_plan_prices）', async () => {
    const hits: TableHit[] = [];
    const result = await markChecked(makeDbStub(hits) as never, {
      targetType: 'plan',
      targetId: 'plan-1',
    });

    expect(result).toEqual({ outcome: 'checked' });
    const tables = tableNames(hits);
    // resolveFlag UPDATE mr_review_flag + 刷 mr_plans/limits/clients/models/period prices 各 UPDATE。
    expect(tables.has(schema.mrReviewFlag)).toBe(true);
    expect(tables.has(schema.mrPlans)).toBe(true);
    expect(tables.has(schema.mrPlanLimits)).toBe(true);
    expect(tables.has(schema.mrPlanClients)).toBe(true);
    expect(tables.has(schema.mrPlanModels)).toBe(true);
    expect(tables.has(schema.mrPlanPrices)).toBe(true);
  });

  it('markChecked(source)：只刷 mr_source，不碰 plan child', async () => {
    const hits: TableHit[] = [];
    const result = await markChecked(makeDbStub(hits) as never, {
      targetType: 'source',
      targetId: 'src-1',
    });

    expect(result).toEqual({ outcome: 'checked' });
    const tables = tableNames(hits);
    expect(tables.has(schema.mrReviewFlag)).toBe(true);
    expect(tables.has(schema.mrSource)).toBe(true);
    expect(tables.has(schema.mrPlans)).toBe(false);
    expect(tables.has(schema.mrPlanModels)).toBe(false);
  });

  it('markChecked(vendor)：仅 resolve（vendor 无 last_checked 列）', async () => {
    const hits: TableHit[] = [];
    const result = await markChecked(makeDbStub(hits) as never, {
      targetType: 'vendor',
      targetId: 'v-1',
    });

    expect(result).toEqual({ outcome: 'checked' });
    const tables = tableNames(hits);
    expect(tables.has(schema.mrReviewFlag)).toBe(true);
    // vendor 身份表无 freshness 列 → 仅 mr_review_flag 被 UPDATE。
    expect(hits.filter((h) => h.op === 'update')).toHaveLength(1);
  });

  it('非法 target_type 经 Zod 闸先拒，不发任何写', async () => {
    const hits: TableHit[] = [];
    await expect(
      markChecked(makeDbStub(hits) as never, { targetType: 'junction', targetId: 'x' }),
    ).rejects.toThrow();
    expect(hits).toHaveLength(0);
  });

  it('resolveFlag 0 行（无 pending 或已被重开/resolve）：返回 not-resolved 且不刷 last_checked', async () => {
    const hits: TableHit[] = [];
    const result = await markChecked(
      makeDbStub(hits, [], { resolveAffectedRows: 0 }) as never,
      { targetType: 'plan', targetId: 'plan-not-resolved' },
    );

    expect(result).toEqual({ outcome: 'not-resolved' });
    // resolveFlag 的 UPDATE 命中 mr_review_flag（0 行），但不刷任何 last_checked 表。
    expect(tableNames(hits)).toEqual(new Set([schema.mrReviewFlag]));
  });
});

describe('listPendingFlags 链路成形（注入桩）', () => {
  it('返回桩给的 pending 行（select→from→where→orderBy）', async () => {
    const rows = [
      { targetType: 'plan', targetId: 'p-1', reason: 'r', openedAtText: '2026-06-25 00:00:00+00' },
    ];
    const out = await listPendingFlags(makeDbStub([], rows) as never, { targetType: 'plan' });
    expect(out).toEqual(rows);
  });

  it('olderThanMs 透传不报错（仅成形 where 谓词）', async () => {
    const out = await listPendingFlags(makeDbStub([], []) as never, {
      olderThanMs: 86_400_000,
    });
    expect(out).toEqual([]);
  });
});
