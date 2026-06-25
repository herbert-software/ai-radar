/**
 * Model Radar（P5 / 5b，design D10）SSRF 单一 chokepoint。
 *
 * **page + robots.txt + 任何派生 URL（重定向目标）抓取都必过本守卫**——它是抓取子系统唯一的出站口。
 * `http-tier.ts` 经 `safeFetch` 走这里；`http-tier` 取 robots.txt 也走这里。
 *
 * 三层 + DNS-rebind 闭合（design D10，load-bearing）：
 * ① scheme 仅 `http`/`https`（拒 `file://`/`gopher://`/`data:` 等）；
 * ② host 的 registrable domain 必 ∈ checked-in 常量白名单 `MR_SOURCE_DOMAIN_ALLOWLIST`（allowlist.ts）；
 * ③ 解析 host：字面 IP 命中私网/环回/link-local 一律拒；
 * ④ **DNS-rebind 闭合（http 档）**：把出站 fetch 底层经 `node:https`/`node:http` 的**原生 `lookup` 选项**
 *    驱动——自定义 lookup 解析 host→**全部 A/AAAA**、**任一私网即整集 fail-closed 拒**、**lookup 抛错/空集 →
 *    `callback(err)` fail-closed**、否则返回预验 public IP 使 check==connect（防 rebind 竞态）；
 *    **仅覆盖 lookup 不重写 URL→IP**（保留原 hostname 供 SNI/证书校验，免 MITM 回归）；无新依赖。
 *    （`browser` 档渲染器 socket 不经此 lookup，靠网络层 egress，见 browser-tier.ts / design D11。）
 * ⑤ 重定向 `redirect:'manual'` + 每跳重跑①②③ + 最大跳数（禁 `redirect:'follow'`）。
 *
 * 错误只记**通用枚举原因 + source id**（不泄露解析到的 IP / 拓扑 / 重定向目标，防差异化报错当 oracle，design 风险节）。
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent as HttpsAgent } from 'node:https';
import { Agent as HttpAgent } from 'node:http';
import { connect as netConnect } from 'node:net';
import { isHostAllowlisted, MR_SOURCE_DOMAIN_ALLOWLIST } from './allowlist.js';

/** SSRF 拒绝的通用枚举原因（不含 IP/拓扑明细，防探测 oracle）。 */
export type SsrfRejectReason =
  | 'scheme-not-allowed'
  | 'host-not-allowlisted'
  | 'private-address'
  | 'dns-resolution-failed'
  | 'too-many-redirects';

/** SSRF 拒绝错误（只带枚举原因，调用方再配 source id 记日志）。 */
export class SsrfBlockedError extends Error {
  constructor(public readonly reason: SsrfRejectReason) {
    super(`ssrf-blocked: ${reason}`);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * 判定一个 IP 字面（v4/v6）是否为私网/环回/link-local（design D10 ③）。
 * 覆盖 `127/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`::1`、`fc00::/7`、`fe80::/10`，
 * 外加 `0.0.0.0`、IPv4-mapped IPv6（`::ffff:a.b.c.d`，按内嵌 v4 再判）。
 */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase();

  // IPv4-mapped IPv6（::ffff:10.0.0.1）→ 取内嵌 v4 判。
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return isPrivateAddress(mapped[1]!);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (mappedHex) {
    const high = parseInt(mappedHex[1]!, 16);
    const low = parseInt(mappedHex[2]!, 16);
    return isPrivateAddress(
      `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`,
    );
  }

  if (addr.includes(':')) {
    // IPv6
    if (addr === '::1' || addr === '::') return true;
    const first = parseInt(addr.split(':')[0] || '0', 16);
    // fe80::/10 = link-local（fe80..febf），不能只匹配 fe80 字面前缀。
    if ((first & 0xffc0) === 0xfe80) return true;
    // fc00::/7 = ULA（fc/fd 开头）
    if ((first & 0xfe00) === 0xfc00) return true;
    return false;
  }

  // IPv4
  const parts = addr.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    // 非规范 v4 字面：fail-closed 当私网拒（绝不放行解析失败的歧义地址）。
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 255 && b === 255 && parts[2] === 255 && parts[3] === 255) return true; // broadcast
  return false;
}

/** 网络层 TCP 连接探测函数：resolve=已建连可达；reject=超时/不可达/被 egress 拦。 */
export type NetworkConnectFn = (
  host: string,
  port: number,
  timeoutMs: number,
) => Promise<void>;

/**
 * 用 `node:net.connect` 做真实网络层连通性探测（browser egress 自检用）。
 * 不经 Playwright `context.route`/CDP，也不经 SSRF URL 守卫，避免进程内拦截让自检 vacuous。
 */
export const connectToHost: NetworkConnectFn = (host, port, timeoutMs) =>
  new Promise<void>((resolve, reject) => {
    let settled = false;
    const socket = netConnect({ host, port });

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish());
    socket.once('timeout', () => finish(new Error('mr-egress-selftest-timeout')));
    socket.once('error', (err) => finish(err));
  });

/**
 * URL 的 scheme + 白名单静态守卫（design D10 ①②③ 的静态部分：scheme/allowlist/字面 IP 私网）。
 * **每跳（page + robots + 重定向目标）都调本函数**。不做 DNS（DNS-rebind 闭合在 ④ 的 lookup 层）。
 * 抛 `SsrfBlockedError`（枚举原因）。
 */
export function assertUrlAllowed(
  rawUrl: string,
  allowlist: readonly string[] = MR_SOURCE_DOMAIN_ALLOWLIST,
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // 非法 URL：当 scheme 非法拒（file:// 无 host 等也落这里）。
    throw new SsrfBlockedError('scheme-not-allowed');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError('scheme-not-allowed');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // 去 IPv6 方括号
  // 字面 IP（含 IPv6）命中私网即拒（在白名单前——白名单是域名集，IP 字面本就不该 ∈ 域名白名单）。
  if (looksLikeIp(host) && isPrivateAddress(host)) {
    throw new SsrfBlockedError('private-address');
  }
  if (!isHostAllowlisted(host, allowlist)) {
    throw new SsrfBlockedError('host-not-allowlisted');
  }
  return url;
}

/** 粗判 host 是否为 IP 字面（v4 点分 / v6 含冒号）。 */
function looksLikeIp(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
}

/**
 * DI 钩子：解析 host 全部 A/AAAA（默认 `node:dns.lookup({all:true})`）。测试注入桩免触网。
 * 返回**所有**解析地址（用于「任一私网即整集拒」）。
 */
export type ResolveAllFn = (host: string) => Promise<LookupAddress[]>;

const defaultResolveAll: ResolveAllFn = (host) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses as LookupAddress[]);
    });
  });

/**
 * 构造一个 `node:https`/`node:http` Agent，其 `lookup` 选项做 DNS-rebind 闭合（design D10 ④）。
 *
 * 自定义 lookup：解析 host→全部 A/AAAA、**任一私网即整集 callback(err) fail-closed**、
 * **解析空集/抛错 → callback(err) fail-closed**（绝不以默认/陈旧地址放行）、
 * 否则把**预验过的某个 public IP** 交给 socket（check==connect，杜绝 check 与 connect 间的 rebind 窗口）。
 * 仅覆盖 lookup、不重写 URL，故 TLS SNI / 证书仍按原 hostname 校验（免 MITM 回归）。
 *
 * @param resolveAll 注入的解析器（生产默认 node:dns；测试注入桩）。
 */
function buildGuardedLookup(resolveAll: ResolveAllFn) {
  // 签名匹配 node 的 LookupFunction（http(s).Agent.lookup）。
  return (
    hostname: string,
    options: unknown,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    resolveAll(hostname)
      .then((addresses) => {
        if (!addresses || addresses.length === 0) {
          // 空集（CNAME-only 无 A·AAAA）→ fail-closed。
          callback(new SsrfBlockedError('dns-resolution-failed'), '');
          return;
        }
        for (const a of addresses) {
          if (isPrivateAddress(a.address)) {
            // 任一私网即整集拒（防 rebind：多 A 记录里夹一条私网）。
            callback(new SsrfBlockedError('private-address'), '');
            return;
          }
        }
        // 全 public：把预验过的首个地址交 socket（check==connect）。
        const chosen = addresses[0]!;
        const wantAll =
          options && typeof options === 'object' && (options as { all?: boolean }).all;
        if (wantAll) {
          callback(null, addresses);
        } else {
          callback(null, chosen.address, chosen.family);
        }
      })
      .catch((err) => {
        // lookup 抛错 → fail-closed（绝不放行）。
        callback(
          err instanceof SsrfBlockedError ? err : new SsrfBlockedError('dns-resolution-failed'),
          '',
        );
      });
  };
}

/** 一对带 guarded lookup 的 http/https Agent（供 fetch 的 dispatcher/agent）。 */
export interface GuardedAgents {
  https: HttpsAgent;
  http: HttpAgent;
}

/**
 * 构造一对带 DNS-rebind 闭合 lookup 的 Agent。Node 的 `fetch`（undici）不直接吃 http.Agent，
 * 故 http-tier 用 `node:https`/`node:http` 原生 request 走这对 Agent（design D10 ④「用 node:https 原生 lookup」）。
 */
export function buildGuardedAgents(resolveAll: ResolveAllFn = defaultResolveAll): GuardedAgents {
  const lookup = buildGuardedLookup(resolveAll);
  return {
    https: new HttpsAgent({ lookup, keepAlive: false }),
    http: new HttpAgent({ lookup, keepAlive: false }),
  };
}
