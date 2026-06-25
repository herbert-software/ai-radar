## 为什么

5a 建好了 Model Radar 的数据模型（`model-radar-catalog`：11 张 `mr_*` 表 + Zod 闸 + 迁移 0008），但**没有任何数据进得去、也没有保鲜机制**。5b 补上「**录入 + 保鲜回路**」：把已核数据录进库、把 5a 定义的写契约（CAS 打标 / append-only / Zod 校验）接进**生产写路径**、并用「三档抓取变更检测 + ai-radar 事件流 + 陈旧度排程」让目录不腐烂。

核心原则（来自 `docs/model-radar-tech-plan.md` 已锁决策）：**保鲜回路先于 UI**；**抓取只做变更检测、只打「待复核」标，绝不自动改 `mr_*` 权威事实**——事实靠人工策展，状态由程序和 DB 保障，不交 LLM。

权威背景：`ROADMAP.md`「P5 步骤拆解」5b、`docs/model-radar-tech-plan.md`、5a 主规范 `openspec/specs/model-radar-catalog/spec.md`。

## 变更内容

- **结构化录入路径**：最小录入（seed/录入函数，非漂亮后台）把已核 8 家全桶数据入库（带 provenance + `source_confidence`）；录入**走 5a 的 Zod 闸**（`src/db/mr-schema.zod.ts` 的 8 枚举 + `current_price`/`currency` 同生同灭 refine）——把 Zod 接进生产写路径（5a 仅测试用）。`name` 遵循「套餐全名」约定。
- **`mr_review_flag` 写契约落地**：实现 design D10 的**单语句 CAS** `INSERT … ON CONFLICT(target_type,target_id) DO UPDATE SET status='pending', reason=excluded.reason, opened_at=now(), resolved_at=NULL`（对齐 `src/kb/store.ts`），并发安全幂等。
- **`mr_price_history` append-only 写契约**：改价只 `only-INSERT`（不 UPDATE/DELETE 既有 history），同刻冲突 `ON CONFLICT(plan_id,changed_at) DO NOTHING`。
- **接 ai-radar 事件流**：每日 workflow 后挂轻量消费者，扫当天 `ai_news_events`，命中「被跟踪厂商名 + 价格/模型/套餐关键词」→ 给该厂商对应 plan 打「待复核」（写 flag 状态，**不改事实**）。事件触发复核，非死轮询。
- **三档抓取变更检测器**（已锁决策：人工 + HTTP + Playwright 全上）：按 `mr_source.fetch_strategy`——`http`（原生 fetch + 价格/额度区域归一文本 → `content_fingerprint` sha256，变即打待复核）/ `browser`（Playwright，独立 BullMQ 队列 + 独立 worker/镜像，headless、并发 1–2、超时/内存兜底，主镜像不装 Playwright）/ `manual`（不抓，靠陈旧度 + 事件流）。**抓取只算 fingerprint + 打标，存新快照供人 diff，绝不自动改 `mr_*`**。守 robots、可识别 UA、天/周级频率、不调各家 API、不做登录绕过。
- **陈旧度排程**：`last_checked` 超阈值（默认 30 天）的源/事实进人工复核队列；维护 `mr_source.last_checked`。
- **`mr_plan_sources` 定位边填充**：源↔plan 覆盖关系录入，使「源指纹变 → 定位覆盖的 plan 集合 → 打标」可落地。

## 功能 (Capabilities)

### 新增功能
- `model-radar-ingestion`: Model Radar 的录入与保鲜流水线——结构化录入（Zod 闸接生产）/ `mr_review_flag` CAS 打标 / `mr_price_history` append-only 写契约 / ai-radar 事件触发复核 / 三档（http/browser/manual）抓取变更检测（只打标不改事实）/ 陈旧度排程 / 定位边维护。

### 修改功能
<!-- 无：5b 实现并建在 model-radar-catalog（5a）的数据模型与写契约之上，不改其任何需求或 schema 语义。若确需新增 mr_* 列，走单独最小 forward-only 迁移并在彼时记为 model-radar-catalog 的修改。 -->

## 影响

- **代码**：新增 `src/mr/`（录入 / 抓取 collectors / fingerprint / flag-write / 事件消费者 / 陈旧度排程），复用 BullMQ（独立队列 = cron 触发器 + 纯函数，照 `alert-queue.ts`/`alert-scan.ts`）、collectors 的 per-source extractor + DI fetch 范式；Zod 闸从 `mr-schema.zod.ts` 接入写路径。
- **依赖 / 中间件**：新增 **Playwright**（唯一确需的新重依赖，**独立 entrypoint + 独立镜像 + 独立 compose service**；主 app/worker 镜像不装）；抓取文本快照存**短期临时文件**（base-dir 限定 + 防穿越，不入 `mr_*`、不引对象存储新依赖——对象存储留 5c，见 design D13）；其余复用现有 Redis/BullMQ/Drizzle。
- **现有系统**：只读消费 `ai_news_events`（事件流，**独立队列不嵌入 run-daily-workflow**）；不改既有表与链路；不触碰 5a 的 `mr_*` schema 语义（扩 `mr-schema.zod.ts` 枚举词表属 5a 文件自留的 5b 扩点，扩值不改语义、不算越界；新增 `mr_*` 列才走单独迁移记为 5a 修改）。
- **安全**：抓取子系统须 SSRF 防护（scheme + **checked-in 常量域名白名单** + 私网封锁 + **DNS-rebind 按档闭合**：`http`=`node:https` 原生 lookup 无新依赖 / `browser`=网络层 egress 必需部署控制 + 单一 chokepoint 覆盖 page/robots）、Playwright 沙箱锁定（含 CDP 封 WebSocket + `SIGKILL` 超时兜底）、裸请求（wrapper 无凭据参数）、快照安全存储（临时文件原子写防穿越/nosniff 属 5c 渲染边界/二阶 XSS）——见 design D10–D13。

## 非目标

- **不做** 比价/检索快照与 API（5c）、比价页（5d）、选型推荐器（5e）。
- **不把** 价格/兼容/额度等精确事实交给 LLM 判定；抓取只 propose（打待复核），人来 dispose；**绝不**用抓取/LLM 自动改 `mr_*` 权威值。
- **不做** 万能爬虫 / 无头集群 / 通用抓取框架（每源一小段 + 一个隔离 Playwright worker 封顶）；**不做登录绕过**。
- **不改** 5a 的 `mr_*` schema 语义（如确需新增列，走单独最小 forward-only 迁移）。
- **不上** 漂亮录入后台（脚本/最小录入先行，保鲜 > 美观）。
- **渠道/代理转售包**列第二阶段单独表，不混入厂商官方榜。
- **不做** 乐观并发版本列（单写者策展不需要；多写者出现再加，避免过早复杂度）。
- **5c raw snapshot 表**（含 raw_payload）留 5c；`mr_price_history` 只记人工确认后的价格事实历史，不作 raw snapshot 表。
