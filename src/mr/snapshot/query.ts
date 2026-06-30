/**
 * Model Radar（P5 / 5c，add-model-radar-compare-api）比价检索的**纯函数过滤/排序层**（组 C，task 3.1–3.4）。
 *
 * 输入 = 组 B 已校验的 `ModelRadarSnapshot`（内存）+ 查询参数；输出 = 组 D 定义的查询响应（`{ groups }`）。
 * **不碰 DB、不碰 HTTP**（HTTP 路由 = 组 E；解析失败的 400 由组 E 把 ZodError 映射成 400）。
 *
 * 关键不变量（spec「比价检索 API 基于快照确定性过滤」「同桶价格排序必须按已核 provenance + 同币种判定」，design D3/D4/D4b）：
 * - 过滤全为确定性 AND；未知参数 / 非法枚举 / 非法 model 语法 / 裸预算 / currency↔maxMonthlyPrice 币种不一致 → Zod 拒（组 E→400）。
 * - 排序 scope = (category, currency)；`priceStatus` 由组 B builder 算好（known ⟺ 价/币非 NULL + 官方 provenance），**此处直接用、不重算 provenance**。
 * - 已知价仅在同一 (category, currency) 内升序，**不做 FX**；未知价（视为 currency=NULL）归入 `sortScope.currency=null` 组、不挂任何已知币种组、不成 cheapest。
 * - `requiresKnownPrice=true` / 带 `maxMonthlyPrice` / 带 `currency` 过滤时排除未知价（未知价无币种、不属任何币种结果集）。
 * - model 语法：`family:version` 冒号必填（family 小写匹配）、空版本 `family:` 匹配哨兵 `''`、裸 family→400；tool/protocol clientId 精确大小写敏感。
 */
import { z } from 'zod';
import { mrCategorySchema, mrCurrencySchema } from '../../db/mr-schema.zod.js';
import {
  modelRadarQueryResponseSchema,
  type ModelRadarQueryResponse,
  type ModelRadarSnapshot,
  type SnapshotPlan,
  type SnapshotPlanGroup,
} from './dto.js';

/** `model=family:version`：冒号必填（family 小写归一匹配），空版本 `family:` → 哨兵 `''`，裸 family（无冒号）→ 400。 */
const parsedModelSchema = z.string().transform((raw, ctx) => {
  const idx = raw.indexOf(':');
  if (idx === -1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'model 须为 family:version 形式（冒号必填；裸 family 如 "glm" 非法）',
    });
    return z.NEVER;
  }
  const family = raw.slice(0, idx).trim();
  if (family === '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'model family（首冒号前）不可为空（如 ":4.6" 非法）',
    });
    return z.NEVER;
  }
  return { family: family.toLowerCase(), version: raw.slice(idx + 1) };
});

/** `maxMonthlyPrice=数额 币种`（如 `100 CNY`）：必带 ISO 4217 大写币种；裸数额 / 非法币种 → 400。 */
const parsedBudgetSchema = z.string().transform((raw, ctx) => {
  const m = /^(\d+(?:\.\d+)?)\s+([A-Z]{3})$/.exec(raw.trim());
  if (!m) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'maxMonthlyPrice 须为「数额 币种」形式（如 "100 CNY"，必带大写 ISO 4217 币种）',
    });
    return z.NEVER;
  }
  const currency = mrCurrencySchema.safeParse(m[2]);
  if (!currency.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `maxMonthlyPrice 币种非法 ISO 4217 枚举：${m[2]}`,
    });
    return z.NEVER;
  }
  return { amount: Number(m[1]), currency: currency.data };
});

/**
 * 查询参数 Zod schema（task 3.1）。accepted 集与 spec 一致；`.strict()` 使未知参数 → 400。
 * 输入均为字符串（对齐 HTTP query map）；输出经 transform 后为已解析强类型。
 */
export const modelRadarQueryParamsSchema = z
  .object({
    category: mrCategorySchema.optional(),
    model: parsedModelSchema.optional(),
    tool: z.string().min(1).optional(),
    protocol: z.string().min(1).optional(),
    maxMonthlyPrice: parsedBudgetSchema.optional(),
    /** 限定结果币种（排除未知价/异币种 plan）；与 maxMonthlyPrice 同传须币种一致。 */
    currency: mrCurrencySchema.optional(),
    /** 单一开关（不设反向 includeUnknownPrice）：true 时排除未知价 plan。 */
    requiresKnownPrice: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      data.currency !== undefined &&
      data.maxMonthlyPrice !== undefined &&
      data.currency !== data.maxMonthlyPrice.currency
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currency'],
        message: `currency=${data.currency} 与 maxMonthlyPrice 币种=${data.maxMonthlyPrice.currency} 不一致`,
      });
    }
  });

export type ModelRadarQueryParams = z.infer<typeof modelRadarQueryParamsSchema>;

/** 确定性 AND 过滤（task 3.2/3.3：预算/currency/known-only 均排除未知价、不做 FX）。 */
function matchesFilters(p: SnapshotPlan, q: ModelRadarQueryParams): boolean {
  if (q.category !== undefined && p.category !== q.category) return false;

  const model = q.model;
  if (model && !p.models.some((m) => m.family === model.family && m.version === model.version)) {
    return false;
  }

  // clientId 精确大小写敏感匹配（录入侧不归一 clientId）。
  if (q.tool !== undefined && !p.clients.some((c) => c.clientType === 'tool' && c.clientId === q.tool)) {
    return false;
  }
  if (
    q.protocol !== undefined &&
    !p.clients.some((c) => c.clientType === 'protocol' && c.clientId === q.protocol)
  ) {
    return false;
  }

  // 未知价（priceStatus!=='known'）被以下三类谓词排除（未知价无币种、不属任何币种结果集）。
  if (q.requiresKnownPrice && p.priceStatus !== 'known') return false;
  if (q.currency !== undefined && (p.priceStatus !== 'known' || p.currency !== q.currency)) {
    return false;
  }
  const budget = q.maxMonthlyPrice;
  if (budget) {
    if (p.priceStatus !== 'known' || p.currency !== budget.currency) return false;
    if (Number(p.currentPrice) > budget.amount) return false; // 禁把 NULL 当 0：未知价已被上面排除
  }

  return true;
}

/**
 * 纯函数过滤 + 同桶排序 + 跨桶/跨币分组（task 3.2–3.4）。
 *
 * 分组键 = (category, effectiveCurrency)，其中 effectiveCurrency = 已知价 plan 的 `currency`、未知价 plan 视为 `null`。
 * 故未知价独立成 `sortScope.currency=null` 组（comparable=false / cheapest=null / unknownCount），不混入已知币种组、不成 cheapest。
 * 组序确定（category 升序、币种升序、null 末位）使「未知排已知后」在展开 groups 时成立。
 */
export function queryModelRadarSnapshot(
  snapshot: ModelRadarSnapshot,
  params: ModelRadarQueryParams,
): ModelRadarQueryResponse {
  const filtered = snapshot.plans.filter((p) => matchesFilters(p, params));

  const grouped = new Map<
    string,
    { category: SnapshotPlan['category']; currency: SnapshotPlan['currency']; plans: SnapshotPlan[] }
  >();
  for (const p of filtered) {
    const eff = p.priceStatus === 'known' ? p.currency : null;
    const key = `${p.category}\0${eff ?? ''}`; // 用 \0 分隔避免 category 与 currency 拼接碰撞；eff 为 null（未知价组）时用 ''
    const g = grouped.get(key);
    if (g) g.plans.push(p);
    else grouped.set(key, { category: p.category, currency: eff, plans: [p] });
  }

  const groups: SnapshotPlanGroup[] = [];
  for (const g of grouped.values()) {
    if (g.currency !== null) {
      // 已知币种组：组内全为已知价，数值升序；停售 plan 可列出但不参与 cheapest/comparable 候选。
      const plans = [...g.plans].sort((a, b) => Number(a.currentPrice) - Number(b.currentPrice));
      const cheapest = plans.find((p) => p.availability !== 'discontinued') ?? null;
      groups.push({
        sortScope: { category: g.category, currency: g.currency },
        plans,
        cheapestPlanId: cheapest?.id ?? null,
        comparable: cheapest !== null,
        unknownCount: 0,
      });
    } else {
      // 未知价组：currency=null、不可比、无 cheapest（保留 builder/过滤后的 id 升序）。
      groups.push({
        sortScope: { category: g.category, currency: null },
        plans: g.plans,
        cheapestPlanId: null,
        comparable: false,
        unknownCount: g.plans.length,
      });
    }
  }

  groups.sort((a, b) => {
    if (a.sortScope.category !== b.sortScope.category) {
      return a.sortScope.category < b.sortScope.category ? -1 : 1;
    }
    const ac = a.sortScope.currency;
    const bc = b.sortScope.currency;
    if (ac === bc) return 0;
    if (ac === null) return 1; // 未知价组排各 category 末位
    if (bc === null) return -1;
    return ac < bc ? -1 : 1;
  });

  // ponytail: 出口再校验响应契约（fail-closed），对小数据集成本可忽略；钉死「未知价混进可比组成 cheapest」等分组 bug。
  return modelRadarQueryResponseSchema.parse({ groups });
}
