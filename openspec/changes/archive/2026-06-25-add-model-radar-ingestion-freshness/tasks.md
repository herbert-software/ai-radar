## 1. 录入路径 + Zod 接生产（`src/mr/ingest/`）

- [x] 1.1 为 `upsertPlan/upsertModel/upsertPlanLimit/upsertPlanClient/upsertPlanModel/upsertPlanSource/upsertSource` 各建组合写校验器（复用 5a 8 enum + plan refine）+ **改价路径**（`recordPriceChange` 写 `mr_price_history` 前过 `mrSourceConfidenceSchema`+`mrCurrencySchema`）；**enum-bearing 校验落点**（`upsertPlanSource`/`upsertVendor` 无枚举列不计；flag 写路径见 2.2），所有写入发 SQL 前过对应 schema（D1，`mr_plan_models`/`mr_price_history` 不可漏）
- [x] 1.2 `upsertModel` 写前 `family` 小写归一（D3，防 `GLM`/`glm` 误分裂）
- [x] 1.3 区分 identity-upsert（vendor/model，唯一键幂等）与 fact-write（plan/limit/client/**plan_model**）；fact 写 = `ON CONFLICT DO NOTHING RETURNING` → 空则读既有行**数值归一逐字段比对事实字段**（plan=`current_price/currency/source_url/source_confidence`+**`category`**（异即冲突打标，唯一键不含 category）、limit=`value/window/source_*`、junction=`source_confidence/source_url`；`last_checked` 非事实字段）→ 相同 no-op / 不同返回+打标，**禁 `onConflictDoUpdate` 盲覆盖**，二次读容 0 行不 NPE（D2）
- [x] 1.4 扩 `src/db/mr-schema.zod.ts` 枚举词表容全桶值（limit_type 增 `credit`/`fast_pass`、currency 增所需 ISO 4217；扩值不改语义=非越界改 5a）+ 每扩一值加 5a 合成往返断言
- [x] 1.5 `name` = 套餐全名约定守护（裸档位告警，design 注明「只告警因裸档位无法可靠机器识别」）
- [x] 1.6 已核 8 家全桶 checked-in seed（扩 fixture 覆盖 IDE会员/Coding Plan/Token Plan 各桶，带 provenance）+ seed 脚本
- [x] 1.7 `mr_plan_sources` 定位边录入：`ON CONFLICT(source_id,plan_id) DO NOTHING`（幂等）

## 2. 写契约（事实 writer 归 `src/mr/ingest/`；flag/fingerprint/last_checked 归 `src/mr/write/`）

- [x] 2.1 `recordPriceChange`（D4，**置于 `src/mr/ingest/`**，是事实写）：**公开 API 自开 `db.transaction`，内部 helper 只接已开 `TxLike`**（非 `DbLike|TxLike`——多语句+`FOR UPDATE` 须真事务，5c 传外层 tx）；同事务 `SELECT current_price/currency/provenance FOR UPDATE`（取 old_value+锁行，plan 不存在报错）→ 过 Zod → **无价变捷径**（`Number(newValue)===current` 且 currency 同 → 仅刷 source_*/last_checked、不 append）→ 否则 `changed_at=clock_timestamp()`（**锁后生成、非 `now()`**——防注入长 tx 倒挂/同 tx 二次共享时戳）→ `INSERT history ON CONFLICT(plan_id,changed_at) DO NOTHING RETURNING id`；非空（真追加）→ `UPDATE mr_plans SET current_price/currency=新值, source_url/source_confidence=provenance, last_checked=now()`；空（同刻冲突，clock_timestamp 下罕见）→ 读既有行**`(new_value,currency)` 元组数值归一比对**（同额异币种=元组异）：元组异=`price_history_conflict`+打 flag、不动 current / 元组同=仅刷 last_checked；二次读容 0 行；**禁 UPDATE/DELETE 既有 history**；`upsertPlan` 改价委托此入口
- [x] 2.2 `mr_review_flag` 单语句翻转（`onConflictDoUpdate` **无 setWhere**，set status=pending/reason=excluded.reason/**opened_at=now()**/resolved_at=null）+ **写前过 `mrReviewFlagTargetTypeSchema`/`mrReviewFlagStatusSchema`**（落地 spec「非录入路径写枚举列也过 Zod」，事件/fingerprint 经此 helper 写 target_type 也过闸）+ `resolveFlag`（plain UPDATE）（D5/D6），置于 `src/mr/write/`（抓取链可 import）
- [x] 2.3 **结构守卫**：`src/mr/scrape/`、`event-consumer` 只 import `src/mr/write/`（flag/fingerprint/last_checked），**禁 import `src/mr/ingest/`**（`upsert*` + `recordPriceChange` 事实 writer）；eslint `no-restricted-imports` 规则，**点名覆盖 `recordPriceChange`**（D7）

## 3. 人工 dispose 面（`src/mr/freshness/dispose.ts`）

- [x] 3.1 `listPendingFlags(by target_type/age，age=`opened_at`)` + `markChecked(target)`：resolveFlag + **按粒度同事务刷 last_checked**——source 标的刷 `mr_source`；**plan 标的刷 `mr_plans` 及全部 child 事实行**（`mr_plan_limits`/`mr_plan_clients`/`mr_plan_models`），否则 junction/limit 触发的 plan flag 被永久重打标（D6 闭环）。`ponytail:` 全刷 child 刻意权衡——掩盖窄因复核的兄弟陈旧但有界（≤30 天 D9 重触发），per-row 精度须加 5a flag child 列=越界留后

## 4. ai-radar 事件流触发复核（`src/mr/freshness/event-consumer.ts`，**独立队列**）

- [x] 4.1 独立 BullMQ 队列（`MR_EVENT_REVIEW_QUEUE/JOB` + `createEventReviewWorker` + cron，**不嵌入 run-daily-workflow**，对齐 alert-queue 范式）
- [x] 4.2 只读扫**闭区间 `startOfDayInTimeZone(now, windowDays-1) <= published_at <= now`**（windowDays env **必须 `>=1`**（拒 `0`，否则下界算成明天致空集静默停打标）；**上界 `<= now` 绝不可省**拦未来值；nullable `published_at` 自然排除）的 `ai_news_events`，**排除 `merged_into IS NOT NULL`**；匹配 `mr_vendors.normalized_name`(归一) vs `representative_title/summary_zh/headline_zh`(**三列 nullable，任一 NULL 跳过该列**，归一) + `const REVIEW_TRIGGER_KEYWORDS`（价格/模型，校准旋钮注释）
- [x] 4.3 命中 → 经 2.2 给 plan 单语句 CAS 打标（**不做写前查 status 预检**，CAS 幂等、预检 TOCTOU 会丢真实事件）；多 plan **per-target 独立**（每 CAS 自治，失败隔离，不裹批事务）；**只写 flag 不改事实**

## 5. 三档抓取变更检测（`src/mr/scrape/`，只 propose）

- [x] 5.1 `fingerprint.ts`：抽价格/额度区域归一文本（每源一小段，不引 cheerio）→ sha256；**原子** compare-and-update（真变才更新 fingerprint+last_checked + 经 `mr_plan_sources` 定位 plan 打标；**空集合给 source 自身打 `target_type='source'` flag**；无变化只刷 last_checked → stale 重试 no-op）（D7）
- [x] 5.2 **SSRF 守卫**（D10，单一 chokepoint，page + `robots.txt` + 任何派生 URL 都必过）：scheme http(s) only、**checked-in 常量白名单 `MR_SOURCE_DOMAIN_ALLOWLIST`**（独立于 source_url，录入 Zod 拒 + 抓取再验）、私网/环回/link-local 封锁、**DNS-rebind 按档闭合**（`http` 档 `node:https` 原生 `lookup`：解析全 A/AAAA 任一私网即整集拒、**lookup 抛错/空集→callback(err) fail-closed**、仅 lookup 不重写 URL 保 SNI、无新依赖；`browser` 档靠网络层 egress 见 5.4；纯 `dns.lookup`-then-`fetch` 不算）、重定向 `redirect:'manual'` + 每跳重验 + 最大跳数（禁 `follow`）；**eslint 禁 `src/mr/scrape/` 裸调出站原语绕过 wrapper（`fetch`/`globalThis.fetch`/`node:http(s)`/`node:net`/`node:dgram`/`require` 形式）**；错误只记通用枚举原因 + source id（不泄露 IP/拓扑）
- [x] 5.3 `http` 档：原生 fetch（per-source extractor + DI fetch）；**裸请求**无凭据（D12）；守 robots + 可识别 UA + 频率
- [x] 5.4 `browser` 档：Playwright **沙箱锁定**（D11：非 root + sandbox 启用、每 job 新 context 用后即关、禁下载/file/对话框/SW/权限）；**渲染器 socket 不经 Node lookup → 私网/元数据权威封锁靠网络层 egress**（browser-worker service 跑在封 RFC1918/link-local/`169.254.169.254` 的 egress 代理或容器 netns，**必需部署控制**）；**启动 fail-closed 自检**：`browser-worker-main.ts` 驱浏览器对每段代表哨兵（元数据 `169.254.169.254`+RFC1918+`127.0.0.1`）发请求、任一未被挡则非零退出拒启动不消费 job（netns 保门/代理须 liveness 重探）；CDP `Network.setBlockedURLs(['ws://*','wss://*'])` 封 WebSocket + `context.route` URL-string 过滤 = 纵深防御（JS shim 可绕过不作权威）；**硬超时 `SIGKILL` 进程树 + 外层 watchdog**（非 `browser.close()`）、内存/响应体上限；独立 entrypoint `browser-worker-main.ts` + 独立镜像（主镜像不装 Playwright）（D15）
- [x] 5.5 `manual` 档：跳过不发请求
- [x] 5.6 快照文本安全存储（D13，best-effort 证据）：**短期临时文件** + 安全派生 id（`sha256(source_id)`）+ **原子写 `id.tmp`+`rename`**（并发同源 last-writer-wins、不读半截）+ 写前断言 `path.resolve(base,id).startsWith(base+sep)` 拒越界 + 不可执行字节 + TTL + janitor（扫删过期 + 总字节上限）；`nosniff`/`attachment` 属 5c 渲染边界（落盘 no-op），5b 控制=静态不可执行字节+无渲染路径；不入 `mr_*`、不引新依赖（对象存储留 5c）
- [x] 5.7 BullMQ 四件套（`MR_SCRAPE_HTTP_*`/`MR_SCRAPE_BROWSER_*` + worker + 分层 cron + `defaultJobOptions{attempts,backoff,removeOnComplete/Fail}` + dead-letter）（D14）

## 6. 陈旧度排程（`src/mr/freshness/staleness.ts`）

- [x] 6.1 扫 `mr_source` **与各事实表**（plans/limits/clients/models）`last_checked`；超阈值（30 天 env）→ source 超期打 source flag、junction/limit 超期**给所属 plan 打 plan 级 flag**（reason 注明）；判定 `last_checked IS NULL OR < threshold`（NULL=最该复核）（D9）；`MR_STALENESS_*` 四件套

## 7. 测试 + 收尾

- [x] 7.1 录入 Zod 闸：非录入路径（抓取/事件/**改价**/**flag 写**）写枚举列也过 Zod（含 `mr_plan_models` + `mr_price_history.source_confidence/currency` + **`mr_review_flag.target_type` 经 flag CAS helper**）；非法拒；全桶新枚举值往返；**family `GLM`/`glm` 同 vendor/version 命中同行不分裂**；**同 (vendor,name) 异 category 打 conflict 不静默 no-op**
- [x] 7.2 改价契约：同刻不同价不脱钩（不动 current + 打 conflict flag）、**同价不同字面（`45` vs `'45.00'`）判幂等不打 conflict**、**同额异币种=元组异打 conflict**、**无价变捷径仅刷 provenance/last_checked 不 append no-op**（`current IS NULL` 占位首个真价仍走真追加不被 `Number(null)→0` 跳过）、真追加才动 current **且一并刷 source_*/last_checked**、**clock_timestamp 下 latest history 与 current 不倒挂**（注入长 tx + 锁等待后改价断言）、old_value=改前、append-only 不覆盖；grep 守 `recordPriceChange` 模块外无 `.update/.delete(mrPriceHistory)`
- [x] 7.3 flag 翻转 + dispose：并发收敛单行 + reason 刷新 + resolved 重开（opened_at 重置）；markChecked 后陈旧度不立即重标；**junction 触发的 plan flag `markChecked(plan)` 后刷 child 行 last_checked、不被重打标**
- [x] 7.4 事件消费者（注入桩）：published_at **闭区间**（下界拦回填 + **上界拦未来值** + **windowDays=0 被 env 校验拒**）+ 排 tombstone + **NULL 文本列跳过不抛** + 命中打标不改事实 + 冷启动不批量误标
- [x] 7.5 抓取（注入 fetch/Playwright 桩，不触网）：指纹真变只打标 + stale 重试 no-op + 定位空集合给 source 打标 + manual 不发请求；**SSRF**：私网/云元数据/非白名单/file://→录入拒+不发请求、重定向私网被拦、**`robots.txt` 重定向私网也被同 chokepoint 拦**、**lookup 空集/抛错→fail-closed 拒连**、**`src/mr/scrape/` 裸调 `fetch`/`node:https`→eslint 报错**；**裸请求**头无凭据；**沙箱**：页内私网被 route 拦 + **页内 `ws://` 私网被显式 WebSocket 封禁拦** + context 随 job 销毁 + **egress 未配 browser-worker 启动自检拒启动** + **挂死渲染器→watchdog `SIGKILL`（桩 pid）**；**快照**：源标识含 `../` → 仍落隔离 base-dir + **janitor 删过期/命中字节上限拒新写**；**合规**：robots 禁则不抓 + UA == 配置 + 频率窗口节流
- [x] 7.6 陈旧度：junction 超期经所属 plan 进复核 + last_checked NULL 也进复核
- [x] 7.7 结构守卫：`src/mr/scrape/`/event-consumer import 事实 writer → eslint 报错（机械验证「抓取改不了事实」）
- [x] 7.8 `tsc --noEmit` 0 错 + `lint` 0 错 + 全量 `vitest` 全绿；browser worker 独立镜像/compose service 接 CI（真实抓取勘验交付用户用真实源跑一次）
