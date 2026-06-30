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
 * 已核 8 家全桶（docs/model-radar-tech-plan.md L154 跨桶清单）+ coding_plan 桶典范 Z.ai + 5c 桶2 五家：
 * - **已核 8 家**：Token Plan 桶 Kimi / MiniMax / MiMo / Step（4）；IDE会员 桶 Trae / Qoder / Comate / CodeBuddy（4）。
 * - **coding_plan 典范**：Z.ai（GLM / bigmodel.cn，桶2 = v1 主桶，走 browser 档）——补满「三桶各 ≥1 例」。
 * - **5c 桶2 多模型 Coding Plan（task 1.4）**：百炼（aliyun）/ 千帆（baidu）/ 腾讯混元（tencent）/ 火山方舟（volcengine）/
 *   讯飞星火（xfyun）——逐家**结构性录入**（vendor + coding_plan plan + source + model/client/limit + provenance）。
 *   5d-C 人在环策展（tri-state）：**6 个在售 coding_plan plan 录 CNY 官方真月价**（GLM Lite/Pro + 百炼/千帆/火山/讯飞，
 *   `official_pricing` + 真订阅页 URL，经 `upsertPlan→recordPriceChange` 授权改价入口入库）；其余未核仍 `needs_login_recheck`
 *   占位（currentPrice/currency NULL，同生同灭）；**腾讯混元停售** → 价保持 NULL + `reviewFlagReason` 打停售 flag，不留普通待核。
 *   **再播种 caveat**：5d-C 校正了 source_url；`upsertSource` 键 `(vendor_id, source_url)`、`upsertPlan` 键 `(vendor_id, name)`
 *   均 upsert-only 不删行，故对**已用旧数据播种过的 DB** 增量重播会留 orphan 旧 source / 旧 plan——curation 设定为**干净重播**
 *   或经 `recordPriceChange` 运行时更新；key 迁移不在本期（out-of-scope follow-up）。
 *   源 `fetch_strategy` 按页面真实性质设：在售四家结构化文档页 → `http`（其域已扩入 `MR_SOURCE_DOMAIN_ALLOWLIST`，见 allowlist.ts，
 *   使 `upsertSource → assertUrlAllowed` 放行）、讯飞登录墙真页 → `manual`；GLM 仍走 `browser`。
 *   **腾讯混元** coding_plan 用 `normalizedName='tencent-hunyuan'`，与既有 CodeBuddy（腾讯，ide_membership，`codebuddy`）
 *   **不同 normalizedName**——区分产品、避免 vendor 去重键歧义（task 1.2）。
 *   故 fixture 共 14 个 vendor 条目（8 已核 + Z.ai 典范 + 5c 桶2 五家）。本 fixture 取每桶代表覆盖，扩满全 plan 由策展随核实增补，不臆造。
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

/** 产品生命周期（与 add-model-radar-price-state-and-periods availability 取值一致）。 */
type Availability = 'on_sale' | 'discontinued' | 'unknown';

/** 月价之外的订阅周期。 */
type BillingPeriod = 'quarterly' | 'annual';

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

/** 周期价 fixture（订阅型桶专用；token_plan 不写）。 */
interface SeedPeriodPrice {
  billingPeriod: BillingPeriod;
  price: number | null;
  currency: 'CNY' | 'USD' | 'EUR';
  sourceUrl: string;
  sourceConfidence: SourceConfidence;
}

/** 套餐 fixture（plan + 其 child 事实行 + 定位用源 URL）。 */
interface SeedPlan {
  /** 套餐全名（含产品上下文，task 1.5）。 */
  name: string;
  category: Category;
  /** 产品生命周期；未知也显式写 unknown，不从价格/confidence 推导。 */
  availability: Availability;
  /** numeric；null = needs_login_recheck 占位（与 currency 同生同灭）。 */
  currentPrice: number | null;
  /** ISO 4217 大写；与 currentPrice 同生同灭（null 占位）。 */
  currency: 'CNY' | 'USD' | 'EUR' | null;
  sourceUrl: string;
  sourceConfidence: SourceConfidence;
  /**
   * 若该 plan 已停售（discontinued），填停售原因 → seed 录入后经 setReviewFlag 打 `mr_review_flag`
   * （reason 记停售）。停售 plan 价保持 NULL、不计入 cheapest，且**不留作普通 needs_login_recheck 待核**
   * （待核暗示「待定价」会误导用户，spec「已停售 plan 不留作普通待核」）。
   */
  reviewFlagReason?: string;
  limits: SeedLimit[];
  models: SeedModel[];
  clients: SeedClient[];
  periodPrices?: SeedPeriodPrice[];
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
        availability: 'on_sale',
        // 5d-C 人在环已核（web-search + 实勘真页）：真月付标准价 ¥49/月（排首月促销、非年付÷12）。
        currentPrice: 49,
        currency: 'CNY',
        sourceUrl: 'https://docs.bigmodel.cn/cn/coding-plan/overview',
        sourceConfidence: 'official_pricing',
        periodPrices: [
          {
            billingPeriod: 'annual',
            price: 468,
            currency: 'CNY',
            sourceUrl: 'https://docs.bigmodel.cn/cn/coding-plan/overview',
            sourceConfidence: 'official_pricing',
          },
        ],
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
        availability: 'on_sale',
        // 5d-C 人在环已核：真月付标准价 ¥149/月。
        currentPrice: 149,
        currency: 'CNY',
        sourceUrl: 'https://docs.bigmodel.cn/cn/coding-plan/overview',
        sourceConfidence: 'official_pricing',
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
        availability: 'unknown',
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
        availability: 'unknown',
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
        availability: 'unknown',
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
        availability: 'unknown',
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
        availability: 'unknown',
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
        availability: 'unknown',
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
        availability: 'unknown',
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
        availability: 'unknown',
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

  // ───────── 5c 桶2 多模型 Coding Plan（task 1.4）：百炼/千帆/腾讯混元/火山方舟/讯飞星火 ─────────
  // 5d-C 人在环已核（web-search + 实勘真 Coding Plan 页）：在售四家录**真月付标准价**（CNY，排首月促销/年付÷12，
  // 经 upsertPlan→recordPriceChange 授权改价入口 official_pricing 入库）；source_url 校正→真订阅页（讯飞登录墙→manual）。
  // **腾讯混元已停售** → 价保持 NULL + 打 mr_review_flag「已停售」，不留普通 needs_login_recheck 待核（spec 边界①）。
  {
    normalizedName: 'bailian',
    name: '百炼（阿里云 Model Studio）',
    sources: [
      // 5d-C 校正→真 Coding Plan 订阅页（原指向计费总览页）。结构化文档页 → http。aliyun.com 在 allowlist。
      { sourceUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan', fetchStrategy: 'http' },
    ],
    plans: [
      {
        name: '百炼 Coding Plan',
        category: 'coding_plan',
        availability: 'on_sale',
        // 5d-C 人在环已核：真月付标准价 ¥200/月。
        currentPrice: 200,
        currency: 'CNY',
        sourceUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan',
        sourceConfidence: 'official_pricing',
        limits: [{ limitType: 'credit', value: null, window: 'month' }],
        models: [{ family: 'qwen', version: '' }],
        clients: [{ clientType: 'protocol', clientId: 'openai-compatible' }],
      },
    ],
  },
  {
    normalizedName: 'qianfan',
    name: '千帆（百度智能云）',
    sources: [
      // 5d-C 校正→真 Coding Plan 订阅页（原指向千帆文档总览页）。结构化文档页 → http。baidu.com 在 allowlist。
      { sourceUrl: 'https://cloud.baidu.com/doc/qianfan/s/imlg0beiu', fetchStrategy: 'http' },
    ],
    plans: [
      {
        name: '千帆 Coding Plan',
        category: 'coding_plan',
        availability: 'on_sale',
        // 5d-C 人在环已核：真月付标准价 ¥40/月。
        currentPrice: 40,
        currency: 'CNY',
        sourceUrl: 'https://cloud.baidu.com/doc/qianfan/s/imlg0beiu',
        sourceConfidence: 'official_pricing',
        limits: [{ limitType: 'credit', value: null, window: 'month' }],
        models: [{ family: 'ernie', version: '' }],
        clients: [{ clientType: 'protocol', clientId: 'openai-compatible' }],
      },
    ],
  },
  {
    // task 1.2：与 CodeBuddy（腾讯，ide_membership，normalizedName='codebuddy'）不同 normalizedName，区分产品。
    normalizedName: 'tencent-hunyuan',
    name: '腾讯混元（腾讯云）',
    sources: [
      // 腾讯云混元文档页（结构化文档）→ http。tencent.com 已在 allowlist。
      { sourceUrl: 'https://cloud.tencent.com/document/product/1729', fetchStrategy: 'http' },
    ],
    plans: [
      {
        name: '腾讯混元 Coding Plan',
        category: 'coding_plan',
        availability: 'discontinued',
        // 5d-C 核实：腾讯混元 Coding Plan 现已停售（无在售订阅）→ 价保持 NULL、不计入 cheapest，
        // 经 reviewFlagReason 打 mr_review_flag「已停售」，不留普通待核（spec「已停售 plan 不留作普通待核」）。
        currentPrice: null,
        currency: null,
        sourceUrl: 'https://cloud.tencent.com/document/product/1729',
        sourceConfidence: 'needs_login_recheck',
        reviewFlagReason:
          '已停售/discontinued：腾讯混元 Coding Plan 现已无在售订阅（停售待复核，不计入 cheapest；结构删除走授权路径，本期不硬删）',
        limits: [{ limitType: 'credit', value: null, window: 'month' }],
        models: [{ family: 'hunyuan', version: '' }],
        clients: [{ clientType: 'protocol', clientId: 'openai-compatible' }],
      },
    ],
  },
  {
    normalizedName: 'volcengine-ark',
    name: '火山方舟（火山引擎）',
    sources: [
      // 5d-C 校正→真 Coding Plan 活动订阅页（原指向方舟文档页）。结构化页 → http。volcengine.com 在 allowlist。
      { sourceUrl: 'https://www.volcengine.com/activity/codingplan', fetchStrategy: 'http' },
    ],
    plans: [
      {
        name: '火山方舟 Coding Plan',
        category: 'coding_plan',
        availability: 'on_sale',
        // 5d-C 人在环已核：真月付标准价 ¥40/月。
        currentPrice: 40,
        currency: 'CNY',
        sourceUrl: 'https://www.volcengine.com/activity/codingplan',
        sourceConfidence: 'official_pricing',
        limits: [{ limitType: 'credit', value: null, window: 'month' }],
        models: [{ family: 'doubao', version: '' }],
        clients: [{ clientType: 'protocol', clientId: 'openai-compatible' }],
      },
    ],
  },
  {
    normalizedName: 'xfyun-spark',
    name: '讯飞星火（科大讯飞）',
    sources: [
      // 5d-C 校正→真订阅页 maas.xfyun.cn/packageSubscription；真页需登录 → fetchStrategy=manual（人工登录核，
      // manual 源不发请求、豁免 allowlist 闸，URL 仅人类参考）。
      { sourceUrl: 'https://maas.xfyun.cn/packageSubscription', fetchStrategy: 'manual' },
    ],
    plans: [
      {
        name: '讯飞星火 Coding Plan',
        category: 'coding_plan',
        availability: 'on_sale',
        // 5d-C 人在环已核（登录后真页）：真月付标准价 ¥19/月（无忧档）。
        currentPrice: 19,
        currency: 'CNY',
        sourceUrl: 'https://maas.xfyun.cn/packageSubscription',
        sourceConfidence: 'official_pricing',
        limits: [{ limitType: 'credit', value: null, window: 'month' }],
        models: [{ family: 'spark', version: '' }],
        clients: [{ clientType: 'protocol', clientId: 'openai-compatible' }],
      },
    ],
  },
];
