/**
 * Model Radar（P5 / 5b，design D11/D15）`browser` 档 = Playwright 沙箱锁定取页（不可信外部页）。
 *
 * **独立 entrypoint（browser-worker-main.ts）+ 独立镜像**（主镜像不装 Playwright，design D15）。
 * Playwright 用**动态 import**（隔离其加载——使 http/manual/SSRF/fingerprint/snapshot 链不依赖 playwright 二进制即可编译运行）。
 *
 * 沙箱契约（design D11，逐条守住）：
 * - 非 root 运行 + Chromium **sandbox 启用**（禁传 `--no-sandbox`）；
 * - **每 job 全新 `browser.newContext()` 用后即关**（非复用单 context，防跨源污染）；
 * - 禁下载（`acceptDownloads:false`）/file chooser/对话框（自动 dismiss）/新窗口/service worker/默认权限；
 * - **私网/元数据 IP 的权威封锁靠网络层 egress**（渲染器 socket 不经 Node lookup，必需部署控制）——
 *   `context.route`（URL-string 过滤）+ CDP `Network.setBlockedURLs(['ws://*','wss://*'])` 封 WebSocket = **纵深防御**；
 * - **硬超时杀进程树**（`SIGKILL` + 外层 watchdog，非 `browser.close()`——后者被挂死渲染器拖住）；
 * - 内存/响应体上限（容器 cgroup + 本层最大体）。
 */
import { env } from '../../config/env.js';
import {
  assertUrlAllowed,
  connectToHost,
  isPrivateAddress,
  type NetworkConnectFn,
} from './ssrf-guard.js';

/** Playwright 最小类型门面（不静态 import playwright，避免主链依赖其二进制）。 */
interface PwRoute {
  request(): { url(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
}
interface PwCDPSession {
  send(method: string, params?: unknown): Promise<unknown>;
}
interface PwPage {
  goto(url: string, opts?: unknown): Promise<unknown>;
  content(): Promise<string>;
  on(event: string, handler: (arg: unknown) => void): void;
}
interface PwContext {
  route(pattern: string, handler: (route: PwRoute) => void): Promise<void>;
  newPage(): Promise<PwPage>;
  newCDPSession(page: PwPage): Promise<PwCDPSession>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(opts?: unknown): Promise<PwContext>;
  process(): { pid?: number } | null;
  close(): Promise<void>;
}
/** 启动浏览器的最小契约（chromium.launch 子集）；测试注入桩。 */
export interface BrowserLauncher {
  launch(opts?: unknown): Promise<PwBrowser>;
}

/** 默认 launcher = 动态 import playwright 的 chromium（隔离加载，主链不依赖二进制）。 */
async function defaultLauncher(): Promise<BrowserLauncher> {
  // 动态 import：仅 browser-worker 进程在 launch 时才真正加载 playwright。
  const pw = (await import('playwright')) as unknown as { chromium: BrowserLauncher };
  return pw.chromium;
}

/** 判一个 URL 是否应被 route 拦（私网/元数据/非 http(s)），纵深防御层。 */
function shouldBlockUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true; // 非法 URL 拦。
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true; // 拦 file://data: 等。
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // 字面私网 IP 拦（host 为域名时由网络层 egress 权威封锁）。
  if ((/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) && isPrivateAddress(host)) {
    return true;
  }
  return false;
}

export interface BrowserFetchOptions {
  /** 注入 launcher（默认动态 import playwright chromium；测试/自检注入桩）。 */
  launcher?: BrowserLauncher | undefined;
  /** 硬超时毫秒（默认 env.MR_SCRAPE_FETCH_TIMEOUT_MS）。 */
  timeoutMs?: number | undefined;
  /** 注入进程树 kill（默认 process.kill）；测试断言 SIGKILL 命中 pid。 */
  killProcess?: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
}

/**
 * browser 档取页（沙箱锁定，design D11）。每次调用 = 一个 job = 全新 context 用后即关。
 *
 * **硬超时杀进程树**：外层 `Promise.race([job, watchdog])`，超时 `process.kill(pid,'SIGKILL')`（进程树）+
 * 不依赖 `browser.close()`（挂死渲染器会拖住它）。
 *
 * @returns 页面 HTML 文本；超时/失败抛错（由 BullMQ 整 job 重试）。
 */
export async function fetchWithBrowser(
  rawUrl: string,
  options: BrowserFetchOptions = {},
): Promise<string> {
  const targetUrl = assertUrlAllowed(rawUrl).toString();
  const timeoutMs = options.timeoutMs ?? env.MR_SCRAPE_FETCH_TIMEOUT_MS;
  const killProcess =
    options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const launcher = options.launcher ?? (await defaultLauncher());

  // sandbox 启用：**绝不传 `--no-sandbox`**（design D11）。
  const browser = await launcher.launch({
    headless: true,
    // chromiumSandbox 显式 true（默认即 true，显式表达不容意外关闭）。
    chromiumSandbox: true,
  });

  const pid = browser.process()?.pid;

  // 外层 watchdog：硬超时 → SIGKILL 进程树（非 browser.close()）。
  let watchdog: NodeJS.Timeout | undefined;
  const hardTimeout = new Promise<never>((_, reject) => {
    watchdog = setTimeout(() => {
      if (pid) killProcess(pid, 'SIGKILL'); // 进程树 kill（cgroup/容器内 pid 同树）。
      reject(new Error('mr-browser-hard-timeout'));
    }, timeoutMs);
  });

  const job = (async (): Promise<string> => {
    // 每 job 全新 context，沙箱锁定选项。
    const context = await browser.newContext({
      acceptDownloads: false, // 禁下载。
      serviceWorkers: 'block', // 禁 service worker。
      bypassCSP: false,
      permissions: [], // 无默认权限。
    });
    try {
      // 纵深防御 ①：context.route 拦私网/元数据/非 http(s)（URL-string 过滤）。
      await context.route('**/*', (route) => {
        if (shouldBlockUrl(route.request().url())) {
          void route.abort();
        } else {
          void route.continue();
        }
      });

      const page = await context.newPage();

      // 禁对话框（自动 dismiss）。
      page.on('dialog', (dialog) => {
        void (dialog as { dismiss?: () => Promise<void> }).dismiss?.();
      });

      // 纵深防御 ②：CDP 封 WebSocket（context.route 不拦 ws；JS shim 可绕过不作权威，design D11）。
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.setBlockedURLs', { urls: ['ws://*', 'wss://*'] });
      await cdp.send('Network.enable');

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      return await page.content();
    } finally {
      // 每 job context 用后即关（防跨源污染）。
      await context.close().catch(() => {});
    }
  })();

  try {
    return await Promise.race([job, hardTimeout]);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    // 正常路径优雅关；挂死路径已被 watchdog SIGKILL，close 失败忽略。
    await browser.close().catch(() => {});
  }
}

/**
 * 启动 fail-closed 自检哨兵（design D11）：browser-worker-main 启动时对**每段一个代表哨兵**
 * 做 TCP 建连，**任一未被网络层 egress 挡住则拒绝启动**（防偏配/未配 egress 裸奔成 SSRF-to-metadata 洞）。
 *
 * 哨兵覆盖三段：云元数据 `169.254.169.254` + 一个 RFC1918 `10.0.0.1` + 环回 `127.0.0.1`。
 */
export const EGRESS_SELFTEST_SENTINELS: readonly string[] = [
  '169.254.169.254:80', // 云元数据
  '10.0.0.1:80', // RFC1918
  '127.0.0.1:80', // 环回
];

export interface EgressSentinel {
  host: string;
  port: number;
}

const DEFAULT_EGRESS_SELFTEST_SENTINELS: readonly EgressSentinel[] =
  EGRESS_SELFTEST_SENTINELS.map((sentinel) => {
    const [host, port] = sentinel.split(':');
    return { host: host!, port: Number(port) };
  });

export interface EgressSelfTestOptions {
  /** TCP connect 注入点：resolve=可达；reject=网络层失败/被封。 */
  connect?: NetworkConnectFn | undefined;
  /** 探测哨兵，默认 169.254.169.254:80 / 10.0.0.1:80 / 127.0.0.1:80。 */
  sentinels?: readonly EgressSentinel[] | undefined;
  /** 单哨兵短超时（默认 4000ms）。 */
  timeoutMs?: number | undefined;
}

/**
 * 对每个哨兵做 TCP 建连探测，**任一建连成功即返回 false（自检失败，拒启动）**。
 * 这里必须绕过 Playwright `context.route`/CDP，测网络层 egress 本身（design D11）。
 *
 * @returns true=全部哨兵被挡（egress 就位，可启动）；false=任一可达（fail-closed，拒启动）。
 */
export async function egressSelfTest(options: EgressSelfTestOptions = {}): Promise<boolean> {
  // ponytail: DROP vs no-route 从 userspace 不可区分；socket 探兜住云元数据可达的误配（主案），
  // 兜不住 bare-metal/LAN（无 egress 过滤时私网哨兵恰不可达也判「被挡」放行）——egress 过滤
  // （netns/proxy）仍是必需部署控制，自检只是纵深防御（D11，spec L109/L119-121）。
  const connect = options.connect ?? connectToHost;
  const sentinels = options.sentinels ?? DEFAULT_EGRESS_SELFTEST_SENTINELS;
  const timeoutMs = options.timeoutMs ?? 4000;

  for (const sentinel of sentinels) {
    try {
      await connect(sentinel.host, sentinel.port, timeoutMs);
    } catch {
      // 网络层失败（超时/拒绝/不可达）= 被挡，继续探下一个哨兵。
      continue;
    }
    // 任一哨兵可达 → egress 未挡住私网 → 自检失败。
    return false;
  }
  return true;
}
