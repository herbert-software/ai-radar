## 新增需求

### 需求:store 层统一文本净化（全源收口）

系统必须在 `store.ts`（`raw_items` 的唯一 text sink）对**所有源**入库的文本列（`title` / `content` / `url` 及 `metadata` 的字符串值）统一净化：剔除 NUL 与 C0 控制字符（保留 `\t` `\n` `\r`），剔除 lone surrogate（保留合法 emoji 代理对）。净化必须由 store 层集中执行而非依赖各采集器自觉——既有仅 `sitemap` 采集器在自身层净化、其余源（RSS/HN/GitHub/Product Hunt/Show HN/HF Papers）未净化的缺口必须由此收口补齐。sitemap 采集器自身的净化可保留作纵深防御（行为不变）。

> 动因：Postgres `text` 列遇 NUL 会在 INSERT 抛错，`jsonb` 遇 `\0` 同样报错，lone surrogate 会破坏下游 `JSON.stringify`；任一源的一条坏文本若未净化会中止整批入库。净化不改变可处理性判定（`canonical_url`/`title_hash` 的生成与 `processableCount` 口径不变）。

`metadata` 的净化必须**递归对每个字符串值施加、且在 `JSON.stringify` 之前**完成（现 `store.ts` 先 `JSON.stringify(metadata)` 再 INSERT；坏码点若留到 stringify 之后，`jsonb` 写入仍会因 NUL 报错）——先净化对象内各层字符串值、再序列化，绝不直接净化序列化后的整串（以免误伤 JSON 结构字符或漏掉嵌套值）。

#### 场景:任一源的 NUL/控制字符文本被净化后入库
- **当** 任一采集器（非仅 sitemap）产出的 `title`/`content`/`metadata` 字符串含原始 NUL/C0 控制字符或 lone surrogate
- **那么** store 层净化后再 INSERT（剔危险码点、保留 `\t\n\r` 与合法 emoji），绝不让 NUL 进 Postgres 致 INSERT 抛错

### 需求:store 层 per-item 入库隔离

系统必须把 `store.ts` 的逐条 INSERT 包在 per-item `try/catch` 中：单条目 INSERT 抛错时必须被捕获、记错误日志、计入新增的 `skippedError` 统计，循环继续处理后续条目，**绝不因单条坏数据中止整批入库**（与既有「单源失败不中止整批采集」对称）。`StoreResult` 必须新增 `skippedError` 字段；`received` / `attempted` / `inserted` / `processableCount` / `skippedInvalid` 等既有口径语义不变。

#### 场景:单条目入库抛错被隔离不中止整批
- **当** 一批待入库条目中某一条在 INSERT 阶段抛错（如净化后仍触发约束/编码错误）
- **那么** 该条被捕获、记错误日志并计入 `skippedError`，其余条目照常完成入库，整批不中止

#### 场景:skippedError 计入返回统计
- **当** 一批入库中有 N 条目触发 per-item 异常被隔离
- **那么** `StoreResult.skippedError` 等于 N，且 `inserted` 仅计真正新插入的行数
