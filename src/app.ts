/**
 * Hono 应用实例（组 D，任务 4.1 / 4.3）。
 *
 * 启动（监听端口）与 app 实例分离：
 * - 本模块只导出 `app` 与 `createHealthApp`，便于 vitest 直接 `app.request('/health')` 测试，
 *   无需真的起 HTTP server。
 * - 实际监听在 src/index.ts 用 @hono/node-server 完成。
 *
 * /health 关键不变量（spec「健康检查端点」）：
 * 并发探测 db 与 redis，任一不可达必须如实反映为不健康，禁止静默返回全部正常。
 * 整体不健康时返回 HTTP 503，但响应体 `{ db, redis }` 始终能区分是哪一项挂。
 */
import { Hono } from 'hono';
import { pingDb } from './db/index.js';
import { pingRedis } from './health/redis.js';

/** 单项依赖的连通状态。 */
export type DependencyStatus = 'ok' | 'down';

/** /health 响应体形状。 */
export interface HealthBody {
  db: DependencyStatus;
  redis: DependencyStatus;
}

/** 可注入的探测函数集合——测试可替换以模拟依赖不可达。 */
export interface HealthProbes {
  /** db 连通探测：可达 true，否则 false（不得抛出）。 */
  probeDb: () => Promise<boolean>;
  /** redis 连通探测：可达 true，否则 false（不得抛出）。 */
  probeRedis: () => Promise<boolean>;
}

/**
 * 默认 db 探测：复用组 C 的 pingDb（SELECT 1）。
 * pingDb 在连接失败时抛出底层错误，这里捕获并归一为 false（如实反映为 down）。
 */
async function defaultProbeDb(): Promise<boolean> {
  try {
    return await pingDb();
  } catch {
    return false;
  }
}

const defaultProbes: HealthProbes = {
  probeDb: defaultProbeDb,
  probeRedis: () => pingRedis(),
};

/**
 * 构造一个挂载了 `GET /health` 的 Hono app。
 * 探测函数通过参数注入，默认使用真实 db/redis 探测；测试传入 mock 即可。
 */
export function createHealthApp(probes: HealthProbes = defaultProbes): Hono {
  const app = new Hono();

  app.get('/health', async (c) => {
    // 并发探测，互不阻塞；任一探测都已被归一为不抛出的 boolean。
    const [dbOk, redisOk] = await Promise.all([
      probes.probeDb(),
      probes.probeRedis(),
    ]);

    const body: HealthBody = {
      db: dbOk ? 'ok' : 'down',
      redis: redisOk ? 'ok' : 'down',
    };

    const healthy = dbOk && redisOk;
    // 整体不健康 → 503；响应体仍如实标出各依赖状态（非静默成功）。
    return c.json(body, healthy ? 200 : 503);
  });

  return app;
}

/** 生产使用的 app 实例（真实探测）。 */
export const app = createHealthApp();
