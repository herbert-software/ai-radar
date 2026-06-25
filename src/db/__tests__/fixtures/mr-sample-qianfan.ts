/**
 * 单桶样例厂商 fixture（tasks 4.1）：百度千帆 **Coding Plan**（category=`coding_plan`，桶2）。
 *
 * 作为 5a 可审计真值基线——已核数据固化成 checked-in fixture，每条断言事实带 provenance
 * （`source_confidence='official_doc'`）。fixture **仅覆盖桶2 单厂内部无损读回**（4.2）；跨桶共存
 * （3.7①）、4 值枚举（3.7①）、跨厂同名 family（3.8）由各自针对性测试**合成**，不靠本 fixture。
 *
 * 数据口径（tasks 4.1）：Lite ¥40 / Pro ¥200；限额 1200/9000/18000（按 plan 分布）；
 * 模型阵容 Kimi/DeepSeek/GLM/MiniMax/ERNIE（带版本，family 已小写归一为 5b 录入契约）；
 * 支持 Claude Code / Qwen Code（client_type=tool）。
 *
 * 全部值由测试录入并逐项读回比对（numeric 读回为字符串，断言按字符串归一）；这里只声明真值结构，
 * 不写任何库（写库与读回在 mr-catalog-migration.integration.test.ts 完成）。
 */

/** 录入用唯一前缀（测试 afterAll 据 vendor.normalizedName / source_url 前缀清理，避免污染）。 */
export const QIANFAN_PREFIX = 'mr-it-qianfan/';

/** provenance 源 URL（千帆 Coding Plan 定价/文档页占位，invalid 域不外联）。 */
export const QIANFAN_SOURCE_URL =
  'https://test.example.invalid/mr-it-qianfan/coding-plan-pricing';

/** 全部断言事实行共享的 last_checked（核对时刻；ISO 字符串，写库时转 timestamptz）。 */
export const QIANFAN_LAST_CHECKED = '2026-06-24T00:00:00.000Z';

/** 千帆厂商身份行（不挂 provenance）。 */
export const qianfanVendor = {
  normalizedName: `${QIANFAN_PREFIX}baidu-qianfan`,
  name: '百度千帆',
} as const;

/**
 * 模型身份行（不挂 provenance）。`family` 已小写归一（5b 录入契约），`version` 哨兵 `''` 仅在
 * 未标版本时用；本 fixture 各模型均带版本。
 */
export const qianfanModels = [
  { family: 'kimi', version: 'k2.7' },
  { family: 'deepseek', version: 'v3' },
  { family: 'glm', version: '4.7' },
  { family: 'minimax', version: 'm1' },
  { family: 'ernie', version: '4.5' },
] as const;

/** 工具/协议兼容端（千帆 Coding Plan 支持的编程工具，均 client_type=tool）。 */
export const qianfanClients = [
  { clientType: 'tool', clientId: 'Claude Code' },
  { clientType: 'tool', clientId: 'Qwen Code' },
] as const;

/**
 * 两个套餐（Lite / Pro），均 category=`coding_plan`、currency=CNY、provenance=official_doc。
 * 价格固定 2 位（current_price numeric(12,2)）。限额按 plan 分布：Lite 月 1200、Pro 月 9000，
 * Pro 另带一条更高额度 18000（rolling 5h 请求数），覆盖「异构限额共存 + numeric 不溢出」读回。
 */
export const qianfanPlans = [
  {
    name: `${QIANFAN_PREFIX}Coding Plan Lite`,
    category: 'coding_plan',
    currentPrice: '40.00',
    currency: 'CNY',
    sourceUrl: QIANFAN_SOURCE_URL,
    sourceConfidence: 'official_doc',
    // 兼容矩阵：Lite 含 kimi/deepseek，支持 Claude Code。
    modelKeys: [
      { family: 'kimi', version: 'k2.7' },
      { family: 'deepseek', version: 'v3' },
    ],
    clientKeys: [{ clientType: 'tool', clientId: 'Claude Code' }],
    // 限额行（带 provenance）。window 哨兵非 NULL。
    limits: [
      {
        limitType: 'monthly_tokens',
        value: '1200',
        window: 'month',
      },
    ],
  },
  {
    name: `${QIANFAN_PREFIX}Coding Plan Pro`,
    category: 'coding_plan',
    currentPrice: '200.00',
    currency: 'CNY',
    sourceUrl: QIANFAN_SOURCE_URL,
    sourceConfidence: 'official_doc',
    // 兼容矩阵：Pro 含全部 5 个模型，支持 Claude Code + Qwen Code。
    modelKeys: [
      { family: 'kimi', version: 'k2.7' },
      { family: 'deepseek', version: 'v3' },
      { family: 'glm', version: '4.7' },
      { family: 'minimax', version: 'm1' },
      { family: 'ernie', version: '4.5' },
    ],
    clientKeys: [
      { clientType: 'tool', clientId: 'Claude Code' },
      { clientType: 'tool', clientId: 'Qwen Code' },
    ],
    limits: [
      { limitType: 'monthly_tokens', value: '9000', window: 'month' },
      { limitType: 'rolling_5h_requests', value: '18000', window: '5h' },
    ],
  },
] as const;

/**
 * 价格历史样例（append-only）：Pro 从 ¥150 改为 ¥200（旧值留痕，currency NOT NULL）。
 * Lite 无历史行（首次录入）。changed_at 为去重键兼记录时间。
 */
export const qianfanPriceHistory = [
  {
    planName: `${QIANFAN_PREFIX}Coding Plan Pro`,
    oldValue: '150.00',
    newValue: '200.00',
    currency: 'CNY',
    changedAt: '2026-06-20T00:00:00.000Z',
    sourceUrl: QIANFAN_SOURCE_URL,
    sourceConfidence: 'official_doc',
  },
] as const;

/** 源定位边样例：一个 browser 源覆盖 Lite + Pro 两个 plan。 */
export const qianfanSource = {
  sourceUrl: QIANFAN_SOURCE_URL,
  fetchStrategy: 'browser',
  contentFingerprint: null,
} as const;
