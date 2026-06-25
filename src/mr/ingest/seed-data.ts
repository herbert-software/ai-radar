/**
 * Model Radar（P5 / 5b，add-model-radar-ingestion-freshness）已核 8 家全桶 checked-in seed fixture（task 1.6）。
 *
 * 职责：以**结构正确性 > 数据完整性**为原则，提供 8 家厂商身份 + 各桶 plan/limit/model/source/定位边的
 * 录入 fixture（带 provenance 三件套）。`runSeed`（见 seed.ts）用 Group B 的 `upsert*` + `upsertPlanSource`
 * 把它灌入 `mr_*`，全程过 5a Zod 闸、幂等可重跑。
 *
 * ⚠️ **精确事实禁臆造（Model Radar 红线）**：价格/额度/兼容是精确事实，绝不臆造数字。
 * - **有把握的公开官方价**（广为人知的国际订阅价）→ 填真值 + `official_pricing` + 官方定价页 URL。
 * - **无把握的**（登录墙后价 / 不确定的具体数字）→ 填 `needs_login_recheck` 占位
 *   （`currentPrice`/`currency`/`value` 皆 NULL，同生同灭由 5a refine 兜），或留 `// TODO 待策展核实`。
 * 宁可少录准确条目，不可多录臆测数字——保鲜回路 + 待复核机制兜后续核实。
 *
 * 已核 8 家全桶（docs/model-radar-tech-plan.md L154 跨桶清单）+ coding_plan 桶典范 Z.ai：
 * - **已核 8 家**：Token Plan 桶 Kimi / MiniMax / MiMo / Step（4）；IDE会员 桶 Trae / Qoder / Comate / CodeBuddy（4）。
 * - **coding_plan 典范**：Z.ai（GLM / bigmodel.cn，桶2 = v1 主桶，走 browser 档）——补满「三桶各 ≥1 例」。
 *   故 fixture 共 9 个 vendor 条目（8 已核 + Z.ai 典范）。本 fixture 取每桶代表覆盖，扩满全 plan 由策展随核实增补，不臆造。
 *
 * `name` = 套餐全名约定（含产品上下文，非裸档位，task 1.5）。`normalizedName` 录入前已小写归一（5b 契约）。
 * `family` 由 `upsertModel` 内建 transform 小写归一（design D3），fixture 写系列名即可。
 * `version` 未标版本填哨兵 `''`（schema.ts:429）。
 */

/** 来源置信度字面（与 5a mrSourceConfidenceSchema 取值一致）。 */
type SourceConfidence =
  | 'official_pricing'
  | 'official_doc'
  | 'official_community'
  | 'media_report'
  | 'needs_login_recheck';

/** 分桶 facet（与 5a mrCategorySchema 取值一致）。 */
type Category = 'ide_membership' | 'coding_plan' | 'token_plan' | 'enterprise_seat';

/** 抓取策略（与 5a mrFetchStrategySchema 取值一致）。 */
type FetchStrategy = 'http' | 'browser' | 'manual';

/** 限额行 fixture（value=null 表占位/不限/登录墙未知）。 */
interface SeedLimit {
  limitType: string;
  /** numeric；null = 占位/不限/登录墙未知（不臆造）。 */
  value: number | null;
  /** 哨兵 NOT NULL：'5h'/'week'/'month'/'none'。 */
  window: string;
}

/** 模型兼容 fixture（family 由 upsertModel 归一小写）。 */
interface SeedModel {
  family: string;
  /** 未标版本填哨兵 ''。 */
  version: string;
}

/** 工具/协议兼容 fixture。 */
interface SeedClient {
  /** 'tool' | 'protocol'。 */
  clientType: string;
  clientId: string;
}

/** 套餐 fixture（plan + 其 child 事实行 + 定位用源 URL）。 */
interface SeedPlan {
  /** 套餐全名（含产品上下文，task 1.5）。 */
  name: string;
  category: Category;
  /** numeric；null = needs_login_recheck 占位（与 currency 同生同灭）。 */
  currentPrice: number | null;
  /** ISO 4217 大写；与 currentPrice 同生同灭（null 占位）。 */
  currency: 'CNY' | 'USD' | 'EUR' | null;
  sourceUrl: string;
  sourceConfidence: SourceConfidence;
  limits: SeedLimit[];
  models: SeedModel[];
  clients: SeedClient[];
}

/** 抓取源 fixture（定位边 = 此源 ↔ 同 vendor 全部 plan）。 */
interface SeedSource {
  sourceUrl: string;
  fetchStrategy: FetchStrategy;
}

/** 厂商 fixture（身份 + 全桶 plan + 抓取源）。 */
export interface SeedVendor {
  /** 已小写归一去重键（5b 契约）。 */
  normalizedName: string;
  /** 展示名。 */
  name: string;
  plans: SeedPlan[];
  sources: SeedSource[];
}

/**
 * 已核 8 家全桶 fixture（checked-in）。每桶 ≥1 例，结构覆盖 plan/limit/model/client/source/定位边。
 *
 * 价格策略（禁臆造）：
 * - 这些为国内/登录墙后价或随活动浮动的套餐，**具体价数无把握** → 一律 `needs_login_recheck` 占位
 *   （currentPrice/currency 皆 NULL，同生同灭），由策展核实后经 recordPriceChange 录真价。
 * - fixture 重在**结构正确**（分桶 facet + 限额行类型 + 兼容 junction + provenance 链路 + 定位边），
 *   不在具体数字——数字靠保鲜回路核实，绝不在此臆造。
 */
export const SEED_VENDORS: SeedVendor[] = [
  // ───────── Coding Plan 桶：Z.ai（GLM，桶2 典范，JS 渲染 → browser 档）─────────
  {
    normalizedName: 'z.ai',
    name: 'Z.ai',
    sources: [
      // GLM coding plan 价页 JS 渲染（普通 fetch 读不到价）→ browser 档（tech-plan L44）。
      { sourceUrl: 'https://bigmodel.cn/glm-coding', fetchStrategy: 'browser' },
    ],
    plans: [
      {
        name: 'GLM Coding Plan Lite',
        category: 'coding_plan',
        // 登录墙/活动浮动，具体价无把握 → 占位待核实，不臆造。
        currentPrice: null,
        currency: null,
        sourceUrl: 'https://bigmodel.cn/glm-coding',
        sourceConfidence: 'needs_login_recheck',
        limits: [
          // 额度类型确定（按请求滚动窗），具体 value 无把握 → null 占位。
          { limitType: 'rolling_5h_requests', value: null, window: '5h' },
        ],
        models: [{ family: 'glm', version: '4.6' }],
        clients: [
          { clientType: 'tool', clientId: 'claude-code' },
          { clientType: 'protocol', clientId: 'anthropic-compatible' },
        ],
      },
      {
        name: 'GLM Coding Plan Pro',
        category: 'coding_plan',
        currentPrice: null,
        currency: null,
        sourceUrl: 'https://bigmodel.cn/glm-coding',
        sourceConfidence: 'needs_login_recheck',
        limits: [{ limitType: 'rolling_5h_requests', value: null, window: '5h' }],
        models: [{ family: 'glm', version: '4.6' }],
        clients: [{ clientType: 'tool', clientId: 'claude-code' }],
      },
    ],
  },

  // ───────── Token Plan 桶：Kimi / MiniMax / MiMo / Step（tech-plan L154）─────────
  {
    normalizedName: 'kimi',
    name: 'Kimi（Moonshot）',
    sources: [
      { sourceUrl: 'https://platform.moonshot.cn/docs/pricing', fetchStrategy: 'http' },
    ],
    plans: [
      {
        name: 'Kimi Open Platform Token Plan',
        category: 'token_plan',
        currentPrice: null,
        currency: null,
        sourceUrl: 'https://platform.moonshot.cn/docs/pricing',
        sourceConfidence: 'needs_login_recheck',
        limits: [
          // Token 桶通用积分额度类型确定，具体数无把握 → null 占位。
          { limitType: 'credit', value: null, window: 'month' },
        ],
        models: [{ family: 'kimi', version: 'k2' }],
        clients: [{ clientType: 'protocol', clientId: 'openai-compatible' }],
      },
    ],
  },
  {
    normalizedName: 'minimax',
    name: 'MiniMax',
    sources: [
      { sourceUrl: 'https://platform.minimaxi.com/document/price', fetchStrategy: 'http' },
    ],
    plans: [
      {
        name: 'MiniMax Open Platform Token Plan',
        category: 'token_plan',
        currentPrice: null,
        currency: null,
        sourceUrl: 'https://platform.minimaxi.com/document/price',
        sourceConfidence: 'needs_login_recheck',
        limits: [{ limitType: 'credit', value: null, window: 'month' }],
        models: [{ family: 'minimax', version: '' }],
        clients: [{ clientType: 'protocol', clientId: 'openai-compatible' }],
      },
    ],
  },
  {
    normalizedName: 'mimo',
    name: 'MiMo（小米）',
    sources: [
      // 待策展确认官方定价页 URL → 暂用 manual（不抓不臆造 URL）。
      { sourceUrl: 'https://xiaomimimo.com', fetchStrategy: 'manual' },
    ],
    plans: [
      {
        name: 'MiMo Token Plan',
        category: 'token_plan',
        currentPrice: null,
        currency: null,
        sourceUrl: 'https://xiaomimimo.com',
        sourceConfidence: 'needs_login_recheck',
        limits: [{ limitType: 'credit', value: null, window: 'month' }],
        models: [{ family: 'mimo', version: '' }],
        clients: [{ clientType: 'protocol', clientId: 'openai-compatible' }],
      },
    ],
  },
  {
    normalizedName: 'step',
    name: 'Step（阶跃星辰）',
    sources: [
      { sourceUrl: 'https://platform.stepfun.com/docs/pricing', fetchStrategy: 'http' },
    ],
    plans: [
      {
        name: 'StepFun Open Platform Token Plan',
        category: 'token_plan',
        currentPrice: null,
        currency: null,
        sourceUrl: 'https://platform.stepfun.com/docs/pricing',
        sourceConfidence: 'needs_login_recheck',
        limits: [{ limitType: 'credit', value: null, window: 'month' }],
        models: [{ family: 'step', version: '' }],
        clients: [{ clientType: 'protocol', clientId: 'openai-compatible' }],
      },
    ],
  },

  // ───────── IDE会员 桶：Trae / Qoder / Comate / CodeBuddy（tech-plan L154）─────────
  {
    normalizedName: 'trae',
    name: 'Trae（字节）',
    sources: [
      // 促销/首月价随活动浮动（tech-plan L87）→ 双周/manual，登录墙后价。
      { sourceUrl: 'https://www.trae.ai/pricing', fetchStrategy: 'http' },
    ],
    plans: [
      {
        name: 'Trae Pro',
        category: 'ide_membership',
        currentPrice: null,
        currency: null,
        sourceUrl: 'https://www.trae.ai/pricing',
        sourceConfidence: 'needs_login_recheck',
        limits: [
          // IDE会员快速通道额度类型确定，具体数无把握 → null 占位。
          { limitType: 'fast_pass', value: null, window: 'month' },
        ],
        models: [],
        clients: [{ clientType: 'tool', clientId: 'trae-ide' }],
      },
    ],
  },
  {
    normalizedName: 'qoder',
    name: 'Qoder（阿里）',
    sources: [
      { sourceUrl: 'https://qoder.com/pricing', fetchStrategy: 'http' },
    ],
    plans: [
      {
        name: 'Qoder Pro',
        category: 'ide_membership',
        currentPrice: null,
        currency: null,
        sourceUrl: 'https://qoder.com/pricing',
        sourceConfidence: 'needs_login_recheck',
        limits: [{ limitType: 'fast_pass', value: null, window: 'month' }],
        models: [],
        clients: [{ clientType: 'tool', clientId: 'qoder-ide' }],
      },
    ],
  },
  {
    normalizedName: 'comate',
    name: 'Comate（百度）',
    sources: [
      { sourceUrl: 'https://comate.baidu.com/pricing', fetchStrategy: 'http' },
    ],
    plans: [
      {
        name: 'Comate Pro',
        category: 'ide_membership',
        currentPrice: null,
        currency: null,
        sourceUrl: 'https://comate.baidu.com/pricing',
        sourceConfidence: 'needs_login_recheck',
        limits: [{ limitType: 'fast_pass', value: null, window: 'month' }],
        models: [],
        clients: [{ clientType: 'tool', clientId: 'comate-ide' }],
      },
    ],
  },
  {
    normalizedName: 'codebuddy',
    name: 'CodeBuddy（腾讯）',
    sources: [
      { sourceUrl: 'https://copilot.tencent.com/pricing', fetchStrategy: 'http' },
    ],
    plans: [
      {
        name: 'CodeBuddy Pro',
        category: 'ide_membership',
        currentPrice: null,
        currency: null,
        sourceUrl: 'https://copilot.tencent.com/pricing',
        sourceConfidence: 'needs_login_recheck',
        limits: [{ limitType: 'fast_pass', value: null, window: 'month' }],
        models: [],
        clients: [{ clientType: 'tool', clientId: 'codebuddy-ide' }],
      },
    ],
  },
];
