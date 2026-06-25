# ai-radar 运行镜像
#
# 设计：单阶段、经 tsx 直接运行 TS 源——本项目全程用 tsx 运行（worker / web / smoke）、
# drizzle-kit 跑迁移，**无独立 build 产物**（tsconfig noEmit）。故镜像装好依赖后直接跑源码，
# 与本地/CI 运行形态一致，避免引入项目从未有过的编译步骤带来的 ESM 解析风险。
#
# 多用途：默认 CMD 跑常驻 worker；docker-compose 各服务用 command 覆盖为 migrate / web。
# 多架构：CI（docker-image.yml）用 buildx 构建 linux/amd64 + linux/arm64，
# 使 amd64 与 arm64 目标主机均可直接 pull 运行。

FROM node:22-alpine

# tzdata：BullMQ repeat 的 cron `tz` 解析与容器日志时间戳用（push_date 业务逻辑另经 Intl/env
# 显式按 PUSH_TIMEZONE 计算，不依赖容器 TZ；此处仍设 TZ 使 cron/日志口径一致）。
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai
ENV NODE_ENV=production

WORKDIR /app

# 先拷贝清单装依赖（利用层缓存：源码变更不必重装依赖）。
# tsx / drizzle-kit 为 devDependencies 但本镜像的运行时确需它们（经 tsx 直接跑源码、
# drizzle-kit 跑迁移），而上面 NODE_ENV=production 会令 npm 默认跳过 devDependencies，
# 故显式 --include=dev 装全量依赖。
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# 再拷贝源码 / 迁移 / 配置（.dockerignore 已排除 node_modules / .env / .git / 测试等）。
COPY . .

# 非 root 运行（node:alpine 自带 node 用户；源码与 node_modules 对其只读，运行期不写文件）。
USER node

# 默认常驻 worker（注册多条调度链，周报/MR 各链默认禁用 *_ENABLED=false → 仅日报段生效）。
# compose 的 migrate / web 服务用 command 覆盖；常驻服务在 compose 用 init:true 兜住信号转发。
# **主镜像不装 Playwright/浏览器**（design D15）：worker-main 只注册 http 档 MR 抓取链，
# browser 档由下方独立 stage（mr-browser-worker）承载。
CMD ["npm", "run", "worker"]

# ── browser-worker stage（design D15）：Model Radar browser 档独立镜像（装 Playwright + chromium）。
#
# 单独 stage 使主镜像保持零 Playwright 体积/攻击面；本 stage 以官方 Playwright 镜像为基（已带
# chromium 及其系统依赖，alpine 装不全 chromium 运行库故不复用上面的 node:alpine 基）。
# 构建：`docker build --target mr-browser-worker -t ai-radar-mr-browser-worker .`
# 运行：`npm run mr:browser-worker`（entrypoint 先做 egress fail-closed 自检，design D11）。
#
# ⚠️ 网络约束（design D11，**必需部署控制**，不在镜像内可保证）：本服务必须跑在
# **封 RFC1918 / link-local（169.254.0.0/16，含云元数据 169.254.169.254）/ 环回**的 egress 代理
# 或容器 netns 内；否则 browser-worker-main.ts 的启动自检会探到私网哨兵可达而 fail-closed 拒启动。
FROM mcr.microsoft.com/playwright:v1.61.1-noble AS mr-browser-worker
ENV TZ=Asia/Shanghai
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# tsx / drizzle-kit 为 devDependencies 但运行时确需（经 tsx 直接跑源码），显式 --include=dev。
RUN npm ci --include=dev
COPY . .
# Playwright 镜像自带 pwuser（非 root）；沙箱要求非 root（design D11）。
USER pwuser
CMD ["npm", "run", "mr:browser-worker"]
