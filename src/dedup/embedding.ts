/**
 * 事件 embedding 生成（add-semantic-dedup-and-store-hardening，组 C / spec「事件 embedding 生成」）。
 *
 * 职责（语义层第三层的前置）：在硬去重塌缩之后、value-judge 之前，为候选时间窗内的新闻事件
 * 生成定长向量并落 `ai_news_events.embedding`，使跨天去重的 pgvector KNN 能检索到历史存活者。
 *
 * 关键不变量（spec / design D1/D2/D3，逐条守住）：
 * - **候选窗口 bootstrap**：生成对象 = 窗内（`first_seen_at >= now()-SEMANTIC_WINDOW_DAYS`）
 *   **所有** `embedding IS NULL AND merged_into IS NULL` 的事件——**不只本轮 collapse 新事件**。
 *   历史存活者须先补 embedding 才能作 KNN 候选被检索到，否则跨天合并静默失效。
 * - **嵌入顺序**：先嵌**本轮新事件**（保证今日新事件本轮即可作查询对象参与合并），再以
 *   `first_seen_at` 升序填补剩余配额嵌历史存活者（作候选）。**不是**单纯 first_seen_at 升序。
 * - **首轮 backlog 上限**：单轮至多嵌 `EMBEDDING_BOOTSTRAP_MAX_PER_RUN`（默认 500）条，
 *   余量后续日报轮次续嵌——防 P3 首部署一次性嵌满 14 天 backlog 撑爆调用 / 拖住日报锁。
 * - **幂等**：已有 embedding 的事件不重复生成（候选 SELECT 即带 `embedding IS NULL`）。
 * - **空文本兜底（防退化向量误并）**：embedding 文本经 trim 后为空/纯空白（`content` 为 NULL/空
 *   且 `representative_title` 为空串）→ **跳过该事件的 embedding 与合并**（记日志、保留独立），
 *   **绝不**对空/空白文本求 embedding（空文本产生退化向量，使无关事件呈高相似度被错误合并）。
 * - **失败不中止整批**：单条/单批 embedding 外部调用重试后仍失败 → 记错误日志、该事件跳过语义
 *   合并（保留独立、欠合并安全），其余照常落库，整批不中止。
 * - embedding 文本 = `representative_title` ‖ 代表 raw_item `content` 摘录（截断到
 *   `EMBEDDING_TEXT_MAX_CHARS`）‖ `main_entities`（若该阶段已存在则附加；dedup 阶段通常无）。
 *
 * 依赖注入：`embedMany` 经 `embedManyFn` 选项注入（默认真实 SDK，照 value-judge 的 generateObjectFn
 * 范式）；测试注入桩不触网。导出低层原语 `embedTexts` 供组 E（知识库）复用。
 */
import { embedMany } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiNewsEvents, rawItems } from '../db/schema.js';
import { env } from '../config/env.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测。 */
type DbLike = typeof defaultDb;

/**
 * `embedMany` 的最小依赖契约（仅取本模块用到的形参/返回）。注入此类型使测试可 mock，不触网。
 * 返回 `embeddings` 须与 `values` 同序、等长（与 SDK `EmbedManyResult` 一致）。
 */
export type EmbedManyFn = (args: {
  model: ReturnType<ReturnType<typeof createOpenAI>['embedding']>;
  values: string[];
}) => Promise<{ embeddings: number[][] }>;

/**
 * 默认（真实）`embedMany` 调用；仅在调用方未注入 `embedManyFn` 时被兜底使用。
 *
 * **测试守卫**（与 llm-client 的 defaultGenerateObject 同口径）：`process.env.VITEST` 下 throw——
 * 把「测试漏注入桩而走默认真实路径」从静默真打生产 embedding API 变成失败。生产恒不设此变量。
 */
const defaultEmbedMany: EmbedManyFn = async (args) => {
  if (process.env.VITEST) {
    throw new Error(
      'embedding: 测试环境（VITEST）禁止真实 embedding 调用——未注入 embedManyFn 桩而走到默认真实路径。' +
        '请在测试中注入 embedManyFn，不要让默认路径触达生产 embedding API。',
    );
  }
  const result = await embedMany(args);
  return { embeddings: result.embeddings as number[][] };
};

/** 按 env 构造 embedding provider + model（仅内存构造、不触网）。 */
function buildEmbeddingModel(): ReturnType<
  ReturnType<typeof createOpenAI>['embedding']
> {
  const provider = createOpenAI({
    baseURL: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    headers: { 'X-Title': 'ai-radar' },
  });
  return provider.embedding(env.EMBEDDING_MODEL);
}

/** 低层 embed 原语的可注入选项（重试 / 日志 / 注入桩）。 */
export interface EmbedTextsOptions {
  /** 注入的 embedMany 实现，默认真实 SDK。 */
  embedManyFn?: EmbedManyFn;
  /** 最大尝试次数（含首次），默认 3（首次 + 2 次重试）。 */
  maxAttempts?: number;
  /** 错误日志 sink，默认 console.error；便于测试断言（非静默）。 */
  logError?: (message: string, detail: unknown) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * 低层可复用 embed 原语：对一批文本批量生成向量，带重试 + 错误日志（供组 C/E 复用）。
 *
 * **绝不**在此做空文本过滤——调用方须保证 `texts` 全部非空（空文本兜底是上层 bootstrap 的职责，
 * 见 buildEmbeddingText / runEmbeddingBootstrap）。本原语只负责「给定非空文本 → 等长同序向量」。
 *
 * 成功：返回与 `texts` 同序、等长的 `number[][]`。
 * 失败：所有尝试都抛错（外部调用失败）→ 记日志 + 抛最后一次错误（由调用方决定降级=跳过该批）。
 *
 * @param texts 待嵌入的非空文本数组。空数组直接返回 `[]`（不发起调用）。
 */
export async function embedTexts(
  texts: readonly string[],
  options: EmbedTextsOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const run = options.embedManyFn ?? defaultEmbedMany;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const logError =
    options.logError ??
    ((message, detail) => console.error(`[embedding] ${message}`, detail));

  const model = buildEmbeddingModel();
  const values = [...texts];

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { embeddings } = await run({ model, values });
      if (!Array.isArray(embeddings) || embeddings.length !== values.length) {
        // 长度不齐则无法可靠地按序回写 event——视为失败重试，绝不错位落库。
        lastError = new Error(
          `embedMany 返回 ${embeddings?.length ?? 'undefined'} 个向量，与请求的 ${values.length} 条文本不等长`,
        );
        logError(`第 ${attempt}/${maxAttempts} 次：embedMany 返回向量数与文本数不一致`, lastError);
        continue;
      }
      return embeddings;
    } catch (error) {
      lastError = error;
      logError(`第 ${attempt}/${maxAttempts} 次：embedMany 调用失败`, error);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`embedTexts 在 ${maxAttempts} 次尝试后仍失败`);
}

/**
 * 构造单个事件的 embedding 文本：`representative_title` ‖ content 摘录（截断）‖ main_entities。
 *
 * **空文本兜底**：拼接后 trim 为空/纯空白 → 返回 `null`（调用方据此跳过该事件的 embedding 与合并，
 * 绝不对空文本求 embedding）。`content` 列可空、`representative_title` 可能为空串，故必须处理。
 *
 * @param maxChars content 摘录截断字符数（默认 env.EMBEDDING_TEXT_MAX_CHARS）。
 * @returns 非空 embedding 文本；若无可用文本则 `null`。
 */
export function buildEmbeddingText(
  event: {
    representativeTitle: string | null;
    content: string | null;
    mainEntities?: unknown;
  },
  maxChars: number = env.EMBEDDING_TEXT_MAX_CHARS,
): string | null {
  const parts: string[] = [];

  const title = (event.representativeTitle ?? '').trim();
  if (title.length > 0) parts.push(title);

  const content = (event.content ?? '').trim();
  if (content.length > 0) {
    parts.push(content.length > maxChars ? content.slice(0, maxChars) : content);
  }

  // main_entities 在 dedup 阶段通常尚未产出（value-judge/digest 之后才有）；若已存在则附加。
  const entitiesText = stringifyMainEntities(event.mainEntities);
  if (entitiesText.length > 0) parts.push(entitiesText);

  const text = parts.join('\n').trim();
  return text.length > 0 ? text : null;
}

/**
 * 把 `main_entities`（jsonb，形态不定）扁平化为附加文本片段。
 * 仅取字符串型条目（数组元素或对象值），其余忽略；无可用值返回空串。
 */
function stringifyMainEntities(value: unknown): string {
  if (value == null) return '';
  const collected: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === 'string') {
      const s = v.trim();
      if (s.length > 0) collected.push(s);
    } else if (Array.isArray(v)) {
      for (const el of v) collect(el);
    } else if (typeof v === 'object') {
      for (const el of Object.values(v as Record<string, unknown>)) collect(el);
    }
  };
  collect(value);
  return collected.join(', ');
}

/** 候选窗口内一条待嵌事件的最小视图（含代表 raw_item content 回指）。 */
interface PendingEmbeddingEvent {
  eventId: string;
  representativeTitle: string | null;
  representativeRawItemId: bigint | null;
  /** 经 representative_raw_item_id 回指的代表 raw_item content（可空）。 */
  content: string | null;
  mainEntities: unknown;
}

/** 一轮 embedding bootstrap 的统计结果（供编排/可观测）。 */
export interface EmbeddingBootstrapResult {
  /** 本轮候选（窗内 `embedding IS NULL AND merged_into IS NULL`）总数（未截上限前）。 */
  candidates: number;
  /** 本轮实际尝试嵌入（非空文本、纳入配额）的事件数。 */
  attempted: number;
  /** 成功落库 embedding 的事件数。 */
  embedded: number;
  /** 因空/空白文本被跳过（不嵌、保留独立、不占外部调用）的事件数。 */
  skippedEmpty: number;
  /** 因 embedding 外部调用失败被跳过（保留独立、不中止整批）的事件数。 */
  failed: number;
  /** 因达单轮上限本轮未处理、留待后续轮次续嵌的余量数。 */
  deferred: number;
}

export interface EmbeddingBootstrapOptions {
  /** 透传给 embedTexts 的选项（注入 mock embedManyFn / maxAttempts / logError）。 */
  embed?: EmbedTextsOptions;
  /** 错误/信息日志 sink，默认 console.error；便于测试断言（空文本/失败被记录，非静默）。 */
  logError?: (message: string, detail: unknown) => void;
  /** 候选时间窗天数（默认 env.SEMANTIC_WINDOW_DAYS）。 */
  windowDays?: number;
  /** 单轮 backlog 上限（默认 env.EMBEDDING_BOOTSTRAP_MAX_PER_RUN）。 */
  maxPerRun?: number;
  /** content 摘录截断字符数（默认 env.EMBEDDING_TEXT_MAX_CHARS）。 */
  maxChars?: number;
  /**
   * 本轮 collapse 新产出的事件 id 集（嵌入顺序须先嵌这些）。
   * 省略/空集时退化为纯 `first_seen_at` 升序（首部署无「本轮新事件」标识时仍工作）。
   */
  thisRoundEventIds?: readonly string[];
}

/**
 * 候选窗口 embedding bootstrap：为窗内所有 `embedding IS NULL AND merged_into IS NULL` 的新闻事件
 * 补生成 embedding 并落库（spec「候选窗口 bootstrap」）。
 *
 * 流程：
 * 1. 候选 SELECT：窗内（`first_seen_at >= now()-windowDays`）、`embedding IS NULL`（幂等：已嵌不重生成）、
 *    `merged_into IS NULL`（tombstone 不嵌、不参与检索），经 representative_raw_item_id LEFT JOIN 回指
 *    代表 raw_item content。
 * 2. 嵌入顺序排序：先**本轮新事件**（thisRoundEventIds，保今日新事件本轮即可作查询对象），
 *    再 `first_seen_at` 升序填补余量（嵌历史存活者作候选）。
 * 3. 截单轮上限 maxPerRun；余量记为 deferred、后续轮次续嵌。
 * 4. 空文本兜底：buildEmbeddingText 返回 null 者跳过（不嵌、不占外部调用、保留独立），计 skippedEmpty。
 * 5. 对非空文本批量 embedTexts（带重试）；调用失败 → 记日志、整批候选计 failed、跳过语义合并（保留独立），
 *    不中止——但**绝不**因一批失败而中止后续（本实现单批，故失败即全批 failed）。
 * 6. 逐条把向量写回 `ai_news_events.embedding`（按 event_id 定位；写回也加 `embedding IS NULL` 守卫，
 *    幂等/防并发覆写）。
 *
 * @param dbh 可注入 db 或事务句柄（默认全局 db）。
 */
export async function runEmbeddingBootstrap(
  options: EmbeddingBootstrapOptions = {},
  dbh: DbLike = defaultDb,
): Promise<EmbeddingBootstrapResult> {
  const windowDays = options.windowDays ?? env.SEMANTIC_WINDOW_DAYS;
  const maxPerRun = options.maxPerRun ?? env.EMBEDDING_BOOTSTRAP_MAX_PER_RUN;
  const maxChars = options.maxChars ?? env.EMBEDDING_TEXT_MAX_CHARS;
  const logError =
    options.logError ??
    ((message, detail) => console.error(`[embedding-bootstrap] ${message}`, detail));
  const thisRoundIds = new Set(options.thisRoundEventIds ?? []);

  // 候选窗口下界：now() - interval（参数化天数，DB 端时钟统一口径，防进程钟漂）。
  const windowCutoff = sql`now() - (${windowDays}::double precision * interval '1 day')`;

  // 候选 SELECT：窗内、未嵌、非 tombstone；LEFT JOIN 回指代表 raw_item content。
  // 排序 = first_seen_at 升序（DB 层）；本轮新事件优先由下方应用层稳定排序前置（thisRoundIds）。
  // first_seen_at 可空（塌缩首建恒写，但历史/异常行可能 NULL）——NULLS 顺序不影响正确性（仅排序，
  // 仍受 LIMIT 约束），用 asc() 默认 NULLS LAST 让 NULL 排在最后填余量。
  const rows = await dbh
    .select({
      eventId: aiNewsEvents.eventId,
      representativeTitle: aiNewsEvents.representativeTitle,
      representativeRawItemId: aiNewsEvents.representativeRawItemId,
      mainEntities: aiNewsEvents.mainEntities,
      firstSeenAt: aiNewsEvents.firstSeenAt,
      content: rawItems.content,
    })
    .from(aiNewsEvents)
    .leftJoin(rawItems, eq(aiNewsEvents.representativeRawItemId, rawItems.id))
    .where(
      and(
        isNull(aiNewsEvents.embedding),
        isNull(aiNewsEvents.mergedInto),
        sql`${aiNewsEvents.firstSeenAt} >= ${windowCutoff}`,
      ),
    )
    .orderBy(asc(aiNewsEvents.firstSeenAt));

  const candidates = rows.length;

  // 嵌入顺序：先本轮新事件（thisRoundIds），再 first_seen_at 升序余量（DB 已升序，稳定保留）。
  // Array.prototype.sort 在 V8 中稳定，故同档内保持 DB 的 first_seen_at 升序。
  const ordered = [...rows].sort((a, b) => {
    const aNew = thisRoundIds.has(a.eventId) ? 0 : 1;
    const bNew = thisRoundIds.has(b.eventId) ? 0 : 1;
    return aNew - bNew;
  });

  // 截单轮上限：本轮处理前 maxPerRun 条，余量 deferred 后续轮次续嵌。
  const selected = ordered.slice(0, maxPerRun);
  const deferred = ordered.length - selected.length;

  // 空文本兜底：buildEmbeddingText 返回 null 者跳过（不嵌、保留独立）。
  const toEmbed: { event: PendingEmbeddingEvent; text: string }[] = [];
  let skippedEmpty = 0;
  for (const row of selected) {
    const event: PendingEmbeddingEvent = {
      eventId: row.eventId,
      representativeTitle: row.representativeTitle,
      representativeRawItemId: row.representativeRawItemId,
      content: row.content,
      mainEntities: row.mainEntities,
    };
    const text = buildEmbeddingText(event, maxChars);
    if (text === null) {
      skippedEmpty += 1;
      logError('事件 embedding 文本为空/空白，跳过 embedding 与合并（保留独立）', {
        eventId: row.eventId,
      });
      continue;
    }
    toEmbed.push({ event, text });
  }

  const attempted = toEmbed.length;
  if (attempted === 0) {
    return { candidates, attempted, embedded: 0, skippedEmpty, failed: 0, deferred };
  }

  // 批量生成（带重试）。失败 → 记日志、整批候选计 failed、跳过语义合并（保留独立），不中止整批。
  let embeddings: number[][];
  try {
    embeddings = await embedTexts(
      toEmbed.map((e) => e.text),
      options.embed,
    );
  } catch (error) {
    logError('embedding 批量生成失败，本批事件跳过语义合并（保留独立），不中止整批', {
      count: attempted,
      error,
    });
    return { candidates, attempted, embedded: 0, skippedEmpty, failed: attempted, deferred };
  }

  // 逐条写回 embedding（按 event_id 定位；加 `embedding IS NULL` 守卫，幂等 + 防并发覆写）。
  let embedded = 0;
  let failed = 0;
  for (let i = 0; i < toEmbed.length; i++) {
    const { event } = toEmbed[i]!;
    const vector = embeddings[i]!;
    try {
      await dbh
        .update(aiNewsEvents)
        .set({ embedding: vector })
        .where(
          and(eq(aiNewsEvents.eventId, event.eventId), isNull(aiNewsEvents.embedding)),
        );
      embedded += 1;
    } catch (error) {
      failed += 1;
      logError('embedding 写回失败，该事件跳过语义合并（保留独立），不中止整批', {
        eventId: event.eventId,
        error,
      });
    }
  }

  return { candidates, attempted, embedded, skippedEmpty, failed, deferred };
}

/**
 * 工具导出：供测试/组 D 按 id 批读已落库 embedding（避免在测试里重复手写 SELECT）。
 * 仅取 embedding 列。inArray 空集时返回空 map（drizzle inArray([]) 行为不可依赖，显式短路）。
 */
export async function readEmbeddingsByEventIds(
  eventIds: readonly string[],
  dbh: DbLike = defaultDb,
): Promise<Map<string, number[] | null>> {
  const result = new Map<string, number[] | null>();
  if (eventIds.length === 0) return result;
  const rows = await dbh
    .select({ eventId: aiNewsEvents.eventId, embedding: aiNewsEvents.embedding })
    .from(aiNewsEvents)
    .where(inArray(aiNewsEvents.eventId, [...eventIds]));
  for (const r of rows) result.set(r.eventId, r.embedding ?? null);
  return result;
}
