# 策划 AI 博主 feed 清单（task 6.1 接入数据）

> 来源：本变更提案阶段的联网调研，每个 feed 均经 WebFetch 实抓确认返回 RSS/Atom XML。
> YouTube channel_id 经 feed 标题二次确认映射，无猜测。合计 **49 个已验证源**。
> 接入分流见文末「建议拆分」——`BLOGGER_FEEDS`（经验链）vs `RSS_FEEDS`（新闻链）。

## 1. 博客 / Substack / Newsletter（feed 自带全文）

| 名称 | feed URL | vendor | 偏向 |
|---|---|---|---|
| Simon Willison's Weblog | `https://simonwillison.net/atom/everything/` | simonwillison | 实战 |
| One Useful Thing (Ethan Mollick) | `https://www.oneusefulthing.org/feed` | ethanmollick | 实战 |
| Ahead of AI (Sebastian Raschka) | `https://magazine.sebastianraschka.com/feed` | raschka | 实战 |
| Interconnects (Nathan Lambert) | `https://www.interconnects.ai/feed` | interconnects | 评论 |
| Latent Space (swyx) | `https://www.latent.space/feed` | latentspace | 实战 |
| Import AI (Jack Clark) | `https://importai.substack.com/feed` | importai | 资讯 |
| Last Week in AI | `https://lastweekin.ai/feed` | lastweekinai | 资讯 |
| The Pragmatic Engineer | `https://newsletter.pragmaticengineer.com/feed` | pragmaticengineer | 实战 |
| Eugene Yan | `https://eugeneyan.com/rss/` | eugeneyan | 实战 |
| Lil'Log (Lilian Weng) | `https://lilianweng.github.io/index.xml` | lilianweng | 实战 |
| Chip Huyen | `https://huyenchip.com/feed.xml` | chiphuyen | 实战 |
| Hamel's Blog (Hamel Husain) | `https://hamel.dev/index.xml` | hamel | 实战 |
| philschmid (Philipp Schmid) | `https://www.philschmid.de/rss` | philschmid | 实战 |
| Jason Liu (jxnl) | `https://jxnl.co/feed_rss_created.xml` | jxnl | 实战 |
| AI as Normal Technology | `https://www.normaltech.ai/feed` | normaltech | 评论 |
| Every (Dan Shipper) | `https://every.substack.com/feed` | every | 实战 |
| Stratechery (Ben Thompson) | `https://stratechery.com/feed/` | stratechery | 评论 |
| TLDR AI | `https://tldr.tech/api/rss/ai` | tldrai | 资讯 |
| The Gradient | `https://thegradient.pub/rss/` | thegradient | 评论 |
| Drew Breunig | `https://www.dbreunig.com/feed.xml` | dbreunig | 实战 |
| Exploring Language Models (Maarten Grootendorst) | `https://newsletter.maartengrootendorst.com/feed` | maartengrootendorst | 实战 |
| Vicki Boykis | `https://vickiboykis.com/index.xml` | vickiboykis | 实战 |
| ByteByteGo (Alex Xu) | `https://blog.bytebytego.com/feed` | bytebytego | 实战 |

## 2. YouTube 频道（频道 RSS，仅标题+简介，正文靠字幕抽取）

| 名称 | channel_id | vendor | 偏向 |
|---|---|---|---|
| Matthew Berman | UCawZsQWqfGSbCI5yjkdVkTA | mattberman | 实战 |
| AI Explained | UCNJ1Ymd5yFuUPtn21xtRbbw | aiexplained | 评论 |
| Two Minute Papers | UCbfYPyITQ-7l4upoX8nvctg | twominutepapers | 资讯 |
| Yannic Kilcher | UCZHmQk67mSJgfCCTn7xBfew | yannic | 评论 |
| bycloud | UCgfe2ooZD3VJPB6aJAnuQng | bycloud | 资讯 |
| Sentdex | UCfzlCWGWYyIQ0aLC5w48gBQ | sentdex | 实战 |
| Prompt Engineering | UCDq7SjbgRKty5TgGafW8Clg | promptengineering | 实战 |
| All About AI | UCtIAwf6ZrOjQzyGJUU0P0Ug | allaboutai | 实战 |
| Wes Roth | UCqcbQf6yw5KzRoDDcZ_wBSw | wesroth | 资讯 |
| Fireship | UCsBjURrPoezykLs9EqgamOA | fireship | 资讯 |
| Cole Medin | UCMwVTLZIRRUyyVrkjDpn4pA | cole-medin | 实战 |
| AICodeKing | UC0m81bQuthaQZmFbXEY9QSw | aicodeking | 实战 |
| IndyDevDan | UC_x36zCEGilGpB1m-V4gmjg | indydevdan | 实战 |
| David Ondrej | UCPGrgwfbkjTIgPoOh2q1BAg | david-ondrej | 实战 |
| Riley Brown | UCMcoud_ZW7cfxeIugBflSBw | riley-brown | 实战 |
| Matt Wolfe | UChpleBmo18P08aKCIgti38g | matt-wolfe | 资讯 |
| The AI Advantage | UCHhYXsLBEVVnbvsq57n1MTQ | ai-advantage | 实战 |
| MattVidPro AI | UC5Wz4fFacYuON6IKbhSa7Zw | mattvidpro | 实战 |

YouTube 频道 RSS 格式：`https://www.youtube.com/feeds/videos.xml?channel_id=<channel_id>`

## 3. 中文 AI 博主

| 名称 | feed URL | vendor | 偏向 |
|---|---|---|---|
| 宝玉的分享 | `https://s.baoyu.io/feed.xml` | baoyu | 实战 |
| Randy's Blog (lutaonan) | `https://lutaonan.com/rss.xml` | lutaonan | 实战 |
| ManateeLazyCat（王纲） | `https://manateelazycat.github.io/feed.xml` | manateelazycat | 实战 |
| 少数派 sspai | `https://sspai.com/feed` | sspai | 实战(测评) |
| 美团技术团队 | `https://tech.meituan.com/feed/` | meituan-tech | 实战 |
| 阮一峰 网络日志 | `https://www.ruanyifeng.com/blog/atom.xml` | ruanyifeng | 资讯(周刊) |
| 量子位 | `https://www.qbitai.com/feed` | qbitai | 资讯 |
| 爱范儿 ifanr | `https://www.ifanr.com/feed` | ifanr | 资讯 |

---

## 建议拆分（接入时执行）

系统定位是「经验提炼」，纯资讯源走经验提炼 Agent 会大多 `long_term_value < 70` 白烧 LLM。建议：

- **`BLOGGER_FEEDS`（经验链，偏向=实战）** ← 上表标「实战」的源（约 31 个：实战博客/Substack + AI 编码向 YouTube + 中文实战博主）。
- **`RSS_FEEDS`（既有新闻链）或暂不接** ← 标「资讯/评论」的源（Import AI / Last Week in AI / TLDR AI / Two Minute Papers / Fireship / Matt Wolfe / 量子位 / 爱范儿 / 阮一峰 等）。资讯类更适合现有新闻链，或先不接。
- `≥70` 价值闸门是兜底：即使个别源归错类，低价值经验也不会进 KB / 实践锦囊。

### 可直接粘进 `BLOGGER_FEEDS` 的行（实战子集，推荐）

```text
https://simonwillison.net/atom/everything/|simonwillison,https://www.oneusefulthing.org/feed|ethanmollick,https://magazine.sebastianraschka.com/feed|raschka,https://www.latent.space/feed|latentspace,https://newsletter.pragmaticengineer.com/feed|pragmaticengineer,https://eugeneyan.com/rss/|eugeneyan,https://lilianweng.github.io/index.xml|lilianweng,https://huyenchip.com/feed.xml|chiphuyen,https://hamel.dev/index.xml|hamel,https://www.philschmid.de/rss|philschmid,https://jxnl.co/feed_rss_created.xml|jxnl,https://every.substack.com/feed|every,https://www.dbreunig.com/feed.xml|dbreunig,https://newsletter.maartengrootendorst.com/feed|maartengrootendorst,https://vickiboykis.com/index.xml|vickiboykis,https://blog.bytebytego.com/feed|bytebytego,https://www.youtube.com/feeds/videos.xml?channel_id=UCawZsQWqfGSbCI5yjkdVkTA|mattberman,https://www.youtube.com/feeds/videos.xml?channel_id=UCfzlCWGWYyIQ0aLC5w48gBQ|sentdex,https://www.youtube.com/feeds/videos.xml?channel_id=UCDq7SjbgRKty5TgGafW8Clg|promptengineering,https://www.youtube.com/feeds/videos.xml?channel_id=UCtIAwf6ZrOjQzyGJUU0P0Ug|allaboutai,https://www.youtube.com/feeds/videos.xml?channel_id=UCMwVTLZIRRUyyVrkjDpn4pA|cole-medin,https://www.youtube.com/feeds/videos.xml?channel_id=UC0m81bQuthaQZmFbXEY9QSw|aicodeking,https://www.youtube.com/feeds/videos.xml?channel_id=UC_x36zCEGilGpB1m-V4gmjg|indydevdan,https://www.youtube.com/feeds/videos.xml?channel_id=UCPGrgwfbkjTIgPoOh2q1BAg|david-ondrej,https://www.youtube.com/feeds/videos.xml?channel_id=UCMcoud_ZW7cfxeIugBflSBw|riley-brown,https://www.youtube.com/feeds/videos.xml?channel_id=UCHhYXsLBEVVnbvsq57n1MTQ|ai-advantage,https://www.youtube.com/feeds/videos.xml?channel_id=UC5Wz4fFacYuON6IKbhSa7Zw|mattvidpro,https://s.baoyu.io/feed.xml|baoyu,https://lutaonan.com/rss.xml|lutaonan,https://manateelazycat.github.io/feed.xml|manateelazycat,https://sspai.com/feed|sspai,https://tech.meituan.com/feed/|meituan-tech
```

## 未验证 / 排除

- **Maxime Labonne (ML Blog)**：常见 feed 路径全 404，接入前需人工查 HTML `<link rel="alternate">`。
- **The Batch (DeepLearning.AI)**：无官方 RSS（需 RSSHub/kill-the-newsletter 桥接，稳定性差）。
- **机器之心**：未找到官方可解析 RSS。
- **歸藏 / 卡兹克 / 小互 等**：主阵地公众号/X，无原生博客 RSS；第三方 X 网关只出推文流，v1 不取正文故未纳入。
