/**
 * Model Radar（P5 / 5a，add-model-radar-data-model）应用层校验闸 —— `mr_*` 有限值集列 Zod 枚举 +
 * `mr_plans` 同生同灭 refine。
 *
 * 关键不变量（design D4/D6/D10 + 风险/权衡）：
 * 全仓零 pg-enum / 零 DB CHECK（对齐 ai_experiences 注释「唯一防线是 Zod」）——`mr_*` 表的取值集
 * 合法性**唯一防线就是本文件的 Zod**。每个有限值集列都必须有枚举闸，否则绕过录入的写入方可写脏值
 * （DB 放行）。**所有有限值集列均须经此校验**，`mr_plans` 价格/币种同生同灭须经 refine。
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
 * 已核官方 provenance 集合（5c / compare-api，design D4）：**唯有这两类可携带非 NULL 价格**。
 * `needs_login_recheck`/`official_community`/`media_report` = 未核，写价时禁带非 NULL 价（须保持 NULL 占位）。
 * 读侧 `priceStatus='known'` 与录入侧 confidence↔price 绑定共用此集合，使「未核价冒充已核价进 cheapest」无路可走。
 */
export const MR_OFFICIAL_CONFIDENCES = [
  'official_pricing',
  'official_doc',
] as const satisfies readonly z.infer<typeof mrSourceConfidenceSchema>[];

/** 是否属已核官方 provenance（携带非 NULL 价的必要条件）。 */
export function isOfficialConfidence(c: string): boolean {
  return (MR_OFFICIAL_CONFIDENCES as readonly string[]).includes(c);
}

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

/** 套餐生命周期（与 source_confidence / reviewStatus.pending 三正交）。 */
export const mrAvailabilitySchema = z.enum(['on_sale', 'discontinued', 'unknown']);

/** 月价之外的订阅计费周期。`monthly` 禁止入周期价表，避免与 mr_plans.current_price 双 SOT。 */
export const mrBillingPeriodSchema = z.enum(['quarterly', 'annual']);

/** 源抓取策略（design D9，3 值）。 */
export const mrFetchStrategySchema = z.enum(['http', 'browser', 'manual']);

/**
 * 币种（design D4/D5，大写 ISO 4217）。列类型为 varchar(3) 而非 text。
 * 5b 全桶录入扩集（扩值不改语义，仍是 varchar(3) 内的 ISO 4217 大写——含欧元区订阅）。
 */
export const mrCurrencySchema = z.enum(['CNY', 'USD', 'EUR']);

/**
 * 额度类型（design D1）。5b 全桶录入扩集（扩值不改语义，仍是有限值集枚举闸）：
 * `credit` = Token Plan 通用积分额度；`fast_pass` = IDE会员/Coding Plan 快速通道额度。
 * `none` = 不限（恰一行 {limit_type:'none', value:NULL, window:'none'}）。
 */
export const mrLimitTypeSchema = z.enum([
  'monthly_tokens',
  'rolling_5h_requests',
  'weekly_messages',
  'credit',
  'fast_pass',
  'none',
]);

/** 待复核标状态（design D10）。 */
export const mrReviewFlagStatusSchema = z.enum(['pending', 'resolved']);

/** 待复核标目标类型（design D10，粗于 provenance：不含 model/client/junction）。 */
export const mrReviewFlagTargetTypeSchema = z.enum(['plan', 'source', 'vendor']);

/** 兼容端类型（design D2，防工具/协议同名误撞）。 */
export const mrClientTypeSchema = z.enum(['tool', 'protocol']);

/**
 * 价格金额校验（5c review）——贴合 numeric(12,2) 列：接受 `number | numeric-string`，但须
 * **有限（非 NaN/Infinity）、≥ 0、量级 < 1e10、小数位 ≤ 2**。无此闸时官方 provenance 的 `-1`/NaN/
 * 超 scale 价能落库并在比价 query 成 cheapest。仅校验、不 transform（保持调用方原值写 SQL）。
 */
export const mrPriceAmountSchema = z
  .union([z.string(), z.number()])
  .superRefine((v, ctx) => {
    const raw = typeof v === 'string' ? v.trim() : v;
    if (raw === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'price 不可为空' });
      return;
    }
    // 字符串入参限十进制字面量：拒 JS 进制/特殊字面量（0x10/0b101/0o12/Infinity/NaN/1.2.3）——否则 Number()
    // 放行后 String() 原样进 numeric(12,2) 成 SQL 晚错。负号由 ≥0 闸拒、科学计数法由 scale 闸过滤。
    if (typeof raw === 'string' && !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'price 须为十进制数值字面量（拒 0x/0b/0o/Infinity/NaN 等）' });
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'price 须为有限数值（非 NaN/Infinity）' });
      return;
    }
    if (n < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'price 不可为负' });
    }
    if (n >= 1e10) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'price 量级须 < 1e10（贴合 numeric(12,2)）' });
    }
    // 基于数值判 scale（非字符串小数点长度）——否则科学计数法（1e-3/1e-7，String() 无 `.`）绕过 scale 闸，
    // 0.001 落 numeric(12,2) 舍成 0.00 冒充免费 cheapest。量级无关判定 Number(n.toFixed(2)) === n
    // （绝对 epsilon `n*100-round` 在大量级浮点 ULP > 1e-9 会误拒合法 2 位小数价，如 1234567.89）。
    if (Number(n.toFixed(2)) !== n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'price 小数位须 ≤ 2（贴合 numeric(12,2)）' });
    }
  });

/**
 * `mr_plans` 写入校验 —— 价格/币种同生同灭（design D6）+ confidence↔price 绑定（5c，design D4）。
 *
 * `current_price` 与 `currency` 必须**要么都有、要么都 NULL**（needs_login_recheck 占位时皆 NULL）。
 * 半 NULL 态（有价无币 / 有币无价）由 refine 拒——DB 零-CHECK 不挡，故合法性闸落在 Zod。
 *
 * **confidence↔price 绑定（5c 关键不变量，design D4）**：写非 NULL 价时 `source_confidence` 须 ∈
 * `MR_OFFICIAL_CONFIDENCES`（official_pricing/official_doc）；非官方/待复核 confidence
 * （needs_login_recheck/official_community/media_report）禁带非 NULL 价（current_price/currency 必 NULL）。
 * 落点是**共享 schema**，使 `upsertPlan` 新建 INSERT 与改价委托两路都过，未核价无法冒充已核价进 cheapest。
 *
 * 仅校验同生同灭、confidence↔price、与 category/currency/source_confidence 取值集；其余列
 * （name/source_url/last_checked 等）的存在性/格式校验留录入路径按需补。
 *
 * 注：`family` 小写归一是 5b 录入契约（design D3），5a 不加 transform，故本文件不含 mr_models 的 family 处理。
 */
export const mrPlanWriteSchema = z
  .object({
    category: mrCategorySchema,
    availability: mrAvailabilitySchema.default('unknown'),
    currentPrice: z.union([z.string(), z.number()]).nullable(),
    currency: mrCurrencySchema.nullable(),
    sourceConfidence: mrSourceConfidenceSchema,
  })
  .refine(
    (v) => (v.currentPrice == null) === (v.currency == null),
    'current_price 与 currency 必须同生同灭（要么都有、要么都 NULL）',
  )
  .refine(
    (v) => v.currentPrice == null || isOfficialConfidence(v.sourceConfidence),
    '非官方 source_confidence 禁带非 NULL 价格（official_pricing/official_doc 才可写价；needs_login_recheck/official_community/media_report 须保持 current_price/currency=NULL）',
  )
  .refine(
    (v) => v.currentPrice == null || mrPriceAmountSchema.safeParse(v.currentPrice).success,
    'current_price 非法（须有限、≥ 0、量级 < 1e10、小数位 ≤ 2，贴合 numeric(12,2)）',
  );

/** 周期价读/写侧派生价格状态：known 当且仅当 price 非 NULL 且 provenance 属官方已核集合。 */
export function getMrPlanPriceStatus(input: {
  price: string | number | null;
  source_confidence: string;
}): 'known' | 'unknown' {
  return input.price !== null && isOfficialConfidence(input.source_confidence)
    ? 'known'
    : 'unknown';
}

/**
 * `mr_plan_prices` 周期价行校验 —— 只允许季度/年付、币种必填、price 可 NULL，占位行仍保留 provenance。
 *
 * confidence↔price 绑定：非官方/待复核 confidence 禁带非 NULL price；priceStatus 派生为
 * `known` 当且仅当 price 非 NULL + official confidence。官方 confidence + NULL price 仍被解析为 unknown，
 * 供上层授权写路径按事实冲突/待核语义决定是否接受。
 */
export const mrPlanPriceSchema = z
  .object({
    plan_id: z.string().min(1),
    billing_period: mrBillingPeriodSchema,
    price: mrPriceAmountSchema.nullable(),
    currency: mrCurrencySchema,
    source_url: z.string().min(1),
    last_checked: z.date(),
    source_confidence: mrSourceConfidenceSchema,
  })
  .superRefine((v, ctx) => {
    if (v.price !== null && !isOfficialConfidence(v.source_confidence)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          '非官方 source_confidence 禁带非 NULL 周期价（official_pricing/official_doc 才可写价；needs_login_recheck/official_community/media_report 须保持 price=NULL）',
      });
    }
  });

export type MrBillingPeriod = z.infer<typeof mrBillingPeriodSchema>;
