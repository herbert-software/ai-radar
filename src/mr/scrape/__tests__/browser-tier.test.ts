/**
 * browser 档沙箱锁定单测（task 7.5，design D11）。注入 Playwright 桩，不真启浏览器/不触网。
 * 覆盖：页内私网/file:// 被 context.route 拦 + 页内 ws:// 被 CDP 显式封 + context 随 job 销毁 +
 * 沙箱不传 --no-sandbox + egress 未配启动自检拒启动 + 挂死渲染器 watchdog SIGKILL（桩 pid）。
 */
import { describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { fetchWithBrowser, egressSelfTest, EGRESS_SELFTEST_SENTINELS } = await import(
  '../browser-tier.js'
);
const { SsrfBlockedError } = await import('../ssrf-guard.js');

/** 构造一个可观测的 Playwright 桩 launcher。 */
function makeStubLauncher(opts: { hang?: boolean } = {}) {
  const state = {
    launchOpts: undefined as unknown,
    contextOpts: undefined as unknown,
    contextClosed: false,
    browserClosed: false,
    routePattern: undefined as string | undefined,
    cdpCalls: [] as { method: string; params?: unknown }[],
    routeHandler: undefined as ((route: never) => void) | undefined,
    gotoUrls: [] as string[],
  };
  const launcher = {
    async launch(launchOpts?: unknown) {
      state.launchOpts = launchOpts;
      return {
        process: () => ({ pid: 4242 }),
        async newContext(contextOpts?: unknown) {
          state.contextOpts = contextOpts;
          return {
            async route(pattern: string, handler: (route: never) => void) {
              state.routePattern = pattern;
              state.routeHandler = handler;
            },
            async newPage() {
              return {
                on() {},
                async goto(url: string) {
                  state.gotoUrls.push(url);
                  if (opts.hang) {
                    // 挂死渲染器：永不 resolve（靠 watchdog SIGKILL 兜底）。
                    await new Promise(() => {});
                  }
                  return null;
                },
                async content() {
                  return '<html>price</html>';
                },
              };
            },
            async newCDPSession() {
              return {
                async send(method: string, params?: unknown) {
                  state.cdpCalls.push({ method, params });
                  return null;
                },
              };
            },
            async close() {
              state.contextClosed = true;
            },
          };
        },
        async close() {
          state.browserClosed = true;
        },
      };
    },
  };
  return { launcher, state };
}

describe('fetchWithBrowser 沙箱锁定', () => {
  it('沙箱启用（不传 --no-sandbox）+ context 沙箱选项 + 用后即关', async () => {
    const { launcher, state } = makeStubLauncher();
    const html = await fetchWithBrowser('https://openai.com/pricing', {
      launcher: launcher as never,
    });
    expect(html).toBe('<html>price</html>');

    // 沙箱：chromiumSandbox=true，绝无 --no-sandbox。
    const launchOpts = state.launchOpts as { chromiumSandbox?: boolean; args?: string[] };
    expect(launchOpts.chromiumSandbox).toBe(true);
    expect(JSON.stringify(launchOpts.args ?? [])).not.toContain('--no-sandbox');

    // context 禁下载/SW/权限。
    const ctxOpts = state.contextOpts as {
      acceptDownloads?: boolean;
      serviceWorkers?: string;
      permissions?: string[];
    };
    expect(ctxOpts.acceptDownloads).toBe(false);
    expect(ctxOpts.serviceWorkers).toBe('block');
    expect(ctxOpts.permissions).toEqual([]);

    // context 随 job 销毁。
    expect(state.contextClosed).toBe(true);

    // CDP 封 WebSocket（页内 ws:// 私网靠此显式封，context.route 不拦 ws）。
    const blocked = state.cdpCalls.find((c) => c.method === 'Network.setBlockedURLs');
    expect(blocked).toBeTruthy();
    expect(JSON.stringify(blocked!.params)).toContain('ws://*');
    expect(JSON.stringify(blocked!.params)).toContain('wss://*');

    // context.route 注册了拦截器，且对私网/file:// 判 abort。
    expect(state.routePattern).toBe('**/*');
    const routeHandler = state.routeHandler!;
    const probe = (url: string) => {
      let aborted = false;
      let continued = false;
      routeHandler({
        request: () => ({ url: () => url }),
        abort: async () => {
          aborted = true;
        },
        continue: async () => {
          continued = true;
        },
      } as never);
      return { aborted, continued };
    };
    expect(probe('http://169.254.169.254/').aborted).toBe(true); // 元数据
    expect(probe('http://10.0.0.1/').aborted).toBe(true); // RFC1918
    expect(probe('file:///etc/passwd').aborted).toBe(true); // file://
    expect(probe('https://openai.com/x').continued).toBe(true); // 白名单 public 放行
  });

  it.each([
    ['https://evil.example.com/pricing', 'host-not-allowlisted'],
    ['file:///etc/passwd', 'scheme-not-allowed'],
  ])('page.goto 前调 assertUrlAllowed，拒绝 %s 且不导航', async (url, reason) => {
    const { launcher, state } = makeStubLauncher();
    try {
      await fetchWithBrowser(url, { launcher: launcher as never });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SsrfBlockedError);
      expect((err as InstanceType<typeof SsrfBlockedError>).reason).toBe(reason);
    }
    expect(state.launchOpts).toBeUndefined();
    expect(state.gotoUrls).toEqual([]);
  });

  it('挂死渲染器 → watchdog SIGKILL 进程树（桩 pid）', async () => {
    const { launcher } = makeStubLauncher({ hang: true });
    const killed: { pid: number; signal: string }[] = [];
    await expect(
      fetchWithBrowser('https://openai.com/pricing', {
        launcher: launcher as never,
        timeoutMs: 50, // 极短硬超时触发 watchdog。
        killProcess: (pid, signal) => killed.push({ pid, signal }),
      }),
    ).rejects.toThrow(/hard-timeout/);
    // watchdog 对桩 pid 发 SIGKILL（非 browser.close()）。
    expect(killed).toEqual([{ pid: 4242, signal: 'SIGKILL' }]);
  });
});

describe('egress fail-closed 自检（design D11）', () => {
  it('全哨兵网络层失败（connect 抛错/不可达）→ 自检通过', async () => {
    const connect = vi.fn(async () => {
      throw new Error('ENETUNREACH');
    });
    expect(await egressSelfTest({ connect, timeoutMs: 123 })).toBe(true);
    // 三段哨兵都以 host/port 探测，不走 browser/page probe。
    expect(connect).toHaveBeenCalledTimes(EGRESS_SELFTEST_SENTINELS.length);
    expect(connect).toHaveBeenNthCalledWith(1, '169.254.169.254', 80, 123);
    expect(connect).toHaveBeenNthCalledWith(2, '10.0.0.1', 80, 123);
    expect(connect).toHaveBeenNthCalledWith(3, '127.0.0.1', 80, 123);
  });

  it('任一哨兵网络层可建连（egress 未配/偏配）→ 自检失败（拒启动）', async () => {
    const connect = vi.fn(async (host: string) => {
      if (host === '10.0.0.1') return;
      throw new Error('ENETUNREACH');
    });
    expect(await egressSelfTest({ connect, timeoutMs: 123 })).toBe(false);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenNthCalledWith(1, '169.254.169.254', 80, 123);
    expect(connect).toHaveBeenNthCalledWith(2, '10.0.0.1', 80, 123);
  });
});
