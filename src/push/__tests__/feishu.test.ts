/**
 * FeishuSender 单测（feishu-push 5.2 / 5.6）：原生 fetch + 签名 + 重试 + 错误日志。
 *
 * 不触网：注入 fetch 桩断言「POST 带 timestamp/sign/msg_type=interactive/card」「重试」
 * 「业务失败 code!==0 抛错」「HTTP 非 2xx 抛错」。签名算法确定性单独断言。
 * 间接 import config/env：注入占位让无真实凭据也能跑（不依赖飞书真实 webhook）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../feishu.js';

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { createFeishuSender, feishuSign } = await import('../feishu.js');

/** 捕获 fetch 调用入参的桩工厂（带显式 FetchLike 形参签名，便于断言 body）。 */
function fetchStub(
  impl: (...args: Parameters<FetchLike>) => ReturnType<FetchLike>,
): ReturnType<typeof vi.fn> & FetchLike {
  return vi.fn(impl) as unknown as ReturnType<typeof vi.fn> & FetchLike;
}

/** 飞书成功响应。 */
const okResponse = () => ({
  ok: true,
  status: 200,
  async text() {
    return JSON.stringify({ code: 0, msg: 'success' });
  },
});

/** 一个最小卡片 payload（dispatcher 传入的 text 是 JSON.stringify({ card })）。 */
const cardText = JSON.stringify({ card: { header: { title: { tag: 'plain_text', content: 'x' } }, elements: [] } });

const SENDER_OPTS = {
  webhookUrl: 'https://open.feishu.cn/hook/test',
  signSecret: 'topsecret',
  baseDelayMs: 0,
  sleep: async () => {},
};

describe('feishuSign 签名算法确定性', () => {
  it('base64(HMAC-SHA256(key=`${ts}\\n${secret}`, data=""))，同输入恒等', () => {
    const a = feishuSign('1700000000', 'topsecret');
    const b = feishuSign('1700000000', 'topsecret');
    expect(a).toBe(b);
    // 不同 timestamp → 不同签名。
    expect(feishuSign('1700000001', 'topsecret')).not.toBe(a);
    // base64 形态。
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe('createFeishuSender 发送', () => {
  it('POST 带 timestamp/sign/msg_type=interactive/card 到 webhook', async () => {
    const fetchImpl = fetchStub(async () => okResponse());
    const sender = createFeishuSender({ ...SENDER_OPTS, fetchImpl });
    await sender.send(cardText, 'MarkdownV2');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as Parameters<FetchLike>;
    expect(url).toBe(SENDER_OPTS.webhookUrl);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.msg_type).toBe('interactive');
    expect(typeof body.timestamp).toBe('string');
    expect(typeof body.sign).toBe('string');
    expect(body.card).toBeDefined();
    // 签名与 body.timestamp 自洽。
    expect(body.sign).toBe(feishuSign(body.timestamp as string, SENDER_OPTS.signSecret));
  });

  it('业务失败 code!==0（含限流 11232）→ 重试后仍抛错', async () => {
    const fetchImpl = fetchStub(async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ code: 11232, msg: 'rate limited' });
      },
    }));
    const logError = vi.fn();
    const sender = createFeishuSender({
      ...SENDER_OPTS,
      fetchImpl,
      maxAttempts: 3,
      logError,
    });
    await expect(sender.send(cardText, 'MarkdownV2')).rejects.toThrow(/11232/);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 重试到上限。
    expect(logError).toHaveBeenCalled(); // 错误日志非静默。
  });

  it('HTTP 非 2xx → 抛错（不静默吞）', async () => {
    const fetchImpl = fetchStub(async () => ({
      ok: false,
      status: 500,
      async text() {
        return 'boom';
      },
    }));
    const sender = createFeishuSender({ ...SENDER_OPTS, fetchImpl, maxAttempts: 1 });
    await expect(sender.send(cardText, 'MarkdownV2')).rejects.toThrow(/500/);
  });

  it('首次失败、二次成功 → 重试成功不抛（有限重试容错）', async () => {
    let n = 0;
    const fetchImpl = fetchStub(async () => {
      n += 1;
      if (n === 1) throw new Error('network blip');
      return okResponse();
    });
    const sender = createFeishuSender({ ...SENDER_OPTS, fetchImpl, maxAttempts: 3 });
    await expect(sender.send(cardText, 'MarkdownV2')).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('未配置 webhook/secret 时构造即抛错（防空配置静默发送）', () => {
    expect(() =>
      createFeishuSender({ webhookUrl: '', signSecret: '' }),
    ).toThrow(/飞书未配置/);
  });
});
