/**
 * 产品段零件（product-discovery，合并进日报后的「新品段」实现）。
 *
 * 产品发现**已合并进日报链**：日报消息内含「要闻段 + 新品段」，由 run-daily-workflow 在新闻链
 * 之后、早退判断之前调用本文件的两步零件（design D1/D6）。本文件**不再有独立 BullMQ 调度**
 * （队列/worker/cron/独立锁/runProductDigest 已移除）——产品段搭日报单例锁 `daily-digest:{push_date}`
 * 便车执行。本文件仅保留三个供日报 import 的导出：
 *   ① selectProductCandidates —— 程序规则选某 channel 当日产品候选（非 LLM）
 *   ② collapseProductsOnce —— channel-blind 塌缩一次（永不抛错）
 *   ③ selectProductsForChannelSafe —— per-channel 候选安全包装（失败降级空段）
 *
 * 关键不变量（绝不可违背，spec product-discovery）：
 * - 幂等四元组 `target_type='product'`、`target_id=product_id`、`channel`、`push_date`
 *   （push_date 取 Asia/Shanghai，与事件日报 push_date **时区口径同源**）。
 *   与事件日报（`target_type='event'`）各自独立命名空间，互不挤占。
 * - **跨天不重推候选窗口**：候选必须满足「该 product_id 从未被任何 push_date 以该 channel
 *   `success` 推送过」——否则产品因 PH 持续上榜、last_seen 天天刷新会每天以新 push_date 重新
 *   入选、UNIQUE 四元组每天不冲突 → 天天重推同一产品。「同日不重复」由 UNIQUE 兜底，「跨天
 *   一产品一生只推一次」由本候选窗口兜底，两层叠加不可删其一。
 * - **排除 merge_conflict**：被标记 merge_conflict 的产品（同一真实产品散为多个 product_id）
 *   其多行各自满足「从未 success」会被各推一次，违反「一产品一生一次」；故排除出候选，直到
 *   P3 跨行合并解决（宁可暂不推，也不重复推）。
 * - **候选查询必须在产品塌缩之后执行**：确保 merge_conflict 标记对候选可见（日报链顺序：
 *   collapseProductsOnce 在 channel 展开之前先跑、候选随后）。
 * - 推送名单**由程序规则决定，禁止由 LLM 决定最终推送名单**。
 *
 * 文件归属边界：本文件只引用 collectors / product-collapse / targets 已导出函数与 schema，
 * 不重写其逻辑、不改 schema；产品候选查询在本文件用程序条件表达。
 */
import { and, eq, inArray, isNull, ne, notExists, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { aiProducts, pushRecords, rawItems } from '../db/schema.js';
import { env } from '../config/env.js';
import {
  collapseUncollapsedProductRawItems,
  UNNAMED_PRODUCT_NAME,
} from '../collectors/product-collapse.js';
import {
  summarizeProduct,
  ProductDigestFailureError,
  type SummarizeProductOptions,
} from '../agents/product-digest/index.js';
import { updateProductZh } from '../agents/product-digest/persistence.js';
import type { SelectedEvent } from '../selection/top-n.js';
import { TARGET_TYPE, type Channel } from '../push/targets.js';

type DbLike = typeof defaultDb;

/**
 * 告警 sink（与 run-daily-workflow 的 AlertSink 结构同构，参数注入）。
 *
 * 本地定义而非从 run-daily-workflow import：run-daily-workflow 运行时 import 本文件
 * （collapseProductsOnce/selectProductsForChannelSafe/digestPendingProducts），反向再 import
 * 其类型会形成循环依赖；本地结构同构类型由结构化类型系统保证可接收注入的 AlertSink。
 */
type AlertSink = (message: string, detail?: unknown) => void;

const defaultAlert: AlertSink = (message, detail) =>
  console.error(`[product-segment][ALERT] ${message}`, detail ?? '');

// ──────────────────────────────────────────────────────────────────────────
// 部署防假绿（启动自检）：ai_products 中文列存在性探针
// ──────────────────────────────────────────────────────────────────────────

/**
 * 启动期自检 `ai_products.name_zh` / `tagline_zh` 列存在，缺则 fail-fast（design D7 部署不变量）。
 *
 * **必须在 worker 启动期（单一入口）调用、且必须 fail-fast**：name_zh/tagline_zh 列须**先于**
 * 读取它们的代码部署（迁移先行）。否则候选查询 `SELECT name_zh` 命中不存在列 →
 * selectProductCandidates 抛 → selectProductsForChannelSafe 把异常静默 catch 成空新品段 →
 * 新品段每日静默全空（CI 连已迁移库永远绿、生产漏迁移则空段 = 典型假绿）。本自检**不依赖**
 * selectProductsForChannelSafe 的静默吞，而是在启动期把「列不存在」显式暴露为明确错误。
 *
 * 探针用 `SELECT name_zh, tagline_zh FROM ai_products LIMIT 0`：只校验列存在（规划期即报缺列），
 * 不取任何行、零数据扫描、对空库亦成立。
 *
 * @param dbh 可注入 db 或事务句柄（默认全局 db）。
 * @throws 列不存在或探针失败时抛出明确错误（提示迁移必先于代码发布）。
 */
export async function assertProductZhColumns(dbh: DbLike = defaultDb): Promise<void> {
  try {
    await dbh.execute(
      sql`SELECT ${aiProducts.nameZh}, ${aiProducts.taglineZh} FROM ${aiProducts} LIMIT 0`,
    );
  } catch (e) {
    throw new Error(
      'ai_products 缺少中文展示列 name_zh / tagline_zh（或探针失败），日报 worker 拒绝启动。' +
        '部署不变量：数据库迁移（drizzle/0005_*）必先于读取这两列的代码发布。' +
        '请先执行 npm run migrate 再启动 worker。',
      { cause: e },
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 候选查询：程序规则选当日推送产品（非 LLM 定名单）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 选当日某 channel 的产品推送候选（程序规则，**非 LLM**）。
 *
 * 候选条件（全在 SQL 层用程序条件表达）：
 * - **排除 merge_conflict**：`metadata->'merge_conflict' IS NULL`（被标记冲突的多行各自满足
 *   「从未 success」会被各推一次，违反「一产品一生一次」，排除直到 P3 跨行合并解决）。
 * - **跨天不重推候选窗口**：`NOT EXISTS(push_records success for this product_id on the target
 *   channel on any push_date)`——「从未以该 channel success」而非「今天未 success」（跨天/跨次
 *   不重推；按目标 channel 分别判定，同一产品可分别进入 telegram 与 feishu 候选）。
 *
 * 「同日不重复」由 dispatcher 的待发集合「今日该 channel success 排除」+ UNIQUE 四元组兜底，
 * 本查询只管「跨天从未 success」与「排除冲突」。名单由程序定、不交 LLM。
 *
 * @param channel 目标分发通道（候选「从未以该 channel success」按 channel 分别判定）。
 * @param dbh     可注入 db 或事务句柄（默认全局 db）。
 * @param limit   取前 N 条（默认 env.TOP_N，与日报同口径）；按 last_seen_at DESC 优先近期上榜。
 */
export async function selectProductCandidates(
  channel: Channel,
  dbh: DbLike = defaultDb,
  limit: number = env.TOP_N,
): Promise<SelectedEvent[]> {
  // 「从未以该 channel success」相关子查询（跨天/跨次不重推）；target_type='product'、
  // target_id=product_id（product_id 与 push_records.target_id 同为 VARCHAR(128)，类型相容）。
  const neverSuccessfullyPushed = notExists(
    dbh
      .select({ one: sql`1` })
      .from(pushRecords)
      .where(
        and(
          eq(pushRecords.targetType, TARGET_TYPE.product),
          eq(pushRecords.targetId, aiProducts.productId),
          eq(pushRecords.channel, channel),
          eq(pushRecords.status, 'success'),
        ),
      ),
  );

  const rows = await dbh
    .select({
      productId: aiProducts.productId,
      name: aiProducts.name,
      // 中文展示列（中文化前置步骤写入；NULL = 未中文化 → 映射回退英文 name / 无要点）。
      nameZh: aiProducts.nameZh,
      taglineZh: aiProducts.taglineZh,
      // 链接来源：ai_products 无 url 列，仅 canonical_domain（裸域，product-collapse 写入端
      // 规范化为无 scheme/path）。映射 canonicalUrl = 'https://' + canonical_domain（见下）。
      canonicalDomain: aiProducts.canonicalDomain,
      lastSeenAt: aiProducts.lastSeenAt,
    })
    .from(aiProducts)
    .where(
      and(
        // 排除 merge_conflict：metadata->'merge_conflict' 不存在（NULL）即未冲突。
        // product-collapse 用 `metadata || {merge_conflict:{...}}` 标记，故以 JSON 路径判存在。
        isNull(sql`${aiProducts.metadata} -> 'merge_conflict'`),
        neverSuccessfullyPushed,
      ),
    )
    // 近期上榜优先（确定性 tiebreaker：product_id ASC），取前 limit 条。
    .orderBy(sql`${aiProducts.lastSeenAt} DESC NULLS LAST`, aiProducts.productId)
    .limit(limit);

  // 映射为 dispatcher 输入视图（SelectedEvent 复用，eventId=product_id）。
  // representativeTitle = name_zh ?? name（中文译名优先、回退英文，design D4）；
  // headlineZh = tagline_zh（**语境复用**：在 product 语境 SelectedEvent.headlineZh 语义 =
  // 产品简介要点行，渲染层据此产要点；summary_zh 产品无、仍置 null 走渲染回退）。
  // target_id=product_id 在 dispatcher 内由 e.eventId 承载，representativeTitle 改中文不污染
  // 推送幂等四元组。
  return rows.map((r) => {
    // canonical_domain 为裸域或 host:port → 'https://' + domain。extractCanonicalDomain 用
    // new URL(url).host 提取，host 合法可含端口（如 example.com:8080），故不能用 `:` 一刀切。
    // 用 URL 试构造校验：保留合法带端口域，仍挡 scheme/path/凭据/空白等畸形 → 降级 null
    // （绝不产生 https://https://… 或坏链接）；domain NULL/空 也降级 null → 渲染回退纯产品名。
    const d = r.canonicalDomain;
    let canonicalUrl: string | null = null;
    if (d && !/\s/.test(d) && !d.includes('://')) {
      try {
        const u = new URL(`https://${d}`);
        // host === d 保证 d 是纯 host（裸域或 host:port），含 path/凭据等畸形则不等 → 降级 null。
        if (u.host === d && u.pathname === '/' && !u.search && !u.hash) {
          canonicalUrl = `https://${d}`;
        }
      } catch {
        /* 畸形 → 保持 null */
      }
    }
    return {
      eventId: r.productId,
      representativeTitle: r.nameZh ?? r.name,
      summaryZh: null,
      headlineZh: r.taglineZh ?? null,
      canonicalUrl,
      publishedAt: null,
      rankScore: 0,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 产品段零件（供日报 run-daily 调用，design D1/D3）：
//   ① collapseProductsOnce —— channel-blind 塌缩一次（永不抛错）
//   ② digestPendingProducts —— channel-blind 中文化一次（永不抛错）
//   ③ selectProductsForChannelSafe —— per-channel 候选（失败降级空段）
// 三步不打包成「含 collapse 的 per-channel 函数」：塌缩 / 中文化单实例承载、候选才 per-channel。
// ──────────────────────────────────────────────────────────────────────────

/**
 * 产品塌缩一次（channel-blind，design D1 步骤 P1）。
 *
 * 薄包装 `collapseUncollapsedProductRawItems`（import 自 `src/collectors/product-collapse.ts`），
 * 任何异常 → 记错误/告警、视为「本次未塌缩」、**绝不向上抛**（产品失败不拖垮新闻）。
 *
 * **必须在 channel 展开之前只调一次**：产品塌缩由单实例承载（product-collapse.ts:272，内部
 * `SELECT ... FOR UPDATE` + product_id 升序防死锁、假设不被并发调用），若随 per-channel 并发
 * 跑 N 次会违反单实例假设产生同批竞态。
 *
 * **前置约束**：依赖调用方持 `daily-digest:{push_date}` 全局单例锁保证
 * `collapseUncollapsedProductRawItems` 单实例假设（product-collapse.ts 顺序处理/FOR UPDATE）；
 * 任何新调用方须持同一锁或等价单例保证，否则两实例争抢同批未塌缩 raw_items。
 *
 * @param dbh 可注入 db 或事务句柄（默认全局 db）。
 */
export async function collapseProductsOnce(dbh: DbLike = defaultDb): Promise<void> {
  try {
    await collapseUncollapsedProductRawItems(dbh);
  } catch (e) {
    console.error('[product-segment] 塌缩失败，降级（视为本次未塌缩，不拖垮新闻）', e);
  }
}

/**
 * 整步内异常视失败数/失败率超过该阈值即告警（系统级故障可观测）。
 *
 * digestPendingProducts「永不向上抛」会吞掉单产品业务失败（ProductDigestFailureError）与
 * 系统异常（DB 断连等）；为避免「全产品中文化失败却完全无声」的黑洞，整步对失败规模异常
 * 单独 `alert(...)`（design D7：不进 events 熔断分母、不中止流水线，但留可观测）。
 * 判据：候选 > 0 且（失败率 > 比例阈 或 失败数 ≥ 绝对阈）→ 告警。
 */
const PRODUCT_DIGEST_FAILURE_RATE_THRESHOLD = 0.5;
const PRODUCT_DIGEST_FAILURE_COUNT_THRESHOLD = 3;

/**
 * channel-blind 产品中文化一次（design D3，pipeline 零件）。
 *
 * **失败语义为编排契约、非内核同规格**（design D7）：对称 `collapseProductsOnce`——
 * 单产品业务失败（ProductDigestFailureError）记 error / 保持 name_zh NULL（渲染回退英文）/
 * 继续下一个；整步**永不向上抛**（保护新闻链，产品失败不拖垮新闻、不进 events 熔断分母、
 * 不中止流水线）；仅 Agent 内核 summarizeProduct 与 events summarizeEvent 同规格
 * （Zod / 重试 / ProductDigestFailureError 降级信号），**不照搬 events digest 的非业务异常
 * rethrow + 降级率熔断**。
 *
 * 候选 = **各 channel 正式推送候选的精确并集**（消除 channel-blind 单窗 + LIMIT 的覆盖边缘、
 * 零「下次幂等补」依赖）：对每个 channel 调用一次 `selectProductCandidates`（复用既有查询路径
 * 而非重写 SQL UNION / NOT EXISTS 谓词，杜绝谓词漂移、dedup 免费）、在应用层用
 * `Set<product_id>` 去重并集；`channels` 为空 → 并集空 → **直接 return、不下发查询**。
 *
 * 对并集 product_id 中 `name_zh IS NULL`（幂等：已中文化跳过）且 `name !== UNNAMED_PRODUCT_NAME`
 * （排除塌缩兜底占位名，零信息输入会诱发 LLM 幻觉译名、反比回退英文更糟；占位字面与
 * product-collapse 单一来源共享常量、防字面漂移）的产品，`LEFT JOIN raw_items ON
 * representative_raw_item_id = raw_items.id`（LEFT 非 INNER：representative_raw_item_id 为
 * NULL / 悬空的产品仍保留、content=NULL 仅凭 name 产中文）取 content，逐个
 * `summarizeProduct({name,content})` → `updateProductZh`。
 *
 * **前置约束**：依赖调用方持 `daily-digest:{push_date}` 全局单例锁（与 collapseProductsOnce 同）；
 * 须在产品塌缩之后、per-channel 候选之前调用（中文化 UPDATE 后续候选才读到中文列）。
 *
 * @param dbh      可注入 db 或事务句柄（默认全局 db）。
 * @param channels 已配置通道集（取各 channel 正式候选并集；为空直接 return）。
 * @param alert    告警 sink（参数注入，默认 console.error；整步失败规模异常时单独告警）。
 * @param summarizeOptions 透传给 summarizeProduct（测试注入 generateObjectFn mock，不真调 LLM）。
 */
export async function digestPendingProducts(
  dbh: DbLike = defaultDb,
  channels: Channel[] = [],
  alert: AlertSink = defaultAlert,
  summarizeOptions?: SummarizeProductOptions,
): Promise<void> {
  // channels 为空 → 并集空 → 直接 return（不下发任何查询、不中文化）。
  if (channels.length === 0) return;

  // 候选并集：复用 selectProductCandidates（每 channel 一次），应用层 Set 去重 product_id。
  // 整个并集收集阶段亦不向上抛——任一 channel 候选查询失败只告警 + 跳过该 channel（永不拖垮新闻）。
  const candidateIds = new Set<string>();
  for (const channel of channels) {
    try {
      const candidates = await selectProductCandidates(channel, dbh);
      for (const c of candidates) candidateIds.add(c.eventId);
    } catch (e) {
      console.error(
        `[product-digest] 候选并集收集失败[${channel}]，跳过该 channel（不拖垮新闻）`,
        e,
      );
      alert('产品中文化候选并集收集失败（系统故障可观测）', { channel, error: e });
    }
  }
  if (candidateIds.size === 0) return;

  // 取并集中「未中文化（name_zh IS NULL）且非占位名」的产品 + LEFT JOIN content。
  // LEFT JOIN：representative_raw_item_id 为 NULL / 悬空时 content=NULL，产品仍保留、仅凭 name 中文化。
  let pending: Array<{ productId: string; name: string; content: string | null }>;
  try {
    pending = await dbh
      .select({
        productId: aiProducts.productId,
        name: aiProducts.name,
        content: rawItems.content,
      })
      .from(aiProducts)
      .leftJoin(rawItems, eq(aiProducts.representativeRawItemId, rawItems.id))
      .where(
        and(
          inArray(aiProducts.productId, [...candidateIds]),
          isNull(aiProducts.nameZh),
          ne(aiProducts.name, UNNAMED_PRODUCT_NAME),
        ),
      );
  } catch (e) {
    // 整步系统级故障（如 DB 断连）：永不向上抛，但单独告警（不进熔断分母、不中止流水线）。
    console.error('[product-digest] 待中文化产品查询失败，整步降级（不拖垮新闻）', e);
    alert('产品中文化待处理查询失败（系统故障可观测）', { error: e });
    return;
  }

  if (pending.length === 0) return;

  // 逐个中文化：单产品失败记 error / 保持 NULL / 继续下一个；整步永不抛。统计失败规模供告警。
  let failed = 0;
  for (const p of pending) {
    try {
      const { name_zh, tagline_zh } = await summarizeProduct(
        { name: p.name, content: p.content },
        summarizeOptions,
      );
      await updateProductZh(dbh, p.productId, name_zh, tagline_zh);
    } catch (e) {
      failed += 1;
      if (e instanceof ProductDigestFailureError) {
        // 业务失败（Agent 降级）：保持 name_zh NULL（渲染回退英文），继续下一个。
        console.error(
          `[product-digest] 产品中文化业务失败，保持 NULL 回退英文（product=${p.productId.slice(0, 8)}）`,
          e,
        );
      } else {
        // 系统级故障（DB 断连 / updateProductZh 写失败等）：同样不向上抛、保护新闻链，但计入失败数。
        console.error(
          `[product-digest] 产品中文化系统级失败，保持 NULL 继续（product=${p.productId.slice(0, 8)}）`,
          e,
        );
      }
    }
  }

  // 整步失败规模异常 → 单独告警（系统故障可观测，「不进熔断」≠「无监管」，design D7）。
  const failureRate = pending.length > 0 ? failed / pending.length : 0;
  if (
    pending.length > 0 &&
    (failureRate > PRODUCT_DIGEST_FAILURE_RATE_THRESHOLD ||
      failed >= PRODUCT_DIGEST_FAILURE_COUNT_THRESHOLD)
  ) {
    alert(
      `产品中文化失败规模异常：${failed}/${pending.length} 失败（${(failureRate * 100).toFixed(0)}%），` +
        `不进熔断分母、不中止流水线，但须排查系统故障（如 LLM/DB 不可用）。`,
      { failed, total: pending.length, failureRate },
    );
  }
}

/**
 * 安全取某 channel 的产品候选（design D1 步骤 P2 的 per-channel 安全包装）。
 *
 * 包 try/catch 调 `selectProductCandidates(channel, dbh)`；失败 → 记告警、返回空段、**绝不向上抛**
 * （该 channel 新品段降级为空，不拖垮新闻 / 不拖垮其余 channel）。供 run-daily 在 per-channel
 * 循环里调，组装 `Map<Channel, SelectedEvent[]>`（design D6 的 productsByChannel）。
 *
 * @param channel 目标分发通道（候选「从未以该 channel success」按 channel 分别判定）。
 * @param dbh     可注入 db 或事务句柄（默认全局 db）。
 */
export async function selectProductsForChannelSafe(
  channel: Channel,
  dbh: DbLike = defaultDb,
): Promise<SelectedEvent[]> {
  try {
    return await selectProductCandidates(channel, dbh);
  } catch (e) {
    console.error(`[product-segment] 候选查询失败[${channel}]，降级空新品段`, e);
    return [];
  }
}

