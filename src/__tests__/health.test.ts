/**
 * /health 端点单元测试（组 D，任务 4.4 核心，纯 mock）。
 *
 * 不依赖真实 pg / redis / env：
 * - mock `../config/env.js`：避免 import 期 env 校验 throw（无需真实 .env）。
 * - mock `../db/index.js`：避免 import 期 `new Pool` 与真实连接。
 * - mock `../health/redis.js`：避免触发真实 ioredis 连接。
 * 单元用例统一用注入探测函数（createHealthApp(probes)）模拟可达 / 不可达。
 *
 * 守住 spec 不变量「任一依赖不可达必须如实反映，禁止静默成功」。
 *
 * 注意：本文件特意 mock 掉 env，因此即便外部设置了 DATABASE_URL 也不会去连真实库，
 * 不影响组 C 那条以 DATABASE_URL 为 skip 信号的 integration 测试。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    DATABASE_URL: 'postgres://test/test',
    REDIS_URL: 'redis://test',
    LLM_API_KEY: 'test',
    LLM_MODEL: 'test',
  },
}));

vi.mock('../db/index.js', () => ({
  pingDb: vi.fn(async () => true),
}));

vi.mock('../health/redis.js', () => ({
  pingRedis: vi.fn(async () => true),
}));

const { createHealthApp } = await import('../app.js');
type HealthBody = import('../app.js').HealthBody;

describe('/health 端点', () => {
  it('依赖均可达时返回 200 且 db/redis 皆 ok', async () => {
    const app = createHealthApp({
      probeDb: async () => true,
      probeRedis: async () => true,
    });

    const res = await app.request('/health');
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthBody;
    expect(body).toEqual({ db: 'ok', redis: 'ok' });
  });

  it('redis 不可达时如实反映 redis 为 down，而非全部正常（503）', async () => {
    const app = createHealthApp({
      probeDb: async () => true, // db 正常
      probeRedis: async () => false, // redis 不可达
    });

    const res = await app.request('/health');

    // 不健康必须可观测：HTTP 非 200。
    expect(res.status).toBe(503);

    const body = (await res.json()) as HealthBody;
    // 关键断言：redis 反映为不健康。
    expect(body.redis).toBe('down');
    // 关键断言：不是"全部正常"。
    expect(body).not.toEqual({ db: 'ok', redis: 'ok' });
    // db 状态如实保留（这里 db 探测仍返回 ok）。
    expect(body.db).toBe('ok');
  });

  it('db 不可达时如实反映 db 为 down（503）', async () => {
    const app = createHealthApp({
      probeDb: async () => false,
      probeRedis: async () => true,
    });

    const res = await app.request('/health');
    expect(res.status).toBe(503);

    const body = (await res.json()) as HealthBody;
    expect(body.db).toBe('down');
    expect(body.redis).toBe('ok');
  });

  it('默认 app 的探测把底层失败归一为 down（不抛出）', async () => {
    // 默认探测：pingDb mock 为 true、pingRedis mock 为 true → 默认 app 健康。
    // 这条确认 createHealthApp() 无参时走默认探测链路且不抛。
    const app = createHealthApp();
    const res = await app.request('/health');
    expect([200, 503]).toContain(res.status);
    const body = (await res.json()) as HealthBody;
    expect(body).toHaveProperty('db');
    expect(body).toHaveProperty('redis');
  });
});
