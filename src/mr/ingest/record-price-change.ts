/**
 * Model Radar（P5 / 5b，add-model-radar-ingestion-freshness）单一改价入口（task 2.1，design D4）。
 *
 * 职责：`mr_plans.current_price`/`currency` 的**唯一授权写入口** + `mr_price_history` append-only 追加。
 * 它是事实写（改 `mr_plans.current_price`），故归 `src/mr/ingest/`（**不可留在抓取链可达的 `src/mr/write/`**，
 * design D7：抓取链 eslint 禁 import 本模块）。`upsertPlan` 检测到价变时**委托**本入口，禁裸改 current_price。
 *
 * 两个 API（design D4）：
 * - **公开** `recordPriceChange(planId,newValue,currency,provenance)`：无外层事务时自身 `db.transaction`。
 * - **内部** `_recordPriceChangeTx(tx: TxLike, …)`：**只接已开事务句柄 `TxLike`**（非 `DbLike|TxLike`——
 *   多语句 + `FOR UPDATE` 须跨语句持锁；若注入顶层 DbLike，锁会在单语句结束即释放留 TOCTOU）。
 *   故 5c 复用必须传**已开**外层 tx（区别于 `claimRecord` 单语句可接 `DbLike|TxLike`）。
 *
 * 同一 tx 内流程（design D4 ①–⑥，逐步守住）：
 * ① `SELECT current_price/currency/source_* … WHERE id=planId FOR UPDATE`（锁行取 old_value；plan 不存在报错——
 *    建行是 upsertPlan 职责）。
 * ② 写前过 Zod（`mrPriceHistoryWriteSchema`：source_confidence + currency 枚举闸）。
 * ③ **无价变捷径**：`current_price` 非 NULL 且 `Number(newValue)===Number(current)` 且 currency 同 →
 *    仅刷 `mr_plans.source_url/source_confidence/last_checked`（provenance 再核），**不 append no-op 价行**，return。
 *    （`current IS NULL` = needs_login_recheck 占位无价，首个真价走真追加，不被 `Number(null)→0` 误判跳过。）
 * ④ 否则真价变：`changed_at = clock_timestamp()`（**拿到行锁后由 DB 生成、非 `now()`**——否则注入的长外层 tx
 *    可在他人已提交改价后插更早 changed_at 致 current 与 MAX(changed_at) 倒挂；且同外层 tx 二次调用共享
 *    `now()` 误入同刻冲突）。
 * ⑤ `INSERT mr_price_history(new_value, old_value=改前 current, currency, changed_at, provenance)
 *    ON CONFLICT(plan_id,changed_at) DO NOTHING RETURNING id`。
 *    - **RETURNING 非空**（真追加）→ `UPDATE mr_plans SET current_price/currency=新值,
 *      source_url/source_confidence=provenance, last_checked=now()`。
 *    - **RETURNING 空**（同刻冲突，clock_timestamp 下仅并发同微秒罕见）→ 读既有行**`(new_value,currency)`
 *      元组数值归一比对**（`Number()` 比额、currency 直比；**同额异币种=元组异**）：元组异=`price_history_conflict`
 *      + `setReviewFlag`（同事务复用已持 plan 锁）不动 current / 元组同=幂等仅刷 last_checked。二次读容 0 行不 NPE。
 *
 * `mr_price_history` **append-only**：本模块只 INSERT，**禁 UPDATE/DELETE 既有 history 行**（task 7.2 grep 守）。
 */
import { eq, sql, type SQL } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { mrPlans, mrPriceHistory } from '../../db/schema.js';
import { mrPriceHistoryWriteSchema } from './validators.js';
import { setReviewFlag } from '../write/flag.js';

/** db 句柄类型（drizzle 实例）。 */
type DbLike = typeof defaultDb;

/** 事务句柄类型（DbLike.transaction 回调入参）。多语句 + FOR UPDATE 须真事务，故内部 helper 只接此型。 */
type TxLike = Parameters<Parameters<DbLike['transaction']>[0]>[0];

/** 改价 provenance（断言事实表必带的来源三件套，currency 随价同行）。 */
export interface PriceProvenance {
  sourceUrl: string;
  /** 过 `mrSourceConfidenceSchema` 枚举闸。 */
  sourceConfidence: string;
}

/** 改价结果（供编排/可观测；事实写不抛断，状态以枚举返回）。 */
export type RecordPriceChangeOutcome =
  /** 真价变：追加 history 新行 + 同事务刷 current/provenance/last_checked。 */
  | { outcome: 'appended'; oldValue: string | null; newValue: string }
  /** 无价变捷径：current 与新值同（同币种）→ 仅刷 provenance/last_checked，不 append。 */
  | { outcome: 'noop-refreshed' }
  /** 同刻冲突且元组异（同 changed_at 异 (new_value,currency)）→ 打 flag、不动 current。 */
  | { outcome: 'history-conflict' }
  /** 同刻冲突但元组同 → 幂等仅刷 last_checked。 */
  | { outcome: 'noop-same-tuple' };

/** 改价请求字段（公开 + 内部共用）。 */
export interface PriceChangeInput {
  planId: string;
  /** 新价（数字或字符串字面，内部 `Number()` 归一比对，写 numeric(12,2) 列）。 */
  newValue: number | string;
  /** 过 `mrCurrencySchema` 枚举闸。 */
  currency: string;
  provenance: PriceProvenance;
}

/**
 * 内部改价 helper —— **只接已开事务句柄 `TxLike`**（design D4）。
 * 调用方须已 `db.transaction(tx => _recordPriceChangeTx(tx, …))`，使 `FOR UPDATE` 跨语句持锁到提交。
 */
export async function _recordPriceChangeTx(
  tx: TxLike,
  input: PriceChangeInput,
  /**
   * `changed_at` 生成式（默认 `clock_timestamp()` = 生产值，design D4④）。
   * **仅测试**钉死固定时戳以受控复现同刻冲突分支（同 changed_at 触发 ON CONFLICT）；生产永不传。
   */
  nowSql: SQL = sql`clock_timestamp()`,
): Promise<RecordPriceChangeOutcome> {
  // ② 写前过 Zod 枚举闸（currency + source_confidence 是有限值列，发 SQL 前拒非法）。
  const { currency, sourceConfidence } = mrPriceHistoryWriteSchema.parse({
    currency: input.currency,
    sourceConfidence: input.provenance.sourceConfidence,
  });

  // ① 锁行取 old_value（plan 不存在报错——建行是 upsertPlan 职责）。
  const locked = await tx
    .select({
      currentPrice: mrPlans.currentPrice,
      currency: mrPlans.currency,
    })
    .from(mrPlans)
    .where(eq(mrPlans.id, input.planId))
    .for('update');
  const plan = locked[0];
  if (!plan) {
    throw new Error(
      `recordPriceChange: plan 不存在（id=${input.planId}）；建行是 upsertPlan 职责`,
    );
  }

  const current = plan.currentPrice; // numeric 列回读为 string | null
  const newValueStr = String(input.newValue);

  // ③ 无价变捷径：current 非 NULL 且数值相等且币种同 → 仅刷 provenance/last_checked，不 append no-op 价行。
  //    current IS NULL（needs_login_recheck 占位）则首个真价走真追加，不被 Number(null)→0 误判。
  if (
    current != null &&
    Number(newValueStr) === Number(current) &&
    currency === plan.currency
  ) {
    await tx
      .update(mrPlans)
      .set({
        sourceUrl: input.provenance.sourceUrl,
        sourceConfidence,
        lastChecked: sql`now()`,
      })
      .where(eq(mrPlans.id, input.planId));
    return { outcome: 'noop-refreshed' };
  }

  // ④ 真价变：changed_at 锁后由 DB 生成（clock_timestamp，非 now()/transaction_timestamp）。
  // ⑤ append-only INSERT ON CONFLICT(plan_id, changed_at) DO NOTHING RETURNING。
  const appended = await tx
    .insert(mrPriceHistory)
    .values({
      planId: input.planId,
      oldValue: current,
      newValue: newValueStr,
      currency,
      changedAt: nowSql,
      sourceUrl: input.provenance.sourceUrl,
      sourceConfidence,
    })
    .onConflictDoNothing({
      target: [mrPriceHistory.planId, mrPriceHistory.changedAt],
    })
    .returning({ id: mrPriceHistory.id });

  if (appended.length > 0) {
    // 真追加 → 同事务刷 current/currency + provenance + last_checked（否则改完价 plan 仍描述旧断言且显陈旧）。
    await tx
      .update(mrPlans)
      .set({
        currentPrice: newValueStr,
        currency,
        sourceUrl: input.provenance.sourceUrl,
        sourceConfidence,
        lastChecked: sql`now()`,
      })
      .where(eq(mrPlans.id, input.planId));
    return { outcome: 'appended', oldValue: current, newValue: newValueStr };
  }

  // ⑥ RETURNING 空（同刻冲突，clock_timestamp 下仅并发同微秒罕见）：读既有行元组数值归一比对。
  //    二次读容 0 行不 NPE（仅自开 tx 单写者竞态可能 0 行；injected-tx 已持锁自写可见）。
  const existingRows = await tx
    .select({
      newValue: mrPriceHistory.newValue,
      currency: mrPriceHistory.currency,
    })
    .from(mrPriceHistory)
    .where(eq(mrPriceHistory.planId, input.planId))
    .orderBy(sql`${mrPriceHistory.changedAt} desc`)
    .limit(1);
  const existing = existingRows[0];
  if (!existing) {
    // 二次读 0 行（竞态）：保守视幂等仅刷 last_checked，绝不 NPE / 不动 current。
    await tx
      .update(mrPlans)
      .set({ lastChecked: sql`now()` })
      .where(eq(mrPlans.id, input.planId));
    return { outcome: 'noop-same-tuple' };
  }

  // (new_value, currency) 元组数值归一比对：Number() 比额、currency 直比（同额异币种=元组异）。
  const tupleSame =
    Number(existing.newValue) === Number(newValueStr) &&
    existing.currency === currency;
  if (tupleSame) {
    await tx
      .update(mrPlans)
      .set({ lastChecked: sql`now()` })
      .where(eq(mrPlans.id, input.planId));
    return { outcome: 'noop-same-tuple' };
  }

  // 元组异：同刻不同价，打 price_history_conflict flag、**不动 current**（同事务复用已持 plan 锁）。
  await setReviewFlag(
    tx,
    { targetType: 'plan', targetId: input.planId },
    `price_history_conflict: 同刻冲突，既有 ${existing.newValue}/${existing.currency} 异于 ${newValueStr}/${currency}`,
  );
  return { outcome: 'history-conflict' };
}

/**
 * 公开改价入口（design D4）。无外层事务时自身 `db.transaction` 包裹 `_recordPriceChangeTx`，
 * 使整条改价（锁行 → append → 刷 current）原子。5c 须改用 `_recordPriceChangeTx(传入已开外层 tx)`。
 *
 * @param dbh db 句柄（默认全局 db，须支持 transaction）。
 */
export async function recordPriceChange(
  input: PriceChangeInput,
  dbh: DbLike = defaultDb,
): Promise<RecordPriceChangeOutcome> {
  return dbh.transaction((tx) => _recordPriceChangeTx(tx, input));
}
