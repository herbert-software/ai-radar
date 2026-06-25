/**
 * mr_review_flag 单行翻转写契约集成测试（task 2.2，**需本地 Postgres**）。
 *
 * 覆盖 spec「mr_review_flag 单行翻转写契约（无 setWhere）」/「人工 dispose 最小面闭环」(design D5/D6)：
 * ① 首次打标 = 新建 pending 行（reason/opened_at/resolved_at 正确）；
 * ② 翻标刷 reason、仍单行（无 setWhere，pending 时也刷 reason）；
 * ③ resolveFlag → status='resolved' + resolved_at 置位；
 * ④ resolved 后再 setReviewFlag = 翻回 pending、清 resolved_at、opened_at 重置为 now、仍单行；
 * ⑤ 写前 Zod 闸：非法 target_type 在发 SQL 前被拒（不落库）。
 *
 * 不触网/不触 LLM；缺 DATABASE_URL 时自动跳过。用唯一 target_id 前缀隔离，afterAll 清理。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, like } from 'drizzle-orm';
import * as schema from '../../../db/schema.js';

// 真实 DB 存在性以**注入占位前**的原值为准（占位仅为让 import 链的 env 校验通过，不代表有可连 DB）。
const databaseUrl = process.env.DATABASE_URL;

// 经 import 链触发 env 校验；注入占位（本套件不触网；无真实 DB 时下方 describeIfDb 跳过所有用例）。
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { setReviewFlag, resolveFlag } = await import('../flag.js');
const PREFIX = 'mr-flag-itest-';
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const db = pool ? drizzle(pool, { schema }) : null;

const describeIfDb = databaseUrl ? describe : describe.skip;

async function rows(targetId: string) {
  return db!
    .select()
    .from(schema.mrReviewFlag)
    .where(eq(schema.mrReviewFlag.targetId, targetId));
}

beforeAll(async () => {
  if (!db) return;
  await db
    .delete(schema.mrReviewFlag)
    .where(like(schema.mrReviewFlag.targetId, `${PREFIX}%`));
});

afterAll(async () => {
  if (!db) return;
  await db
    .delete(schema.mrReviewFlag)
    .where(like(schema.mrReviewFlag.targetId, `${PREFIX}%`));
  await pool!.end();
});

describeIfDb('setReviewFlag / resolveFlag 单行翻转', () => {
  it('首次打标新建 pending 行', async () => {
    const targetId = `${PREFIX}new`;
    await setReviewFlag(db!, { targetType: 'plan', targetId }, '价格疑变');

    const r = await rows(targetId);
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe('pending');
    expect(r[0]!.reason).toBe('价格疑变');
    expect(r[0]!.resolvedAt).toBeNull();
    expect(r[0]!.openedAt).not.toBeNull();
  });

  it('翻标刷 reason、仍单行（无 setWhere）', async () => {
    const targetId = `${PREFIX}refresh`;
    await setReviewFlag(db!, { targetType: 'source', targetId }, '原因甲');
    await setReviewFlag(db!, { targetType: 'source', targetId }, '原因乙');

    const r = await rows(targetId);
    expect(r).toHaveLength(1);
    expect(r[0]!.reason).toBe('原因乙');
    expect(r[0]!.status).toBe('pending');
  });

  it('resolveFlag → resolved + resolved_at 置位', async () => {
    const targetId = `${PREFIX}resolve`;
    await setReviewFlag(db!, { targetType: 'plan', targetId }, '触发');
    await resolveFlag(db!, { targetType: 'plan', targetId });

    const r = await rows(targetId);
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe('resolved');
    expect(r[0]!.resolvedAt).not.toBeNull();
  });

  it('resolved 后重开：翻回 pending、清 resolved_at、opened_at 重置、仍单行', async () => {
    const targetId = `${PREFIX}reopen`;
    await setReviewFlag(db!, { targetType: 'vendor', targetId }, '首次');
    await resolveFlag(db!, { targetType: 'vendor', targetId });
    const beforeReopen = (await rows(targetId))[0]!;

    // 重置 opened_at 到过去，便于断言重开后被刷新为 now。
    await db!
      .update(schema.mrReviewFlag)
      .set({ openedAt: new Date('2000-01-01T00:00:00Z') })
      .where(eq(schema.mrReviewFlag.targetId, targetId));

    await setReviewFlag(db!, { targetType: 'vendor', targetId }, '重开');

    const r = await rows(targetId);
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe('pending');
    expect(r[0]!.resolvedAt).toBeNull();
    expect(r[0]!.reason).toBe('重开');
    // opened_at 重置为 now（远晚于我们手动塞的 2000 年）。
    expect(r[0]!.openedAt!.getFullYear()).toBeGreaterThan(2000);
    // 仍是当初那条行（id 不变 = 单行可变标，非新建）。
    expect(r[0]!.id).toBe(beforeReopen.id);
  });

  it('并发多次打标收敛单行（CAS 幂等）', async () => {
    const targetId = `${PREFIX}concurrent`;
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        setReviewFlag(db!, { targetType: 'plan', targetId }, `r${i}`),
      ),
    );
    const r = await rows(targetId);
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe('pending');
  });

  it('非法 target_type 写前被 Zod 拒，不落库', async () => {
    const targetId = `${PREFIX}badtype`;
    await expect(
      setReviewFlag(db!, { targetType: 'junction', targetId }, 'x'),
    ).rejects.toThrow();
    await expect(
      resolveFlag(db!, { targetType: 'junction', targetId }),
    ).rejects.toThrow();

    const r = await db!
      .select()
      .from(schema.mrReviewFlag)
      .where(
        and(
          eq(schema.mrReviewFlag.targetId, targetId),
          eq(schema.mrReviewFlag.targetType, 'junction'),
        ),
      );
    expect(r).toHaveLength(0);
  });
});
