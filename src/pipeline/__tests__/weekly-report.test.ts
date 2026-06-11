/**
 * 周报锚点单元测试（任务 10.2，weekly-report「触发时刻跨 ISO 周边界抖动不改变 target_id/push_date」）。
 *
 * 纯函数测试（不触 DB/Redis），验证 weeklyAnchor 的核心不变量：
 * - 窗口与 iso_week / push_date **同源锚定「被汇总窗口 [上周一,本周一)」对应的 ISO 周**（= 上周）；
 * - push_date 恒等于 iso_week 对应的周一日期（同源）；
 * - 窗口是 ISO 周边界对齐的 `[上周一, 本周一)`（**非滚动 7×24h**）；
 * - **同一 ISO 周内任意时刻触发得到相同 (iso_week, push_date, window)**——这是「跨 ISO 周边界抖动
 *   触发不改变 target_id/push_date」的实质保证：一个 Monday 早晨调度的 cron，其真实抖动（秒级~分钟级）
 *   恒落在同一触发 ISO 周内，故 target_id/push_date 稳定不漂移。
 */
import { describe, expect, it } from 'vitest';

// 注入占位 env，让 config/env 启动校验通过（本测试不触真实基础设施）。
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/db';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph';

const { weeklyAnchor, isoWeekLabel } = await import('../weekly-report.js');

describe('weeklyAnchor — 窗口与 iso_week/push_date 同源锚定被汇总周', () => {
  // 2026-06-08 是周一（ISO W24 起始）。触发 ISO 周 = W24 → 被汇总窗口 = 上周 W23 [06-01,06-08)。
  // 周一 09:07 SH = 2026-06-08T01:07:00Z。
  const MON_0907_SH = new Date('2026-06-08T01:07:00Z');

  it('被汇总窗口对应「上周」(W23)，push_date = 上周一(2026-06-01)', () => {
    const a = weeklyAnchor(MON_0907_SH);
    expect(a.isoWeek).toBe('2026-W23');
    expect(a.pushDate).toBe('2026-06-01'); // 上周一（W23 的周一）。
  });

  it('push_date 与 iso_week 同源：isoWeekLabel(push_date) === iso_week', () => {
    const a = weeklyAnchor(MON_0907_SH);
    expect(isoWeekLabel(a.pushDate)).toBe(a.isoWeek);
  });

  it('窗口为 ISO 周边界对齐的 [上周一,本周一)（非滚动 7×24h），跨度恰 7 天', () => {
    const a = weeklyAnchor(MON_0907_SH);
    // 上周一 06-01 00:00 SH = 2026-05-31T16:00Z；本周一 06-08 00:00 SH = 2026-06-07T16:00Z。
    expect(a.windowStart.toISOString()).toBe('2026-05-31T16:00:00.000Z');
    expect(a.windowEnd.toISOString()).toBe('2026-06-07T16:00:00.000Z');
    const days = (a.windowEnd.getTime() - a.windowStart.getTime()) / (24 * 3600 * 1000);
    expect(days).toBe(7);
  });

  it('同一触发 ISO 周内任意时刻（周一/周三/周日）触发 → 锚点完全一致（抖动不改变 target_id/push_date）', () => {
    // 全部落在触发 ISO 周 W24（2026-06-08 周一 ~ 2026-06-14 周日 SH），无论 weekday：
    const triggers = [
      new Date('2026-06-08T01:07:00Z'), // 周一 09:07 SH
      new Date('2026-06-08T00:00:00Z'), // 周一 08:00 SH（整点，但实现避整点是 cron 层）
      new Date('2026-06-10T04:00:00Z'), // 周三 12:00 SH
      new Date('2026-06-14T15:59:00Z'), // 周日 23:59 SH（仍在 W24）
    ];
    const anchors = triggers.map((t) => weeklyAnchor(t));
    const first = anchors[0]!;
    for (const a of anchors) {
      expect(a.isoWeek).toBe(first.isoWeek); // 2026-W23
      expect(a.pushDate).toBe(first.pushDate); // 2026-06-01
      expect(a.windowStart.toISOString()).toBe(first.windowStart.toISOString());
      expect(a.windowEnd.toISOString()).toBe(first.windowEnd.toISOString());
    }
    expect(first.isoWeek).toBe('2026-W23');
  });

  it('与触发 weekday 无关：周三触发也锚定「上周」(本周一恒为触发当周周一)', () => {
    // 周三 2026-06-10 触发 → 本周一 = 06-08（W24 周一），上周 = W23 [06-01,06-08)。
    const a = weeklyAnchor(new Date('2026-06-10T04:00:00Z'));
    expect(a.isoWeek).toBe('2026-W23');
    expect(a.pushDate).toBe('2026-06-01');
  });

  it('跨公历年 ISO 周边界正确（2025-12-29 周一 = 2026-W01；上周 = 2025-W52）', () => {
    // 2025-12-29 是周一，属 ISO 2026-W01（含 2026-01-04 的周）。触发该周 → 上周 = 2025-W52。
    const a = weeklyAnchor(new Date('2025-12-30T04:00:00Z')); // 周二 12:00 SH，触发周 2026-W01
    expect(a.isoWeek).toBe('2025-W52');
    expect(isoWeekLabel(a.pushDate)).toBe(a.isoWeek);
    expect(a.pushDate).toBe('2025-12-22'); // 2025-W52 的周一。
  });
});

describe('isoWeekLabel — ISO 8601 周编号', () => {
  it('2026-06-01（周一）属 2026-W23', () => {
    expect(isoWeekLabel('2026-06-01')).toBe('2026-W23');
  });
  it('2025-12-29（周一）属 2026-W01（含 1/4 的周归次年）', () => {
    expect(isoWeekLabel('2025-12-29')).toBe('2026-W01');
  });
  it('2025-12-22（周一）属 2025-W52', () => {
    expect(isoWeekLabel('2025-12-22')).toBe('2025-W52');
  });
});
