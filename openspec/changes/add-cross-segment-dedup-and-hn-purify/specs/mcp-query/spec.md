## 修改需求

### 需求:查询当日已推日报

`get_today_ai_digest` 必须以 `push_records`（`push_date = 今天（MCP env PUSH_TIMEZONE、default Asia/Shanghai、与主链同口径）`、`status='success'`）为准还原当日**已推**日报——按 `target_type` 分组 join `ai_news_events`（要闻段）与 `ai_products`（新品段），即查「已推送的事实」而非重跑 Top N 选择。channel 默认取**库中当日实际有 success 的 distinct channel**（不依赖进程 env 的 isFeishuEnabled 等，免漏已推 channel），可传 channel 过滤。event 原文 url 经 `representative_raw_item_id → raw_items.canonical_url`（缺则省略）；**product 链接须复用 product-digest 的同一 `resolveProductUrl` 回退链（`canonical_domain` → `github_repo` → `product_hunt_slug`，含 URL/段校验、畸形降级 null），不得裸拼**，以忠实于实际已推内容。`resolveProductUrl` MUST 为**零 env/db/config 依赖的纯函数**、置于 `src/collectors/product-keys.ts`（既有零 env/db 纯 leaf，push 与 MCP 查询链均可 import；MCP server.ts 的 top-level 禁 import 清单不含 `collectors`，纯函数 import 不触全局 env、符合 stdio/env 纪律；push 侧不反向依赖 `mcp/`）。`get_today` 产品查询 SELECT MUST 取 `github_repo`/`product_hunt_slug`（否则换 `resolveProductUrl` 仍会因入参缺失丢链接）。**仅 `get_today_ai_digest` 改用回退链**（其有「忠实于已推」不变量）；`search_ai_products`（见「查询历史事件与产品」需求）**不变**——它是历史检索、无忠实义务，保留既有 `canonical_domain`-only 渲染（`productCanonicalUrl` 不删除）。当日尚未推送则返回空 + 说明。**产品中文字段**：新品段输出（structuredContent）须含产品中文译名 / 简介（来自 `ai_products.name_zh`/`tagline_zh`），缺则回退英文 `name`（简介字段为空）。**近似语义**：中文字段反映查询时 `ai_products` 当前值（`push_records` 不存渲染文本快照）——产品以英文推送后若 later 被中文化，查询将显示中文（与当时推的英文不完全一致），属既有「join 当前值还原」固有近似（events 同理）、非本能力引入的新缺陷。链接同属此「还原以当前实体值」近似（产品归一键 later 变化则链接随之，既有性质）。

#### 场景:当日已推则返回要闻+新品两段
- **当** 当日有 `target_type='event'`/`'product'` 的 success push_records，调用 get_today_ai_digest
- **那么** 以 push_records 为准 join 还原要闻段（events）与新品段（products）返回；orphan（push_records success 但行已删）跳过、不报错

#### 场景:当日未推返回空并说明
- **当** 当日尚无 success push_records
- **那么** 返回空日报 + 文本说明「今日尚未推送」，不重跑选择

#### 场景:产品链接忠实于已推（三键回退一致）
- **当** 某已推产品 `canonical_domain` 为空但 `github_repo='owner/repo'`（实际已推消息经 `resolveProductUrl` 回退渲染出 `https://github.com/owner/repo`）
- **那么** get_today 同样经 `resolveProductUrl` 回退还原出该 github 链接，与实际已推内容一致（不因仅认 `canonical_domain` 而丢链接）

#### 场景:产品链接畸形降级与已推一致
- **当** 某已推产品三键皆空/畸形（实际已推消息因严格校验降级为无链接）
- **那么** get_today 同样按 `resolveProductUrl` 降级 null（不裸拼出 `https://畸形`），与实际已推内容一致

#### 场景:get_today 新品段返回中文译名与简介
- **当** 调用 get_today_ai_digest、当日已推产品已中文化
- **那么** 产品项返回中文译名 + 中文简介（structuredContent 字段）；未中文化的产品回退英文 `name`、简介字段为空

#### 场景:中文字段反映当前值非推送快照
- **当** 产品以英文推送（中文化失败回退）后、later 被某次中文化填入 name_zh
- **那么** get_today 查询显示当前中文（join 当前 ai_products 值）；这是既有「还原以当前实体值」的近似、非新缺陷
