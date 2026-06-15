## MODIFIED Requirements

### 需求:查询当日已推日报

`get_today_ai_digest` 的新品段输出（structuredContent）必须包含产品中文译名与中文简介字段（来自 `ai_products` 的 `name_zh`/`tagline_zh`），缺则回退英文 `name`（简介字段为空）；不改既有以 push_records 还原已推事实的口径、不重跑选择。**近似语义**：中文字段反映查询时 `ai_products` 当前值（`push_records` 不存渲染文本快照）——产品以英文推送后若 later 被中文化，查询将显示中文（与当时推的英文不完全一致），属既有「join 当前值还原」的固有近似（events 同理）、非本能力引入的新缺陷；实务中产品在 dispatch 前已中文化、多数推时即中文。

#### 场景:get_today 新品段返回中文译名与简介
- **当** 调用 get_today_ai_digest、当日已推产品已中文化
- **那么** 产品项返回中文译名 + 中文简介（structuredContent 字段）；未中文化的产品回退英文 `name`、简介字段为空

#### 场景:中文字段反映当前值非推送快照
- **当** 产品以英文推送（中文化失败回退）后、later 被某次中文化填入 name_zh
- **那么** get_today 查询显示当前中文（join 当前 ai_products 值）；这是既有「还原以当前实体值」的近似、非新缺陷
