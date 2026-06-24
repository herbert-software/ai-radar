/**
 * Model Radar（P5 / 5a，add-model-radar-data-model）应用层校验闸 —— `mr_*` 有限值集列 Zod 枚举 +
 * `mr_plans` 同生同灭 refine。
 *
 * 关键不变量（design D4/D6/D10 + 风险/权衡）：
 * 全仓零 pg-enum / 零 DB CHECK（对齐 ai_experiences 注释「唯一防线是 Zod」）——`mr_*` 表的取值集
 * 合法性**唯一防线就是本文件的 Zod**。每个有限值集列都必须有枚举闸，否则绕过录入的写入方可写脏值
 * （DB 放行）。**所有有限值集列均须经此校验**（8 个枚举），`mr_plans` 价格/币种同生同灭须经 refine。
 *
 * 词表为「5a 桶2 样例出现的类型」，**不声称覆盖 8 家全部**；`limit_type` 的 credit/fast_pass、
 * currency 的更多 ISO 4217、source_confidence/fetch_strategy 等的扩集留 5b 全桶入库随录入扩。
 */
import { z } from 'zod';

/** 来源置信度（design D4，5 值）。`needs_login_recheck` = 登录墙占位（current_price/currency 皆 NULL）。 */
export const mrSourceConfidenceSchema = z.enum([
  'official_pricing',
  'official_doc',
  'official_community',
  'media_report',
  'needs_login_recheck',
]);

/**
 * 套餐分桶 category（design D4，恰好 4 桶——分桶为 facet）。
 * `ide_membership`=IDE会员、`coding_plan`=Coding Plan、`token_plan`=Token Plan、`enterprise_seat`=企业席位。
 */
export const mrCategorySchema = z.enum([
  'ide_membership',
  'coding_plan',
  'token_plan',
  'enterprise_seat',
]);

/** 源抓取策略（design D9，3 值）。 */
export const mrFetchStrategySchema = z.enum(['http', 'browser', 'manual']);

/** 币种（design D4/D5，大写 ISO 4217）。5b 扩集；列类型为 varchar(3) 而非 text。 */
export const mrCurrencySchema = z.enum(['CNY', 'USD']);

/**
 * 额度类型（design D1，桶2 样例集）。`credit`/`fast_pass` 等留 5b 全桶入库随录入扩。
 * `none` = 不限（恰一行 {limit_type:'none', value:NULL, window:'none'}）。
 */
export const mrLimitTypeSchema = z.enum([
  'monthly_tokens',
  'rolling_5h_requests',
  'weekly_messages',
  'none',
]);

/** 待复核标状态（design D10）。 */
export const mrReviewFlagStatusSchema = z.enum(['pending', 'resolved']);

/** 待复核标目标类型（design D10，粗于 provenance：不含 model/client/junction）。 */
export const mrReviewFlagTargetTypeSchema = z.enum(['plan', 'source', 'vendor']);

/** 兼容端类型（design D2，防工具/协议同名误撞）。 */
export const mrClientTypeSchema = z.enum(['tool', 'protocol']);

/**
 * `mr_plans` 写入校验 —— 价格/币种同生同灭（design D6）。
 *
 * `current_price` 与 `currency` 必须**要么都有、要么都 NULL**（needs_login_recheck 占位时皆 NULL）。
 * 半 NULL 态（有价无币 / 有币无价）由本 refine 拒——DB 零-CHECK 不挡，故合法性闸落在 Zod。
 * 仅校验同生同灭与 category/currency/source_confidence 取值集；其余列（name/source_url/last_checked 等）
 * 的存在性/格式校验留 5b 录入路径按需补。
 *
 * 注：`family` 小写归一是 5b 录入契约（design D3），5a 不加 transform，故本文件不含 mr_models 的 family 处理。
 */
export const mrPlanWriteSchema = z
  .object({
    category: mrCategorySchema,
    currentPrice: z.union([z.string(), z.number()]).nullable(),
    currency: mrCurrencySchema.nullable(),
    sourceConfidence: mrSourceConfidenceSchema,
  })
  .refine(
    (v) => (v.currentPrice == null) === (v.currency == null),
    'current_price 与 currency 必须同生同灭（要么都有、要么都 NULL）',
  );
