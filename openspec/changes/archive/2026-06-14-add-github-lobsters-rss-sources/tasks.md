## 1. 本地配置接入

- [x] 1.1 在 `.env.example` 的 `RSS_FEEDS` 末尾追加三条 `url|vendor`：`https://github.blog/feed/|github`、`https://github.blog/changelog/feed/|github`、`https://lobste.rs/rss|lobsters`
- [x] 1.2 同步追加同样三条到本地 `.env` 的 `RSS_FEEDS`（与 `.env.example` 保持一致，避免漂移）

## 2. 本地验证（不触网 schema + 实拉）

- [x] 2.1 **确定性验收（不触网，进 CI 口径）**：`npx tsx` 加载 `env`，确认 `env.RSS_FEEDS` 解析出 **(改动前条数 + 3)** 个 feed（锚定本提案掌控的「新增 3 条」而非绝对数，规避 `.env.example` 被其他改动影响）、**新增三条** vendor 分别为 `github`/`github`/`lobsters`、URL 正确；解析不触网、可复现
- [x] 2.2 **确定性不变量已由既有测试覆盖**：`source='rss'` / `metadata.{vendor,feed_url}` 落库 / `source_item_id` fallback 链与命名空间化 / 单 feed 失败隔离等不变量由既有 `src/collectors/__tests__/collectors.test.ts`（注入 `fetchFeed` mock）覆盖，本提案不新增 src 代码、不新增测试。如需对新 feed 做不变量回归，用 fixture（mock feed）跑 `mapRssItem`/`collectRss` 断言，**不依赖外网**
- [x] 2.3 **一次性人工 spot-check（不进 CI，可重复性不保证）**：用生产 `collectRss({feeds})` 实拉三个新 feed 确认「该 URL 当前仍能解析」；判据放宽——单 feed 实网失败由 `allSettled` 隔离（返回空不阻断其余），故验收看「整体能拉到条目且 GitHub Blog/Changelog 的 `metadata.vendor` 均为 `github`、`feed_url` 不同」即可；`publishedAt` 允许为 `null`（无 pubDate 条目正常，由 published-at-inference 回填，不算失败）

## 3. 远端 ts.mac-mini 同步生效

- [x] 3.1 `ssh ts.mac-mini`（用别名，勿用裸 `mac-mini`）→ `cd ~/ai-radar` → `cp -p .env .env.bak.$(date +%Y%m%d-%H%M%S)` 备份
- [x] 3.2 用 python3 精确 `str.replace` 把远端 `.env` 的 `RSS_FEEDS` 行追加新 3 条（带断言：旧行唯一存在、3 条新条目尚不存在；勿假设远端绝对条数，远端 `.env` 可能因端口避让等与本地有差异），勿整文件覆盖
- [x] 3.3 `export PATH=/usr/local/bin:$PATH && docker compose --profile app up -d --force-recreate --no-deps worker` 重建 worker（`--force-recreate` 必需：`restart` 不重读 `env_file`）
- [x] 3.4 `docker compose exec -T worker printenv RSS_FEEDS` 确认进程内 RSS_FEEDS 含新 3 条；`docker compose logs --since 60s worker` 确认**判据明确**：env 校验未抛错（worker 未崩溃退出）且出现既有启动日志行 `已启动 N 条调度链（daily-digest, product-digest）`（即 parseEnv 通过、worker 常驻）

## 4. 提交与规范归档

- [x] 4.1 提交 `.env.example` 配置改动（`.env` 被 gitignore 不入库）；纯配置/文档，按本仓库约定走 `main`
- [x] 4.2 `/opsx:sync` 将本变更增量规范并入 `openspec/specs/source-collectors/spec.md` 主规范
- [x] 4.3 `/opsx:archive` 归档本变更
