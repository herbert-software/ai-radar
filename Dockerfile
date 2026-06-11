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

# 默认常驻 worker（注册 4 条调度链，周报默认禁用 WEEKLY_REPORT_ENABLED=false → 实际 3 条生效）。
# compose 的 migrate / web 服务用 command 覆盖；常驻服务在 compose 用 init:true 兜住信号转发。
CMD ["npm", "run", "worker"]
