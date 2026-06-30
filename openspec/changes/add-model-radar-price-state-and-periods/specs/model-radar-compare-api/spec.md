## MODIFIED Requirements

### 需求:只读快照从 mr_* 子集构建并校验

系统必须提供 Model Radar 只读快照构建器，从构建所需的 `mr_*` 子集（10 张：vendors/plans/models/plan_models/plan_clients/plan_limits/plan_prices/source/plan_sources/review_flag，仍不含 `mr_price_history`、也不含 `mr_catalog_version`）读取并构建去规范化 JSON。快照必须覆盖 vendor、plan、availability、models、clients、limits、`mr_plan_prices` 季/年付、`mr_source`、`mr_plan_sources`、provenance、staleness、review flag，并在对外返回前经过 Zod schema 校验。快照读取必须是单事务、point-in-time 一致；各表/数组必须按稳定键排序，其中 `mr_plan_prices` 按 `(plan_id,billing_period,currency)` 排序，防无变更 hash 漂移。API 请求热路径禁止直接 join 规范化 `mr_*` 表作为主要读路径。

#### 场景:快照包含完整关系、周期价与 provenance
- **当** 数据库中存在一个 plan 及其模型、工具/协议、限额、季/年付周期价和待复核 flag
- **那么** 快照中同一 plan 带有这些去规范化关系、`availability`、每条断言事实的 provenance（日粒度 `lastCheckedDate`）、离散 freshness 和 pending review 状态

#### 场景:快照单事务一致读不撕裂
- **当** 在快照构建过程中有并发写提交（如新增某 plan 的 period price 行）
- **那么** 构建器在单事务 point-in-time 视图下读取，结果要么完全包含该写、要么完全不含，不出现「读到 plan 却漏其 child」的撕裂态

#### 场景:快照 schema 校验失败不对外服务且不覆盖旧快照
- **当** 快照构建结果缺失必需 provenance 字段、出现非法枚举值、或周期价 `effectiveMonthly` 与 `priceStatus` 不一致
- **那么** 构建器必须报错、不缓存坏快照、不覆盖既有可用快照；冷启动首建即失败时 API 返回 503 且不写缓存

### 需求:快照聚合源与厂商待复核及陈旧状态

快照中每个 plan 的 `reviewStatus`/`staleness` 必须聚合：直接指向该 plan 的 flag、指向其 vendor 的 flag、经 `mr_plan_sources` 关联的 source flag 与 source `last_checked`、plan 自身及其 child 事实行（`mr_plan_limits`/`mr_plan_clients`/`mr_plan_models`/`mr_plan_prices`）的 `last_checked`。任一为 pending/陈旧，则该 plan 必须暴露为待复核/陈旧，禁止只看 plan 级 flag 而把关联源/child 行已待复核或陈旧的 plan 显示为干净。

#### 场景:周期价陈旧的 plan 不显示新鲜
- **当** 某 plan 的 `mr_plan_prices` 年付行 `last_checked` 已超阈值，而其它事实行仍新鲜
- **那么** 快照中该 plan 的 `freshness.stale=true`

#### 场景:关联源待复核的 plan 不显示干净
- **当** 某 plan 经 `mr_plan_sources` 关联的源被打了 `target_type='source'` 的 pending flag
- **那么** 快照中该 plan 的 reviewStatus 为待复核，而非干净

#### 场景:vendor 级 flag 传导到其 plan
- **当** 某 vendor 被打 pending flag
- **那么** 其名下 plan 的 reviewStatus 反映该待复核状态

#### 场景:从未核对的源（last_checked NULL）判陈旧
- **当** 某 plan 关联一个从未抓取的 browser 源（`mr_source.last_checked IS NULL`、`content_fingerprint NULL`）
- **那么** 快照将其判为陈旧、暴露待复核，而非按 `now - NULL` 误判为新鲜（plan/child 行 last_checked 为 NOT NULL，只走阈值比较）

### 需求:同桶价格排序必须按已核 provenance + 同币种判定

同桶排序必须将 plan 判为 `priceStatus='known'` **当且仅当**：canonical 月价 `current_price` 非 NULL、`currency` 非 NULL、且 `source_confidence` 属已核官方集合 `{official_pricing, official_doc}`。任一不满足（价格或币种为 NULL，或 confidence 为 `needs_login_recheck`/`official_community`/`media_report`）一律判 `priceStatus='unknown'`（未核）。已知价格只在**同一 category 且同一 currency** 内按数值升序排序；不做汇率换算。未知价格（currency 视为 NULL）**当其在结果集中时**必须归入 `sortScope.currency=null` 的未知价组、不挂任何已知币种组（与「currency 过滤指定币种时排除未知价」互不冲突——前者是默认分组归属、后者是谓词过滤把未知价移出结果集，二者 mode-disjoint），不参与“最便宜”结论，并在 `requiresKnownPrice=true` / 预算过滤 / `currency` 过滤时被排除。禁止把 NULL 当作 0、估算价或默认价；禁止用非官方 confidence 的价格冒充已核价参与 cheapest。

本变更新增：`availability='discontinued'` 与 priceStatus 正交，停售 plan 可保持 `priceStatus='known'`（历史价格仍是事实），但必须从 `cheapestPlanId` / `comparable=true` 的候选集合排除，且在推荐器中不得成为 primary；`availability='unknown'` 不当停售处理。季/年付 `effectiveMonthly` 不参与 cheapest/sort。

#### 场景:非官方 confidence 带价格不参与 cheapest
- **当** 某 plan `current_price=40`、`currency='CNY'`，但 `source_confidence='needs_login_recheck'`（或 media_report）
- **那么** 该 plan 判 `priceStatus='unknown'`，不参与 cheapest，不被当作已核价排序

#### 场景:未知价格排在已知价格之后
- **当** 同一 category 同一 currency 中 plan A 价格为 40 CNY 且 official_pricing，plan B 价格为 NULL
- **那么** 价格升序结果中 A 排在 B 前，B 标记 `priceStatus='unknown'` 且不成为 cheapest

#### 场景:混币不当同单位比较
- **当** 同一 category 内 plan C 为 20 EUR、plan D 为 40 CNY
- **那么** 二者不被当同单位比较；排序按 (category, currency) 分组进行，或请求未带 currency 时不输出跨币种 cheapest

#### 场景:预算过滤排除未知价格
- **当** 请求 `maxMonthlyPrice=100 CNY` 或 `requiresKnownPrice=true`
- **那么** priceStatus 为 unknown 的 plan 不进入结果集

#### 场景:裸预算无 currency 被拒
- **当** 请求 `maxMonthlyPrice=100`（未带 currency）
- **那么** API 返回 400（与「maxMonthlyPrice 必带 currency」契约一致）

#### 场景:全未知价格不产生最便宜结论（currency 可为 null）
- **当** 某 category 的匹配 plan 全部为 unknown price（currency 缺失为 NULL）
- **那么** API 返回结果可列出这些 plan，置于 `sortScope.currency=null` 的未知价组，必须返回 `cheapestPlanId=null`（无可比最便宜 plan）加具名标记（`comparable=false` 与 `unknownCount`），不得用自由文本含糊表达

#### 场景:停售已核低价不成为 cheapest
- **当** 同一 (coding_plan,CNY) 组内 plan A `availability='discontinued'` 且月价 ¥1，plan B `availability='on_sale'` 且月价 ¥49
- **那么** plan A 可列出并标停售，但 `cheapestPlanId` 指向 plan B；不得因停售低价得出最便宜结论

#### 场景:季/年有效月价不参与 cheapest
- **当** 某 plan 月付 ¥49、年付 ¥468（effectiveMonthly ¥39）
- **那么** cheapest 仍按月价 ¥49 与其它 plan 比较，不按 ¥39 排序

### 需求:快照版本与 ETag 必须随数据变更失效

API 暴露的 `version`/ETag 必须在底层数据变更后改变，否则下游 HTTP 304 会返回陈旧价。**唯一公开 `version`/ETag 源 = 快照内容哈希**：哈希前必须 **canonical 序列化**——既排序对象键，也固定数组/行序（buildSnapshot 各表 `ORDER BY id` 或 builder 内按稳定键排序；新增 `mr_plan_prices` 必须按 `(plan_id,billing_period,currency)` 稳定排序）。**`mr_catalog_version`/`builtAt` 纯属内部用途、不作公开 `version`/ETag 源、不进服务表征**（避免「bump 每周期/无变化也变」与内容哈希语义冲突）。

**哈希内容契约（ETag = 服务表征的纯函数；防过度失效 + 防 304-with-stale）**：ETag 必须是 **API 实际返回的服务表征**的 canonical 哈希——**不得有 served-but-unhashed 或 hashed-but-unserved 字段**，唯一例外是 `version`/ETag 字段本身：响应体 `version`（若返回）等于该内容哈希、是从 canonical 服务表征派生的传输别名，本身不进入哈希输入（避免自引用）。新增的 `availability`、`periodPrices`、周期价 `priceStatus`、`effectiveMonthly`、周期价 provenance/`lastCheckedDate` 都是服务表征，必须进入内容哈希。`effectiveMonthly` 不进 cheapest/sort，但只要服务给客户端就必须进 hash。

为同时满足「无变更稳定」与「跨阈值翻转」，服务表征的 freshness 仅暴露离散 `stale: boolean`（由 `last_checked IS NULL 或 < (注入 now − 阈值)` 算出；plan 级 `stale` = 其任一成分事实/源 stale 的聚合，良定义），服务表征不暴露 raw 秒级 `last_checked`、也不暴露 plan 级聚合 date；但暴露 per-provenance 日粒度 `lastCheckedDate`。如此「排除 raw last_checked / now 派生连续量（ageMs） / 构建时刻」对 hash 与 served 表征同时成立、无 served-vs-hash 错配。由此：① 同一注入 now、无服务表征变化 → 哈希稳定、304 命中、不过度失效；② now 推进跨过 staleness 阈值 → `stale` 翻转 → 服务表征变 → ETag 变；③ 仅推 raw 秒级 `last_checked`、未跨该事实的 UTC 日界、未翻 stale 谓词的写不改服务表征 → ETag 可不变；若该写把 `last_checked` 推到新 UTC 日，则其 `lastCheckedDate` 变 → ETag 变。

**per-fact age**：服务表征必须为每条事实行 provenance（plan 价格事实、models/clients/limits 事实、period price 事实）+ 关联源行暴露一个 `lastCheckedDate`（日粒度 ISO 日期），由 builder 在单事务 point-in-time 内从该行 `last_checked` 派生。它是 `trunc(last_checked)` 的纯函数、完全与 `now` 无关；仅当该事实行 `last_checked` 被写到新 UTC 日才变。截断必须按固定 UTC（`toISOString().slice(0,10)` 或 SQL `AT TIME ZONE 'UTC'`），禁按进程/会话本地时区。`snapshotSourceSchema.lastCheckedDate` 可为 null（`mr_source.last_checked` 可 NULL，从未抓源无 date）；事实 provenance（plan/limit/client/model/period price，其 `last_checked` NOT NULL）的 date 必填非 null。仍不暴露 raw 秒级 `last_checked`、仍不暴露 plan 级聚合 date；「N 天前」相对文案只在 render 层算，绝不进 DTO/哈希。

**已拒绝的替代方案**：「bump `mr_catalog_version` 作公开 version 源」——它会带来「每周期 bump/无变化也变」的过度失效，且若在 on-read 触发则让 GET 在请求路径写 `mr_*`、违反「请求路径只读」；故唯一公开源是内容哈希，不引入该备选。hashed 内容真变经 rebuild 后 ETag 必须变化、无变更则 ETag 稳定。

rebuild **recompute** 必须**无缺口**地覆盖一切改变快照可见字段的授权写（recompute 覆盖全部路径；ETag 是否变化取决于 hashed 内容是否真变——纯幂等 no-op 允许 ETag 不变）：① **canonical 月价改价**——recompute 必须覆盖**两个改价入口**（公开 `recordPriceChange` **与** `upsertPlan` 经 `_recordPriceChangeTx` 的委托改价路径），且在**最外层事务提交后**触发（提交前重建会读不到未提交价），并覆盖 `recordPriceChange` 的**全部 success outcome**（appended / noop-refreshed / noop-same-tuple / history-conflict 等），不得只钩 `outcome==='appended'`；其中 appended/provenance 变会改 hashed 内容→ETag 变，而 `noop-same-tuple`（仅推 last_checked、**未跨其 UTC 日界**、未翻 stale 谓词、无其它变化）属幂等 no-op、ETag 可不变（304 仍正确）——但若该 refresh 把 last_checked 推到**新 UTC 日**，其 `lastCheckedDate` 变 → ETag 变。② **结构性录入事实变**（seed / 策展脚本 / ad-hoc `upsertPlan*`/`upsertVendor`/`upsertSource` 等）由脚本末尾触发或由周期 rebuild 兜（单条 ad-hoc 结构写不保证即时刷 ETag，归周期 rebuild）。③ **保鲜回路的 flag/staleness 写**（`setReviewFlag`/`markChecked`/staleness 排程改 reviewStatus/staleness）路径众多且 cron 驱动，须由**后台周期 rebuild 安全网**兜底——**周期/带外、非 on-read**，请求路径绝不触发写。④ 本变更新增的 `setPlanAvailability`、`upsertPlanPeriodPrice` 授权写提交后必须触发快照 rebuild/invalidation。**5c 范围**继续是交付可直接调用的 rebuild job body + builder/cache 注入 `now` + CI 测；常驻 worker 装配与跨进程失效由后续既有 specs 接线，不在本变更谎称已有运行中安全网。实现宜把 rebuild 钩在写编排边界（包住两个改价入口 + 本变更新增授权入口）+ 后台周期安全网，而非脆弱地逐入口枚举或 on-read 触发。

#### 场景:数据变更后 ETag 变化
- **当** 某 plan 月价经授权改价入口更新后触发快照 invalidate+rebuild
- **那么** API 返回的 version/ETag 与变更前不同，下游不会拿到陈旧 304

#### 场景:授权写触发 rebuild（含 upsertPlan 委托改价）
- **当** 改价经 `recordPriceChange` 或经 `upsertPlan` 委托路径成功（任一 success outcome）
- **那么** 在最外层事务提交后必触发快照 rebuild recompute（不留「改价但未 rebuild」缺口）；ETag 仅在 hashed(=服务表征) 内容真变时变化——appended/provenance 变 → ETag 变，纯 `noop-same-tuple`（仅推 raw last_checked、未跨 UTC 日界、未翻 stale）→ 服务表征不变、ETag 可不变

#### 场景:availability 变化后 ETag 变化
- **当** 某 plan 经授权入口从 `availability='on_sale'` 改为 `discontinued`
- **那么** API 返回的 version/ETag 与变更前不同，下游不会拿到旧的在售状态 304

#### 场景:周期价变化后 ETag 变化
- **当** 某 plan 的年付价、period provenance 或 `lastCheckedDate` 发生快照可见变化
- **那么** 内容哈希/version 随之变化；客户端不会缓存旧的最佳周期依据

#### 场景:保鲜回路 flag 写经 rebuild job body 反映
- **当** 保鲜回路给某 plan 打 pending flag（不经改价入口），随后直接调用 rebuild job body（注入 now）
- **那么** 快照 reviewStatus 反映该变化、ETag 变化（请求路径不触发任何写）；测试经直接调 job body + 注入 now 断言，无需真实等待或常驻 worker

#### 场景:无服务表征变化 rebuild 不漂移 ETag
- **当** 重复写入同一 availability 或同一周期价 tuple，且 `lastCheckedDate`/stale 未变
- **那么** 内容哈希 ETag 可保持不变，避免过度失效

#### 场景:staleness 阈值穿越翻转 ETag（不 304-with-stale）
- **当** 无任何 DB 写，但注入 now 推进跨过某 source 或 period price 的 staleness 阈值（前一刻 stale=false，跨后 stale=true）
- **那么** 离散 stale 谓词翻转使 hashed 内容变、ETag 变，客户端不会拿到 304 却附过期 stale 状态

#### 场景:不跨阈值无变更 rebuild 不漂移 ETag
- **当** 注入 now 推进但**未跨任何 staleness 阈值**、且无任何快照可见字段变化
- **那么** 内容哈希 ETag 保持不变、下游 304 仍命中（不过度失效；哈希不含构建时刻/now 派生连续量）

#### 场景:per-fact lastCheckedDate 完全 now 无关（now 跨日界亦不改哈希）
- **当** 无任何 DB 写、注入 now 推进跨过某事实的 UTC 自然午夜（但未跨 staleness 阈值）
- **那么** 各 provenance 的 `lastCheckedDate` 不变，内容哈希/version 稳定；「N 天前」相对文案在 render 层另算、不进哈希

#### 场景:事实重核到新 UTC 日改其 date 与哈希
- **当** 某事实行 `last_checked` 被**写**到新的 UTC 日期
- **那么** 该 provenance 的 `lastCheckedDate` 变为新日期、内容哈希/version 随之变

#### 场景:UTC 截断保证跨进程哈希一致
- **当** 两个 `process.env.TZ` 不同的进程对同一 DB 状态构建快照、某 `last_checked` 落在近午夜瞬间
- **那么** 二者按固定 UTC 截断得到同一 `lastCheckedDate` 字符串、算出同一内容哈希

## ADDED Requirements

### 需求:只读快照暴露 availability + 季/年付周期价（含有效月价），cheapest 仍以月价

只读快照 DTO 必须逐 plan 暴露 `availability ∈ {on_sale, discontinued, unknown}` 与 `periodPrices[]`（`{billingPeriod ∈ {quarterly,annual}, price, currency, priceStatus, provenance, effectiveMonthly}`）。周期价 `priceStatus='known'` 当且仅当 price 非 NULL + 官方 confidence；`effectiveMonthly` = 确定性 `price ÷ {quarterly:3, annual:12}`，但当 `priceStatus!='known'` 时必须为 `null`。比价 / cheapest 仍以 canonical 月价（`current_price`）排序、money-path 排序口径不变；周期价仅作附加暴露和最佳周期依据，不进 cheapest/sort。Token Plan 不生成 effectiveMonthly / 最佳周期。

#### 场景:DTO 暴露 availability + 周期价、cheapest 仍月价
- **当** 某 (coding_plan, CNY) 组含月付 ¥49 与年付 ¥468（effectiveMonthly ¥39）的 plan
- **那么** 快照逐 plan 带 `availability` + 年付 `periodPrices`；该组 cheapest 仍按月价 ¥49，而不是按年付有效月价 ¥39

#### 场景:未核周期价 effectiveMonthly 为 null
- **当** 某年付行 `price=NULL,currency='CNY',source_confidence='needs_login_recheck'`
- **那么** DTO 中该行 `priceStatus='unknown'`、`effectiveMonthly=null`，不得输出 0 或省略导致下游误判

#### 场景:停售 plan 经 availability 暴露、不靠占位暗示
- **当** 某 plan `availability='discontinued'`
- **那么** 快照 DTO 显式带 `availability='discontinued'`，供 query/recommender 区分「停售」与「未核价」；不靠 NULL 价占位暗示停售
