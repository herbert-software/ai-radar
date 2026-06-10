/**
 * Redis 连通探测 —— 供 /health 复用（组 D，任务 4.2）。
 *
 * 设计要点：
 * - 连接串来自 env.REDIS_URL（已在 src/config/env.ts 做启动期校验，缺失即 throw）。
 * - 探测必须有超时与"不无限重连"语义：Redis 不可达时不能让 /health 长时间挂起，
 *   失败即判 down（spec「依赖不可达时如实反映」——禁止静默成功）。
 * - 每次探测用一次性短连接，探测完即 quit，不复用长连接，避免后台无限重连噪声。
 */
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/**
 * 执行一次 Redis `PING`。
 * 成功（收到 `PONG`）返回 true；不可达 / 超时 / 任何错误返回 false（不抛出）。
 *
 * @param timeoutMs 探测整体超时（毫秒），默认 2000。
 */
export async function pingRedis(timeoutMs = 2000): Promise<boolean> {
  const client = new Redis(env.REDIS_URL, {
    // 单次连接尝试即放弃，避免不可达时进入无限重连。
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: timeoutMs,
    lazyConnect: true,
    enableOfflineQueue: false,
  });

  // ioredis 的 Redis 是 EventEmitter：连接失败会发 'error' 事件，无监听器时
  // ioredis 会打印 "[ioredis] Unhandled error event"。健康探针已通过下面的
  // race/catch 处理失败并返回 false，故在此吞掉 error 事件，避免 redis 不可达时刷屏。
  client.on('error', () => {
    /* 失败语义由 pingRedis 的返回值承载，无需再噪声化 */
  });

  // connect+ping 链：即便 timeout 先赢得 race、随后 disconnect() 把 client 拆掉，
  // 该链最终仍会 reject。必须给它挂 catch 吞掉，否则成为 unhandledRejection
  // （redis 慢/不可达时的噪声，严格模式下可能崩进程）。
  const connectAndPing = client.connect().then(() => client.ping());
  connectAndPing.catch(() => {
    /* race 已由 timeout 决出胜负；孤儿 reject 在此被处理 */
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pong = await Promise.race([
      connectAndPing,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('redis ping 超时')), timeoutMs);
      }),
    ]);
    return pong === 'PONG';
  } catch {
    return false;
  } finally {
    // 清掉未触发的超时定时器，避免无谓地保活事件循环。
    if (timer) clearTimeout(timer);
    // disconnect() 立即断开，不等待 pending 重连，避免句柄泄漏。
    client.disconnect();
  }
}
