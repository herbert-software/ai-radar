## ADDED Requirements

### 需求:三源确定性采集

系统必须提供 RSS、Hacker News、GitHub 三个确定性采集器（collector），以程序而非 Agent 自由采集的方式拉取数据，并将每条结果以统一结构写入 `raw_items`。统一结构必须至少包含 `source`、`source_item_id`、`url`、`title`、`content`、`published_at`、`raw_type` 字段（对齐 QA.md §10.1）。禁止用 LLM/Agent 决定采什么或是否采。

#### 场景:三源各自拉取并统一入库
- **当** 每日流水线触发采集
- **那么** RSS、Hacker News、GitHub 三个 collector 分别拉取并将结果按统一结构写入 `raw_items`，`source` 字段如实标记来源

#### 场景:单源失败不拖垮整批
- **当** 三源中某一源（如 GitHub API 限流）抓取失败
- **那么** 该源失败被记录错误日志，其余源照常完成入库，整批采集不因单源失败而中止

### 需求:源内幂等采集

系统必须为每条采集结果生成稳定且**非空**的 `source_item_id`，依赖 `raw_items` 的 `UNIQUE(source, source_item_id)` 约束保障同一源重复抓取不产生重复行。`source_item_id` 必须按 fallback 链取值：Hacker News 用 item id、GitHub 用 repo 稳定 id（如 full_name 或数值 id）、RSS 用 guid；缺失时 fallback 到 `canonical_url`；`canonical_url` 也为空时，必须终端 fallback 到内容哈希（如 `sha256(title ‖ content)`），**绝不允许 `source_item_id` 为 NULL**——因为 Postgres 中 `NULL` 不等于 `NULL`，`UNIQUE(source, NULL)` 对多行全部放行，会使源内幂等静默失效。禁止用易变值（如原始 URL 含追踪参数、纯标题）当 `source_item_id`。fallback 链中用到的 `canonical_url` 由 URL 规范化纯函数在采集阶段即时生成（见 dedup-and-normalization）。

#### 场景:重复抓取同一条不产生重复行
- **当** 同一源在两次采集中返回同一条目（相同稳定标识）
- **那么** 第二次写入因 `UNIQUE(source, source_item_id)` 冲突而被跳过，`raw_items` 中该源该条目仅一行

#### 场景:RSS guid 缺失时回退 canonical_url
- **当** 某 RSS 条目缺少 guid
- **那么** 系统以其即时生成的 `canonical_url` 作为 `source_item_id`，仍保证源内幂等

#### 场景:guid 与 canonical_url 皆缺时终端回退内容哈希
- **当** 某条目既无 guid 又无可用 `canonical_url`
- **那么** 系统以内容哈希作为非空 `source_item_id`，源内幂等不失效

### 需求:采集外部调用带重试与错误日志

系统对所有外部源的网络调用必须带重试与错误日志（横切不变量）。失败时禁止静默吞掉，必须记录可观测的错误信息。

#### 场景:外部源瞬时失败时重试
- **当** 某外部源调用发生瞬时网络错误
- **那么** 系统按有限重试策略重试，并在最终失败时记录错误日志，不静默成功
