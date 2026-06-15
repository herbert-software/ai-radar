/**
 * 查询链零全局-env 验收（task 6.4 / N2）——纯进程内难剥离已加载的 .env，故用**子进程**裁剪 env 跑。
 *
 * 验收点（design D8「纯查询只需 DATABASE_URL」）：仅设 `DATABASE_URL`（剔除推送/采集 token——
 * 即 TELEGRAM、REDIS_URL、LLM、PRODUCT_HUNT_TOKEN、FEISHU 等）时，
 * `import('src/mcp/tools/index.ts')`（server.ts 启动即做的事）**不抛**——证明：
 *   ① 查询链 top-level 不 static import dispatcher/push-date/top-n(value)/telegram/feishu/
 *      db/index.ts/config/env.ts（它们 import 期跑全局 parseEnv 会崩纯查询）；
 *   ② push_event_now 的推送链在 handler 内动态 import、不在 top-level（注册其 handler 不触发加载）。
 *
 * 子进程用 tsx 跑 `import(...).then(...)`，env 只给 DATABASE_URL（+ 进程必要的 PATH）；
 * 断言 exit 0。另以静态 grep 兜底：7 个 tool 文件顶层无 push 链 static import。
 */
import 'dotenv/config';
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
// src/mcp/__tests__ → 仓根。
const repoRoot = resolve(here, '../../..');
const toolsIndex = resolve(repoRoot, 'src/mcp/tools/index.ts');

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('查询链仅 DATABASE_URL 可加载（N2 / 子进程裁剪 env）', () => {
  it('仅设 DATABASE_URL 时 import tools/index.ts 不抛（exit 0）', async () => {
    // 裁剪后的 env：只保留 DATABASE_URL + 进程基础（PATH、HOME 供 tsx、node 运行）。
    // 不传 .env 里的推送、采集 token（TELEGRAM、REDIS_URL、LLM、PRODUCT_HUNT_TOKEN、FEISHU 等）——
    // 若查询链顶层误触全局 parseEnv，import 期即 throw → 子进程非 0 退出 → 本用例红。
    const prunedEnv: NodeJS.ProcessEnv = {
      DATABASE_URL: databaseUrl,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    };

    const script = `import(${JSON.stringify(toolsIndex)}).then((m) => {
      if (!Array.isArray(m.allTools) || m.allTools.length !== 7) {
        console.error('allTools 数量异常: ' + (m.allTools && m.allTools.length));
        process.exit(2);
      }
      process.exit(0);
    }).catch((e) => {
      console.error('IMPORT_THREW: ' + (e && e.message ? e.message : String(e)));
      process.exit(1);
    });`;

    const { stdout, stderr } = await execFileAsync(
      'npx',
      ['tsx', '-e', script],
      {
        cwd: repoRoot,
        env: prunedEnv,
        timeout: 60_000,
      },
    );
    // execFileAsync 在非 0 退出时 reject（带 stdout/stderr）——能到这里即 exit 0。
    expect(stderr).not.toContain('IMPORT_THREW');
    void stdout;
  });

  it('静态兜底：7 个 tool 文件顶层 import 区不 static import 推送链/全局 env', async () => {
    const files = [
      'get-today.ts',
      'search-events.ts',
      'search-products.ts',
      'source-quality.ts',
      'mark-event.ts',
      'mark-product.ts',
      'push-event-now.ts',
    ];
    // 禁止出现在「顶层 import 语句」里的 specifier（push_event_now 经 await import 动态加载、不算）。
    const forbidden = [
      '../../push/dispatcher.js',
      '../../push/telegram.js',
      '../../push/feishu.js',
      '../../push/push-date.js',
      '../../config/env.js',
      '../../db/index.js',
      '../../selection/top-n.js', // 仅可 import type；下面单独放行 type-only。
    ];
    for (const f of files) {
      const src = await readFile(resolve(repoRoot, 'src/mcp/tools', f), 'utf8');
      // 取所有以 import 开头的整行（含跨行的简单近似：按行）。
      const importLines = src
        .split('\n')
        .filter((l) => /^\s*import\b/.test(l));
      for (const spec of forbidden) {
        const offending = importLines.filter((l) => l.includes(spec));
        for (const line of offending) {
          // 放行 `import type` 仅类型导入（编译期擦除、不触发运行时 parseEnv）。
          expect(line.trimStart().startsWith('import type'), `${f}: ${line.trim()}`).toBe(true);
        }
      }
    }
  });
});
