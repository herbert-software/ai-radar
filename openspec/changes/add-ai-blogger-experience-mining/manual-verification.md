# 真实凭据 / 外网勘验清单（task 6.3）

以下三项依赖真实凭据 + 外网，**无法在 CI/本地无凭据环境复现**，交付用户在自己机器上执行；结果作 artifact 附 PR。

> 自动化已覆盖的（无需手动）：transcript 拉取/失败隔离、博主 feed 解析、经验提炼降级、塌缩排除、KB 沉淀幂等、锦囊推送幂等/三元早退/channel-blind——均由注入桩单测 + 连真实 pg+redis 集成测试覆盖（`npx vitest run` 连 DB/Redis **831 passed / 0 skip**）。

## 1. 拉一次有字幕 YouTube transcript（验证 `youtube-transcript` 默认实现）

```bash
# 任取 feeds.md 里一个 YouTube 频道的近期有字幕视频 URL
node -e "import('youtube-transcript').then(async ({YoutubeTranscript})=>{const t=await YoutubeTranscript.fetchTranscript('https://www.youtube.com/watch?v=<VIDEO_ID>');console.log('段数',t.length,'\n前 200 字:',t.map(s=>s.text).join(' ').slice(0,200));})"
```
预期：打印字幕段数 + 正文片段（非空）。若该库对某视频反爬失败 → 经验链会按设计**失败隔离退化为标题+简介**（不致命），但说明默认 transcript 实现需关注；可换库（注入接口背后）。

## 2. 拉一个 Substack/博客 feed（验证 blogger 采集端到端入库）

```bash
docker compose up -d   # postgres + redis
export DATABASE_URL="postgres://ai_radar:ai_radar@localhost:5432/ai_radar" REDIS_URL="redis://localhost:6379"
npm run migrate
# 只配一个实战源跑一次采集，确认 raw_items 落 source='blogger'/raw_type='experience'/collapsed=true
BLOGGER_FEEDS="https://simonwillison.net/atom/everything/|simonwillison" npm run smoke   # 或等价的单次采集入口
psql "$DATABASE_URL" -c "SELECT source, raw_type, collapsed, left(title,60) FROM raw_items WHERE source='blogger' ORDER BY fetched_at DESC LIMIT 5;"
```
预期：新行 `source=blogger`、`raw_type=experience`、`collapsed=t`；**绝不**出现 `source=rss`/`raw_type=news`（隔离命门）。

## 3. 实践锦囊发一条测试卡片（验证 telegram + 飞书真实送达 + 渲染）

```bash
# 配齐真实 TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID 与/或飞书 webhook+签名（钉到测试群，勿用生产群）
# 跑一次 runDailyWorkflow（或锦囊段冒烟入口），确认实践锦囊段卡片送达：标题=headline_zh、要点=summary_zh、来源链接、独立「AI Radar 实践锦囊」表头
npm run smoke   # 用真实凭据
```
预期：测试群收到实践锦囊卡片，渲染含 summary_zh（非被 headline 屏蔽）；同日重跑同卡片**不重复送达**（幂等四元组 `target_type='experience'`）。

---

**时效性提醒（policy-push-timeliness）**：首次上线前，确认 `published_at` recency 窗口生效——锦囊段**只推窗口内当期经验**，绝不批量回推历史旧博文/旧视频刷屏。
