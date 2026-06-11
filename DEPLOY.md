# 部署指南（容器化）

把整个 ai-radar 以容器跑在目标主机上。组件全在 `docker-compose.yml`：

| 服务 | 作用 | 重启策略 |
| --- | --- | --- |
| `postgres` | pgvector/pgvector:pg16，主数据库 | unless-stopped |
| `redis` | redis:7-alpine，BullMQ 队列 | unless-stopped |
| `migrate` | 一次性跑 `drizzle-kit migrate`，幂等 | no（跑完退出） |
| `worker` | 常驻：日报 / 产品发现 / 实时告警三条调度链（周报默认禁用） | unless-stopped |
| `web` | Hono HTTP，暴露 `/health` 供探活 | unless-stopped |

`migrate`/`worker`/`web` 归入 `app` profile：不带 `--profile app` 时只起 `postgres`+`redis`（本地开发用法不变）。

---

## 一、准备 .env

在目标主机仓库根目录放一份 `.env`（**不进 git**）。`DATABASE_URL` / `REDIS_URL` 在 compose 里已用容器服务名覆盖，`.env` 里这两项写什么都会被覆盖；其余为业务凭据，**必须真实**：

必填：

```
LLM_API_KEY=...
LLM_MODEL=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
PRODUCT_HUNT_TOKEN=...        # 启动期强校验，缺失则 worker 起不来
```

可选（按需启用通道 / 调参，键清单见 .env.example）：

```
FEISHU_WEBHOOK_URL=...        # 与 FEISHU_SIGN_SECRET 必须同时给或同时不给
FEISHU_SIGN_SECRET=...
PUSH_TIMEZONE=Asia/Shanghai
DAILY_DIGEST_CRON=3 8 * * *   # 避开整点/半点，防飞书限流
WEEKLY_REPORT_ENABLED=false   # 周报暂缓打磨，默认禁用
```

数据库口令如需自定义，同时设 `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`（compose 会据此拼 `DATABASE_URL`）。

---

## 二、两种部署方式

### 方式 A：本地构建（无需镜像仓库，最省事）

在目标主机上：

```bash
git clone <repo> ai-radar && cd ai-radar
# 放好 .env（见上）
docker compose --profile app up -d --build
docker compose ps                 # postgres/redis healthy，migrate 已 Exit 0，worker/web Up
docker compose logs -f worker     # 看到「已启动 N 条调度链」即成功
curl localhost:3000/health        # {"db":"ok","redis":"ok"}（全 ok 返回 200，任一 down 返回 503）
```

arm64 / amd64 主机都能本地构建（基础镜像均为多架构）。

### 方式 B：拉 CI 构建的镜像（GHCR）

CI（`.github/workflows/docker-image.yml`）在 push main / 打 `v*` tag 时构建 **amd64+arm64** 多架构镜像并推 `ghcr.io/herbert-software/ai-radar:latest`（owner 取 `github.repository_owner`，与 compose 的 `image:` 默认值一致）。目标主机直接拉：

```bash
# 若该 GHCR package 为私有，先登录（PAT 需 read:packages）：
echo $GHCR_PAT | docker login ghcr.io -u <user> --password-stdin

docker compose --profile app pull          # 拉 worker/web/migrate 共用的镜像
docker compose --profile app up -d
```

> 公开该 package 后可免登录直接 pull。
> 镜像名如需改（如 fork 到别的 owner），设环境变量 `AI_RADAR_IMAGE=ghcr.io/<owner>/ai-radar:latest` 即可，compose 会用它覆盖默认值。

---

## 三、运维

```bash
docker compose logs -f worker            # 跟随 worker 日志
docker compose --profile app restart worker
docker compose --profile app down        # 停（保留数据卷）
docker compose --profile app down -v     # 停并删卷（清空 DB/Redis，谨慎）

# 升级：拉新代码/镜像后重建
git pull && docker compose --profile app up -d --build   # 方式 A
docker compose --profile app pull && docker compose --profile app up -d  # 方式 B
```

升级时 `migrate` 会先于 worker/web 重新跑一次（幂等，已应用的迁移自动跳过）。

---

## 四、要点

- **时区**：镜像内置 tzdata 且 `TZ=Asia/Shanghai`；推送日期（push_date）由应用按 `PUSH_TIMEZONE` 显式计算，不依赖容器 TZ。
- **健康探活**：`web` 的 `/health` 同时检 DB 与 Redis；可经主机或内网/VPN 访问 `http://<主机>:${APP_PORT:-3000}/health`。
- **首次真实凭据勘验**：worker 起来后可用 `docker compose --profile app run --rm worker npm run smoke` 立刻触发一次日报流程，不必等 cron。
- **数据持久化**：DB/Redis 落在命名卷 `postgres_data` / `redis_data`，`down`（不带 `-v`）不丢数据。
