/**
 * 降级率熔断与系统级故障告警判定纯函数单测（任务 10.3，design D8）。
 *
 * 穷举关键分支：分母 0 不中止 / 严格大于阈值才中止 / 阶段各自独立 /
 * 系统级告警以采集层为准（三源全挂、全 unprocessable、全命中既有事件不告警）。
 * 纯函数无 I/O，不需 DB/Redis，恒运行。
 */
import { describe, expect, it } from 'vitest';
import {
  classifySystemFailure,
  stageDegradeRate,
  stageShouldAbort,
} from '../circuit-breaker.js';

describe('stageShouldAbort（按阶段独立熔断）', () => {
  it('分母 = 0 恒不中止（禁止 0/0，分母 0 不是错误）', () => {
    expect(stageShouldAbort({ processed: 0, degraded: 0 }, 0.5)).toBe(false);
    // 即便 degraded 莫名 > 0（理论不应发生），分母 0 仍不中止（不算 0/0）。
    expect(stageShouldAbort({ processed: 0, degraded: 3 }, 0.5)).toBe(false);
  });

  it('严格大于阈值才中止（等于阈值不中止）', () => {
    // 5 条 2 降级 = 0.4 < 0.5 → 不中止。
    expect(stageShouldAbort({ processed: 5, degraded: 2 }, 0.5)).toBe(false);
    // 4 条 2 降级 = 0.5 = 阈值 → 严格大于为假 → 不中止。
    expect(stageShouldAbort({ processed: 4, degraded: 2 }, 0.5)).toBe(false);
    // 4 条 3 降级 = 0.75 > 0.5 → 中止。
    expect(stageShouldAbort({ processed: 4, degraded: 3 }, 0.5)).toBe(true);
  });

  it('全部降级（率 1.0）中止', () => {
    expect(stageShouldAbort({ processed: 3, degraded: 3 }, 0.5)).toBe(true);
  });
});

describe('stageDegradeRate', () => {
  it('分母 0 返回 null（无可计算，非 0）', () => {
    expect(stageDegradeRate({ processed: 0, degraded: 0 })).toBeNull();
  });
  it('正常返回比率', () => {
    expect(stageDegradeRate({ processed: 4, degraded: 1 })).toBe(0.25);
  });
});

describe('classifySystemFailure（告警以采集/规范化层为准，新闻类分母）', () => {
  it('采集返回 0（registry 全部源失败）→ 告警 no-collection', () => {
    const v = classifySystemFailure({ collectedCount: 0, newsProcessableCount: 0 });
    expect(v.alert).toBe(true);
    expect(v.kind).toBe('no-collection');
  });

  it('采集 > 0 但新闻类可处理数 0（全 unprocessable）→ 告警 all-unprocessable', () => {
    const v = classifySystemFailure({ collectedCount: 10, newsProcessableCount: 0 });
    expect(v.alert).toBe(true);
    expect(v.kind).toBe('all-unprocessable');
  });

  it('采集 > 0 且新闻类可处理数 > 0（含全命中既有新闻事件的正常无新闻日）→ 不告警', () => {
    // 全命中既有事件：collected 5、新闻类可处理 5（都塌缩进既有 event），无新 event 仍不告警。
    const v = classifySystemFailure({ collectedCount: 5, newsProcessableCount: 5 });
    expect(v.alert).toBe(false);
    expect(v.kind).toBe('none');
  });

  it('仅 arXiv 返回 paper、新闻源全空（collected>0 但新闻类可处理=0）→ 仍按新闻真空告警', () => {
    // paper/product 不计入新闻类分母；某轮仅 arXiv 返回 paper（collectedCount>0）、
    // 新闻源全空（newsProcessableCount=0）→ 必须照常告警，不被 paper 掩盖。
    const v = classifySystemFailure({ collectedCount: 7, newsProcessableCount: 0 });
    expect(v.alert).toBe(true);
    expect(v.kind).toBe('all-unprocessable');
  });
});
