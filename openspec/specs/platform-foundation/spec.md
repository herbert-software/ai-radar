# platform-foundation 规范

## 目的
待定 - 由归档变更 bootstrap-walking-skeleton 创建。归档后请更新目的。
## 需求
### 需求:容器化基础设施可编排
系统必须提供一份 `docker-compose.yml`，通过单条 `docker compose up` 启动 PostgreSQL 与 Redis 两项基础设施。PostgreSQL 必须使用 `pgvector/pgvector` 镜像，以便后续期次引入向量检索时无需更换镜像；但本期禁止建立任何 vector 列、禁止启用 `vector` 扩展逻辑。Redis 必须可被应用连通（供后续 BullMQ 使用）。

#### 场景:一键启动基础设施
- **当** 在仓库根目录执行 `docker compose up`
- **那么** PostgreSQL 与 Redis 容器均成功启动并进入健康状态

#### 场景:PostgreSQL 使用 pgvector 镜像但不启用向量能力
- **当** 检视 `docker-compose.yml` 的 postgres 服务镜像与本期 migration
- **那么** 镜像为 `pgvector/pgvector`，且 migration 中不包含任何 vector 列或 `CREATE EXTENSION vector` 语句

### 需求:数据库 Schema 可迁移

系统必须用 Drizzle 定义并通过 `drizzle-kit migrate` 落库核心表 `raw_items`、`ai_news_events`、`push_records`。三张表的列必须对齐 QA.md §8.1 / §8.2 / §8.6 的 DDL（不得只建主键与唯一约束的空壳表）。`drizzle-kit migrate` 必须可重复执行：已应用的迁移被跳过、命令成功返回、数据库结构无变化（迁移 journal 级幂等）。本期（P2）在 P1 三表基础上**解禁并新建 `ai_products` 表**（产品发现所需，见「ai_products 产品表可迁移」需求）；但仍禁止定义 `item_event_relations` / `item_product_relations` / `kb_ingestion_records` / `ai_tools` / `task_patterns` 这五张表（事件-产品关系表留待 P3 语义合并、工具/任务模式表留待 P5 顾问期提案再加）。

schema 必须包含以下列与约束（P1 已落库，P2 沿用、不得回退）：

- `ai_news_events.event_id` 必须为不透明 surrogate key，其值不得由内容（如 `canonical_url` 哈希）派生——以保证 P3 语义合并时事件身份稳定、历史引用（`push_records.target_id` 等）不需迁移。为与 `push_records.target_id`（`VARCHAR(128)`）保持类型一致以便 `target_id=event_id` 互引，`event_id` 必须保留 `VARCHAR(128)` 列类型，并设数据库默认值 `gen_random_uuid()::text`——使塌缩 `INSERT` 省略 `event_id` 时由数据库生成 UUID 文本，禁止由应用层用内容派生值填充。
- `ai_news_events` 必须新增 `dedup_key` 列并建 `UNIQUE(dedup_key)`，作为硬去重塌缩的冲突键（`INSERT ... ON CONFLICT (dedup_key) DO UPDATE`）。
- `ai_news_events` 必须新增 `representative_raw_item_id` 列，记录塌缩时第一条命中的 `raw_item` 主键。
- `ai_news_events` 必须新增 `published_at` 列（可空），承载代表 `raw_item` 的发布时间，供 Top N 排序 tiebreaker 使用——`ai_news_events` 此前无 `published_at` 列（仅 `first_seen_at` / `last_seen_at`），不补则排序字段不存在。
- `raw_items` 必须新增 `title_hash` 列，承载标题归一化哈希。
- `raw_items` 必须新增 `unprocessable` 标记列（`BOOLEAN NOT NULL DEFAULT false`），承载「既无可用 `canonical_url` 又归一后标题为空」的兜底状态——P0 `raw_items` 无任何状态列，不补则该兜底需求无落点。
- `raw_items` 必须含 `collapsed` 标记列（`BOOLEAN NOT NULL DEFAULT false`，P1 已落库，本期沿用并扩展语义）：对新闻类行表示「已塌缩进 `ai_news_events`」；P2 扩展为对 `raw_type='product'` 行表示「已塌缩进 `ai_products`」、对 `raw_type='paper'` 行表示「已沉淀/已路由」（入库即置 `true`）。dedup 类型路由与产品塌缩均依赖此列的 `collapsed=false` 过滤避免每轮无界重扫（见 dedup-and-normalization 与 product-discovery）——spec 显式声明此列存在，使据 spec 重建 schema 不漏列。
- `raw_items.canonical_url` 由 P0 的「建好但不生成其值」转为本期必须真正生成并写入（采集/规范化阶段填值）。
- `ai_news_events` 必须保留 P0 的 `importance_score` / `novelty_score` / `developer_relevance_score` / `hype_risk_score` / `should_push` / `summary_zh` / `first_seen_at` / `last_seen_at` / `source_count` 等列；`raw_items` 必须保留 `UNIQUE(source, source_item_id)`。

P2 必须为 `ai_news_events` 新增 `judge_claimed_at TIMESTAMPTZ`（可空）列：承载 Value Judge 评分前的原子 claim（日报链与实时告警高频链并发评分时，只有 `UPDATE ... SET judge_claimed_at WHERE *_score IS NULL AND (judge_claimed_at IS NULL OR judge_claimed_at < now() - interval 'T') RETURNING` claim 成功者送 LLM，防双评分覆写，见 daily-intel-pipeline「降级逐条容错」为权威定义）；含超时回收项（`OR judge_claimed_at < now()-T`，`T > L + W`）使 claim 后崩溃的事件可被后续运行重新 claim，该列与「僵尸 claim 回收」语义配套。

迁移对既有数据的处理：P2 必须以 forward-only 迁移（追加新迁移序号、不重写既有 0000–0003）落新增的 `ai_products` 表、`ai_news_events.judge_claimed_at` 列及任何新增列，禁止 drop 既有上线数据表重建。

`push_records` 必须保留 `UNIQUE(target_type, target_id, channel, push_date)` 唯一约束。本期推送链路扩展为多通道与多 `target_type`，系统必须实际写入推送记录（先 `pending`、成功 `success`、失败 `failed`）。`target_type` 与 `channel` 的取值必须由程序集中定义的枚举（如 Zod enum）统一收口，禁止在各推送路径散落字面量——避免某处误拼（如 `'alerts'`、`'Event'`）使幂等四元组静默分裂成两个命名空间、绕过去重而漏推/重推（DB 裸 `varchar` 不挡拼写错）。**本期权威全集必须显式声明**：`target_type` 枚举 = `{event, product, alert, weekly}`、`channel` 枚举 = `{telegram, feishu}`；新增 `target_type`/`channel` 必须先扩此枚举再使用。该全集相对 QA.md §8.6 注释集 `event/product/paper/repo` 是**双向有意偏离**，两个方向都须自洽说明：① **收口**：`paper`/`repo` 不在 P2（arXiv 论文仅采集沉淀、不推送，见 source-collectors 与 proposal 非目标），留后续期；② **扩张**：`alert`/`weekly` 是 P2 相对 QA §8.6 注释的有意新增（QA §8.6 注释未列，但本期实时告警与周报两种推送节奏各需独立幂等命名空间，见 realtime-alerts / weekly-report）。此偏离不与 QA.md 的 DDL 冲突，因为 §8.6 的 `-- event/product/paper/repo` 是 **SQL 行内注释、非 `CHECK` 约束**（QA.md DDL 中 `target_type VARCHAR(32)` 无 CHECK），枚举集可由实现期收口/扩张而不破坏 DDL；CLAUDE.md 以 QA.md 为最高权威，此处对其注释集的偏离已显式登记为有意决策。

#### 场景:迁移落核心表与本期新增列
- **当** 对一个空数据库执行 `drizzle-kit migrate`
- **那么** 数据库中存在 `raw_items`、`ai_news_events`、`push_records` 三张表，且 `ai_news_events` 含 `dedup_key`（UNIQUE）、`representative_raw_item_id`、`published_at`、`judge_claimed_at`，`raw_items` 含 `title_hash`、`unprocessable`、`collapsed`

#### 场景:event_id 为不依赖内容的 surrogate key 且与 target_id 类型一致
- **当** 检视 `ai_news_events.event_id` 的列类型与默认值
- **那么** 其列类型为 `VARCHAR(128)`（与 `push_records.target_id` 一致）、默认值为 `gen_random_uuid()::text`，不由 `canonical_url` 等内容哈希派生

#### 场景:dedup_key 唯一约束就位
- **当** 检视 `ai_news_events` 表结构
- **那么** 存在 `UNIQUE(dedup_key)` 约束，可作为塌缩 `ON CONFLICT` 的冲突目标

#### 场景:迁移可重跑且幂等
- **当** 在已迁移的数据库上再次执行 `drizzle-kit migrate`
- **那么** 已应用的迁移被跳过、命令成功返回、表结构无变化、不报错

#### 场景:推送幂等唯一约束就位
- **当** 检视 `push_records` 表结构
- **那么** 存在 `UNIQUE(target_type, target_id, channel, push_date)` 约束

#### 场景:本期仅解禁 ai_products 其余关系/顾问表仍禁止
- **当** 检视 P2 迁移
- **那么** 新增 `ai_products` 表，且不含 `item_event_relations` / `item_product_relations` / `kb_ingestion_records` / `ai_tools` / `task_patterns` 五张表

### 需求:健康检查端点
系统必须提供 Hono 应用并暴露 `GET /health` 端点，返回数据库与 Redis 的连通状态。当任一依赖不可达时，端点必须以可观测的方式反映该依赖为不健康（非静默成功）。

#### 场景:依赖健康时返回 ok
- **当** PostgreSQL 与 Redis 均可达，客户端请求 `GET /health`
- **那么** 响应体反映 `db` 与 `redis` 均为连通状态

#### 场景:依赖不可达时如实反映
- **当** Redis 不可达，客户端请求 `GET /health`
- **那么** 响应明确反映 `redis` 为不健康，而非返回全部正常

### 需求:环境配置校验
系统必须提供 `.env.example` 列出运行所需环境变量（`DATABASE_URL`、`REDIS_URL`、LLM provider API key、model 名）。应用启动时必须校验关键环境变量存在，缺失时以可观测的方式快速失败（启动即报错），禁止静默使用空值或默认值继续运行。

#### 场景:缺关键变量时启动即报错
- **当** 缺少 `DATABASE_URL` 等关键环境变量并尝试启动应用
- **那么** 应用以明确错误信息退出，而非静默启动或用空值连接

### 需求:ai_news_events 承载日报一句话要点列

系统必须为 `ai_news_events` 提供 `headline_zh` 列（`text`，可空），承载中文摘要 Agent 产出的「一句话要点」，供 Telegram 日报渲染。该列由一次 forward-only 迁移 `ALTER TABLE ai_news_events ADD COLUMN headline_zh text` 添加（取当前下一个未用迁移序号 `0003`，不重写既有 0000/0001/0002）；`drizzle-kit migrate` 必须可重复执行幂等（journal 追加一条 entry、重跑跳过、结构无变化）。该列可空使旧事件（迁移前已落库、无要点）保持 `NULL`，由日报渲染层按固定顺序回退（`summary_zh` 截断 → `representative_title` → 仅标题），不阻塞。

> 本需求把 `headline_zh` 这一新增 schema 列归入 platform-foundation（schema 的单一事实来源），使「中文摘要 Agent 写 `ai_news_events.headline_zh`」与「schema 声明该列」一致，不产生"消费方要求某列但 schema 不声明"的断裂。

#### 场景:迁移添加 headline_zh 列且幂等
- **当** 对已落 P1 schema 的数据库执行新增迁移 `0003`，再次执行 `drizzle-kit migrate`
- **那么** `ai_news_events` 含可空 `headline_zh text` 列；第二次 migrate 被跳过、结构无变化、不报错

#### 场景:旧事件 headline_zh 为 NULL 不阻塞
- **当** 迁移前已存在的事件（`headline_zh` 为 NULL）进入当日 Top N
- **那么** 日报渲染按回退顺序取 `summary_zh` 截断/`representative_title`，不因 `headline_zh` 为 NULL 报错或漏推

### 需求:ai_products 产品表可迁移

系统必须用 Drizzle 定义并以 forward-only 迁移落库 `ai_products` 表（对齐 QA.md §8.3 产品数据模型），承载产品发现的硬规则合并。该表**至少必须包含以下用于本期硬合并/推送的列**（QA.md §8.3 的其余富化列如 `vendor`/`official_url`/`category`/`description`/`open_source`/`mcp_supported`/`score` 等可一并建好留空、或留 P5 顾问期 forward-only 追加，**不得 drop**——本期不消费 ≠ 不存在）：

- 产品身份 surrogate key `product_id`，列类型与默认值钉死为 `VARCHAR(128) PRIMARY KEY DEFAULT gen_random_uuid()::text`（对齐 QA.md §8.3 的 `VARCHAR(128) PRIMARY KEY`，并与 `ai_news_events.event_id` 同口径：不透明、不由内容派生、与 `push_records.target_id` 的 `VARCHAR(128)` 类型相容以便 `target_id=product_id` 互引）；
- `name VARCHAR(255) NOT NULL`（QA.md §8.3 的唯一 NOT NULL 业务列，必须显式声明并在塌缩 INSERT 时填充，见 product-discovery「ai_products 硬规则产品合并」——漏填会使塌缩 INSERT 因 NOT NULL 约束直接失败）；
- 硬规则合并所需的唯一约束：`UNIQUE(canonical_domain)`、`UNIQUE(github_repo)`、`UNIQUE(product_hunt_slug)`（三者各自唯一，作为 `ON CONFLICT` 冲突目标）；
- last_seen 类可累加字段 `first_seen_at` / `last_seen_at` / `last_pushed_at`（可空）——**本期必建**（不属可延后的纯富化列）：硬合并塌缩的 `UPDATE` 分支累加/更新这些列，缺列则 UPDATE 无目标列、塌缩跑不通；
- `metadata JSONB`（QA.md §8.3 含此列）——**本期必建**：多键命中多行冲突态以 `metadata.merge_conflict` 标记落点（见 product-discovery「ai_products 硬规则产品合并」），缺列则冲突状态无持久落点、推送排除规则失去依据；
- `representative_raw_item_id BIGINT`（**独立列**，回指 `raw_items.id`、类型与 `ai_news_events.representative_raw_item_id` 一致）。**此列为 P2 新增过渡列，QA.md §8.3 DDL 未列**，用于在不建 `item_product_relations`（P3）的前提下保留 raw_item↔product 回指，P3 引入关系表后可迁移——spec 此处标注其为有意偏离 QA §8.3、非 DDL 不一致。

迁移必须 forward-only（追加新迁移序号、不重写既有迁移）且 `drizzle-kit migrate` 可重复执行幂等。本期禁止在 `ai_products` 上建立任何 vector 列或启用 `vector` 扩展（沿用 P1 零向量不变量，语义能力留 P3）。

#### 场景:迁移落 ai_products 表与合并唯一约束
- **当** 对已落 P1 schema 的数据库执行 P2 新增迁移
- **那么** 存在 `ai_products` 表，含 `product_id` surrogate key 及 `UNIQUE(canonical_domain)` / `UNIQUE(github_repo)` / `UNIQUE(product_hunt_slug)` 约束，可作为塌缩 `ON CONFLICT` 冲突目标

#### 场景:ai_products 迁移 forward-only 且幂等
- **当** 在已迁移数据库上再次执行 `drizzle-kit migrate`
- **那么** 既有迁移不被重写、新增迁移被跳过、表结构无变化、不报错

#### 场景:ai_products 不含向量列
- **当** 检视 `ai_products` 的 P2 迁移
- **那么** 不包含任何 vector 列或 `CREATE EXTENSION vector` 语句

### 需求:测试环境必须隔离生产外部出口

系统必须保证：在测试环境（`process.env.VITEST` 为真）下，任何**外部出口**的**默认（真实）调用路径**被守卫拒绝（throw），强制测试注入 mock / 桩，绝不让用例静默触达生产。外部出口涵盖：

- **消息发送器**：`createTelegramSender`（grammY）与 `createFeishuSender`（webhook）。
- **LLM 调用**：三个 Agent 模块（value-judge / digest / published-at-inference）的默认 `generateObject` 调用路径（即未注入 `generateObjectFn` 时的兜底实现）。

根因：`config/env.ts` 经 `import 'dotenv/config'` 使测试自动加载 `.env`（含真实 `TELEGRAM_*` / `FEISHU_*` / `LLM_API_KEY`），且测试运行器无 env 中和；若默认真实路径无守卫，任一用例漏注入 mock 即静默真发到生产飞书/telegram 或真打生产 LLM（刷屏 + 费用 + 非确定性）。

守卫判据必须为 `process.env.VITEST`（vitest 恒设、生产恒不设），故**生产运行时行为完全不受影响**——provider / model / 重试 / 超时 / 降级 / 发送口径均不变。守卫必须卡在**真实网络出口路径**：发送器在「未注入真实 transport（telegram 的 api / 飞书的 fetchImpl）」时 throw；LLM 在默认 `generateObject` 实现（仅在未注入 `generateObjectFn` 时被调用）入口 throw——**不得**卡在 `createOpenAI`/`buildModel` 这类仅构造 provider、不触网的步骤上（否则误伤已注入 mock 的用例）。守卫抛错信息必须可操作（指明「测试禁止真实调用，请注入 mock」）。

> 本需求把 PR #10 已落地的发送器守卫与本次新增的 LLM 守卫合并为同一条跨切「测试隔离生产外部出口」不变量，作为单一事实来源，防新增 Agent / 发送器复制旧的无守卫默认路径使该泄漏类复发。

#### 场景:测试下默认 LLM 调用被守卫拒绝
- **当** 某测试用例调用某 Agent（value-judge / digest / published-at-inference）但**未注入** `generateObjectFn` mock，致其走默认真实 `generateObject` 路径
- **那么** 守卫在 `process.env.VITEST` 下直接 throw（可操作错误信息），**绝不发起真实 LLM 网络调用**（首要保证，绝对成立）；该用例随后经各自链路（value-judge/digest 逐条降级→熔断，published-at→backfill 判不出）失败暴露，而非静默通过

#### 场景:测试下默认发送器被守卫拒绝
- **当** 某测试用例使通道集回退到真实发送器（未注入 telegram 的 api / 飞书的 fetchImpl，未注入 mock sender、未钉 channels）
- **那么** `createTelegramSender` / `createFeishuSender` 在 `process.env.VITEST` 下 throw，该用例当场失败，绝不真发到生产 chat / webhook

#### 场景:注入 mock 或桩的用例不被守卫误伤
- **当** 用例已注入 `generateObjectFn` mock（LLM）或注入 transport 桩 / mock sender / 钉定 channels（发送器）
- **那么** 守卫不触发，用例正常执行——守卫只拦「漏注入而回退真实出口」，不拦正确注入的用例

#### 场景:生产运行时不受测试守卫影响
- **当** 应用在生产运行（`process.env.VITEST` 未设）执行日报 / 告警 / 评分 / 摘要 / 发布时间推断
- **那么** 默认真实发送器与 LLM 调用路径照常工作，守卫恒不触发，行为与守卫引入前完全一致

