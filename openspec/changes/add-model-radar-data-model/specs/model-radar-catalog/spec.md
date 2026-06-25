## 新增需求

### 需求:目录作为隔离的 bounded domain

Model Radar 目录必须存放在自有的 `mr_*` 表中，与 `ai_products` 及新闻/去重/推送/KB 管线 schema 完全隔离。迁移禁止改动任何既有表结构。引用列沿用全仓零-FK 惯例（裸 id，不 `references()`）。**孤儿引用（指向不存在行）在 5a 由 DB 放行——这是零-FK 取舍，不是漏测；引用完整性是 5b 录入事务契约，非 5a 保证。**

#### 场景:迁移落表不触碰既有表
- **当** 应用 Model Radar 数据模型迁移
- **那么** 新建全部 `mr_*` 表，且 `raw_items`、`ai_news_events`、`ai_products`、`push_records` 等既有表结构保持不变

#### 场景:无外键（零-FK 断言）
- **当** 检查 `mr_*` 表的外键约束
- **那么** 不存在任何 `references()`/FOREIGN KEY（镜像 `ai_experiences` 的零-FK 断言），引用完整性显式属 5b

### 需求:套餐分桶为 facet 字段

`mr_plans` 必须携带 `category` 枚举，其合法值集在 5a 即固定为恰好 4 个 **code 字面量 slug**（与 source_confidence/limit_type 等其它枚举同风格，非 Chinese 显示名）：`{ide_membership, coding_plan, token_plan, enterprise_seat}`，分别对应 4 桶 **IDE会员 / Coding Plan / Token Plan / 企业席位**（显示名留 5b/5d UI 层）。应用层 Zod 校验，非仅样例所用桶。不同桶套餐共存同一表、以 `category` 区分，禁止「每桶一张表」。

#### 场景:不同桶套餐共存一表
- **当** 插入一条 `Coding Plan` 套餐与一条 `Token Plan` 套餐
- **那么** 二者同在 `mr_plans`、以 `category` 区分，且不存在按桶分表

#### 场景:4 桶值集在 5a 固定（合成测）
- **当** 校验 `category` Zod 值集并合成插入第 4 桶（如 `ide_membership`）一行
- **那么** 值集恰好为 4 桶，写入第 4 桶不被拒（该校验经合成插入，独立于单桶样例 fixture）

### 需求:额度以带类型限额行表达

套餐额度必须建成 `mr_plan_limits{plan_id, limit_type, value, window}`：`value` 为 `numeric`（容 token/credit/请求数及小数，禁 `integer`）nullable；`window` 为 `text` **NOT NULL 哨兵**（如 `'5h'`/`'week'`/`'month'`/`'none'`，**不用 NULL**，否则 PG `UNIQUE` 对 NULL distinct 会放过重复）。禁止单 `quota` 整数列。`UNIQUE(plan_id, limit_type, window)` 兜底去重。`limit_type` 合法集由应用层 Zod 保证（DB 不约束）。零条限额行语义为「未录入（缺数据）」，不等于不限；不限须显式写 `none` 行。`none` 行与具名限额行互斥（不应同时不限又有具名额度）属 5b 录入契约，5a 不强制（DB 无法表达此跨行约束）。

#### 场景:异构额度可共存
- **当** 套餐 A 写入 `{rolling_5h_requests, value=6000, window='5h'}` 与 `{monthly_tokens, value=90000000000, window='month'}`，套餐 B 写入 `{none, value=NULL, window='none'}`（不限）
- **那么** 三者都能表达，`value=900 亿` 不溢出（numeric），不限行 value 为 NULL

#### 场景:重复 (limit_type, window) 被唯一约束拒（含不限）
- **当** 对同一 plan 重复插入两条 `{monthly_tokens, window='month'}`，或两条 `{none, window='none'}`
- **那么** `UNIQUE(plan_id, limit_type, window)` 拒绝第二条（window 为哨兵非 NULL，去重生效）；「不限」每 plan 恰好一行

#### 场景:Zod 拒未知 limit_type
- **当** 录入路径收到未知 `limit_type`（如 `montly_tokens`）
- **那么** 应用层 Zod 枚举校验拒绝，不入库

### 需求:模型保留版本

`mr_models` 必须以真实三列 `UNIQUE(vendor_id, family, version)` 保证 `GLM-5.2` 与 `GLM-4.7` 可区分。`version` 必须 NOT NULL，未标版本填哨兵 `''`（禁用 NULL）。`family` 为去版本号系列名小写（其归一是 5b 录入契约，5a 注释记录不强制）。`mr_models` 是身份行，不挂 provenance。

#### 场景:同系列不同版本不塌缩
- **当** 录入 `GLM-5.2` 与 `GLM-4.7`（同 vendor、family=`glm`）
- **那么** 二者是 `mr_models` 两条不同记录

#### 场景:无版本模型不重复入库
- **当** 录入厂商未标版本的模型两次（version 哨兵 `''`）
- **那么** 第二条被唯一键拒，不重复

### 需求:套餐兼容关系以矩阵表达且带独立 provenance

套餐 ↔ 模型（`mr_plan_models`）、套餐 ↔ 工具/协议（`mr_plan_clients`，含 `client_type ∈ {tool,protocol}`）的兼容关系必须建成 junction 表，禁止 JSONB。唯一键 `UNIQUE(plan_id, model_id)` 与 `UNIQUE(plan_id, client_type, client_id)`。**两张 junction 各自携带 provenance 三字段**（兼容是断言事实，置信度独立于价格，不得继承 plan 级置信度）。

#### 场景:按模型与工具可过滤
- **当** 查询「含 `GLM-5.2` 且支持 `Claude Code`」的套餐
- **那么** 经 `mr_plan_models` join `mr_plan_clients` 过滤得到，无需解析 JSON

#### 场景:兼容置信度独立于价格
- **当** 某 plan 价格来自 `official_pricing`、其某条模型兼容来自 `official_community`
- **那么** `mr_plan_models` 该行读回 `source_confidence=official_community`，不被冒充为 `official_pricing`

#### 场景:工具与协议同名不误撞
- **当** 某 plan 有协议 `OpenAI`（client_type=protocol）与（设想）工具 `OpenAI`（client_type=tool）
- **那么** `client_type` 使二者为不同行，唯一键不冲突

### 需求:价格变更以时序保留、带币种与 provenance

价格变更必须追加 `mr_price_history{plan_id, old_value(nullable), new_value NOT NULL, currency NOT NULL, changed_at, source_url, source_confidence}`，price 列 `numeric(12,2)`、`currency varchar(3)`（大写 ISO 4217），`UNIQUE(plan_id, changed_at)`。**append-only 是 5b 写契约非 5a DB 强制**：唯一约束只防同刻重复 INSERT，防不住 UPDATE/DELETE 覆盖（5a 不上 trigger）；5b 写路径必须 only-INSERT、不得改删既有 history 行，同刻冲突以 `ON CONFLICT DO NOTHING` 容忍。**`mr_price_history` 的 provenance 例外**：带 `source_url`/`source_confidence`/`changed_at`，`changed_at` 兼任记录/核对时间（不可变历史行不重新核对，故不单建 `last_checked`）。`mr_plans.current_price` 与 `mr_plans.currency` 必须「同生同灭」（同为 NULL 或同为非 NULL），由应用层 Zod `.refine()` 保证（DB 零-CHECK 不挡），半 NULL 态被录入校验拒；二者与 history 的 current=latest 双写一致性由 5b 保证，非 5a 目标。

#### 场景:改价追加历史行且可溯源
- **当** 某套餐价格从 ¥40 改为 ¥45
- **那么** `mr_price_history` 追加一行（`currency=CNY`、旧值 ¥40 仍在），可读回 `source_confidence`

#### 场景:current_price/currency 半 NULL 态被拒
- **当** 录入 `current_price=40, currency=NULL`（或 `current_price=NULL, currency='CNY'`）
- **那么** 应用层 Zod `.refine()` 拒绝该半 NULL 态

### 需求:每条断言事实带 provenance（逐表）

承载**断言事实**的每张表（`mr_plans`、`mr_plan_limits`、`mr_plan_clients`、`mr_plan_models`）必须各自携带 `source_url text NOT NULL`、`last_checked timestamptz NOT NULL`、`source_confidence text NOT NULL`。**仅 `source_confidence` 是枚举** ∈ {official_pricing, official_doc, official_community, media_report, needs_login_recheck}，由应用层 Zod 校验（DB 不建 CHECK/pg-enum）；`source_url`/`last_checked` 是普通 text/timestamptz 非枚举。`mr_price_history` 按上条带 `source_url`/`source_confidence`/`changed_at`（例外）。**身份行 `mr_vendors`/`mr_models` 与定位边 `mr_source`/`mr_plan_sources` 有意不挂 provenance**（实体存在性/边，非定价或兼容断言；时效由拥有它的兼容/价格行承载）。

#### 场景:needs_login_recheck 缺值可表达
- **当** 录入一条登录墙后的事实（如火山续费价，`source_confidence=needs_login_recheck`、值缺）
- **那么** `mr_plans.current_price` 与 `currency` 同为 NULL（占位、同生同灭），provenance 三字段齐备，**不写** `mr_price_history` 行（`new_value` NOT NULL，无确值不追历史）；该记录可无损录入读回

### 需求:源带抓取策略、内容指纹与定位边

`mr_source` 必须携带 `source_url`、`vendor_id`、`fetch_strategy` ∈ {http, browser, manual}、`content_fingerprint`（`text` NULL，sha256 hex）、`last_checked`（`timestamptz` NULL，无 default，**非 provenance 字段**：未抓过 ≠ 入库时刻），`UNIQUE(vendor_id, source_url)`。源与其覆盖套餐之间有定位边 `mr_plan_sources{source_id, plan_id}` `UNIQUE(source_id, plan_id)`。5a 仅建列与关系，不填 fingerprint、不写变更检测。

#### 场景:JS 渲染源分档为 browser
- **当** 登记一个 JS 渲染定价页源（如 GLM 购买页）
- **那么** 其 `fetch_strategy='browser'`，具备 `content_fingerprint` 列待填充

#### 场景:源可定位到其覆盖的 plan 集合
- **当** 一个源（千帆定价页）覆盖 Lite 与 Pro 两个 plan
- **那么** 经 `mr_plan_sources` 可得该源覆盖的 plan 集合 {Lite, Pro}

### 需求:待复核状态多态可记且单 target 单行幂等

`mr_review_flag` 必须支持多态目标 `target_type ∈ {plan, source, vendor}` + `target_id`（`varchar(128)`，与身份表 PK 同型）+ `status ∈ {pending, resolved}` + `opened_at` + `resolved_at`(nullable)，并由**普通** `UNIQUE(target_type, target_id)` 约束保证**单 target 单行**（非 partial index）。**写契约必须是单语句幂等 upsert**：开标/重开 = `INSERT … ON CONFLICT(target_type, target_id) DO UPDATE SET status='pending', reason=excluded.reason, opened_at=now(), resolved_at=NULL`（并发触发经冲突行锁串行化收敛为单行，禁止「先判存在再 INSERT/UPDATE」的两段式以免 TOCTOU 抛 UNIQUE 错）；解决 = plain `UPDATE … SET status='resolved', resolved_at=now()`。写/翻 flag 禁止改动事实值。`mr_catalog_version`（快照版本号，供 5c）必须有 `UNIQUE(version)` 与 `built_at NOT NULL`（bump/latest 需有序唯一版本），5a 仅建表、**不被任何写路径触碰**。

#### 场景:标待复核不改事实
- **当** 把某 plan 标为待复核
- **那么** `mr_review_flag` 新增一行指向该 plan，而 `mr_plans`/`mr_plan_limits` 事实值不变

#### 场景:同 target 单行 upsert、resolved 后可重开
- **当** 对同一 plan 重复触发待复核（经 ON CONFLICT upsert，含仍 pending 时与 resolved 后）
- **那么** 始终收敛为单行（不抛 UNIQUE 错、`reason` 被刷新）；resolved 行经 upsert 翻回 pending 并清 `resolved_at`，不产生第二行

### 需求:唯一约束逐一列举且迁移幂等由 DB/CI 保障

所有 `mr_*` 表唯一键必须逐一列举落地（`mr_vendors UNIQUE(normalized_name)`、`mr_plans UNIQUE(vendor_id,name)`、`mr_models` 三列、各 junction 键、`mr_plan_limits` 三元、`mr_price_history UNIQUE(plan_id,changed_at)`、`mr_source UNIQUE(vendor_id,source_url)`、`mr_plan_sources`、`mr_review_flag UNIQUE(target_type,target_id)`、`mr_catalog_version UNIQUE(version)`），必须全部用**命名表级** `unique('<name>').on(...)` 约束（对齐本仓 `push_records`/`ai_products` 命名约束形式，非列级 `.unique()` 链；禁用 partial index），由 DB 保障不交 LLM。**每个唯一键组件列必须 `.notNull()`**（PG `UNIQUE` 对 NULL distinct，组件可空会让去重键静默失效）；`mr_plans.name` 必须作为真实列 `name text NOT NULL` 建。**`name` 录入约定 = 套餐全名（含产品上下文，如 `Coding Plan Pro`、`Qoder Pro`），非裸档位（`Pro`）**——故 `UNIQUE(vendor_id, name)` 不含 `category` 仍正确：同厂跨桶套餐全名天然不同，且该键能挡住同厂同名误录重复；裸档位录入会让跨桶同档位误撞，属 5b 录入契约须避免。PK 一律 `id varchar(128) DEFAULT gen_random_uuid()::text`，`mr_review_flag.target_id` 同型以多态引身份表 PK。迁移幂等沿用既有范式：`npm run migrate` 二跑 journal no-op（命令级），**幂等不在 test 内重跑迁移**；结构（表/列/唯一约束/`is_nullable`）经 `information_schema` 断言；行为/往返测试（唯一键拒绝、upsert、fixture 录入读回）**写隔离数据并清理**——「只做只读断言」仅指迁移幂等那一项，不限制行为测试写库。

#### 场景:迁移命令二跑幂等
- **当** 对同一库连续 `npm run migrate` 两次
- **那么** 第二次 journal 无新增已应用条目、目标表结构 `information_schema` 快照一致、退出码 0

#### 场景:重复唯一键由 DB 约束兜底
- **当** 重复插入任一 `mr_*` 表的唯一键
- **那么** 由 DB 唯一约束（`table_constraints` 可见）拒绝或塌缩，而非依赖 LLM

### 需求:样例厂商可完整录入并读回（基于单桶 checked-in fixture）

数据模型必须支持把一家厂商的完整目录（厂商 + 套餐 + 模型兼容 + 工具/协议兼容 + 带类型限额 + 价格历史 + 逐表 provenance）录入后无损读回。样例数据来自随 5a 附库的 **checked-in seed fixture（单桶：Coding Plan，即已核千帆数据）**，带 provenance，作为可审计真值基线。样例往返覆盖**单厂内部无损读回**；跨厂唯一键区分、跨桶/4 值枚举、junction 防重边由各自针对性测试**合成**覆盖（非由单厂单桶 fixture 证明）。

#### 场景:样例厂商往返
- **当** 从 fixture 录入千帆 Coding Plan 完整目录并读回
- **那么** 厂商、套餐（含 category+currency）、模型兼容、工具/协议兼容、各限额行、价格历史、各断言事实表 provenance 三字段均逐项读回一致

#### 场景:两厂商同名 family 不同 vendor 不误合（合成）
- **当** 合成插入厂商 A 与 B 各有 family=`glm`、version=`x` 的模型
- **那么** 因唯一键含 `vendor_id`，二者为不同记录，不误合
