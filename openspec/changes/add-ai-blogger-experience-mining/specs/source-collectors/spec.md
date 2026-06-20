## 新增需求

### 需求:策划 AI 博主 feed 接入与经验类硬字段标记

系统必须支持把一批**策划的 AI 博主 feed**（独立博客 / Substack / YouTube 频道 RSS）经独立 `BLOGGER_FEEDS` env（复用 `rssFeedList` 的 `URL|vendor` 解析）注册进既有 collector registry 接入采集，沿用既有 RSS 采集与源内幂等机制（`UNIQUE(source, source_item_id)`、单源失败隔离、数组驱动 registry）。接入必须**扩展 `CollectorSource` 联合类型新增 `'blogger'`** 并在 registry 注册对应 collector；且必须**显式声明 `blogger` 不归属实时告警子集 `REALTIME_NEWS_SOURCES` 与产品子集 `PRODUCT_SOURCES`**（对齐既有「新增源须显式决定子集归属、否则被静默排除」前向护栏）。

这些经验导向条目必须被**两个确定性硬字段**标记：`source='blogger'` 且 `raw_type='experience'`（不复用 `raw_type='post'`——`post` 已被 Hacker News 占用且被事件塌缩当新闻类纳入）。标记由程序在配置/采集层确定性写入硬字段（**禁止**用 `metadata` 软标记，因下游塌缩路由与经验链选条都靠 `raw_type` 硬筛），且经验条目入库即置 `collapsed=true`（沉淀，使其不被新闻/告警事件塌缩的 `collapsed=false` 过滤选入）。

**隔离命门（不变量）**：`raw_items.source`/`raw_type` 由 collector 返回的 `item.source`/`item.rawType` 直写（DB 裸 varchar 不挡），与 registry 项的 `source` 字段是两个独立来源。既有 `mapRssItem` 把 `source:'rss'`/`raw_type:'news'` 硬钉为内部常量（非参数）；blogger 采集**绝不得复用** `mapRssItem`（否则静默写入 `source='rss'`/`raw_type='news'` → 两硬字段隔离全部失效、经验帖被塌进 `ai_news_events`），必须走**独立映射函数** `mapBloggerItem` 产出 `source:'blogger'`/`raw_type:'experience'`/`collapsed:true`，并从 `env.BLOGGER_FEEDS` 取 feed 清单。**不变量**：registry 注册某 collector 时声明的 `source` 字段必须与该 collector 返回的 `item.source` 一致。

#### 场景:新增博主 feed 仅需注册即接入
- **当** 向 `BLOGGER_FEEDS` 增加一个策划 AI 博主 feed（blog/substack/youtube）
- **那么** 它被采集编排按既有 RSS 机制拉取并落 `raw_items`，无需修改既有源的编排分支；`CollectorSource` 含 `'blogger'`，且 blogger 显式不在实时/产品子集内

#### 场景:经验类来源被确定性硬字段标记并沉淀
- **当** 一条来自策划 AI 博主 feed 的条目落 `raw_items`
- **那么** 它带 `source='blogger'`、`raw_type='experience'` 两个硬字段（非 metadata 软标记）且 `collapsed=true`，标记由程序在配置/采集层确定性写入、不经 LLM

### 需求:YouTube 频道条目有字幕则取正文

对来自 YouTube 频道 RSS 的条目，系统必须在采集阶段**逐条尝试拉取该视频的字幕（caption/transcript）作为 `content`**：有字幕时以字幕文本作正文供下游经验提炼；**无字幕时仅保留标题+简介、不进行 ASR 转写**（本期不引入语音转写）。因既有 `mapRssItem` 是同步纯函数无网络，取字幕须作为 `collectRss` 内的**逐条异步增强**（对 host=youtube.com 的条目 `await` transcript），属真实结构改动、非零改动。字幕拉取必须带重试与错误日志，且作为单条增强**失败被隔离**——某条取字幕失败不得中止整批采集（退化为仅标题+简介落库）。YouTube Atom feed 由 `rss-parser` 原生解析（无需新增 Atom 分支），`source_item_id` 经既有 fallback 链取 `canonical_url`（watch URL 稳定）。

#### 场景:有字幕视频取 transcript 作正文
- **当** 采集到一条有字幕的 YouTube 视频条目
- **那么** 系统拉取其字幕文本作为 `content` 落 `raw_items`，供下游经验提炼

#### 场景:无字幕视频不做 ASR
- **当** 采集到一条无字幕的 YouTube 视频条目
- **那么** 系统仅以标题+简介落库、不进行语音转写，且不因此中止整批采集

#### 场景:取字幕失败被隔离
- **当** 某条视频字幕拉取请求失败（超时/限流/无接口）
- **那么** 该失败被记错误日志、该条退化为仅标题+简介落库，其余条目与源照常完成
