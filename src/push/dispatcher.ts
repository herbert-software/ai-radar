/**
 * 推送 Dispatcher（telegram-push 9.2 / 9.3，design D6）。
 *
 * 输入：今日待发名单（事件/产品/告警/周报等，由各 selection 路径产出的 SelectedEvent 视图）。
 * 职责：算待发集合 → 事务内为无记录者 INSERT pending（ON CONFLICT DO NOTHING）→
 * 按 channel 渲染一条消息发送 → 单消息原子：成功整批 success / 失败整批 failed（留 error_message）。
 *
 * **(target_type, channel) 双向泛化（P2）**：状态机对所有 target_type ∈ {event,product,alert,weekly}
 * 与 channel ∈ {telegram,feishu} 一致，由调用方传入幂等四元组的 `targetType`/`channel`（默认
 * `event`/`telegram` 向后兼容 P1 调用）。后续产品/告警/周报推送只需以各自的 target_type+channel
 * 调用本 dispatch 核心，**不必再编辑本文件**；不同 target_type 的「候选谓词」差异在各自的
 * selection 查询里表达（候选窗口跨天排除，见 top-n），dispatch 只承载「待发集合同日 success 排除
 * + pending → 原子送达 → success/failed」状态机。
 *
 * 关键不变量（绝不可违背）：
 * - 幂等四元组：`target_type, target_id, channel, push_date`（targetType/channel 参数化，禁写死）；
 *   push_date 用 push-date.ts 的同一 Asia/Shanghai 时间源（getPushDate）。
 * - **待发集合** = 今日待发名单中该 (target_type, channel) 上 status ∈ {无记录, pending, failed}
 *   （**显式排除今日该 channel 的 success**，按 channel 限定不跨 channel 误排除）。
 *   failed 与崩溃残留的僵尸 pending 自动纳入重试；已 success 不重发。
 *   两层排除 success 分工：候选窗口「从未以该 channel success」管跨天不重推；待发集合
 *   「今日该 channel success」管同日不重发——叠加不矛盾，不可删其一。
 * - **单消息原子**：拼一条消息，成功整批置 success（写 pushed_at）/ 失败整批置 failed
 *   （留 error_message 供重试）。禁止把已 success 的事件重新拼入消息。
 * - INSERT pending 用 `ON CONFLICT DO NOTHING`（不覆盖既有 failed/pending/success 行）。
 * - 排序/名单由程序定（top-n），本模块不做任何 LLM 调用。
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { pushRecords } from '../db/schema.js';
import type { SelectedEvent } from '../selection/top-n.js';
import { getPushDate } from './push-date.js';
import { renderDigest } from './message.js';
import { CHANNEL, TARGET_TYPE, type Channel, type TargetType } from './targets.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测。 */
type DbLike = typeof defaultDb;

/** 默认幂等四元组维度（向后兼容 P1：事件日报走 telegram）。 */
const DEFAULT_TARGET_TYPE: TargetType = TARGET_TYPE.event;
const DEFAULT_CHANNEL: Channel = CHANNEL.telegram;

/**
 * 消息发送器抽象（依赖注入）——把 grammY 的真实发送解耦，单测/集成测注入 mock 断言状态机，
 * 不依赖真实 Telegram token/网络（真实发送冒烟留给 11.1）。
 * 实现失败时**必须抛错**（dispatcher 据此把整批置 failed）。
 */
export interface MessageSender {
  send(text: string, parseMode: 'MarkdownV2'): Promise<void>;
}

export interface DispatchOptions {
  /** 参考时刻，决定 push_date（默认当前时刻）。 */
  now?: Date;
  /** 消息发送器（必填：测试注入 mock，生产注入 grammY 包装）。 */
  sender: MessageSender;
  /**
   * 幂等四元组的 target_type（默认 `event`）。后续产品/告警/周报推送传各自的 target_type
   * 调用同一 dispatch 核心，无需改本文件。
   */
  targetType?: TargetType;
  /**
   * 幂等四元组的 channel（默认 `telegram`）。多通道分发时各通道传各自 channel——待发集合的
   * success 排除按 channel 限定，同事件不同通道各自独立幂等。
   */
  channel?: Channel;
}

/** 推送结果（供编排组/可观测）。 */
export interface DispatchResult {
  pushDate: string;
  /** 待发集合大小（今日 Top N 排除今日 success 后的条数）。 */
  pending: number;
  /** 本次实际发送的状态：'sent' 整批 success / 'failed' 整批 failed / 'skipped' 待发为空或无可发内容。 */
  outcome: 'sent' | 'failed' | 'skipped';
  /** 本次实际发出（拼进消息、未被截断）的事件 event_id 列表；被截断者不在此列、保持 pending。 */
  eventIds: string[];
}

/**
 * 计算待发集合：统一名单中该 (target_type, channel) 上 **从未** success 的条目
 * （status ∈ {无记录, pending, failed}；显式排除**任一 push_date** 在该 channel 已 success 的）。
 *
 * **统一日报模型（Model B）——选题与通道解耦、各通道可靠补发**：上游 channel-blind 选出**一份**
 * 统一名单（候选窗口「尚未投递给所有已配置通道」，见 selectTopN/selectAlertCandidates），同一份发给
 * 所有通道；本函数按 **per-channel 跨天**口径过滤——该 channel **从未** success 过的才进待发。如此：
 * - 某通道（如飞书）失败 → 其在该 channel 无 success → 跨天/跨次仍在待发 → **可靠补发**（不丢）；
 * - 已 success 的通道（如 telegram）→ 排除 → **绝不跨天重发**；
 * - 一旦所有通道都 success，selectTopN 候选层把该事件移出统一名单（不再重选）。
 *
 * 注意：跨天口径**蕴含**同日去重（同日 success 也是 success 之一）；failed/pending/无记录均纳入
 * （重试僵尸 pending 与上次失败）。`pushDate` 参数保留供日志/INSERT 用，**不再用于 success 过滤**。
 *
 * @param topN       统一待发名单（各 selection 路径产出，channel-blind）。
 * @param pushDate   今日 push_date（用于 INSERT pending 的四元组，非过滤条件）。
 * @param dbh        db 或事务句柄。
 * @param targetType 幂等四元组 target_type（默认 `event`）。
 * @param channel    幂等四元组 channel（默认 `telegram`）。
 */
export async function computePendingSet(
  topN: readonly SelectedEvent[],
  _pushDate: string,
  dbh: DbLike = defaultDb,
  targetType: TargetType = DEFAULT_TARGET_TYPE,
  channel: Channel = DEFAULT_CHANNEL,
): Promise<SelectedEvent[]> {
  if (topN.length === 0) return [];

  const eventIds = topN.map((e) => e.eventId);
  // 该 (target_type, channel) 上**任一 push_date** 已 success 的 target_id（跨天 per-channel 去重）。
  const successRows = await dbh
    .select({ targetId: pushRecords.targetId })
    .from(pushRecords)
    .where(
      and(
        eq(pushRecords.targetType, targetType),
        eq(pushRecords.channel, channel),
        eq(pushRecords.status, 'success'),
        inArray(pushRecords.targetId, eventIds),
      ),
    );

  const everSucceededOnChannel = new Set(successRows.map((r) => r.targetId));
  return topN.filter((e) => !everSucceededOnChannel.has(e.eventId));
}

/**
 * 执行一次推送：算待发集合 → 事务内插 pending（ON CONFLICT DO NOTHING）→ 发一条消息 →
 * 整批 success/failed。
 *
 * - 待发集合为空（今日已全部 success）→ 不发任何消息，outcome='skipped'。
 * - 发送成功 → 整批 status='success' + pushed_at；outcome='sent'。
 * - 发送失败 → 整批 status='failed' + error_message；outcome='failed'（下次重试纳入待发集合）。
 *
 * @param topN 今日待发名单。
 * @param options 含 now 与 sender（必填），及可选 targetType/channel（默认 event/telegram）。
 * @param dbh db 或事务句柄。
 */
export async function dispatchDigest(
  topN: readonly SelectedEvent[],
  options: DispatchOptions,
  dbh: DbLike = defaultDb,
): Promise<DispatchResult> {
  const pushDate = getPushDate(options.now);
  const targetType = options.targetType ?? DEFAULT_TARGET_TYPE;
  const channel = options.channel ?? DEFAULT_CHANNEL;

  const pending = await computePendingSet(topN, pushDate, dbh, targetType, channel);
  if (pending.length === 0) {
    return { pushDate, pending: 0, outcome: 'skipped', eventIds: [] };
  }

  // 1. 事务内为待发集合中「无记录者」插 pending（ON CONFLICT DO NOTHING 不覆盖既有行）。
  await dbh.transaction(async (tx) => {
    await tx
      .insert(pushRecords)
      .values(
        pending.map((e) => ({
          targetType,
          targetId: e.eventId,
          channel,
          pushDate,
          status: 'pending',
        })),
      )
      .onConflictDoNothing();
  });

  // 2. 按 channel 渲染一条消息发送（单消息原子，发送在事务外——避免长外部调用占着 DB 事务/锁）。
  //    只对 includedIds（实际拼进消息、未被截断丢弃的事件）改状态；被截断者保持 pending，
  //    下次运行因仍属待发集合而重新拼入消息（天然分批跨次发完），避免被误标 success 永久漏推。
  const rendered = renderDigest(pending, channel);
  const { includedIds } = rendered;

  if (includedIds.length === 0) {
    // 不变量：buildDigestMessage 对非空 pending 必至少含一条——单块已按 TITLE_MAX/HEADLINE_MAX
    // 与 MAX_URL_LENGTH 有界（见 message.ts），首块恒可装下。走到此处说明不变量被破坏。
    // **绝不**静默返回 'skipped'：那会被 run-daily-workflow 误映射为 'skipped-no-candidates' →
    // job 成功 → BullMQ 不重试 → 这批 pending 永久不发、唯一信号只剩一行日志（静默漏推）。
    // 改为抛错使整 job 可见失败（BullMQ 重试 + 错误冒泡），记录保持 pending 安全。
    throw new Error(
      `dispatchDigest: pending=${pending.length} 但渲染出 0 条可发事件（单块超限不变量被破坏），` +
        `不静默跳过，抛错使整 job 失败可见。pushDate=${pushDate} targetType=${targetType} channel=${channel}`,
    );
  }

  // 已知限制（可观测告警）：单条 Telegram 消息上限导致截断时，尾部事件（不在 includedIds）
  // 顺延到下次运行——保持 pending、不丢失，跨天因 never-success 仍在候选窗口。默认 TOP_N=8 ×
  // 短摘要远低于上限，正常不触发；若 Top N 摘要总长持续超限，尾部可能延迟多日（后续可加分批
  // 多消息 / 老化提权）。另：单条消息原子发送下，若前缀含一条导致整条发送失败的事件，该批会反复
  // 失败、尾部轮不到（MarkdownV2 已对保留字符完整转义，正常不触发）。此处仅打告警，不改状态机。
  if (includedIds.length < pending.length) {
    const deferred = pending.length - includedIds.length;
    console.error(
      `[push] 消息截断：待发 ${pending.length} 条，本次发出 ${includedIds.length} 条，${deferred} 条顺延下次推送。pushDate=${pushDate}`,
    );
  }

  try {
    // 当前仅 telegram 渲染分支落地（renderDigest 对 feishu 抛「未实现」，组5接入）；
    // telegram 经 MessageSender(text, MarkdownV2) 送达。
    await options.sender.send(rendered.text, rendered.parseMode);
  } catch (error) {
    // 3a. 失败 → 仅本次发出的那批（includedIds）置 failed + error_message；未包含者保持 pending。
    const message =
      error instanceof Error ? error.message : String(error);
    await dbh.transaction(async (tx) => {
      await tx
        .update(pushRecords)
        .set({
          status: 'failed',
          errorMessage: message.slice(0, 1000),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(pushRecords.targetType, targetType),
            eq(pushRecords.channel, channel),
            eq(pushRecords.pushDate, pushDate),
            inArray(pushRecords.targetId, includedIds),
          ),
        );
    });
    return { pushDate, pending: pending.length, outcome: 'failed', eventIds: includedIds };
  }

  // 3b. 成功 → 仅本次发出的那批（includedIds）置 success + pushed_at（清空残留 error_message）；
  //     未包含者保持 pending。
  const now = new Date();
  await dbh.transaction(async (tx) => {
    await tx
      .update(pushRecords)
      .set({
        status: 'success',
        pushedAt: now,
        errorMessage: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(pushRecords.targetType, targetType),
          eq(pushRecords.channel, channel),
          eq(pushRecords.pushDate, pushDate),
          inArray(pushRecords.targetId, includedIds),
        ),
      );
  });

  return { pushDate, pending: pending.length, outcome: 'sent', eventIds: includedIds };
}
