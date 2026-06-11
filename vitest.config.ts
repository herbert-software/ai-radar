/**
 * Vitest 配置。
 *
 * fileParallelism=false：集成测试共用同一个 docker-compose Postgres + Redis。
 * 各套件靠唯一前缀/专属日期隔离自己造的行，但**全链路编排测试**（pipeline）必须做
 * 全局读（Value Judge 扫描所有未评分事件、Top N 扫描所有候选），无法只看自己的行。
 * 若文件级并行，另一套件实时写入的「未评分 / should_push 候选」会污染这些全局读导致 flaky。
 * 关掉文件级并行让所有套件串行跑（共享单库的标准做法），消除跨文件 DB 竞态。
 *
 * 纯单测（无 DB）也一并串行——本仓库测试总量小，串行开销可忽略，换取确定性。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 共享单个 Postgres/Redis 的集成测试需串行，避免跨文件 DB 竞态污染全局读。
    fileParallelism: false,
  },
});
