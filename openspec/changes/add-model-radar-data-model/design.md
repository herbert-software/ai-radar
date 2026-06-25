## 上下文

Model Radar（P5）把 ai-radar 的「选型顾问」具象到编程订阅垂类，并作为同仓 bounded domain 并入。5a 只建数据模型与迁移，是 5b（抓取/录入/保鲜）→ 5c（快照/比价 API）→ 5d（比价页）→ 5e（推荐器）的前置闸门。

约束（来自 `CLAUDE.md`「Model Radar 专属约束」与 `docs/model-radar-tech-plan.md`）：bounded domain 隔离；精确事实由 DB 保障不交 LLM；额度带类型不建单 INT；分桶为 facet；事实带 provenance；价格历史从第 0 天记录。技术栈以 `config.yaml` 为准：Drizzle + PostgreSQL/pgvector，`src/db/schema.ts` 追加 + `drizzle/` forward-only 迁移。

**既有代码事实（落地必须对齐，经 grep 核实）**：① 全仓**零外键、零 pg-enum、零 DB CHECK**（`ai_experiences` 注释「不加 DB CHECK，唯一防线是 Zod」；引用列「裸 bigint 无 FK」）。② 迁移幂等由 **CI/本地 `npm run migrate` 二跑 + journal no-op** 保障；迁移测试是**纯 `information_schema` 只读断言、不在 test 内重跑迁移**。③ 全仓**零 partial index**、唯一键一律**命名表级** `unique('<name>').on(...)` 约束（经 `information_schema.table_constraints` 断言）。④ `ai_products` **当前无 `vendor`/`pricing_model` 列**（仅注释保留待 P6）。下一迁移序号 = `0008`。5a 一律沿用这些惯例，**不引入全仓第一个 FK/CHECK/pg-enum/partial-index**。

已有事实输入：8 家厂商官方页已逐字核对（2026-06-24），额度口径异构——**这 8 家是背景输入**。5a 的 checked-in seed fixture **仅固化其中千帆 Coding Plan 单厂单桶样例**（见 tasks 4.1），使样例往返有可审计真值基线；其余 7 家随 5b 全桶入库。

## 目标 / 非目标

**目标：** 隔离的 `mr_*` 表，无损承载厂商/套餐/模型兼容/工具协议兼容/带类型限额/价格历史/来源与待复核状态，每张**断言事实**表各带 provenance；迁移幂等、**逐一列举的唯一约束**就位、单厂样例往返（基于 fixture）；为 5b/5c 预留**结构完整**接缝，不提前实现抓取/快照逻辑。

**非目标：** 抓取/Playwright/录入后台/比价页/推荐器（5b–5e）；读路径/快照/缓存（5c）；改动 `ai_products` 与新闻管线；`current_price` 与 history 双写一致性（5b 保证）；引用完整性（零-FK，孤儿拒绝是 5b 录入契约，**非 5a 保证**）。

## 决策

**D1：`mr_plan_limits{plan_id, limit_type, value, window}` 带类型限额行，不建 `mr_plans.quota INT`。**
- `value` = `numeric`（无精度，容月级 token 900 亿 + 小数 credit；禁 `integer` 防 int32 溢出），nullable（不限时 NULL）。
- **`window` = `text` NOT NULL，用哨兵不用 NULL**（如 `'5h'`/`'week'`/`'month'`/`'none'`）——PG `UNIQUE` 对 NULL 默认 distinct，若 window 可空则 `(plan_id, limit_type, NULL)` 重复行不被拒，与「拒重复」矛盾。哨兵使 `UNIQUE(plan_id, limit_type, window)` 正常去重。「不限」= 恰好一行 `{limit_type:'none', value:NULL, window:'none'}`。**`none` 行与具名限额行互斥**（一个 plan 不应同时「不限」又有 `monthly_tokens`——唯一键跨 limit_type 拦不住此矛盾）属 **5b 录入契约**，5a 不强制（DB 无法表达此跨行约束）。
- **口径说明（防 5b 误改）**：`value` 用无精度 numeric 是因口径异构（token 整数 / credit 可小数 / 无统一标度）；价格列用 `numeric(12,2)`（固定 2 位分位）——二者刻意不同，勿统一。

**D2：兼容关系用 junction（`mr_plan_models`、`mr_plan_clients`），不用 JSONB。**
- 唯一键 `UNIQUE(plan_id, model_id)`；`mr_plan_clients` 含 `client_type ∈ {tool, protocol}`：`UNIQUE(plan_id, client_type, client_id)`（防工具/协议同名误撞）。反向索引（`model_id`/`client_id`）暂缓，schema 注释记理由（快照承读 + 低百行）。

**D3：`mr_models` 唯一键 = 真实三列 `UNIQUE(vendor_id, family, version)`。**
- `version` NOT NULL，未标版本填哨兵 `''`（不用 NULL）。`family` = 去版本号系列名小写（GLM-5.2→`glm`、Kimi-K2.7→`kimi`）。**`family` 小写归一是 5b 录入契约**：5a schema 注释记录但不加 Zod transform/CHECK（对齐零-CHECK）；5a 不强制、不测。

**D4：provenance 挂在每张**断言事实**表上，落地 `text` 列 + 应用层 Zod，不建集中表/pg-enum/CHECK。**
- **挂载点**：**4 张标准断言事实表**（`mr_plans` 价格 / `mr_plan_limits` 额度 / `mr_plan_clients` 工具协议兼容 / `mr_plan_models` 模型兼容）各带**三字段** `source_url`/`last_checked`/`source_confidence`；`mr_price_history` 为**例外**（只带 `source_url`/`source_confidence`/`changed_at`，见下）。因价格来自官方页、兼容常来自人脑/社区，置信度本就不同，不得让兼容继承 plan 级置信度。
- **豁免（有意，显式声明）**：`mr_vendors`/`mr_models` 是**身份行**（实体存在性，非定价/兼容断言），其时效由拥有它的 plan 兼容行 provenance 间接承载；`mr_source`/`mr_plan_sources` 是**定位边**本身。三者不挂 provenance。
- **provenance 字段**：断言事实表带 `source_url`/`last_checked`/`source_confidence`。**`mr_price_history` 是唯一例外**：append-only 不可变历史行带 `source_url`/`source_confidence`/`changed_at`，`changed_at` 兼任该行的记录/核对时间（历史行不被重新核对，故不单建 `last_checked`）；「再核对的新鲜度」体现在 `mr_plans.current_price` 的 `last_checked` 上。此例外显式记录，非疏漏。
- `source_confidence`（5 值）/`limit_type`/`category`/`fetch_strategy` 列类型为 `text` + `z.enum([...])`（应用层）；**`currency` 列类型是 `varchar(3)`**（非 text）+ `z.enum(['CNY','USD'])`。取值集合法性统一由应用层 Zod 兜，DB 不建 CHECK/pg-enum。

**D5：价格历史独立 append-only `mr_price_history`，与 `mr_plans` 当前价并存，均带币种。**
- `mr_plans.current_price numeric(12,2)` 持当前价；`mr_price_history`（`old_value` nullable / `new_value numeric(12,2)` NOT NULL，改价必留痕）append。
- **币种**：`mr_price_history.currency varchar(3)` **NOT NULL**（`new_value` 必有真实价 ⇒ 必有币种）；`mr_plans.currency varchar(3)` **nullable**，与 `current_price` **同生同灭**（要么都有、要么都 NULL）——见 D6 的 needs_login_recheck。`currency` 录入归一为大写 ISO 4217（CNY/USD），合法集由 5b Zod `z.enum(['CNY','USD'])` 兜。价格列 `numeric(12,2)`。
- 双写一致性（current=latest）由 5b 录入事务保证。**append-only 是 5b 写契约，非 5a DB 强制**：`UNIQUE(plan_id, changed_at)` 只防同刻重复 INSERT，**防不住 UPDATE/DELETE 覆盖历史**（5a 不上 trigger，对齐全仓零-trigger 惯例）；5b 写路径必须 only-INSERT、不得 UPDATE/DELETE 既有 history 行。`changed_at` 既是去重键又兼任记录时间——5b 须为每次观测供**不同** `changed_at`；同 plan 同刻重复观测以 `ON CONFLICT(plan_id, changed_at) DO NOTHING` 容忍为幂等（视作同一变更，非数据丢失）。

**D6：`needs_login_recheck` 缺值语义。**
- 登录墙后拿不到的事实（如火山续费价）：`mr_plans.current_price` 与 `currency` 均 NULL（占位），`source_confidence=needs_login_recheck`、`source_url` 指向登录页。该 plan **不写** `mr_price_history` 行（`new_value` NOT NULL，无确值则不追历史）。`mr_plan_limits.value` 同理可 NULL 占位。NULL 占位指**当前值列**（`current_price`/`value`），不指 `mr_price_history.new_value`。
- **`current_price`/`currency`「同生同灭」由应用层 Zod `.refine()` 兜**（`(current_price==null)===(currency==null)`），半 NULL 态被录入校验拒——DB 零-CHECK 不挡，故合法性闸落在 Zod（同 `limit_type` 取值集机制）；tasks 加两条负例测试。这与 D5「current=latest 双写交 5b」是同类「DB 不便约束的不变量交应用层」处理。

**D7：迁移 forward-only、幂等沿用既有范式。**
- 迁移由 `drizzle-kit generate` 产出（**非手写文件名**），序号自动顺延为 `0008_*`；仅 `CREATE TABLE mr_*` + 索引/唯一约束，**不 ALTER 既有表**、不含 `CREATE EXTENSION`；文件头复刻 0006/0007 幂等口径注释。
- 幂等验证：CI/本地 `npm run migrate` 二跑 journal no-op（**迁移幂等不在 test 内重跑**）；integration 测试中**结构断言**走 `information_schema` 只读，**行为/往返测试写隔离数据并清理**——「只读」仅指迁移幂等那一项，不限制行为测试写库（与 spec/tasks 一致）。

**D8：所有 `mr_*` 引用列沿用全仓零-FK 惯例（裸 id，不 `references()`）。**
- 引用完整性由 5b 录入事务保证；**孤儿引用（如 `plan_id` 指向不存在 plan）在 5a 被 DB 放行——这是零-FK 的取舍，不是漏测**。5a 测试加一条 no-FK schema 断言（镜像 `ai_experiences` 测试，断言 `mr_*` 无 FK），并把「孤儿拒绝 = 5b 写契约」显式写入 spec/注释，避免后续评审误判漏测或误以为 5a 保证引用完整性。连带化解 CASCADE 删历史隐患（无 FK 无级联）。

**D9：`mr_source` 在 5a 即建定位边。**
- `mr_source{id, source_url, vendor_id, fetch_strategy, content_fingerprint(text, sha256 hex), last_checked, created_at}`，`UNIQUE(vendor_id, source_url)`；`mr_plan_sources{source_id, plan_id, created_at}` `UNIQUE(source_id, plan_id)`。使 5b「源指纹变 → 哪些 plan 待复核」可落地。
- `plan.source_url`（事实出处）与 `mr_source.source_url`（被监控目标）的对齐（是否同 URL、由谁主）属 **5b 录入规范**，5a 不约束二者一致性（显式 deferred，与 D5「current=latest 双写交 5b」同类处理）。

**D10：`mr_review_flag` 用普通全列唯一约束 + status 翻转，不用 partial index。**
- **替代方案：partial unique index `WHERE status='pending'` → 否决**。理由：① 它是全仓第一个 partial index（破坏「唯一键一律 `unique()` 内联」惯例），且不进 `information_schema.table_constraints`，与既有迁移测试范式不兼容（会假绿）；② drizzle `uniqueIndex().where()` 的 introspect 往返在本仓无先例、有 drift 风险；③ resolved 后重开/累积语义需额外定义。
- **采纳：`mr_review_flag{id, target_type ∈ {plan,source,vendor}, target_id, reason, status ∈ {pending,resolved}, opened_at, resolved_at(nullable), created_at}` + 普通 `UNIQUE(target_type, target_id)`**——**单 target 单行可变标**。
- **写契约（必须单语句 CAS，非 INSERT-then-UPDATE）**：开标/重开 = 一条**无条件** `INSERT … ON CONFLICT(target_type, target_id) DO UPDATE SET status='pending', reason=excluded.reason, opened_at=now(), resolved_at=NULL`（不加任何 `WHERE` 谓词——仍 pending 时也须刷新 reason，与 tasks 3.5 一致；churn 担忧对低百行表是过早优化）；解决 = 唯一的 plain `UPDATE … SET status='resolved', resolved_at=now()`。
- **flag 粒度（有意粗于 provenance）**：`target_type ∈ {plan, source, vendor}`，**不含** model/client/junction 行。某条兼容断言（`mr_plan_models`/`mr_plan_clients`）陈旧时，经其**所属 plan** 的 flag 复核（粗粒度），5b/5c 不应假设有 per-兼容行 flag。**理由**：`mr_review_flag` 由两个并发生产者写（5b 抓取变更检测 + ai-radar 事件流），「先 SELECT 判存在再 INSERT/UPDATE」有 TOCTOU 竞态——两个首次触发都 INSERT，第二个撞 `UNIQUE` 抛错而非幂等收敛。本仓孪生表 `kb_ingestion_records`（`src/kb/store.ts`）正是用单语句 `ON CONFLICT DO UPDATE`（冲突行持锁串行化）解决同一问题；D10 抄其表形状必须连其并发机制一起抄（`reason=excluded.reason` 是对该范式的正确**扩展**——kb 孪生只 SET 字面量、无 `excluded.*`，而 `reason` 是本表唯一 per-call 变化的列，故必须 `excluded.reason`）。对齐 `push_records`/`kb_ingestion_records` 全列 `unique()` 惯例，走 `table_constraints` 可断言，无 partial index、无 resolved 行累积，`resolved_at` 满足 D11 审计。flip 逻辑落 5b，但 5a 的此写契约措辞钉死「必为 upsert」，避免 5b 实现成 racey 序列（tasks 3.5 据此测 upsert + reason 刷新，非「第二条 INSERT 被拒」）。
- **ponytail 取舍（显式）**：单行可变标**丢失「同 target 多次标记历史」**。5a 不需要该历史；若 5b 要审计标记次数，再以独立 append-only flag-event 日志承载（YAGNI，5a 不预建）。schema 注释标此 ceiling。
- 写/翻 flag 只动 `mr_review_flag`，不改任何事实值。

**D11：审计列 + PK 惯例。** **每张** `mr_*` 表（含 `mr_plan_sources`、`mr_catalog_version`）带 `created_at timestamptz NOT NULL DEFAULT now()`；承载可变事实的 `mr_plans`/`mr_plan_limits` 另带 `updated_at timestamptz NOT NULL DEFAULT now()`（较既有 `updated_at` 列——`ai_news_events`/`push_records`/`ai_products` 为 `defaultNow()` 可空——**刻意更严**：有 default 故 insert 永不失败，不声称与既有列逐字一致）；`mr_review_flag` 带 `opened_at timestamptz NOT NULL DEFAULT now()`/`resolved_at timestamptz`（nullable）。`last_checked`（核对时间）≠ `created_at`（入库时间），并存（`mr_source.last_checked` 可空无 default：未抓过 ≠ 入库时刻）。
- **PK 惯例**：所有 `mr_*` 表 PK = `id varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text`，对齐 `ai_products`/`ai_news_events`/`ai_experiences` 代理键惯例。`mr_review_flag.target_id` 多态引 {plan,source,vendor} 三身份表 PK，故必须同型 `varchar(128)`（对齐本仓 `push_records.target_id`/`ai_news_events.event_id` 的「互引相容皆 varchar(128)」不变量，schema.ts 已注明）。`mr_catalog_version` 取 `id` PK + `version bigint NOT NULL UNIQUE` + `built_at timestamptz NOT NULL DEFAULT now()`（5c bump/latest 需有序唯一版本）。

**D12：唯一键逐一钉死 + 组件列一律 NOT NULL。** `mr_vendors UNIQUE(normalized_name)`、`mr_plans UNIQUE(vendor_id, name)`、`mr_models UNIQUE(vendor_id, family, version)`、`mr_plan_models UNIQUE(plan_id, model_id)`、`mr_plan_clients UNIQUE(plan_id, client_type, client_id)`、`mr_plan_limits UNIQUE(plan_id, limit_type, window)`、`mr_price_history UNIQUE(plan_id, changed_at)`、`mr_source UNIQUE(vendor_id, source_url)`、`mr_plan_sources UNIQUE(source_id, plan_id)`、`mr_review_flag UNIQUE(target_type, target_id)`、`mr_catalog_version UNIQUE(version)`。全部用**命名表级** `unique('<name>').on(...)` 约束（对齐本仓 `push_records`/`ai_products` 的命名约束形式，非列级 `.unique()` 链；无 partial index），经 `information_schema.table_constraints` 断言。
- **每个唯一键组件列必须 `.notNull()`**（`normalized_name`/`vendor_id`/`name`/`family`/`version`/`plan_id`/`model_id`/`client_type`/`client_id`/`limit_type`/`window`/`changed_at`/`source_url`/`source_id`/`target_type`/`target_id`/`version`）——PG `UNIQUE` 对 NULL distinct，组件可空会让去重键静默失效（同 `window`/`version` 的哨兵理由，泛化到全部组件）。`mr_plans.name` 是 `UNIQUE(vendor_id,name)` 组件，必须作为真实列 `name text NOT NULL` 建（修内部矛盾）。

## 风险 / 权衡

- 取值集（`limit_type`/`source_confidence`/`category`/`fetch_strategy`/`currency`/`status`/`target_type`/`client_type`——**所有有限值集列**）只在应用层 Zod，DB 不约束 → 绕过录入的写入方可写脏值。接受（对齐零-CHECK），spec 显式声明「合法集由 Zod 保证」+ 加「Zod 拒未知值 / 接受合法值」单测。
- `limit_type` 词表 = **桶2 样例出现的类型**（`monthly_tokens`/`rolling_5h_requests`/`weekly_messages`/`none`）；`credit`/`fast_pass` 等留 5b 全桶入库随录入扩 Zod。5a **不声称覆盖 8 家全部类型**。
- `current_price` 与 history 双写漂移 → 5a 留结构护栏（`new_value` NOT NULL + `UNIQUE(plan_id, changed_at)`），current=latest 等式由 5b 保证。
- provenance 就近挂多表 → 数据量极小可接受，膨胀再抽集中表（YAGNI）。

## 迁移计划

- `drizzle-kit generate` 产出 `0008_*`（落地前 grep 确认无编号冲突；不得手改文件名/journal tag）；仅 `CREATE TABLE` + 约束。回滚 = 不部署（forward-only，零交叉）。验证：本地 `npm run migrate` 二跑幂等 + 新增不变量测试纳入 CI（带 pg service）。

## 待解决问题

- `mr_vendors` 与 `ai_products` 的 vendor 关联：**5a 不关联**——`ai_products.vendor` 列当前不存在（仅注释保留待 P6），此刻无双源。P6 富化时边界定为「`mr_vendors` 唯一真值，`ai_products.vendor` 软引用不外键」。已从「隐患」澄清为「对端列未生 + 未来软关联边界」。
- ~~`mr_source.source_url` 与 plan 级 `source_url` 的对齐~~（**已定**：属 5b 录入规范，5a 不约束二者一致性，见 D9）。
