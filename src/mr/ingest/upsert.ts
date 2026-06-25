/**
 * Model Radar（P5 / 5b，add-model-radar-ingestion-freshness）录入 upsert 写路径（task 1.2/1.3/1.5，design D2/D3）。
 *
 * 职责：把 5a 写契约接进生产录入路径。**区分两类写**（design D2）：
 * - **identity-upsert**（`upsertVendor`/`upsertModel`/`upsertSource`）：唯一键冲突幂等 no-op，无事实字段冲突概念。
 * - **fact guarded-write**（`upsertPlan`/`upsertPlanLimit`/`upsertPlanClient`/`upsertPlanModel`）：断言事实表，
 *   机制 = `INSERT … ON CONFLICT DO NOTHING RETURNING` → RETURNING 空则读既有行**数值归一逐字段比对事实字段** →
 *   相同=幂等 no-op、不同=返回 `{conflict,field,…}` + 打 flag（`setReviewFlag`），**永不 `onConflictDoUpdate`
 *   盲覆盖事实字段**；二次读容 0 行不 NPE（单写者前提下视竞态 no-op，绝不 NPE，design D2）。
 *
 * **价格路径例外**（design D2/D4）：existing-plan 的价格/币种及对应 provenance 变更**只经 `recordPriceChange`
 * 同事务更新**——`upsertPlan` 检测到既有 plan 价/币变即委托该入口，禁裸改 `current_price`。本模块 fact-write
 * 冲突分支对事实字段**只返回 + 打 flag、禁 `.set()` 盲覆盖**。
 *
 * `mr_plan_sources` 定位边录入（task 1.7）归本组但属其他组复选框；本文件只产 upsert*，不含 1.6/1.7。
 *
 * 各表事实字段（design D2，lint/test 据此判「盲覆盖」）：
 * - plan = `current_price/currency/source_url/source_confidence` + **`category`**（5a 唯一键 (vendor_id,name)
 *   不含 category，同 (vendor_id,name) 重录但 category 异**必须打 conflict、不静默 no-op**）。
 * - limit = `value/window/source_url/source_confidence`（window 是唯一键组件，异 window 走新行不冲突）。
 * - client/model junction = `source_confidence/source_url`。
 * - `last_checked` 是可自由刷新的 provenance（非事实字段）；本模块录入不主动刷它（刷新归 dispose/staleness）。
 */
import { and, eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import {
  mrModels,
  mrPlanClients,
  mrPlanLimits,
  mrPlanModels,
  mrPlanSources,
  mrPlans,
  mrSource,
  mrVendors,
} from '../../db/schema.js';
import {
  mrModelWriteSchema,
  mrPlanClientWriteSchema,
  mrPlanLimitWriteSchema,
  mrPlanModelWriteSchema,
  mrPlanWriteValidator,
  mrSourceWriteSchema,
} from './validators.js';
import { _recordPriceChangeTx } from './record-price-change.js';
import { setReviewFlag } from '../write/flag.js';
// design D10 双层闸的录入侧：录入 source 前断言 source_url 过 SSRF 白名单（scheme/私网/host）。
// 纯校验函数，不触发抓取——结构守卫只禁 scrape→ingest，不禁 ingest→scrape 的校验 import。
import { assertUrlAllowed } from '../scrape/ssrf-guard.js';

/** db 句柄类型（drizzle 实例或事务），用于依赖注入/集成测（对齐 kb/store.ts）。 */
type DbLike = typeof defaultDb;
type TxLike = Parameters<Parameters<DbLike['transaction']>[0]>[0];
type Dbh = DbLike | TxLike;

/** identity-upsert 结果。 */
export type IdentityUpsertOutcome =
  /** 新建身份行。 */
  | { outcome: 'inserted'; id: string }
  /** 唯一键命中既有行（幂等）。 */
  | { outcome: 'exists'; id: string };

/** fact guarded-write 结果（design D2）。 */
export type FactWriteOutcome =
  /** 新建事实行。 */
  | { outcome: 'inserted'; id: string }
  /** 既有行事实字段逐字段相同（幂等 no-op）。 */
  | { outcome: 'noop'; id: string }
  /** 既有行某事实字段不同 → 已打 flag、不盲覆盖。 */
  | { outcome: 'conflict'; id: string; field: string; existing: unknown; incoming: unknown }
  /** 既有 plan 价/币变 → 已委托 recordPriceChange（授权事实更新，非盲覆盖）。 */
  | { outcome: 'price-delegated'; id: string }
  /** 二次读 0 行（单写者竞态）→ 视 no-op，绝不 NPE。 */
  | { outcome: 'noop-race' };

/** 数值归一比对（numeric 列回读为 string，`'45.00'` vs `45` 须判同；NULL 双方皆 null=同）。 */
function numericEq(a: string | null, b: number | string | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Number(a) === Number(b);
}

// ───────────────────────── identity-upsert（唯一键冲突幂等）─────────────────────────

/** 厂商身份录入（identity）。`normalized_name` 唯一键冲突幂等。归一小写是录入契约（调用方传入已归一值）。 */
export async function upsertVendor(
  dbh: Dbh,
  v: { normalizedName: string; name: string },
): Promise<IdentityUpsertOutcome> {
  const inserted = await dbh
    .insert(mrVendors)
    .values({ normalizedName: v.normalizedName, name: v.name })
    .onConflictDoNothing({ target: [mrVendors.normalizedName] })
    .returning({ id: mrVendors.id });
  if (inserted.length > 0) return { outcome: 'inserted', id: inserted[0]!.id };

  const existing = await dbh
    .select({ id: mrVendors.id })
    .from(mrVendors)
    .where(eq(mrVendors.normalizedName, v.normalizedName))
    .limit(1);
  return { outcome: 'exists', id: existing[0]!.id };
}

/**
 * 模型身份录入（identity，design D3）。**写前 `family` 小写归一**——过 `mrModelWriteSchema`
 * （内建 `.toLowerCase().trim()` transform），用**解析后的值**写 SQL，防 `GLM`/`glm` 因
 * `UNIQUE(vendor_id,family,version)` 大小写敏感误分裂。version 不归一（保留版本号原貌）。
 */
export async function upsertModel(
  dbh: Dbh,
  m: { vendorId: string; family: string; version: string },
): Promise<IdentityUpsertOutcome> {
  // design D3：family 写前归一。用解析后的值写 SQL（天然归一）。
  const { family, version } = mrModelWriteSchema.parse({
    family: m.family,
    version: m.version,
  });
  const inserted = await dbh
    .insert(mrModels)
    .values({ vendorId: m.vendorId, family, version })
    .onConflictDoNothing({
      target: [mrModels.vendorId, mrModels.family, mrModels.version],
    })
    .returning({ id: mrModels.id });
  if (inserted.length > 0) return { outcome: 'inserted', id: inserted[0]!.id };

  const existing = await dbh
    .select({ id: mrModels.id })
    .from(mrModels)
    .where(
      and(
        eq(mrModels.vendorId, m.vendorId),
        eq(mrModels.family, family),
        eq(mrModels.version, version),
      ),
    )
    .limit(1);
  return { outcome: 'exists', id: existing[0]!.id };
}

/**
 * 源身份录入（identity，design D9）。`UNIQUE(vendor_id, source_url)` 冲突幂等。
 * 写前过 `mrSourceWriteSchema`（`fetch_strategy` 有限值列，非录入路径写非法值须发 SQL 前被拒）。
 */
export async function upsertSource(
  dbh: Dbh,
  s: { vendorId: string; sourceUrl: string; fetchStrategy: string },
): Promise<IdentityUpsertOutcome> {
  const { fetchStrategy } = mrSourceWriteSchema.parse({
    fetchStrategy: s.fetchStrategy,
  });
  // design D10 双层闸（录入侧）：scheme 非 http(s)/私网/host ∉ 白名单 → 抛 SsrfBlockedError 不落库。
  // **仅对 `http`/`browser` will-fetch 源**断言（D10：manual 源不发请求、豁免该闸，URL 仅人类参考）。
  if (fetchStrategy === 'http' || fetchStrategy === 'browser') {
    assertUrlAllowed(s.sourceUrl);
  }
  const inserted = await dbh
    .insert(mrSource)
    .values({ vendorId: s.vendorId, sourceUrl: s.sourceUrl, fetchStrategy })
    .onConflictDoNothing({ target: [mrSource.vendorId, mrSource.sourceUrl] })
    .returning({ id: mrSource.id });
  if (inserted.length > 0) return { outcome: 'inserted', id: inserted[0]!.id };

  const existing = await dbh
    .select({ id: mrSource.id })
    .from(mrSource)
    .where(
      and(eq(mrSource.vendorId, s.vendorId), eq(mrSource.sourceUrl, s.sourceUrl)),
    )
    .limit(1);
  return { outcome: 'exists', id: existing[0]!.id };
}

// ───────────────────────── fact guarded-write（ON CONFLICT DO NOTHING + 比对 + 打标）─────────────────────────

/** plan 录入参数。`name` = 套餐全名（含产品上下文，非裸档位，见 task 1.5 守护）。 */
export interface PlanWriteInput {
  vendorId: string;
  name: string;
  category: string;
  /** numeric(12,2)，与 currency 同生同灭。 */
  currentPrice: number | string | null;
  currency: string | null;
  sourceUrl: string;
  sourceConfidence: string;
  /** 录入时刻的核对时间（NOT NULL 列）。 */
  lastChecked?: Date;
}

/** 裸档位档名集合（task 1.5 守护：name 应为套餐全名，裸档位无法可靠机器识别故仅告警）。 */
const BARE_TIER_NAMES = new Set([
  'pro',
  'plus',
  'max',
  'free',
  'basic',
  'team',
  'enterprise',
  'starter',
  'standard',
  'premium',
  'ultimate',
]);

/**
 * 套餐录入（fact guarded-write，design D2）。
 *
 * 流程：
 * 1. 过 Zod（`mrPlanWriteValidator`：category/currency/source_confidence 取值集 + 价格币种同生同灭 refine）。
 * 2. **task 1.5 裸档位告警**：`name` 应为套餐全名（含产品上下文）。裸档位（如 'Pro'）跨桶易误撞唯一键
 *    `(vendor_id, name)`，**但裸档位无法可靠机器识别**（'Pro' 既可能是裸档位也可能是产品名片段），
 *    故只告警不拒（design 注明）。
 * 3. `INSERT … ON CONFLICT(vendor_id, name) DO NOTHING RETURNING id`。
 *    - 非空 → 新建。
 *    - 空 → 读既有行逐字段比对事实字段（category/source_url/source_confidence；价/币走 recordPriceChange）：
 *      - **category 异** → conflict + 打 flag（唯一键不含 category，必须打不静默 no-op）。
 *      - **价/币异**（且非 NULL→NULL 占位回退）→ 委托 `recordPriceChange`（授权事实更新，非盲覆盖）。
 *      - source_url/source_confidence 异 → conflict + 打 flag。
 *      - 全同 → 幂等 no-op。
 */
export async function upsertPlan(
  dbh: DbLike,
  p: PlanWriteInput,
): Promise<FactWriteOutcome> {
  const parsed = mrPlanWriteValidator.parse({
    category: p.category,
    currentPrice: p.currentPrice,
    currency: p.currency,
    sourceConfidence: p.sourceConfidence,
  });

  // task 1.5：裸档位告警（无法可靠机器识别故仅告警，design 注明）。
  if (BARE_TIER_NAMES.has(p.name.trim().toLowerCase())) {
    console.warn(
      `[mr-ingest] upsertPlan: name='${p.name}' 疑为裸档位；约定 name=套餐全名（含产品上下文，如 'Coding Plan Pro'）以免跨桶误撞唯一键 (vendor_id,name)。仅告警（裸档位无法可靠机器识别）。`,
    );
  }

  // design D4 原子性：guarded-read + 价变委托须同事务（否则改价决策与加锁读跨两 tx，TOCTOU）。
  return dbh.transaction(async (tx): Promise<FactWriteOutcome> => {
    const inserted = await tx
      .insert(mrPlans)
      .values({
        vendorId: p.vendorId,
        name: p.name,
        category: parsed.category,
        currentPrice: p.currentPrice == null ? null : String(p.currentPrice),
        currency: p.currency,
        sourceUrl: p.sourceUrl,
        sourceConfidence: parsed.sourceConfidence,
        lastChecked: p.lastChecked ?? sql`now()`,
      })
      .onConflictDoNothing({ target: [mrPlans.vendorId, mrPlans.name] })
      .returning({ id: mrPlans.id });
    if (inserted.length > 0) return { outcome: 'inserted', id: inserted[0]!.id };

    const existingRows = await tx
      .select({
        id: mrPlans.id,
        category: mrPlans.category,
        currentPrice: mrPlans.currentPrice,
        currency: mrPlans.currency,
        sourceUrl: mrPlans.sourceUrl,
        sourceConfidence: mrPlans.sourceConfidence,
      })
      .from(mrPlans)
      .where(and(eq(mrPlans.vendorId, p.vendorId), eq(mrPlans.name, p.name)))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) return { outcome: 'noop-race' }; // 二次读 0 行：竞态 no-op，绝不 NPE。

    // category 异（唯一键不含 category）→ conflict + 打 flag，不静默 no-op。
    if (existing.category !== parsed.category) {
      await setReviewFlag(
        tx,
        { targetType: 'plan', targetId: existing.id },
        `plan category 冲突: 既有 ${existing.category} 异于 ${parsed.category}`,
      );
      return {
        outcome: 'conflict',
        id: existing.id,
        field: 'category',
        existing: existing.category,
        incoming: parsed.category,
      };
    }

    // existing 有价、incoming 价/币降级为 NULL 占位 → conflict + 打 flag（不改 current、不委托）。
    if (existing.currentPrice != null && p.currentPrice == null) {
      await setReviewFlag(
        tx,
        { targetType: 'plan', targetId: existing.id },
        `plan 价格降级为占位: 既有 ${existing.currentPrice}/${existing.currency} 异于 incoming NULL（价→占位降级）`,
      );
      return {
        outcome: 'conflict',
        id: existing.id,
        field: 'current_price',
        existing: existing.currentPrice,
        incoming: null,
      };
    }

    // 价/币变 → 委托 _recordPriceChangeTx（同事务、唯一授权刷 plan 事实字段的入口，禁裸改 current_price）。
    // 仅当传入了真价（currentPrice 非 NULL）且与既有不同才委托；NULL 占位回退已在上面拦下。
    const priceDiffers =
      p.currentPrice != null &&
      (!numericEq(existing.currentPrice, p.currentPrice) ||
        existing.currency !== p.currency);
    if (priceDiffers) {
      await _recordPriceChangeTx(tx, {
        planId: existing.id,
        newValue: p.currentPrice!,
        currency: p.currency!,
        provenance: {
          sourceUrl: p.sourceUrl,
          sourceConfidence: parsed.sourceConfidence,
        },
      });
      return { outcome: 'price-delegated', id: existing.id };
    }

    // 其余 provenance 事实字段（source_url/source_confidence）异 → conflict + 打 flag。
    if (existing.sourceUrl !== p.sourceUrl) {
      await setReviewFlag(
        tx,
        { targetType: 'plan', targetId: existing.id },
        `plan source_url 冲突: 既有 ${existing.sourceUrl} 异于 ${p.sourceUrl}`,
      );
      return {
        outcome: 'conflict',
        id: existing.id,
        field: 'source_url',
        existing: existing.sourceUrl,
        incoming: p.sourceUrl,
      };
    }
    if (existing.sourceConfidence !== parsed.sourceConfidence) {
      await setReviewFlag(
        tx,
        { targetType: 'plan', targetId: existing.id },
        `plan source_confidence 冲突: 既有 ${existing.sourceConfidence} 异于 ${parsed.sourceConfidence}`,
      );
      return {
        outcome: 'conflict',
        id: existing.id,
        field: 'source_confidence',
        existing: existing.sourceConfidence,
        incoming: parsed.sourceConfidence,
      };
    }

    return { outcome: 'noop', id: existing.id };
  });
}

/**
 * 限额录入（fact guarded-write，design D2）。唯一键 `(plan_id, limit_type, window)`——异 window 是新行。
 * 既有 (plan_id, limit_type, window) 行的事实字段 = `value/source_url/source_confidence`（window 是键非事实字段）。
 */
export async function upsertPlanLimit(
  dbh: Dbh,
  l: {
    planId: string;
    limitType: string;
    value: number | string | null;
    window: string;
    sourceUrl: string;
    sourceConfidence: string;
    lastChecked?: Date;
  },
): Promise<FactWriteOutcome> {
  const { limitType, sourceConfidence } = mrPlanLimitWriteSchema.parse({
    limitType: l.limitType,
    sourceConfidence: l.sourceConfidence,
  });

  const inserted = await dbh
    .insert(mrPlanLimits)
    .values({
      planId: l.planId,
      limitType,
      value: l.value == null ? null : String(l.value),
      window: l.window,
      sourceUrl: l.sourceUrl,
      sourceConfidence,
      lastChecked: l.lastChecked ?? sql`now()`,
    })
    .onConflictDoNothing({
      target: [mrPlanLimits.planId, mrPlanLimits.limitType, mrPlanLimits.window],
    })
    .returning({ id: mrPlanLimits.id });
  if (inserted.length > 0) return { outcome: 'inserted', id: inserted[0]!.id };

  const existingRows = await dbh
    .select({
      id: mrPlanLimits.id,
      value: mrPlanLimits.value,
      sourceUrl: mrPlanLimits.sourceUrl,
      sourceConfidence: mrPlanLimits.sourceConfidence,
    })
    .from(mrPlanLimits)
    .where(
      and(
        eq(mrPlanLimits.planId, l.planId),
        eq(mrPlanLimits.limitType, limitType),
        eq(mrPlanLimits.window, l.window),
      ),
    )
    .limit(1);
  const existing = existingRows[0];
  if (!existing) return { outcome: 'noop-race' };

  const conflict =
    !numericEq(existing.value, l.value)
      ? { field: 'value', existing: existing.value, incoming: l.value }
      : existing.sourceUrl !== l.sourceUrl
        ? { field: 'source_url', existing: existing.sourceUrl, incoming: l.sourceUrl }
        : existing.sourceConfidence !== sourceConfidence
          ? {
              field: 'source_confidence',
              existing: existing.sourceConfidence,
              incoming: sourceConfidence,
            }
          : null;
  if (conflict) {
    await setReviewFlag(
      dbh,
      { targetType: 'plan', targetId: l.planId },
      `plan_limit ${conflict.field} 冲突（${limitType}/${l.window}）: 既有 ${conflict.existing} 异于 ${conflict.incoming}`,
    );
    return { outcome: 'conflict', id: existing.id, ...conflict };
  }
  return { outcome: 'noop', id: existing.id };
}

/**
 * 工具/协议兼容录入（fact guarded-write junction，design D2）。唯一键 `(plan_id, client_type, client_id)`。
 * 既有行事实字段 = `source_confidence/source_url`。
 */
export async function upsertPlanClient(
  dbh: Dbh,
  c: {
    planId: string;
    clientType: string;
    clientId: string;
    sourceUrl: string;
    sourceConfidence: string;
    lastChecked?: Date;
  },
): Promise<FactWriteOutcome> {
  const { clientType, sourceConfidence } = mrPlanClientWriteSchema.parse({
    clientType: c.clientType,
    sourceConfidence: c.sourceConfidence,
  });

  const inserted = await dbh
    .insert(mrPlanClients)
    .values({
      planId: c.planId,
      clientType,
      clientId: c.clientId,
      sourceUrl: c.sourceUrl,
      sourceConfidence,
      lastChecked: c.lastChecked ?? sql`now()`,
    })
    .onConflictDoNothing({
      target: [
        mrPlanClients.planId,
        mrPlanClients.clientType,
        mrPlanClients.clientId,
      ],
    })
    .returning({ id: mrPlanClients.id });
  if (inserted.length > 0) return { outcome: 'inserted', id: inserted[0]!.id };

  const existingRows = await dbh
    .select({
      id: mrPlanClients.id,
      sourceUrl: mrPlanClients.sourceUrl,
      sourceConfidence: mrPlanClients.sourceConfidence,
    })
    .from(mrPlanClients)
    .where(
      and(
        eq(mrPlanClients.planId, c.planId),
        eq(mrPlanClients.clientType, clientType),
        eq(mrPlanClients.clientId, c.clientId),
      ),
    )
    .limit(1);
  const existing = existingRows[0];
  if (!existing) return { outcome: 'noop-race' };

  const conflict =
    existing.sourceUrl !== c.sourceUrl
      ? { field: 'source_url', existing: existing.sourceUrl, incoming: c.sourceUrl }
      : existing.sourceConfidence !== sourceConfidence
        ? {
            field: 'source_confidence',
            existing: existing.sourceConfidence,
            incoming: sourceConfidence,
          }
        : null;
  if (conflict) {
    await setReviewFlag(
      dbh,
      { targetType: 'plan', targetId: c.planId },
      `plan_client ${conflict.field} 冲突（${clientType}/${c.clientId}）: 既有 ${conflict.existing} 异于 ${conflict.incoming}`,
    );
    return { outcome: 'conflict', id: existing.id, ...conflict };
  }
  return { outcome: 'noop', id: existing.id };
}

/**
 * 模型兼容录入（fact guarded-write junction，design D1/D2，**不可漏**）。唯一键 `(plan_id, model_id)`。
 * 既有行事实字段 = `source_confidence/source_url`。
 */
export async function upsertPlanModel(
  dbh: Dbh,
  m: {
    planId: string;
    modelId: string;
    sourceUrl: string;
    sourceConfidence: string;
    lastChecked?: Date;
  },
): Promise<FactWriteOutcome> {
  const { sourceConfidence } = mrPlanModelWriteSchema.parse({
    sourceConfidence: m.sourceConfidence,
  });

  const inserted = await dbh
    .insert(mrPlanModels)
    .values({
      planId: m.planId,
      modelId: m.modelId,
      sourceUrl: m.sourceUrl,
      sourceConfidence,
      lastChecked: m.lastChecked ?? sql`now()`,
    })
    .onConflictDoNothing({
      target: [mrPlanModels.planId, mrPlanModels.modelId],
    })
    .returning({ id: mrPlanModels.id });
  if (inserted.length > 0) return { outcome: 'inserted', id: inserted[0]!.id };

  const existingRows = await dbh
    .select({
      id: mrPlanModels.id,
      sourceUrl: mrPlanModels.sourceUrl,
      sourceConfidence: mrPlanModels.sourceConfidence,
    })
    .from(mrPlanModels)
    .where(
      and(eq(mrPlanModels.planId, m.planId), eq(mrPlanModels.modelId, m.modelId)),
    )
    .limit(1);
  const existing = existingRows[0];
  if (!existing) return { outcome: 'noop-race' };

  const conflict =
    existing.sourceUrl !== m.sourceUrl
      ? { field: 'source_url', existing: existing.sourceUrl, incoming: m.sourceUrl }
      : existing.sourceConfidence !== sourceConfidence
        ? {
            field: 'source_confidence',
            existing: existing.sourceConfidence,
            incoming: sourceConfidence,
          }
        : null;
  if (conflict) {
    await setReviewFlag(
      dbh,
      { targetType: 'plan', targetId: m.planId },
      `plan_model ${conflict.field} 冲突（model=${m.modelId}）: 既有 ${conflict.existing} 异于 ${conflict.incoming}`,
    );
    return { outcome: 'conflict', id: existing.id, ...conflict };
  }
  return { outcome: 'noop', id: existing.id };
}

// ───────────────────────── 定位边录入（task 1.7，纯 junction，ON CONFLICT DO NOTHING）─────────────────────────

/** 定位边录入结果（纯定位边，无事实字段冲突概念，design D9）。 */
export type PlanSourceUpsertOutcome =
  /** 新建边。 */
  | { outcome: 'inserted'; id: string }
  /** `(source_id, plan_id)` 边已存（幂等 no-op）。 */
  | { outcome: 'exists' };

/**
 * 源↔套餐定位边录入（task 1.7，design D9）。**纯定位边，无 provenance/事实字段**——
 * 「源指纹变 → 经此边定位覆盖 plan 集合 → 打标」靠它落地。`ON CONFLICT(source_id, plan_id) DO NOTHING`
 * 使重跑录入幂等（spec 场景「重跑录入边幂等」）。无枚举列故不过 Zod（task 1.1 明确不计）。
 */
export async function upsertPlanSource(
  dbh: Dbh,
  e: { sourceId: string; planId: string },
): Promise<PlanSourceUpsertOutcome> {
  const inserted = await dbh
    .insert(mrPlanSources)
    .values({ sourceId: e.sourceId, planId: e.planId })
    .onConflictDoNothing({
      target: [mrPlanSources.sourceId, mrPlanSources.planId],
    })
    .returning({ id: mrPlanSources.id });
  return inserted.length > 0
    ? { outcome: 'inserted', id: inserted[0]!.id }
    : { outcome: 'exists' };
}
