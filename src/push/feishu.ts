/**
 * 飞书自定义机器人发送器（feishu-push 5.2，design D5）。
 *
 * 把飞书自定义机器人 webhook 的「带签名 POST 一条互动卡片」包装成 dispatcher 的
 * `MessageSender` 接口——dispatcher 对所有 channel 一致调 `send(text, parseMode)`，
 * 本模块是飞书 channel 的唯一真实实现。
 *
 * 关键不变量（绝不可违背，feishu-push）：
 * - **原生 fetch + 签名**：用 Node 原生 `fetch`（依赖注入便于单测桩，不触网）；
 *   签名算法为飞书规定：`HMAC-SHA256(key = timestamp + "\n" + secret, data = "")` 的 base64。
 * - **卡片不依赖回调**：发送的是 `msg_type='interactive'` 互动卡片（渲染见 message.ts
 *   buildFeishuCard，跳转走文字链），不含任何回调字段。
 * - **带重试 + 错误日志**：外部调用经 withRetry 包裹；失败抛错（dispatcher 据此整批 failed），
 *   绝不静默吞掉。飞书业务错误（响应体 `code !== 0`，含限流 11232）也视为失败抛错。
 *
 * **与 dispatcher 的契约**：dispatcher 传入的 `text` 是 buildFeishuCard 产出的
 * `JSON.stringify({ card })`；本模块解析回对象，拼上 `timestamp`/`sign`/`msg_type`/`card`
 * 后 POST。`parseMode` 形参被忽略（仅为满足 MessageSender 接口类型）。
 */
import { createHmac } from 'node:crypto';
import { env } from '../config/env.js';
import { withRetry, type LogError, defaultLogError } from '../collectors/types.js';
import type { MessageSender } from './dispatcher.js';

/** 原生 fetch 的最小能力面（便于单测注入桩，不触网）。 */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface FeishuSenderOptions {
  /** webhook 地址（默认 env.FEISHU_WEBHOOK_URL；未配置时必须显式传入）。 */
  webhookUrl?: string;
  /** 签名密钥（默认 env.FEISHU_SIGN_SECRET；未配置时必须显式传入）。 */
  signSecret?: string;
  /** 注入 fetch（默认全局 fetch；单测注入桩）。 */
  fetchImpl?: FetchLike;
  /** 重试次数（含首次），默认 3。 */
  maxAttempts?: number;
  /** 重试基础退避毫秒，默认 0（测试不等待；生产可调大避限流）。 */
  baseDelayMs?: number;
  /** 注入 sleep（测试用立即返回桩）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 错误日志 sink（默认 console.error）。 */
  logError?: LogError;
  /** 单次请求超时毫秒（防 webhook 挂起；默认 env.COLLECTOR_FETCH_TIMEOUT_MS）。 */
  timeoutMs?: number;
}

/**
 * 计算飞书自定义机器人签名：`base64(HMAC-SHA256(key = `${timestamp}\n${secret}`, data = ''))`。
 *
 * 注意飞书算法的特殊点：HMAC 的**密钥**是 `${timestamp}\n${secret}` 这整串，被签名的
 * **数据**为空字符串。timestamp 为**秒级** Unix 时间戳（字符串）。
 */
export function feishuSign(timestamp: string, secret: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return createHmac('sha256', stringToSign).update('').digest('base64');
}

/** 飞书 webhook 成功响应：`code === 0`（StatusCode/StatusMessage 是历史字段，新版用 code/msg）。 */
interface FeishuResponseBody {
  code?: number;
  msg?: string;
  // 历史字段（部分场景返回 StatusCode）：0 表示成功。
  StatusCode?: number;
  StatusMessage?: string;
}

/**
 * 构造一个走飞书自定义机器人的 MessageSender。
 *
 * 发送流程：解析 text 得卡片 payload → 生成秒级 timestamp + 签名 → POST
 * `{ timestamp, sign, msg_type:'interactive', card }` → 校验响应 `code===0`（否则抛错）。
 * 整个 POST 经 withRetry 包裹（有限重试 + 错误日志），失败向上抛使 dispatcher 整批 failed。
 */
export function createFeishuSender(
  options: FeishuSenderOptions = {},
): MessageSender {
  const webhookUrl = options.webhookUrl ?? env.FEISHU_WEBHOOK_URL;
  const signSecret = options.signSecret ?? env.FEISHU_SIGN_SECRET;
  if (!webhookUrl || !signSecret) {
    // 不可达：调用方仅在 isFeishuEnabled() 为真时构造本 sender。显式抛错防误用空配置静默发送。
    throw new Error(
      'createFeishuSender: 飞书未配置（FEISHU_WEBHOOK_URL / FEISHU_SIGN_SECRET 缺失），' +
        '不应在飞书 disabled 时构造 FeishuSender。',
    );
  }
  const fetchImpl: FetchLike =
    options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const logError = options.logError ?? defaultLogError;
  const timeoutMs = options.timeoutMs ?? env.COLLECTOR_FETCH_TIMEOUT_MS;

  return {
    async send(text: string): Promise<void> {
      // dispatcher 传入的 text 是 buildFeishuCard 的 JSON.stringify({ card })。
      const parsed = JSON.parse(text) as { card: unknown };
      const card = parsed.card;

      await withRetry(
        async () => {
          // 每次重试都重新生成 timestamp + 签名：飞书签名含 timestamp，过期会被拒。
          const timestamp = String(Math.floor(Date.now() / 1000));
          const sign = feishuSign(timestamp, signSecret);
          const body = JSON.stringify({
            timestamp,
            sign,
            msg_type: 'interactive',
            card,
          });

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          let resp: Awaited<ReturnType<FetchLike>>;
          try {
            resp = await fetchImpl(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }

          const rawText = await resp.text();
          if (!resp.ok) {
            throw new Error(
              `飞书 webhook HTTP ${resp.status}：${rawText.slice(0, 500)}`,
            );
          }
          // 飞书 HTTP 200 仍可能业务失败（含限流 11232）：必须校验 code===0。
          let parsedBody: FeishuResponseBody;
          try {
            parsedBody = JSON.parse(rawText) as FeishuResponseBody;
          } catch {
            throw new Error(`飞书 webhook 响应非 JSON：${rawText.slice(0, 500)}`);
          }
          const code = parsedBody.code ?? parsedBody.StatusCode;
          if (code !== 0) {
            const msg = parsedBody.msg ?? parsedBody.StatusMessage ?? '';
            throw new Error(`飞书 webhook 业务失败 code=${code} msg=${msg}`);
          }
        },
        {
          maxAttempts: options.maxAttempts ?? 3,
          baseDelayMs: options.baseDelayMs ?? 0,
          sleep: options.sleep,
          logError,
          label: 'feishu-webhook',
        },
      );
    },
  };
}
