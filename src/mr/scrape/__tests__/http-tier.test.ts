/**
 * http 档单测（task 7.5）：robots 解析（禁则不抓）+ 裸请求头契约 + 默认 extractor 归一。
 * 不触网：robotsAllows 纯函数；safeFetch 经 fake Agent / 内存 socket 驱动真实 rawGet 路径。
 */
import { describe, expect, it, vi } from 'vitest';
import { Agent } from 'node:http';
import { Duplex } from 'node:stream';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { robotsAllows, defaultPriceRegionExtractor, safeFetch, isAllowedByRobots } =
  await import('../http-tier.js');

interface MockHttpResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

class MockHttpSocket extends Duplex {
  private rawRequest = '';
  private responded = false;

  constructor(private readonly handler: (rawRequest: string) => MockHttpResponse) {
    super();
  }

  override _read(_size: number): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.rawRequest += chunk.toString('latin1');
    if (!this.responded && this.rawRequest.includes('\r\n\r\n')) {
      this.responded = true;
      const response = this.handler(this.rawRequest);
      queueMicrotask(() => {
        this.push(formatResponse(response), 'latin1');
        this.push(null);
      });
    }
    callback();
  }

  setTimeout(_timeoutMs: number, _callback?: () => void): this {
    return this;
  }

  setNoDelay(_noDelay?: boolean): this {
    return this;
  }

  setKeepAlive(_enable?: boolean, _initialDelay?: number): this {
    return this;
  }
}

class MockAgent extends Agent {
  constructor(private readonly handler: (rawRequest: string) => MockHttpResponse) {
    super({ keepAlive: false });
  }

  override createConnection(): MockHttpSocket {
    return new MockHttpSocket(this.handler);
  }
}

function formatResponse(response: MockHttpResponse): string {
  const reason =
    response.status === 404
      ? 'Not Found'
      : response.status >= 500
        ? 'Server Error'
        : 'OK';
  const headers = {
    'content-length': String(Buffer.byteLength(response.body)),
    connection: 'close',
    ...(response.headers ?? {}),
  };
  const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  return [`HTTP/1.1 ${response.status} ${reason}`, ...headerLines, '', response.body].join(
    '\r\n',
  );
}

function mockAgent(handler: (rawRequest: string) => MockHttpResponse): Agent {
  return new MockAgent(handler);
}

function requestPath(rawRequest: string): string {
  return rawRequest.split(' ')[1] ?? '/';
}

function parseRequestHeaders(rawRequest: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of rawRequest.split('\r\n').slice(1)) {
    if (!line) break;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    headers[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

describe('robotsAllows', () => {
  it('Disallow 命中前缀 → 不允许', () => {
    const robots = 'User-agent: *\nDisallow: /private';
    expect(robotsAllows(robots, '/private/x', 'ai-radar/1.0')).toBe(false);
  });

  it('Disallow 不命中 → 允许', () => {
    const robots = 'User-agent: *\nDisallow: /private';
    expect(robotsAllows(robots, '/pricing', 'ai-radar/1.0')).toBe(true);
  });

  it('空 Disallow = 允许全部', () => {
    const robots = 'User-agent: *\nDisallow:';
    expect(robotsAllows(robots, '/anything', 'ai-radar/1.0')).toBe(true);
  });

  it('最长前缀：Allow 覆盖更短的 Disallow', () => {
    const robots = 'User-agent: *\nDisallow: /a\nAllow: /a/b';
    expect(robotsAllows(robots, '/a/b/c', 'ai-radar/1.0')).toBe(true);
    expect(robotsAllows(robots, '/a/x', 'ai-radar/1.0')).toBe(false);
  });

  it('无适用组 → 允许', () => {
    expect(robotsAllows('', '/x', 'ai-radar/1.0')).toBe(true);
  });
});

describe('defaultPriceRegionExtractor', () => {
  it('剥 script/style/标签、压空白、小写', () => {
    const html =
      '<html><head><style>.x{color:red}</style></head><body>  Price: <b>$20</b>/mo <script>x()</script></body></html>';
    const out = defaultPriceRegionExtractor(html, 'https://x');
    expect(out).toBe('price: $20 /mo');
  });

  it('用线性扫描剥 script/style，避免 ReDOS 形嵌套正则', () => {
    const html = `<body>Keep<script>${'<'.repeat(2000)}price</script><style>.x{}</style><b>$9</b></body>`;
    expect(defaultPriceRegionExtractor(html, 'https://x')).toBe('keep $9');
  });

  it('30 万个未闭合 `<` 在 1s 内返回（标签剥有界类 + 输入钳长，无 O(N²)）', () => {
    const t0 = Date.now();
    defaultPriceRegionExtractor('<'.repeat(300_000), 'https://x');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('safeFetch 响应体上限', () => {
  it('超 maxBytes 标记 truncated 且 body=null，避免截断文本进入指纹', async () => {
    const agent = mockAgent(() => ({ status: 200, body: 'abcdef' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const res = await safeFetch('http://test.openai.com/pricing', {
        allowlist: ['openai.com'],
        agents: { http: agent as never, https: agent as never },
        maxBytes: 3,
      });
      expect(res.status).toBe(200);
      expect(res.truncated).toBe(true);
      expect(res.body).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('truncated'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('robots fetch 状态处理', () => {
  it('robots 404 仍允许，5xx fail-closed 不抓', async () => {
    const notFoundAgent = mockAgent((raw) => ({
      status: requestPath(raw) === '/robots.txt' ? 404 : 200,
      body: '',
    }));
    expect(
      await isAllowedByRobots('http://test.openai.com/pricing', {
        allowlist: ['openai.com'],
        agents: { http: notFoundAgent as never, https: notFoundAgent as never },
      }),
    ).toBe(true);

    const failingAgent = mockAgent(() => ({ status: 503, body: '' }));
    expect(
      await isAllowedByRobots('http://test.openai.com/pricing', {
        allowlist: ['openai.com'],
        agents: { http: failingAgent as never, https: failingAgent as never },
      }),
    ).toBe(false);
  });
});

describe('裸请求头无凭据（design D12）', () => {
  it('出站头恰为 {User-Agent}，无 Authorization/Cookie 等', async () => {
    let capturedHeaders: Record<string, string> = {};
    const plainAgent = mockAgent((rawRequest) => {
      capturedHeaders = parseRequestHeaders(rawRequest);
      return { status: 200, body: 'ok', headers: { 'content-type': 'text/plain' } };
    });

    const res = await safeFetch('http://test.openai.com/pricing', {
      allowlist: ['openai.com'],
      agents: { http: plainAgent as never, https: plainAgent as never },
    });

    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
    // 出站头：恰含 UA，且**无任何凭据头**（design D12 裸请求）。
    const UA = process.env.MR_SCRAPE_USER_AGENT ?? '';
    expect(capturedHeaders['user-agent']).toBe(
      UA ||
        'ai-radar-model-radar/1.0 (+https://github.com/HerbertGao/ai-radar; pricing-change-detector)',
    );
    expect(capturedHeaders.authorization).toBeUndefined();
    expect(capturedHeaders.cookie).toBeUndefined();
    expect(capturedHeaders['x-api-key']).toBeUndefined();
  });
});
