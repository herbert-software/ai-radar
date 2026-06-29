/**
 * Model Radar（P5 / 5d，add-model-radar-snapshot-cross-process-invalidation）快照跨进程失效通道。
 *
 * Redis **仅作 pub/sub 通道、不存 blob**（design D1）：复用 5c 内容哈希 version 的「免协调一致性」——
 * 任意进程从同一 DB 状态 build 出逐字节相同快照 → 相同 version，故只需广播「失效信号」、各进程仍各自 build-from-DB。
 * 失效语义 = **at-most-once + 周期 rebuild 兜底**（design D3）：publish 失败仅记日志、不阻塞写；漏的失效由
 * 服务进程周期 rebuild 在一个间隔内自愈。
 *
 * **两连接形态相反**（design D4）：
 * - publisher = 短连接「连/发/拆」（仿 src/health/redis.ts pingRedis）：每次 publish 起一次性连接、发完即拆，
 *   **绝不留常驻 socket**——否则吊住 seed 等刻意不调 `process.exit`、靠事件循环排空退出的一次性进程。
 * - subscriber = 长连接保持自动重连（ioredis 默认 retryStrategy）：断线重连后内部订阅集自动重放 SUBSCRIBE，
 *   **禁**拷贝探针/publisher 的 `retryStrategy:()=>null`/`lazyConnect`/`enableOfflineQueue:false`——否则抖一次即永久静默失活。
 */
import { Redis } from 'ioredis';
import { env } from '../../config/env.js';

/** 失效广播 channel 名（channel-only：消息体不解析，只当作失效信号）。 */
export const SNAPSHOT_INVALIDATION_CHANNEL = 'mr:snapshot:invalidate';

/** at-most-once 短连接 publish；失败仅 console.error 不抛、不阻塞调用方、不留常驻 socket。 */
export async function publishSnapshotInvalidation(): Promise<void> {
  // 短连接配置（仿 pingRedis）：单次连接尝试即放弃、不进入无限重连。post-commit publish 的阻塞上界 =
  // connectTimeout + commandTimeout（≤~2s）：connectTimeout 钉 1s 只管 TCP 握手；commandTimeout 钉 1s 兜
  // connectTimeout 漏掉的「半开」情形——TCP 连上但 Redis 半死不回包时命令快速失败而非无限阻塞
  // （仿 src/pipeline/alert-lock.ts / src/push/lock.ts 的 commandTimeout 用法），避免 await publish() 永久吊住 seed/改价 post-commit 路径。
  // （publish 被 await 以保证 disconnect 在 seed 事件循环排空前发生。）
  const client = new Redis(env.REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    lazyConnect: true,
    connectTimeout: 1000,
    commandTimeout: 1000,
  });
  // ioredis 的 Redis 是 EventEmitter：连接失败发 'error' 事件，无监听器会打印 "Unhandled error event"。
  // 失败语义由下方 catch 承载（at-most-once 仅记日志），此处吞掉避免 Redis 不可达时刷屏。
  client.on('error', () => {
    /* 失败由 publish 的 catch 处理，无需再噪声化 */
  });
  try {
    // 显式 connect→publish 序列：enableOfflineQueue:false 下不能依赖 lazy 自连——直接 publish() 即便 Redis
    // 在线也会立即 reject「Stream isn't writeable」、丢 happy-path。故先 await connect() 再 publish()。
    await client.connect();
    await client.publish(SNAPSHOT_INVALIDATION_CHANNEL, '1');
  } catch (err) {
    // at-most-once：失败仅记日志、不抛、不阻塞调用方。漏的失效由服务进程周期 rebuild 在一个间隔内自愈（design D3）。
    console.error('[mr-snapshot] publishSnapshotInvalidation 失败（at-most-once，已忽略）:', err);
  } finally {
    // 短连接「连/发/拆」：立即断开、不等待 pending 重连、不留常驻 socket（否则吊住一次性进程的事件循环）。
    client.disconnect();
  }
}

/** 长连接订阅句柄；`quit()` best-effort 关闭（调用方包 .catch()，design D4）。 */
export interface SnapshotInvalidationSubscriber {
  quit(): Promise<void>;
}

/** 长连接保持 ioredis 自动重连的 subscriber；收到 channel 消息即调 onInvalidate()。 */
export function createSnapshotInvalidationSubscriber(
  onInvalidate: () => void,
): SnapshotInvalidationSubscriber {
  // 长连接：保留 ioredis 默认/退避 retryStrategy（**禁** retryStrategy:()=>null/lazyConnect/enableOfflineQueue:false）。
  // ioredis 只自动重放「至少成功过一次」的订阅。默认 maxRetriesPerRequest 下，冷启动时若 Redis down，重试预算耗尽后
  // 会把首个 SUBSCRIBE 连同 MaxRetriesPerRequestError 一起 flush 掉——它从未进入订阅集，重连后**永不**自动重订阅 → 永久静默失活。
  // 设 null（仿 src/pipeline/queue.ts / src/mr/freshness/staleness-queue.ts 的 BullMQ 长连接）则首个 SUBSCRIBE 一直挂在
  // offline queue（不被 flush）直到连上 → 进入订阅集 → 此后断线自动重放 SUBSCRIBE 生效（design D4）。
  const client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  // 吞掉断连/重连噪声；可用性由 ioredis 自动重连 + 服务进程周期 rebuild 兜底（不因抖动崩进程）。
  client.on('error', () => {
    /* pub/sub 失效仅是优化，掉线由周期 rebuild 兜底，无需噪声化 */
  });
  // channel-only：只对本 channel 触发，消息体不解析。
  client.on('message', (channel) => {
    if (channel === SNAPSHOT_INVALIDATION_CHANNEL) onInvalidate();
  });
  client.subscribe(SNAPSHOT_INVALIDATION_CHANNEL).catch((err) => {
    // 仅记日志、不在此重试：靠上面的 maxRetriesPerRequest:null 让首个 SUBSCRIBE 一直挂起（不被 flush）直到连上并成功，
    // 从而进入订阅集；ioredis 只自动重放「成功过一次」的订阅，此后随重连自动重订阅。
    console.error('[mr-snapshot] subscribe 失败（已挂起至连上，随后随 ioredis 重连自动重订阅）:', err);
  });
  return {
    quit: () => client.quit().then(() => undefined),
  };
}
