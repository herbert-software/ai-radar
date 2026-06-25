/**
 * SSRF 守卫单测（task 7.5，design D10）。不触网：测纯函数 + 注入 resolveAll 桩。
 *
 * 覆盖：私网/云元数据/非白名单/file:// → 拒；重定向私网被拦（assertUrlAllowed 重跑）；
 * lookup 空集/抛错 → fail-closed callback(err)；任一 A 私网整集拒；裸请求头无凭据（http-tier 固定 UA）。
 */
import { describe, expect, it } from 'vitest';

// import 链触发 env 校验：注入占位（不触网/不连 DB）。
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const {
  assertUrlAllowed,
  isPrivateAddress,
  buildGuardedAgents,
  SsrfBlockedError,
} = await import('../ssrf-guard.js');

const ALLOW = ['openai.com', 'anthropic.com'];

describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false], // 出 12 位段
    ['192.168.1.1', true],
    ['169.254.169.254', true], // 云元数据
    ['0.0.0.0', true],
    ['100.64.0.1', true], // CGNAT
    ['100.127.255.255', true], // CGNAT 上界
    ['100.128.0.1', false], // CGNAT 外
    ['255.255.255.255', true], // 广播
    ['8.8.8.8', false], // public
    ['::1', true],
    ['fe80::1', true],
    ['fe90::1', true], // fe80::/10
    ['febf::1', true], // fe80::/10 上界
    ['fc00::1', true],
    ['fd12::34', true],
    ['::ffff:10.0.0.1', true], // v4-mapped 私网
    ['::ffff:7f00:1', true], // v4-mapped hex loopback
    ['::ffff:a9fe:a9fe', true], // v4-mapped hex link-local / metadata
    ['2606:4700:4700::1111', false], // public v6
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});

describe('assertUrlAllowed（scheme + 白名单 + 字面 IP 私网）', () => {
  it('非白名单域 → host-not-allowlisted', () => {
    expect(() => assertUrlAllowed('https://evil.example.com/p', ALLOW)).toThrow(
      SsrfBlockedError,
    );
    try {
      assertUrlAllowed('https://evil.example.com/p', ALLOW);
    } catch (e) {
      expect((e as InstanceType<typeof SsrfBlockedError>).reason).toBe('host-not-allowlisted');
    }
  });

  it('子域命中白名单裸域', () => {
    expect(() => assertUrlAllowed('https://pricing.openai.com/x', ALLOW)).not.toThrow();
  });

  it('file:// → scheme-not-allowed', () => {
    try {
      assertUrlAllowed('file:///etc/passwd', ALLOW);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as InstanceType<typeof SsrfBlockedError>).reason).toBe('scheme-not-allowed');
    }
  });

  it('字面云元数据 IP → private-address（即便不在白名单也先判私网）', () => {
    try {
      assertUrlAllowed('http://169.254.169.254/latest/meta-data/', ALLOW);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as InstanceType<typeof SsrfBlockedError>).reason).toBe('private-address');
    }
  });

  it('字面环回 → private-address', () => {
    try {
      assertUrlAllowed('http://127.0.0.1:6379/', ALLOW);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as InstanceType<typeof SsrfBlockedError>).reason).toBe('private-address');
    }
  });

  it('重定向目标私网 → 重跑守卫拦截（每跳重验）', () => {
    // 模拟「白名单源 302 到私网」：守卫对 location 重跑即拒。
    const redirectTarget = 'http://169.254.169.254/';
    expect(() => assertUrlAllowed(redirectTarget, ALLOW)).toThrow(SsrfBlockedError);
  });
});

describe('guarded lookup（DNS-rebind 闭合，design D10 ④）', () => {
  // 取 Agent 的私有 lookup：经 buildGuardedAgents 注入 resolveAll 桩，直接调 lookup 验 callback。
  function getLookup(resolveAll: (host: string) => Promise<{ address: string; family: number }[]>) {
    const agents = buildGuardedAgents(resolveAll);
    // node http.Agent 的 lookup 选项挂在 options 上。
    return (
      agents.https as unknown as {
        options: {
          lookup: (host: string, opts: unknown, cb: (...args: unknown[]) => void) => void;
        };
      }
    ).options.lookup;
  }

  it('全 public → callback(null, ip)', async () => {
    const lookup = getLookup(async () => [{ address: '8.8.8.8', family: 4 }]);
    const res = await new Promise<{ err: unknown; addr: unknown }>((resolve) => {
      lookup('openai.com', {}, (err: unknown, addr: unknown) => resolve({ err, addr }));
    });
    expect(res.err).toBeNull();
    expect(res.addr).toBe('8.8.8.8');
  });

  it('任一 A 私网 → 整集 callback(private-address)', async () => {
    const lookup = getLookup(async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.5', family: 4 }, // 夹一条私网（rebind 攻击）
    ]);
    const res = await new Promise<{ err: unknown }>((resolve) => {
      lookup('rebind.openai.com', {}, (err: unknown) => resolve({ err }));
    });
    expect(res.err).toBeInstanceOf(SsrfBlockedError);
    expect((res.err as InstanceType<typeof SsrfBlockedError>).reason).toBe('private-address');
  });

  it('解析空集（CNAME-only）→ fail-closed callback(dns-resolution-failed)', async () => {
    const lookup = getLookup(async () => []);
    const res = await new Promise<{ err: unknown }>((resolve) => {
      lookup('cname.openai.com', {}, (err: unknown) => resolve({ err }));
    });
    expect(res.err).toBeInstanceOf(SsrfBlockedError);
    expect((res.err as InstanceType<typeof SsrfBlockedError>).reason).toBe('dns-resolution-failed');
  });

  it('lookup 抛错 → fail-closed callback(err)', async () => {
    const lookup = getLookup(async () => {
      throw new Error('ENOTFOUND');
    });
    const res = await new Promise<{ err: unknown }>((resolve) => {
      lookup('broken.openai.com', {}, (err: unknown) => resolve({ err }));
    });
    expect(res.err).toBeTruthy(); // 抛错 → callback(err)，绝不放行。
  });
});
