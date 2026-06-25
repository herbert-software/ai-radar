/**
 * Model Radar 已核 8 家全桶 seed 录入入口（一次性 / 可重跑运维）—— `npm run mr:seed` 执行本文件（task 1.6）。
 *
 * 触发一次 `runSeed()`：把 `seed-data.ts` 的 checked-in fixture 经 Group B 的 `upsert*` + `upsertPlanSource`
 * 灌入 `mr_*`。**幂等**（identity exists / fact noop / 定位边 DO NOTHING，可安全重复跑）、**不推送**、
 * **不 bump catalog version**（design D16，留 5c）、**不臆造价格**（无把握处 needs_login_recheck 占位）。
 *
 * 前置：postgres 已起且迁移到 5a（`mr_*` 表存在）。
 *
 * 退出码：完成 → 0；抛错 → 1。日志走 stderr，结构化结果（artifact）走 stdout。
 */
import { runSeed } from './seed.js';

async function main(): Promise<void> {
  console.error(
    '[mr-seed] 开始已核 8 家全桶 seed 录入（幂等、不推送、不 bump version、不臆造价格）…',
  );
  const res = await runSeed();
  // 结构化结果打到 stdout 作可审计 artifact（日志 stderr / 数据 stdout）。
  console.log(JSON.stringify({ artifact: 'mr-seed', result: res }, null, 2));
  console.error(
    `[mr-seed] 完成：vendor ${res.vendors}、plan ${res.plans}、limit ${res.limits}、` +
      `model兼容 ${res.models}、client兼容 ${res.clients}、source ${res.sources}、定位边 ${res.planSources}。`,
  );
}

main()
  // 成功路径不调 process.exit(0)（自然退出，避免截断 stdout 的 JSON artifact 缓冲）。
  .catch((err: unknown) => {
    console.error('[mr-seed] 失败：', err);
    // 设 exitCode 而非 process.exit(1)，让缓冲的输出自然刷出。
    process.exitCode = 1;
  });
