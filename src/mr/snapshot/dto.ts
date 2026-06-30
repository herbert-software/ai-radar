/**
 * Model Radar（P5 / 5c，add-model-radar-compare-api）只读快照 DTO + 查询响应 Zod schema（task 2.1）。
 *
 * 这是 5c 读路径的对外服务表征契约——组 C（过滤/排序）与组 D（缓存/ETag/内容哈希）依赖本文件导出的
 * 类型与 schema。本文件**只声明形状**，不含构建逻辑（见 ./build.ts）、不含 canonical 序列化/哈希（组 D）。
 *
 * 关键不变量（design D1/D8 / spec「快照版本与 ETag 必须随数据变更失效」）——**ETag = 服务表征的纯函数**：
 * - 服务表征 freshness **plan 级仅暴露离散 `stale: boolean`**（= 任一成分事实/源 stale 的聚合）；
 *   **绝不暴露 raw 秒级 `last_checked`、也不暴露 plan 级聚合 date**（raw last_checked 仅 builder 内部算 staleness）。
 * - **但每条事实行 provenance 暴露日粒度 `lastCheckedDate`**（5d-B，design D1）= `trunc_UTC(该行 last_checked)`
 *   的纯函数、**完全与 build/render `now` 无关**——now 推进即便跨任何 UTC 自然午夜也不改它，仅该行 `last_checked`
 *   被**写**到新 UTC 日才变 → 进内容哈希仍稳定、不每日过度失效；「N 天前」相对文案只在 render 层算、**绝不**进 DTO/哈希。
 *   关联源行（`snapshotSourceSchema`）的 date 可为 null（`mr_source.last_checked` 可 NULL，从未抓源无 date）。
 * - **不含构建时刻 / now 派生连续量（ageMs）**：本 DTO 无 `builtAt`、无 `version` 字段——`builtAt` 是 builder
 *   内部、`mr_catalog_version` 留未来/内部，二者绝不进服务表征；`version`/ETag 由组 D 对本 DTO 内容哈希派生、
 *   作传输别名包在响应外层（不入哈希输入，避免自引用）。
 * 如此「同一 now 无变更→哈希稳定」与「now 跨 staleness 阈值→stale 翻转→哈希变」同时成立。
 *
 * 复用 `mr-schema.zod.ts` 既有枚举（单一事实来源，避免值集漂移）。
 */
import { z } from 'zod';
import {
  isOfficialConfidence,
  mrAvailabilitySchema,
  mrBillingPeriodSchema,
  mrCategorySchema,
  mrClientTypeSchema,
  mrCurrencySchema,
  mrFetchStrategySchema,
  mrLimitTypeSchema,
  mrPriceAmountSchema,
  mrSourceConfidenceSchema,
} from '../../db/mr-schema.zod.js';
import { effectiveMonthly } from '../effective-monthly.js';

/**
 * 每条断言事实的 provenance（plan 价格事实 + models/clients/limits）。
 * source_url/source_confidence 必带；`lastCheckedDate` = 日粒度 ISO 日期 `YYYY-MM-DD` = `trunc_UTC(该行 last_checked)`
 * （5d-B / design D1：日粒度、固定 UTC 截断、数据派生、完全 now 无关；这些事实行 `last_checked` 按 DDL NOT NULL → 必填）。
 * 仍不暴露 raw 秒级 `last_checked`（仅 builder 内部算 staleness）。
 */
export const snapshotProvenanceSchema = z.object({
  sourceUrl: z.string().refine((s) => s.trim().length > 0, 'source_url 不可为空（不可纯空白）'),
  sourceConfidence: mrSourceConfidenceSchema,
  lastCheckedDate: z.iso.date(),
});

/** 套餐↔模型兼容（去规范化 family:version + 该兼容断言自身 provenance）。 */
export const snapshotModelSchema = z.object({
  modelId: z.string(),
  /** 去版本号系列名（小写归一，录入契约；查询侧 `family:version` 按此匹配）。 */
  family: z.string(),
  /** 版本号；未标版本为哨兵空串 `''`。 */
  version: z.string(),
  provenance: snapshotProvenanceSchema,
});

/** 套餐↔工具/协议兼容（clientType ∈ {tool,protocol}，clientId 精确大小写敏感）。 */
export const snapshotClientSchema = z.object({
  clientType: mrClientTypeSchema,
  clientId: z.string(),
  provenance: snapshotProvenanceSchema,
});

/** 带类型限额（value 为 numeric→string，不限/占位时 NULL；window 哨兵文本）。 */
export const snapshotLimitSchema = z.object({
  limitType: mrLimitTypeSchema,
  value: z.string().nullable(),
  window: z.string(),
  provenance: snapshotProvenanceSchema,
});

/**
 * 套餐关联源（mr_source + mr_plan_sources 定位边去规范化；用于透明展示，不含 raw 秒级 last_checked）。
 * `lastCheckedDate` = `trunc_UTC(mr_source.last_checked)` 或 **null**——`mr_source.last_checked` 按 DDL 可 NULL
 * （从未抓源），故仅本 schema 的 date 可 null（事实 provenance 的 date 必填）。
 */
export const snapshotSourceSchema = z.object({
  sourceUrl: z.string().refine((s) => s.trim().length > 0, 'source_url 不可为空（不可纯空白）'),
  fetchStrategy: mrFetchStrategySchema,
  lastCheckedDate: z.iso.date().nullable(),
});

/** 价格状态（design D4：known 须同币种 + 已核官方 provenance；否则 unknown）。 */
export const priceStatusSchema = z.enum(['known', 'unknown']);

/** 月价之外的周期价行（展示字段；不参与 cheapest/sort）。 */
export const snapshotPeriodPriceSchema = z.object({
  billingPeriod: mrBillingPeriodSchema,
  price: z.string().nullable(),
  currency: mrCurrencySchema,
  priceStatus: priceStatusSchema,
  provenance: snapshotProvenanceSchema,
  effectiveMonthly: z.number().nullable(),
});

/**
 * 单个套餐的去规范化服务表征。
 *
 * `.superRefine` 钉死 known 不变量（双层兜的读侧防线）：priceStatus='known' ⟺ currentPrice/currency 非 NULL
 * 且 source_confidence ∈ 已核官方集合——builder 计算后此校验再核，逻辑漂移即 fail-closed 抛错（不返回坏快照）。
 */
export const snapshotPlanSchema = z
  .object({
    id: z.string(),
    vendorId: z.string(),
    /** 去规范化 vendor 名（覆盖 spec「快照必须覆盖 vendor」）。 */
    vendorName: z.string(),
    name: z.string(),
    category: mrCategorySchema,
    availability: mrAvailabilitySchema,
    /** numeric→string；priceStatus=unknown 时可为 NULL（占位）或非 NULL（非官方 confidence 带价）。 */
    currentPrice: z.string().nullable(),
    currency: mrCurrencySchema.nullable(),
    priceStatus: priceStatusSchema,
    provenance: snapshotProvenanceSchema,
    /** 离散 freshness（plan 级聚合：plan 自身 + child 事实行 + 关联源 last_checked 任一陈旧即 true）。 */
    freshness: z.object({ stale: z.boolean() }),
    /** 待复核（plan 级聚合：plan flag / vendor flag / 关联 source flag 任一 pending 即 true）。 */
    reviewStatus: z.object({ pending: z.boolean() }),
    periodPrices: z.array(snapshotPeriodPriceSchema),
    models: z.array(snapshotModelSchema),
    clients: z.array(snapshotClientSchema),
    limits: z.array(snapshotLimitSchema),
    sources: z.array(snapshotSourceSchema),
  })
  .superRefine((p, ctx) => {
    const officialOk = isOfficialConfidence(p.provenance.sourceConfidence);
    const known = p.currentPrice !== null && p.currency !== null && officialOk;
    if (p.priceStatus === 'known' && !known) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'priceStatus=known 必须满足 currentPrice/currency 非 NULL 且 source_confidence 属已核官方集合',
      });
    }
    // known 价数值合法性 fail-closed：DB 若存脏价（NaN/负/超 scale），读侧拒返坏快照，免 query Number() 成 NaN/负 cheapest。
    if (
      p.priceStatus === 'known' &&
      p.currentPrice !== null &&
      !mrPriceAmountSchema.safeParse(p.currentPrice).success
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'priceStatus=known 的 currentPrice 须为合法金额（有限、≥ 0、小数位 ≤ 2）',
      });
    }
    if (p.priceStatus === 'unknown' && known) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'priceStatus=unknown 但价格/币种/provenance 满足 known 条件，判定不一致',
      });
    }
    for (const pp of p.periodPrices) {
      const ppKnown =
        pp.price !== null && isOfficialConfidence(pp.provenance.sourceConfidence);
      if (pp.priceStatus === 'known' && !ppKnown) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['periodPrices'],
          message: 'period priceStatus=known 必须满足 price 非 NULL 且 source_confidence 属已核官方集合',
        });
      }
      if (pp.priceStatus === 'unknown' && ppKnown) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['periodPrices'],
          message: 'period priceStatus=unknown 但价格/provenance 满足 known 条件，判定不一致',
        });
      }
      if (pp.price !== null && !mrPriceAmountSchema.safeParse(pp.price).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['periodPrices'],
          message: 'period price 须为合法金额（有限、≥ 0、小数位 ≤ 2）',
        });
      }
      if (pp.priceStatus !== 'known' && pp.effectiveMonthly !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['periodPrices'],
          message: "period priceStatus!='known' 时 effectiveMonthly 必须为 null",
        });
      }
      if (p.category === 'token_plan' && pp.effectiveMonthly !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['periodPrices'],
          message: 'token_plan 不生成 effectiveMonthly',
        });
      }
      if (p.category !== 'token_plan' && pp.priceStatus === 'known') {
        const expected = effectiveMonthly(pp.price, pp.billingPeriod, pp.priceStatus);
        if (pp.effectiveMonthly !== expected) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['periodPrices'],
            message: 'period effectiveMonthly 与 price/billingPeriod/priceStatus 不一致',
          });
        }
      }
    }
  });

/** 完整只读快照（服务表征：plans 按 id 升序固定数组序，使组 D 内容哈希 canonical）。 */
export const modelRadarSnapshotSchema = z.object({
  plans: z.array(snapshotPlanSchema),
});

/** 排序作用域（design D4b：同桶同币种才可比；全未知价组 currency 为 null）。 */
export const snapshotSortScopeSchema = z.object({
  category: mrCategorySchema,
  currency: mrCurrencySchema.nullable(),
});

/**
 * 单个 (category, currency) 分组的查询响应（组 C 填充：known 价升序、unknown 排后）。
 * `cheapestPlanId` 指向本组 plans 内最便宜的已核价 plan；全 unknown 时为 null + comparable=false。
 */
export const snapshotPlanGroupSchema = z.object({
  sortScope: snapshotSortScopeSchema,
  plans: z.array(snapshotPlanSchema),
  cheapestPlanId: z.string().nullable(),
  comparable: z.boolean(),
  unknownCount: z.number().int().nonnegative(),
});

/** 比价检索响应（横切多桶时按 (category, currency) 分组；禁全局 price rank，design D3/D4）。 */
export const modelRadarQueryResponseSchema = z.object({
  groups: z.array(snapshotPlanGroupSchema),
});

export type SnapshotProvenance = z.infer<typeof snapshotProvenanceSchema>;
export type SnapshotModel = z.infer<typeof snapshotModelSchema>;
export type SnapshotClient = z.infer<typeof snapshotClientSchema>;
export type SnapshotLimit = z.infer<typeof snapshotLimitSchema>;
export type SnapshotSource = z.infer<typeof snapshotSourceSchema>;
export type PriceStatus = z.infer<typeof priceStatusSchema>;
export type SnapshotPeriodPrice = z.infer<typeof snapshotPeriodPriceSchema>;
export type SnapshotPlan = z.infer<typeof snapshotPlanSchema>;
export type ModelRadarSnapshot = z.infer<typeof modelRadarSnapshotSchema>;
export type SnapshotSortScope = z.infer<typeof snapshotSortScopeSchema>;
export type SnapshotPlanGroup = z.infer<typeof snapshotPlanGroupSchema>;
export type ModelRadarQueryResponse = z.infer<typeof modelRadarQueryResponseSchema>;
