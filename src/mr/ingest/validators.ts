/**
 * Model Radar（P5 / 5b，add-model-radar-ingestion-freshness）per-table 组合写校验器（task 1.1，design D1）。
 *
 * 职责：5a（`src/db/mr-schema.zod.ts`）只给 8 个独立 enum + partial `mrPlanWriteSchema` refine，
 * **未组合成各表的写校验器**。本文件把它们组合成每张写 `mr_*` 表的「有限值集列」组合写 schema，
 * 供 Group B 的 `upsert*` / `recordPriceChange` 在发 SQL **前**调用——「任何生产路径写 mr_* 前过 Zod」
 * 的录入侧落点。
 *
 * 不变量（spec「录入经 Zod 闸」/ design D1）：
 * - 8 个 enum-bearing 校验落点 = plan / model / planLimit / planClient / planModel / source(fetch_strategy)
 *   + 改价 priceHistory（`source_confidence`+`currency`）。`mr_plan_models`/`mr_price_history` 同为有限值列，
 *   **不可漏**（否则模型兼容事实 / 改价 provenance 绕过 Zod）。
 * - `mr_plan_sources`（junction）/ `mr_vendors`（身份）无枚举列，不在此列（task 1.1 明确不计）。
 * - `mr_models.family` 写前小写归一（design D3，防 `GLM`/`glm` 因大小写敏感唯一键误分裂）——
 *   作为 transform 内建于 `mrModelWriteSchema`，使 Group B 用解析后的值写 SQL 即天然归一。
 *
 * 这些是**校验器**（组合 Zod schema），不是 upsert 函数本体（那是 Group B）。每张表只校验其有限值集列；
 * 其余列（name/source_url/value/window 文本等）的存在性/格式校验留 Group B 录入路径按需补。
 */
import { z } from 'zod';
import {
  isOfficialConfidence,
  mrClientTypeSchema,
  mrCurrencySchema,
  mrFetchStrategySchema,
  mrPlanPriceSchema,
  mrLimitTypeSchema,
  mrPlanWriteSchema,
  mrSourceConfidenceSchema,
} from '../../db/mr-schema.zod.js';

/**
 * `upsertPlan` 写校验器 = 5a `mrPlanWriteSchema`（category/currentPrice/currency/sourceConfidence
 * 取值集 + 价格币种同生同灭 refine，design D6）。直接复用、不重造（避免 refine 漂移）。
 */
export const mrPlanWriteValidator = mrPlanWriteSchema;

/**
 * 共享 source_url 非空校验（5c review）——快照所读事实表（plan/limit/client/model junction/source）的
 * `source_url` 列 DB NOT NULL 但允许空串；空串提交后快照 build 的 DTO `.parse`（`z.string().min(1)`）会拒 →
 * fail-closed（冷启动 503 / 旧快照不更新）。各 `upsert*` 录入发 SQL **前**过此闸，使空串在写侧即被拒。
 */
export const mrSourceUrlSchema = z
  .string()
  .refine((s) => s.trim().length > 0, 'source_url 不可为空（不可纯空白）');

/**
 * `upsertModel` 写校验器（design D3）。`mr_models` 唯一键 `UNIQUE(vendor_id, family, version)` 大小写敏感，
 * 故 `family` 写前 `.toLowerCase().trim()` 归一（`GLM`/`glm` 命中同行不分裂）。
 * version 不归一（保留版本号原貌；未标版本由 Group B 填哨兵 `''`）。本表无 enum 列，归一是唯一有限值约束。
 */
export const mrModelWriteSchema = z.object({
  // 先 trim 再校验非空（纯空白 family 会归一成 '' 入 (vendor_id,family,version) 唯一键 → 畸形身份，fail-fast）。
  family: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, 'family 不可为空'))
    .transform((s) => s.toLowerCase()),
  version: z.string(),
});

/**
 * `upsertPlanLimit` 写校验器（design D1）。`limit_type` 过枚举闸（含 5b 扩入的 `credit`/`fast_pass`），
 * `source_confidence` 过 provenance 枚举闸。value/window 文本非有限值集，留 Group B。
 */
export const mrPlanLimitWriteSchema = z.object({
  limitType: mrLimitTypeSchema,
  sourceConfidence: mrSourceConfidenceSchema,
});

/**
 * `upsertPlanClient` 写校验器（design D2/D4）。`client_type ∈ {tool, protocol}` 过枚举闸防工具/协议同名误撞，
 * `source_confidence` 过 provenance 枚举闸。client_id 文本留 Group B。
 */
export const mrPlanClientWriteSchema = z.object({
  clientType: mrClientTypeSchema,
  sourceConfidence: mrSourceConfidenceSchema,
});

/**
 * `upsertPlanModel` 写校验器（design D1，**不可漏**——断言事实 junction）。仅 `source_confidence` 是有限值列。
 */
export const mrPlanModelWriteSchema = z.object({
  sourceConfidence: mrSourceConfidenceSchema,
});

/**
 * `upsertSource` 写校验器（design D9）。`mr_source.fetch_strategy ∈ {http, browser, manual}` 是有限值列，
 * 非录入路径（抓取链注册源）写非法 `fetch_strategy` 须在发 SQL 前被拒（spec 场景「非录入路径写枚举列也过 Zod」）。
 */
export const mrSourceWriteSchema = z.object({
  fetchStrategy: mrFetchStrategySchema,
});

/**
 * `upsertPlanPeriodPrice` 写校验器（add-model-radar-price-state-and-periods D6）。
 * 复用 5a/Group A 的 `mrPlanPriceSchema`，覆盖 billing_period/currency/source_confidence
 * 以及周期价 confidence↔price 绑定；`monthly` 镜像行会在发 SQL 前被拒。
 */
export const mrPlanPeriodPriceWriteSchema = mrPlanPriceSchema;

/**
 * 改价路径写校验器（design D1/D4）。`recordPriceChange` 写 `mr_price_history` 前必校验 provenance 有限值列：
 * `source_confidence`（枚举）+ `currency`（ISO 4217 枚举，含 5b 扩入的 `EUR`）。
 * new_value/old_value 数值非有限值集，留 Group B 改价逻辑。
 *
 * **confidence-must-be-official（5c，design D4）**：`mr_price_history` 行恒携带非 NULL `new_value`，故写价 provenance
 * 必 ∈ 已核官方集合（official_pricing/official_doc）。非官方 confidence（needs_login_recheck/official_community/
 * media_report）在发 SQL 前被拒——与 `mrPlanWriteSchema` 的 confidence↔price 绑定双层兜，未核价无法进 history/current。
 */
export const mrPriceHistoryWriteSchema = z
  .object({
    currency: mrCurrencySchema,
    sourceConfidence: mrSourceConfidenceSchema,
  })
  .refine(
    (v) => isOfficialConfidence(v.sourceConfidence),
    'recordPriceChange 写价须官方 provenance（official_pricing/official_doc）；非官方 confidence 不得携带价格',
  );
