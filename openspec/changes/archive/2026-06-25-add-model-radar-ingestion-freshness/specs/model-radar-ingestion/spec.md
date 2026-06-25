## 新增需求

### 需求:录入经 Zod 闸（每写 mr_* 前校验，含非录入路径）

**任何生产路径**写入或更新任一 `mr_*` 表前，必须对其涉及的有限值字段调 `src/db/mr-schema.zod.ts` 对应 schema（8 枚举），`mr_plans` 调 `mrPlanWriteSchema` refine；校验失败不得发 SQL。这包括录入路径**以及**抓取链（写 `mr_source.fetch_strategy`）、事件消费者（写 `mr_review_flag.target_type`）、改价（`mr_price_history`）。5a 只提供 8 enum + partial plan schema，5b 必须为 `upsertPlan/Model/PlanLimit/PlanClient/PlanModel/PlanSource/Source` 各建组合写校验器，**且改价路径（`recordPriceChange` 写 `mr_price_history`）必须校验 `source_confidence`/`currency` 枚举**（`mr_plan_models`/`mr_price_history` 同为有限值列，不可漏）；全桶所需新枚举值（`credit`/`fast_pass`/更多 currency）随录入扩入 `mr-schema.zod.ts`（扩值不改语义，仍是该文件统一闸）。

#### 场景:非录入路径写枚举列也过 Zod
- **当** 抓取链注册一个 `fetch_strategy` 非法的源（或事件消费者写非法 `target_type`）
- **那么** 对应 Zod 枚举校验在发 SQL 前拒绝

#### 场景:全桶新枚举值随录入扩
- **当** 录入 IDE会员/Token 桶含 `fast_pass`/`credit` 限额
- **那么** `mr-schema.zod.ts` 词表已扩入该值并校验通过（扩值有对应录入往返测试）

### 需求:ingest 区分 identity 与 fact 写，禁止盲覆盖事实

`upsertVendor/upsertModel` 是 identity（唯一键冲突幂等）；`upsertPlan/upsertPlanLimit/upsertPlanClient/upsertPlanModel` 写断言事实。事实写**机制必须**为 `INSERT … ON CONFLICT DO NOTHING RETURNING` → RETURNING 空则读既有行**数值归一逐字段比对事实字段**（相同=幂等 no-op、不同=返回 `{conflict,field}` + 打 flag），**禁止用 `onConflictDoUpdate` 在唯一键冲突时盲覆盖事实字段**（plan=`current_price/currency/source_url/source_confidence` + **`category`**（5a 唯一键 `(vendor_id,name)` 不含 category，同 `(vendor_id,name)` 重录但 category 异**必须打 conflict、不静默 no-op**）、limit=`value/source_*`（`window` 是 5a 唯一键组件非比对事实）、junction=`source_confidence/source_url`；`last_checked` 是可刷新 provenance 非事实字段），二次读容 0 行不 NPE。**价格路径例外**：existing-plan 价格及对应 provenance 经 `recordPriceChange`（唯一授权刷 plan 事实字段的入口）同事务更新——属授权事实更新非盲覆盖；D2「禁盲覆盖」专指 `upsertPlan` 冲突分支对事实字段禁 `.set()`。`mr_models.family` 写前必须小写归一（5a 移交契约，防 `GLM`/`glm` 误分裂）。

#### 场景:同 vendor 同 family 大小写归一不分裂
- **当** 录入 `GLM` 与 `glm`（同 vendor、同 version）
- **那么** 归一后命中同一 family，唯一键视为同行，不分裂

#### 场景:同 (vendor,name) 异 category 打冲突不静默
- **当** `upsertPlan` 重录同 `(vendor_id,name)` 但 `category` 与既有不同（价格/provenance 即便相同）
- **那么** 返回 conflict + 打 flag，不被当幂等 no-op 静默吞掉

### 需求:单一改价入口，current=latest 从 history 推导

改价必须经 `recordPriceChange`：**公开 API 无外层事务时自身 `db.transaction`，内部 helper 只接已开 `TxLike`（非 `DbLike|TxLike`——多语句 + `FOR UPDATE` 须真事务，顶层 DbLike 会令锁早释留 TOCTOU；5c 复用须传已开外层 tx）**。同事务先 `SELECT current_price/currency/provenance … FOR UPDATE` 取 old_value 并锁行（plan 不存在报错）、过 Zod；**无价变捷径**：`current` 非 NULL 且 `Number(newValue)===Number(current)` 且 currency 同 → 仅刷 `mr_plans.source_*/last_checked`（不 append no-op 价行；`current IS NULL` 占位无价时首个真价走真追加，不被 `Number(null)→0` 误判）；否则真价变 `changed_at = clock_timestamp()`（**拿到行锁后由 DB 生成，非 `now()`/transaction_timestamp**——否则注入长 tx 可插更早 changed_at 致 current 与 MAX(changed_at) 倒挂、同 tx 二次调用共享时戳误冲突），`INSERT mr_price_history(new_value, old_value=改前 current, currency, changed_at, provenance) ON CONFLICT(plan_id, changed_at) DO NOTHING RETURNING id`。RETURNING **非空**（真追加）→ `UPDATE mr_plans SET current_price/currency=新值, source_url/source_confidence=provenance, last_checked=now()`（**provenance+freshness 必须同事务一并刷**，否则改完价 plan 仍描述旧断言且显陈旧）；RETURNING **空**（同刻冲突，clock_timestamp 下仅并发同微秒罕见）→ 读既有行**数值归一比对 `(new_value,currency)` 元组**（`Number()` 比额、currency 直比无需折叠；**同额异币种=元组异**）：元组**异**=返回/抛 `price_history_conflict` + 打 flag、**不更新 current**；元组**同**=幂等仅刷 last_checked；二次读容 0 行不 NPE。`upsertPlan` 改价必须委托 `recordPriceChange`，**禁止**裸改 `current_price`。`mr_price_history` 为 append-only（only-INSERT，禁 UPDATE/DELETE 既有行）。

#### 场景:同刻不同价不脱钩
- **当** 同 `(plan_id, changed_at)` 已存 `new_value=40`，又来一条 `new_value=45`
- **那么** history 行不变（DO NOTHING），`current_price` **不更新为 45**，且打 `price_history_conflict` flag

#### 场景:真追加才动 current
- **当** 一条新 `changed_at` 的改价（RETURNING 非空）
- **那么** history 追加新行（带 old_value=改前 current）且 `current_price`、`source_url`/`source_confidence`、`last_checked` 同事务一并更新

#### 场景:同价不同字面判幂等
- **当** 同 `(plan_id, changed_at)` 已存 `new_value='45.00'`，又来一条 `newValue=45`（数字字面）
- **那么** 数值归一比对判为相同 → 幂等不动 current、不打 conflict flag（不因 `'45.00'!==45` 误判冲突）

#### 场景:同额异币种判冲突
- **当** 同刻冲突分支既有行 `45/CNY`，传入 `45/USD`（同额异币种）
- **那么** `(new_value,currency)` 元组判为异 → 打 `price_history_conflict`、不更新 current

#### 场景:注入长事务改价 latest 与 current 不倒挂
- **当** 5c 传入已开长外层 tx、锁等待后改价（`changed_at` 由 `clock_timestamp()` 锁后生成）
- **那么** latest history（MAX changed_at）与 `mr_plans.current_price` 一致，不因 `now()` 取 tx 起始时刻而倒挂

#### 场景:同价再核刷新 provenance 不 append
- **当** `newValue` 等于 plan 当前 `current_price` 且 currency 同，但 provenance（`source_url`/`source_confidence`）不同
- **那么** 走无价变捷径仅刷 `mr_plans.source_*/last_checked`，**不 append no-op 价行**、不打 conflict、不静默丢新 provenance

### 需求:mr_review_flag 单行翻转写契约（无 setWhere）

打/翻标必须用单语句 `INSERT … ON CONFLICT(target_type, target_id) DO UPDATE SET status='pending', reason=excluded.reason, opened_at=now(), resolved_at=NULL`（**无 setWhere**——pending 时也刷 reason，区别于 `kb/store.ts` 守 terminal success；resolved 后翻回 pending 是预期，`opened_at` 重置为 now 是单行可变标的有意行为）。解决用 plain `UPDATE status='resolved', resolved_at=now()`。stale-retry 不靠 CAS guard 防护，而靠检测器幂等（见「三档抓取」需求）。

#### 场景:resolved 后重开
- **当** 一个 resolved 的 flag 被新检测触发
- **那么** 翻回 pending、清 resolved_at、`opened_at` 重置为 now，仍单行

### 需求:人工 dispose 最小面闭环

必须提供 `resolveFlag(target)`（plain UPDATE status='resolved'+resolved_at）+ 最小 dispose 面（脚本/函数）：列出 pending flags（按 target_type/age）+ `markChecked(target)`：resolveFlag + **按标的粒度同事务刷 last_checked**——source 标的刷 `mr_source.last_checked`，**plan 标的必须刷 `mr_plans.last_checked` 及其全部 child 事实行**（`mr_plan_limits`/`mr_plan_clients`/`mr_plan_models`）的 `last_checked`（否则 junction/limit 触发的 plan flag 因陈旧度仍扫到陈旧 child 行而被永久重打标）。保鲜回路必须闭合：propose（打标）→ 人工 dispose（resolve + 刷 last_checked），否则 flag 只进不出、陈旧度反复重打标。

#### 场景:resolve 后不被陈旧度立即重打标
- **当** 人工 `markChecked` 某源（resolve + 刷 last_checked=now）
- **那么** 陈旧度排程不再立即对它重打标（last_checked 已新）

#### 场景:junction 触发的 plan flag dispose 后不重打标
- **当** 某 `mr_plan_models` 行陈旧触发 plan flag，人工 `markChecked(plan)`
- **那么** 该 plan 的 `mr_plans` 及全部 child 事实行 `last_checked` 一并刷新，下轮陈旧度不再对该 junction 行重打标

### 需求:三档抓取仅做变更检测、检测器原子防 stale-retry、绝不改事实

抓取必须按 `mr_source.fetch_strategy ∈ {http,browser,manual}` 分档：抽价格/额度区域归一文本 → `content_fingerprint` sha256。必须**原子比对 `mr_source.content_fingerprint`，仅真变时**才同事务更新 fingerprint+last_checked + 经 `mr_plan_sources` 定位覆盖 plan 逐个打标；**定位空集合则给 source 自身打 `target_type='source'` flag**（页面变动永不被吞）。无变化只刷 last_checked，不打标。`manual` 不抓。**禁止自动改 `mr_*` 价格/限额/兼容事实**——结构上 `src/mr/scrape/` 禁止 import 事实 writer（`upsertPlan`/`recordPriceChange`），eslint `no-restricted-imports` 兜底。

#### 场景:指纹真变只打标不改值
- **当** 某源 fingerprint 较存储值变化
- **那么** 更新 fingerprint/last_checked + 给覆盖 plan 打待复核，`mr_*` 事实值不变

#### 场景:stale 重试 no-op
- **当** 一个旧抓取 job 重试，抓到与已更新 fingerprint 相同的内容
- **那么** 无变化 → 不打标（已 resolve 的 flag 不被旧 job 无条件重开）

#### 场景:定位空集合给 source 打标
- **当** 一个未关联任何 plan 的源指纹变化
- **那么** 给 `target_type='source'` 打标（不静默吞掉页面变动）

#### 场景:manual 源不抓
- **当** `fetch_strategy='manual'` 的源
- **那么** 抓取链不发请求

### 需求:抓取 SSRF 防护（白名单 + 私网封锁）

抓取目标 URL（`mr_source.source_url`，人工录入，视为不可信）必须经**单一 SSRF chokepoint**（page + `robots.txt` + 任何派生 URL 都必过）：① scheme 仅 `http`/`https`（拒 `file://`/`gopher://` 等）；② host 过 **checked-in 常量域名白名单 `MR_SOURCE_DOMAIN_ALLOWLIST`**（独立于 source_url，禁从录入 URL 自取 host 自授权；录入时 Zod 拒非白名单 + 抓取时再验；**录入闸仅对 `fetch_strategy∈{http,browser}` will-fetch 源，`manual` 源不发请求故豁免**）；③ 解析 host 命中私网/环回/link-local（`127/8`/`10/8`/`172.16/12`/`192.168/16`/`169.254/16`/`::1`/`fc00::/7`/`fe80::/10`）一律拒；④ **DNS-rebind 必须按档由连接层闭合**——`http` 档用 `node:https` 原生 `lookup`（解析全 A/AAAA、任一私网即整集拒、**lookup 抛错/空集 → `callback(err)` fail-closed 拒连**、否则返回预验 IP 使 check==connect、仅 lookup 不重写 URL 以保 SNI/证书、无新依赖），`browser` 档渲染器 socket 不经 Node dispatcher、靠网络层 egress（见 Playwright 沙箱需求）；纯 `dns.lookup`-then-`fetch` 不算闭合；⑤ 重定向必须 `redirect:'manual'` + 每跳重跑全套守卫 + 最大跳数（禁 `redirect:'follow'`）。`http` 档及 `robots.txt`/派生 URL 同走该守卫。

#### 场景:私网/云元数据/非白名单被拒
- **当** 录入 `source_url` 指向 `169.254.169.254` / `localhost:6379` / 非白名单域 / `file://`
- **那么** 录入被拒，抓取链不发请求

#### 场景:重定向到私网被拦
- **当** 一个白名单源 302 重定向到 `http://169.254.169.254`
- **那么** 重定向跳被 SSRF 守卫拦截，不跟随

### 需求:Playwright 沙箱锁定（不可信外部页）

`browser` 档必须：非 root 运行、Chromium sandbox 启用（禁 `--no-sandbox`）；**每 job 全新 `browser.newContext()` 用后即关**（非复用单 context）；禁下载/file chooser/对话框/新窗口/service worker/默认权限。**渲染器导航/子资源/WebSocket socket 不经 Node `lookup`——故 browser 档对私网/元数据 IP 的权威封锁必须是网络层 egress 控制**（browser-worker 独立 service 跑在封 RFC1918/link-local/`169.254.169.254` 的 egress 代理或容器 netns 内，**必需部署控制**）；**browser-worker 启动必须 fail-closed 自检**：对每段一个代表哨兵（元数据 `169.254.169.254` + 一个 RFC1918 + 环回 `127.0.0.1`）各发请求，任一未被挡则**拒绝启动、不消费 job**（netns 失效即 fail-closed 是保门选择，egress 代理须 liveness 重探，自检只证 T0）；CDP `Network.setBlockedURLs(['ws://*','wss://*'])` 封 WebSocket + `context.route` URL-string 过滤 = 纵深防御（JS shim 改 `window.WebSocket` 可被 iframe/Worker/抢跑绕过、不作权威）；硬超时**必须杀进程**（`SIGKILL` 进程树 + 外层 watchdog，非 `browser.close()`）；容器级内存上限 + 最大响应体/重定向上限。

#### 场景:页内私网请求被拦 + context 随 job 销毁
- **当** Playwright 渲染含 `<script>` 发起对 `169.254.169.254`/`file://` 的页内请求
- **那么** 被 `context.route` 拦截，且 context 随 job 结束销毁

#### 场景:页内 WebSocket 私网被封
- **当** 页内脚本 `new WebSocket('ws://169.254.169.254/')`
- **那么** 被显式 WebSocket 封禁拦截（不依赖 `context.route`，后者不拦 ws）

#### 场景:egress 未配置 browser-worker 拒绝启动
- **当** browser-worker 启动自检对私网哨兵 `http://169.254.169.254/` 发请求、发现未被网络层 egress 挡住
- **那么** worker 非零退出、拒绝启动、不消费任何 job（fail-closed，不裸奔触外网）

### 需求:抓取请求为裸请求（无凭据）

抓取 fetch wrapper **必须不接受任何 `headers`/`token` 参数**（仅固定 UA）——无参数可穿凭据，结构上无 `Authorization`/`Cookie`/任何 provider API key；不得从带凭据的 collector（如 `github.ts` 带 `GITHUB_TOKEN`）派生 fetch。

#### 场景:抓取请求头不含凭据
- **当** 检查抓取出站请求头
- **那么** 不含任何 Authorization/Cookie/API-key 字段，仅 UA

### 需求:抓取合规与礼貌（可执行）

抓取必须守 `robots.txt`、带配置的可识别 UA、天/周级频率（命中即缓存不重复抓）、不调各家 API、不登录绕过；**`robots.txt` 取用必须过与 page 同一 SSRF chokepoint + 响应体上限**（它是第一个触达不可信 host 的请求）；登录墙事实留 `needs_login_recheck` 占位（源 `fetch_strategy='manual'`，不发请求）。

#### 场景:robots 禁止路径不抓
- **当** 某源 robots.txt Disallow 命中其路径
- **那么** 该源不抓

#### 场景:robots 抓取重定向到私网被拦
- **当** 某源 `robots.txt` 302 重定向到 `http://169.254.169.254`
- **那么** 被同一 SSRF chokepoint 拦截，不跟随

#### 场景:UA 为配置标识 + 频率窗口内节流
- **当** 出站抓取请求 / 同源在频率窗口内重复触发
- **那么** 请求头 UA == 配置可识别标识 / 第二次被节流跳过

### 需求:快照安全与 5c 边界

抓取文本快照（供人 diff，**best-effort 证据**：flag 不依赖其存活、过期人重抓）：存储键必须是安全派生 id（`sha256(source_id)`），禁止把 `source_url`/厂商名拼进路径（防穿越）；**介质 5b 定为短期临时文件**，**原子写**（`id.tmp`+`rename`，并发同源 last-writer-wins、不让 diff 读半截）+ 写前必须断言 `path.resolve(base,id)` 落在 base-dir 内（拒越界）+ TTL + janitor（扫删过期 + 总字节上限防本地 DoS）；以不可执行字节存（非内联 `text/html`）；**`nosniff`/`attachment` 与「渲染当不可信文本转义」是 5c/5d 渲染边界控制**（落盘静态文件上 nosniff 为 no-op），5b 自身控制 = 静态不可执行字节 + 无渲染路径（防二阶 stored-XSS）。`mr_price_history` 只记人工确认后的价格事实历史，**不作 5c raw snapshot 表**；5c 如需 raw snapshot 走独立 `mr_*_snapshots` 表。5b 快照文本不入任何 `mr_*` 列、不引新依赖（对象存储留 5c）。

#### 场景:源标识含路径穿越仍隔离
- **当** 源标识含 `../`/斜杠
- **那么** 快照写入仍落在隔离目录内，不越界

### 需求:ai-radar 事件流触发复核（独立队列、published_at、排 tombstone、不改事实）

事件消费者必须是**独立 BullMQ 队列**（cron 在每日 workflow 产出事件之后，**不嵌入 `run-daily-workflow.ts`**）；候选门必须是**闭区间 `startOfDayInTimeZone(now, windowDays-1) <= published_at <= now`**（windowDays env 可配但**必须 `>=1`**，env 校验拒 `0`——`0`→`daysBack=-1`→下界算成明天→区间空集**静默停打标**，与 alert-scan「0=不限窗口」心智相反；**上界 `<= now` 绝不可省**——拦 AI 推断的未来 `published_at` 越过下界刷屏；nullable `published_at` 经 `gte/lte` 自然排除）的 `ai_news_events`，**排除 `merged_into IS NOT NULL` tombstone**；匹配 `mr_vendors.normalized_name`（已归一）vs 事件 `representative_title/summary_zh/headline_zh`（**三列均 nullable，任一为 NULL 必须跳过该列、不对 NULL 归一**，两侧归一）+ 价格/模型关键词常量。命中 → 给该厂商 plan 经单行翻转 CAS 打标（**不做「写前查 status」预检**——CAS 本就幂等，预检是 TOCTOU 会与人工 resolve 竞态丢真实事件），多 plan **per-target 独立**（每 CAS 自治，失败隔离）。**只写 flag、不改事实**。

#### 场景:命中厂商变动打标不改事实
- **当** 当天 `published_at` 某非-tombstone 事件命中被跟踪厂商 + 价格/模型关键词
- **那么** 对应 plan 打待复核，其事实值不变

#### 场景:tombstone 与冷启动不误触发
- **当** 扫到 `merged_into IS NOT NULL` 的合并事件 / 首次部署的历史回填事件
- **那么** 被排除/窗口下界挡住，不打标

#### 场景:未来 published_at 不绕过上界
- **当** 一条 `published_at` 为未来日期的事件命中关键词
- **那么** 被闭区间上界 `<= now` 挡住，不打标

### 需求:陈旧度排程覆盖所有事实表（含 NULL 与 junction）

陈旧度必须扫 `mr_source` **与各事实表 `mr_plans`/`mr_plan_limits`/`mr_plan_clients`/`mr_plan_models` 的 `last_checked`**；超阈值（默认 30 天 env 可配）→ source 超期打 source flag、junction/limit 超期**给其所属 plan 打 plan 级 flag**（reason 注明兼容/限额行陈旧，落地 5a 兼容陈旧经所属 plan 复核的意图）。判定为 **`last_checked IS NULL OR last_checked < threshold`**（NULL=从未核对=最该复核，不被静默跳过）。

#### 场景:junction 陈旧经所属 plan 进复核
- **当** 某 `mr_plan_models` 行 `last_checked` 超 30 天
- **那么** 给其所属 plan 打 plan 级 flag（reason 注明兼容行陈旧）

#### 场景:last_checked NULL 也进复核
- **当** 一个 manual/needs_login 占位源 `last_checked IS NULL`
- **那么** 它进入复核（NULL 判为最该复核，非跳过）

### 需求:mr_plan_sources 定位边可从源定位 plan 集合且幂等录入

录入必须维护 `mr_plan_sources`（源↔plan 覆盖），使「源指纹变 → 定位覆盖 plan 集合 → 打标」可落地；录入必须用 `ON CONFLICT(source_id, plan_id) DO NOTHING`（纯定位边，重跑幂等）。

#### 场景:重跑录入边幂等
- **当** 重复录入同一 `(source_id, plan_id)` 边
- **那么** `ON CONFLICT DO NOTHING`，不报错不重复

### 需求:BullMQ 队列四件套完整 + 重试/死信

每个 5b 队列必须给齐 `*_QUEUE`/`*_JOB` 常量 + `create*Worker` + `schedule*` + payload shape（对齐 `alert-queue.ts`），命名 `MR_EVENT_REVIEW_QUEUE/JOB`、`MR_SCRAPE_HTTP_QUEUE/JOB`、`MR_SCRAPE_BROWSER_QUEUE/JOB`、`MR_STALENESS_QUEUE/JOB`。每队列 `defaultJobOptions{attempts, exponential backoff, removeOnComplete, removeOnFail}`；重试耗尽保留 failed job（或投 `mr-*-dead`）供人工排查/重放，**失败不改事实**。browser 抓取必须独立 entrypoint + 独立镜像（主镜像不装 Playwright）。

#### 场景:worker 失败退避重试不改事实
- **当** 某抓取/事件/陈旧度 job 抛错
- **那么** 按指数退避重试，耗尽后不改事实、记录 failed 可人工重放
