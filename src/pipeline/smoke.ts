/**
 * 端到端冒烟入口（daily-intel-pipeline 11.1）—— `npm run smoke` 执行本文件。
 *
 * 手动触发一次 `runDailyWorkflow()`，把 G1–G6 整条链路跑通：
 *   采集（RSS/HN/GitHub 三源）→ 去重塌缩 → Value Judge 逐条 → Top N → 中文摘要 → Telegram 推送。
 *
 * 用法：
 *   npm run smoke              # 真实推送：用 grammY 真把日报发到 TELEGRAM_CHAT_ID
 *   npm run smoke -- --dry-run # 链路冒烟：不连 Telegram，把待发消息打到 stdout（验证链路不抛错）
 *
 * 前置（真实推送时）：
 *   1. docker compose up -d 起 postgres + redis 并 healthy；
 *   2. npm run migrate 把表迁移好；
 *   3. .env 填好真实 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 与 LLM_API_KEY / LLM_MODEL；
 *   4. .env 的 RSS_FEEDS 至少填一个真实 feed（否则三源全空会触发系统级故障告警、无内容可推）。
 *
 * 退出码：正常完成（含「无候选不推」「未抢到锁」）→ 0；抛错（含熔断中止）→ 1。
 * 真实 Telegram 送达需真实凭据 + 外网，沙箱无法验证——故提供 --dry-run 在本地 DB 上
 * 验证非 Telegram 部分链路不抛错；真实送达由用户按上面前置在本地执行确认。
 */
import { runDailyWorkflow } from './run-daily-workflow.js';
import type { MessageSender } from '../push/dispatcher.js';

/** --dry-run 用的 sender：不连 Telegram，把渲染好的日报消息打到 stdout。 */
const dryRunSender: MessageSender = {
  async send(text: string, parseMode: 'MarkdownV2'): Promise<void> {
    console.log(
      `\n===== [dry-run] 本应发往 Telegram 的日报（parse_mode=${parseMode}）=====\n${text}\n===== [dry-run] 消息结束 =====\n`,
    );
  },
};

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  console.error(
    `[smoke] 触发一次 runDailyWorkflow()，模式：${dryRun ? 'dry-run（不连 Telegram）' : '真实推送到 Telegram'}`,
  );

  const result = await runDailyWorkflow(
    dryRun ? { sender: dryRunSender } : {},
  );

  // 结构化结果打到 stdout 作为可审计 artifact（日志走 stderr，数据走 stdout）。
  console.log(
    JSON.stringify({ artifact: 'daily-workflow-smoke', dryRun, result }, null, 2),
  );

  console.error(`[smoke] 完成，outcome=${result.outcome}`);
  if (result.outcome === 'pushed') {
    console.error(
      dryRun
        ? '[smoke] dry-run：链路跑通，未真实送达（见上方 [dry-run] 消息）。'
        : '[smoke] 已真实推送一条日报到 Telegram，请到目标会话核对送达。',
    );
  }
}

main().catch((err: unknown) => {
  console.error('[smoke] 失败：', err);
  process.exitCode = 1;
});
