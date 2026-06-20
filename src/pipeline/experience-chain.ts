/**
 * 经验链编排（组 D，capability: blogger-experience-mining，design D4/D5/D6）。
 *
 * 与新闻/产品链并行的「实践经验」提炼链。本文件是 **placement-agnostic 的纯可调用单元**——
 * 只造函数、不接线 `runDailyWorkflow`（接线是组 E 的 5.2）。导出三个零件：
 *   ① runExperienceMiningOnce —— channel-blind 选条（4.2）+ 调 mineExperience + 写 ai_experiences（4.3），每批只跑一次
 *   ② runExperienceKbIngestion —— channel-blind：≥KB_ADMISSION_FLOOR 卡片沉淀 KB（4.4），不走 runKbIngestion、必在早退之前
 *   ③ selectExperiencesForChannel —— per-channel 推送候选（供组 E 5.2 接线）
 *
 * 关键不变量（绝不可违背，spec blogger-experience-mining / design D4/D5/D6）：
 *
 * - **选条（4.2）**：`source='blogger'` AND `raw_type='experience'` AND `canonical_url IS NOT NULL`
 *   AND 按 `canonical_source_url` 反连接 `ai_experiences` 尚无对应卡片，且 `DISTINCT ON (canonical_url)`
 *   `ORDER BY canonical_url, id` 批内去重（跨 feed 同 URL 一轮只提炼一次）。`canonical_url` 为空者
 *   跳过 + 记日志、终态永久 collapsed sink（**禁加重扫**）。
 *
 * - **幂等三层（4.3，崩溃/重入安全）**：① 反连接预去重（省 LLM，非正确性）；② `ON CONFLICT
 *   (canonical_source_url)` DB 兜底（正确性——同 URL 只落一行）；③ blogger 入库即 collapsed=true、
 *   经验链**不靠 collapsed 翻转**记处理状态（处理状态 = 是否有该 URL 卡片）。故「选 → 调 LLM →
 *   INSERT」**无需事务包 LLM**：崩溃重选 + ON CONFLICT 收敛，至多白烧一次 LLM、不产生重复卡片。
 *
 * - **KB 沉淀（4.4）**：**绝不走 runKbIngestion**（它硬编码每条调 generateKbMetadata）。候选 =
 *   `ai_experiences.long_term_value >= KB_ADMISSION_FLOOR` AND `target_type='experience'`、**不要求
 *   已推送**。复用 storeKbDocument 原语 + kb_ingestion_records 幂等、跳过 KB 摘要 Agent 重算、失败隔离
 *   永不向上抛。`KB_ADMISSION_FLOOR` import 自 kb/index（单一来源，禁写字面量 70）。
 *
 * - **推送候选（selectExperiencesForChannel）**：`long_term_value >= KB_ADMISSION_FLOOR`、`published_at`
 *   在 recency 窗口内、且「该卡片从未以该 channel success」（NOT EXISTS anti-join）。`published_at`
 *   为 NULL 经 gte/lte 求假被自然排除（NULL 即排除，对齐 top-n.ts），刻意接受 date-less 卡片 KB-only。
 *   排序 `long_term_value DESC, published_at DESC NULLS LAST, id`，取 Top N。
 */
import { and, eq, gte, isNotNull, lte, notExists, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import {
  aiExperiences,
  kbIngestionRecords,
  pushRecords,
  rawItems,
} from '../db/schema.js';
import { env } from '../config/env.js';
import { getPushDate, startOfDayInTimeZone } from '../push/push-date.js';
import { TARGET_TYPE, type Channel } from '../push/targets.js';
import {
  storeKbDocument,
  KB_PROVIDER_CUSTOM,
  type KbStoreOptions,
} from '../kb/store.js';
import { KB_ADMISSION_FLOOR } from '../kb/index.js';
import {
  mineExperience,
  ExperienceMiningFailureError,
  type MineExperienceOptions,
  type ExperienceCard,
} from '../agents/experience-mining/index.js';
import type { SelectedEvent } from '../selection/top-n.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测。 */
type DbLike = typeof defaultDb;

/** 错误/信息日志 sink 类型（非静默，便于测试断言）。 */
type LogError = (message: string, detail: unknown) => void;

// ──────────────────────────────────────────────────────────────────────────
// ① 经验提炼一次（channel-blind，4.2 选条 + 4.3 写库）
// ──────────────────────────────────────────────────────────────────────────

/**
 * mineExperience 的最小依赖契约（注入此函数使测试可 mock，不真调 LLM）。
 * 默认用真实 mineExperience；测试注入返回固定卡片的桩或抛 ExperienceMiningFailureError。
 */
export type MineExperienceFn = (
  input: { title: string; content?: string | null; source?: string | null },
  options?: MineExperienceOptions,
) => Promise<ExperienceCard>;

export interface RunExperienceMiningOptions {
  /** 注入的 mineExperience 实现（默认真实 Agent）；测试用桩固定卡片、不真调 LLM。 */
  mineExperienceFn?: MineExperienceFn;
  /** 透传给 mineExperience 的选项（注入 generateObjectFn / maxAttempts 等）。 */
  mineOptions?: MineExperienceOptions;
  /** 错误/信息日志 sink，默认 console.error。 */
  logError?: LogError;
}

/** 一轮经验提炼的统计结果（供编排/可观测；自有形状，不复用 event 版 KbIngestionResult）。 */
export interface ExperienceMiningResult {
  /** 经选条（含 DISTINCT ON 批内去重）命中、本轮待提炼的候选数。 */
  candidates: number;
  /** 提炼 + 写库成功的卡片数（含 ON CONFLICT 收敛命中既有行）。 */
  mined: number;
  /** 提炼降级（ExperienceMiningFailureError）被跳过、不写库的条数。 */
  miningFailed: number;
  /** 其它（写库/系统级）失败被隔离的条数。 */
  storeFailed: number;
}

/** 选条命中的经验候选最小视图（一条代表 raw_item，已批内去重到唯一 canonical_url）。 */
interface ExperienceCandidate {
  rawItemId: bigint;
  canonicalUrl: string;
  title: string;
  content: string | null;
  source: string;
  publishedAt: Date | null;
}

/**
 * 选本轮待提炼的经验候选（4.2 选条，纯程序 + DB，不调 LLM）。
 *
 * `source='blogger'` AND `raw_type='experience'` AND `canonical_url IS NOT NULL`（两硬字段 + 非空 URL
 * 都进谓词）AND 按 `canonical_source_url` 反连接 `ai_experiences` 尚无对应卡片（NOT EXISTS）。
 * `DISTINCT ON (canonical_url) ORDER BY canonical_url, id` 做**批内**去重：跨 feed 同 URL 一轮只取一条
 * 代表（id 最小者，确定性）→ 只提炼一次。`canonical_url` 为空者由 `IS NOT NULL` 预过滤排除（终态永久
 * collapsed sink，禁加重扫）。
 */
async function selectExperienceCandidates(
  dbh: DbLike,
): Promise<ExperienceCandidate[]> {
  // 反连接：该 canonical_url 在 ai_experiences 中尚无对应卡片（挡跨天 DB 已有的重复）。
  const noExistingCard = notExists(
    dbh
      .select({ one: sql`1` })
      .from(aiExperiences)
      .where(eq(aiExperiences.canonicalSourceUrl, rawItems.canonicalUrl)),
  );

  // DISTINCT ON (canonical_url) ORDER BY canonical_url, id：批内去重取确定性代表（id 最小）。
  const rows = await dbh
    .selectDistinctOn([rawItems.canonicalUrl], {
      rawItemId: rawItems.id,
      canonicalUrl: rawItems.canonicalUrl,
      title: rawItems.title,
      content: rawItems.content,
      source: rawItems.source,
      publishedAt: rawItems.publishedAt,
    })
    .from(rawItems)
    .where(
      and(
        eq(rawItems.source, 'blogger'),
        eq(rawItems.rawType, 'experience'),
        isNotNull(rawItems.canonicalUrl),
        noExistingCard,
      ),
    )
    .orderBy(rawItems.canonicalUrl, rawItems.id);

  // canonicalUrl 经 IS NOT NULL 预过滤后必非空；窄化为 string。
  return rows.map((r) => ({
    rawItemId: r.rawItemId,
    canonicalUrl: r.canonicalUrl!,
    title: r.title,
    content: r.content,
    source: r.source,
    publishedAt: r.publishedAt,
  }));
}

/**
 * 提炼一次（channel-blind，每批只跑一次，design D6 步骤①；在 per-channel 候选之前）。
 *
 * 对每条候选：mineExperience（外部 LLM，自带重试；降级抛 ExperienceMiningFailureError → 跳过该条
 * 不写库、记日志、继续）→ `INSERT ai_experiences ON CONFLICT (canonical_source_url) DO NOTHING`
 * 兜底收敛（幂等三层之②；同 URL 只落一行）。published_at 取自 raw_items。**提炼与写库不必同事务**
 * （幂等三层：反连接预去重 → ON CONFLICT 兜底 → collapsed 已 true 不靠翻转；崩溃重选安全、至多白烧
 * 一次 LLM）。整步失败隔离：单条任何失败只跳过该条、**永不向上抛**（不拖垮日报）。
 *
 * `canonical_url` 为空的经验条目已被选条 `IS NOT NULL` 排除（终态永久 collapsed sink），此处记一条
 * 信息日志统计被跳过数（**不重扫、不烧 LLM**）。
 *
 * **前置约束**：依赖调用方持 `daily-digest:{push_date}` 单例锁 + channel-blind 单跑使稳态无并发
 * （design D4）；任何新调用方须持同一锁或等价单例保证。
 *
 * @param options 注入 mineExperienceFn（默认真实 Agent）/ mineOptions / logError。
 * @param dbh     可注入 db 或事务句柄（默认全局 db）。
 */
export async function runExperienceMiningOnce(
  options: RunExperienceMiningOptions = {},
  dbh: DbLike = defaultDb,
): Promise<ExperienceMiningResult> {
  const mine = options.mineExperienceFn ?? mineExperience;
  const logError =
    options.logError ??
    ((message, detail) => console.error(`[experience-chain] ${message}`, detail));

  // 统计 canonical_url 为空被选条排除的经验条目数（信息日志，禁加重扫）。
  await logSkippedNullUrlExperiences(dbh, logError);

  let candidates: ExperienceCandidate[];
  try {
    candidates = await selectExperienceCandidates(dbh);
  } catch (e) {
    // 选条系统级故障（DB 断连等）：永不向上抛（保护日报），返回零候选结果。
    logError('经验候选选条失败，整步降级（不拖垮日报）', e);
    return { candidates: 0, mined: 0, miningFailed: 0, storeFailed: 0 };
  }

  const result: ExperienceMiningResult = {
    candidates: candidates.length,
    mined: 0,
    miningFailed: 0,
    storeFailed: 0,
  };

  for (const c of candidates) {
    let card: ExperienceCard;
    try {
      card = await mine(
        { title: c.title, content: c.content, source: c.source },
        options.mineOptions,
      );
    } catch (e) {
      if (e instanceof ExperienceMiningFailureError) {
        result.miningFailed += 1;
        logError(
          `经验提炼降级（不写 ai_experiences，继续下一条）：${c.canonicalUrl}`,
          e,
        );
      } else {
        // 非降级信号的系统级异常：同样隔离、不向上抛（保护日报）。
        result.miningFailed += 1;
        logError(
          `经验提炼系统级失败（不写 ai_experiences，继续下一条）：${c.canonicalUrl}`,
          e,
        );
      }
      continue;
    }

    // 写库（4.3）：ON CONFLICT (canonical_source_url) DO NOTHING 兜底收敛（同 URL 只落一行）。
    // tools jsonb 存数组；published_at 取自 raw_items；卡片字段来自 mineExperience 输出。
    try {
      await dbh
        .insert(aiExperiences)
        .values({
          // id 省略 → DB 默认 gen_random_uuid()::text 生成（与 event_id/product_id 同口径）。
          canonicalSourceUrl: c.canonicalUrl,
          representativeRawItemId: c.rawItemId,
          scenario: card.scenario,
          tools: card.tools,
          techniques: card.techniques,
          applicability: card.applicability,
          longTermValue: card.long_term_value,
          headlineZh: card.headline_zh,
          summaryZh: card.summary_zh,
          publishedAt: c.publishedAt,
        })
        .onConflictDoNothing({ target: aiExperiences.canonicalSourceUrl });
      result.mined += 1;
    } catch (e) {
      result.storeFailed += 1;
      logError(
        `写 ai_experiences 失败（已隔离，继续下一条）：${c.canonicalUrl}`,
        e,
      );
    }
  }

  return result;
}

/**
 * 统计 `canonical_url` 为空的经验条目数并记一条信息日志（终态永久 collapsed sink，禁加重扫）。
 *
 * 这类行没有去重键：已由选条 `canonical_url IS NOT NULL` 排除，入库即 collapsed=true 永久沉淀
 * （占一行、不重扫、不烧 LLM，对称新闻 unprocessable）。此处仅记一条可观测日志，**绝不**对其加任何
 * 重扫/重提炼逻辑（否则重新引入本可无界重选的 bug，spec 明文禁止）。
 */
async function logSkippedNullUrlExperiences(
  dbh: DbLike,
  logError: LogError,
): Promise<void> {
  try {
    const rows = await dbh
      .select({ count: sql<number>`count(*)::int` })
      .from(rawItems)
      .where(
        and(
          eq(rawItems.source, 'blogger'),
          eq(rawItems.rawType, 'experience'),
          sql`${rawItems.canonicalUrl} IS NULL`,
        ),
      );
    const n = rows[0]?.count ?? 0;
    if (n > 0) {
      logError(
        `${n} 条 canonical_url 为空的经验条目被选条排除（永久 collapsed sink，不重扫、不烧 LLM）`,
        { count: n },
      );
    }
  } catch {
    // 这条仅为可观测统计，失败不影响提炼主流程（静默忽略）。
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ② 经验 KB 沉淀一次（channel-blind，4.4；不走 runKbIngestion、必在早退之前）
// ──────────────────────────────────────────────────────────────────────────

export interface RunExperienceKbIngestionOptions {
  /** 参考时刻，决定 eventDate NULL 回退的当日 pushDate（默认当前时刻，与 dispatcher 同源）。 */
  now?: Date;
  /** kb_provider，默认 'custom'（本地表）。 */
  kbProvider?: string;
  /** 透传给 storeKbDocument 的选项（logError 等；kbProvider 由本编排统一注入）。 */
  store?: Omit<KbStoreOptions, 'kbProvider'>;
  /** 错误/信息日志 sink，默认 console.error。 */
  logError?: LogError;
}

/** 一轮经验 KB 入库统计（自有形状；不含 event 版 agentOk/agentFailed——经验链不调 KB Agent）。 */
export interface ExperienceKbIngestionResult {
  /** ≥KB_ADMISSION_FLOOR 的经验候选数（不要求已推送）。 */
  candidates: number;
  /** 实际新增 kb_documents 的条数。 */
  ingested: number;
  /** 认领未抢到（已 success）被跳过的条数。 */
  skippedClaimed: number;
  /** 认领成功但写入失败（已回滚、置 failed 待重试）的条数。 */
  storeFailed: number;
}

/** 经验 KB 候选最小视图（卡片字段直接组 KbStoreItem，不再调 KB 摘要 Agent）。 */
interface ExperienceKbCandidate {
  id: string;
  canonicalSourceUrl: string;
  scenario: string | null;
  tools: unknown;
  longTermValue: number;
  headlineZh: string | null;
  summaryZh: string | null;
  publishedAt: Date | null;
}

/**
 * 经验 KB 沉淀一次（channel-blind，design D6 步骤②；**与提炼同侧、必在早退判断之前**）。
 *
 * **绝不走 runKbIngestion**（它循环硬编码每条调 generateKbMetadata + embedding；对经验卡片既违反
 * 「跳过重算」又因输入形状不符降级）。候选 = `ai_experiences.long_term_value >= KB_ADMISSION_FLOOR`
 * AND `target_type='experience'`、**不要求已推送**（经验入 KB 不以已推送为前提；push-empty 与 KB-empty
 * 是不同集合——某天 ≥70 卡片昨天已推、push 候选空但今天有新 ≥70 卡片仍须入 KB）。
 *
 * 直接以卡片字段组**完整 10 字段 KbStoreItem** → storeKbDocument（kbProvider='custom' 经 options
 * 传入）+ kb_ingestion_records 幂等。**跳过 KB 摘要 Agent 重算**。失败隔离、**永不向上抛**。
 *
 * **前置约束**：依赖调用方持 `daily-digest:{push_date}` 单例锁、channel-blind 单跑（design D6）；
 * 且必须在 runDailyWorkflow 无候选早退**之前**调用（防 KB stranding，接线由组 E 5.2 负责）。
 *
 * @param options 注入 now（决定 eventDate NULL 回退当日）/ store / logError / kbProvider。
 * @param dbh     db 句柄（默认全局 db）。storeKbDocument 内部自起事务，dbh 应为顶层 db 实例。
 */
export async function runExperienceKbIngestion(
  options: RunExperienceKbIngestionOptions = {},
  dbh: DbLike = defaultDb,
): Promise<ExperienceKbIngestionResult> {
  const pushDate = getPushDate(options.now);
  const kbProvider = options.kbProvider ?? KB_PROVIDER_CUSTOM;
  const logError =
    options.logError ??
    ((message, detail) =>
      console.error(`[experience-kb-ingestion] ${message}`, detail));

  let candidates: ExperienceKbCandidate[];
  try {
    candidates = await dbh
      .select({
        id: aiExperiences.id,
        canonicalSourceUrl: aiExperiences.canonicalSourceUrl,
        scenario: aiExperiences.scenario,
        tools: aiExperiences.tools,
        longTermValue: aiExperiences.longTermValue,
        headlineZh: aiExperiences.headlineZh,
        summaryZh: aiExperiences.summaryZh,
        publishedAt: aiExperiences.publishedAt,
      })
      .from(aiExperiences)
      // 候选 = ≥70 且**尚未成功入 KB** 的卡片。反连接 kb_ingestion_records 把已 success 入库者剔出候选，
      // 把每轮成本降为「新增/未成功」增量——否则每日重扫全部历史 ≥70 卡片、逐条开事务（claim CAS 虽幂等
      // 不烧 LLM，但触发项目「禁无界重扫」反模式）。语义与 claim CAS 一致，只是把跳过前移到选条层。
      .where(
        and(
          gte(aiExperiences.longTermValue, KB_ADMISSION_FLOOR),
          notExists(
            dbh
              .select({ one: sql`1` })
              .from(kbIngestionRecords)
              .where(
                and(
                  eq(kbIngestionRecords.targetType, TARGET_TYPE.experience),
                  eq(kbIngestionRecords.targetId, aiExperiences.id),
                  eq(kbIngestionRecords.kbProvider, kbProvider),
                  eq(kbIngestionRecords.status, 'success'),
                ),
              ),
          ),
        ),
      );
  } catch (e) {
    // 候选选条系统级故障：永不向上抛（保护日报），返回零候选结果。
    logError('经验 KB 候选选条失败，整步降级（不拖垮日报）', e);
    return { candidates: 0, ingested: 0, skippedClaimed: 0, storeFailed: 0 };
  }

  const result: ExperienceKbIngestionResult = {
    candidates: candidates.length,
    ingested: 0,
    skippedClaimed: 0,
    storeFailed: 0,
  };

  for (const card of candidates) {
    try {
      const outcome = await storeKbDocument(
        {
          targetType: TARGET_TYPE.experience,
          // targetId = ai_experiences.id（与推送侧 target_id 同源；KB claim CAS 目标身份）。
          targetId: card.id,
          // kbTitle 回退防空：headline_zh ?? scenario（scenario 仍可能 NULL，store 列可空）。
          kbTitle: card.headlineZh ?? card.scenario ?? '',
          summaryZh: card.summaryZh ?? '',
          // tags = 卡片 tools（jsonb 读回收敛为 string[]，空 []）；卡片无独立 tags 字段。
          tags: toStringArray(card.tools),
          entities: [],
          // 有意 canonical-only：经验表不存原始 raw_items.url，canonical 已是去 utm 可点击来源。
          sourceUrls: [card.canonicalSourceUrl],
          // 镜像 deriveEventDate 的 NULL 回退：published_at ? getPushDate(published_at) : 当日 pushDate。
          // 绝不写 NULL/undefined 进 kb_documents.event_date date 列。
          eventDate: card.publishedAt ? getPushDate(card.publishedAt) : pushDate,
          longTermValue: card.longTermValue,
          // 跳过 embedding 生成（经验链不调 embedTexts；列可空，供未来检索）。
          embedding: null,
        },
        { ...options.store, kbProvider },
        dbh,
      );

      if (outcome.outcome === 'ingested') {
        result.ingested += 1;
      } else if (outcome.outcome === 'skipped-claimed') {
        result.skippedClaimed += 1;
      } else {
        result.storeFailed += 1;
      }
    } catch (e) {
      // storeKbDocument 已自吞失败返回 KbStoreOutcome，但稳妥起见再隔离一层、永不向上抛。
      result.storeFailed += 1;
      logError(`经验卡片入 KB 失败（已隔离，继续下一条）：${card.id}`, e);
    }
  }

  return result;
}

/** 把 jsonb 读回的 tools 收敛为 string[]（非数组 / 含非字符串元素 → 过滤；NULL → []）。 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

// ──────────────────────────────────────────────────────────────────────────
// ③ per-channel 推送候选（供组 E 5.2 接线）
// ──────────────────────────────────────────────────────────────────────────

export interface SelectExperiencesOptions {
  /** 参考时刻，决定 recency 窗口下界（默认当前时刻，与 push_date 同源）。 */
  now?: Date;
  /** 取前 N 条（默认 env.TOP_N，与日报同口径）。 */
  limit?: number;
  /** recency 窗口天数（默认 env.FIRST_SEEN_WINDOW_DAYS，与日报候选同口径）。 */
  windowDays?: number;
}

/**
 * 选某 channel 当日实践锦囊推送候选（程序规则，**非 LLM**；供组 E 5.2 接线）。
 *
 * 候选条件（全在 SQL 层用程序条件表达，design D6）：
 * - `long_term_value >= KB_ADMISSION_FLOOR`（**引用导出常量、不写字面量 70**，与 KB 准入同源）。
 * - `published_at` 在 recency 窗口内（闭区间 lowerBound <= published_at <= now）：gte/lte 对 NULL
 *   求假 → `published_at` 为 NULL 的卡片被自然排除（NULL 即排除，刻意接受 date-less 卡片 KB-only，
 *   对齐 top-n.ts；时效性靠窗口谓词保证不回推旧经验，policy-push-timeliness）。
 * - 「该卡片从未以该 channel success」（NOT EXISTS anti-join；跨天不重推；两侧 target_id/id 均
 *   varchar(128) 类型相容）。
 *
 * 排序 `long_term_value DESC, published_at DESC NULLS LAST, id`（确定性 tiebreaker），取前 limit 条。
 * 「同日不重复」由 dispatcher 的 UNIQUE 四元组兜底，本查询管「跨天从未 success」与窗口。
 *
 * 映射为 dispatcher 输入视图（SelectedEvent 复用，eventId=经验卡片主键 id；headlineZh=卡片 headline_zh）。
 *
 * @param channel 目标分发通道（候选「从未以该 channel success」按 channel 分别判定）。
 * @param dbh     可注入 db 或事务句柄（默认全局 db）。
 * @param options 注入 now / limit / windowDays。
 */
export async function selectExperiencesForChannel(
  channel: Channel,
  dbh: DbLike = defaultDb,
  options: SelectExperiencesOptions = {},
): Promise<SelectedEvent[]> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? env.TOP_N;
  const windowDays = options.windowDays ?? env.FIRST_SEEN_WINDOW_DAYS;

  // recency 窗口下界：复用 push-date 的 Asia/Shanghai 时区源（与日报 windowLowerBound 同口径，防漂移）。
  const lowerBound = startOfDayInTimeZone(now, windowDays - 1);

  // 「该卡片从未以该 channel success」anti-join（跨天/跨次不重推；按目标 channel 分别判定）。
  const neverSuccessfullyPushed = notExists(
    dbh
      .select({ one: sql`1` })
      .from(pushRecords)
      .where(
        and(
          eq(pushRecords.targetType, TARGET_TYPE.experience),
          eq(pushRecords.targetId, aiExperiences.id),
          eq(pushRecords.channel, channel),
          eq(pushRecords.status, 'success'),
        ),
      ),
  );

  const rows = await dbh
    .select({
      id: aiExperiences.id,
      headlineZh: aiExperiences.headlineZh,
      summaryZh: aiExperiences.summaryZh,
      scenario: aiExperiences.scenario,
      canonicalSourceUrl: aiExperiences.canonicalSourceUrl,
      publishedAt: aiExperiences.publishedAt,
      longTermValue: aiExperiences.longTermValue,
    })
    .from(aiExperiences)
    .where(
      and(
        gte(aiExperiences.longTermValue, KB_ADMISSION_FLOOR),
        // recency 窗口闭区间：gte/lte 对 NULL published_at 求假 → date-less 卡片被自然排除。
        gte(aiExperiences.publishedAt, lowerBound),
        lte(aiExperiences.publishedAt, now),
        neverSuccessfullyPushed,
      ),
    )
    // long_term_value DESC + published_at tiebreaker（design D5）+ id 终极确定性 tiebreaker。
    .orderBy(
      sql`${aiExperiences.longTermValue} DESC`,
      sql`${aiExperiences.publishedAt} DESC NULLS LAST`,
      aiExperiences.id,
    )
    .limit(limit);

  // 映射为 dispatcher 输入视图（SelectedEvent 复用，eventId=经验卡片主键 id）。
  // headlineZh 在经验语境承载一句话要点行；representativeTitle 用 headline_zh ?? scenario 回退防空。
  return rows.map((r) => ({
    eventId: r.id,
    representativeTitle: r.headlineZh ?? r.scenario,
    summaryZh: r.summaryZh,
    headlineZh: r.headlineZh,
    canonicalUrl: r.canonicalSourceUrl,
    publishedAt: r.publishedAt,
    rankScore: r.longTermValue,
  }));
}
