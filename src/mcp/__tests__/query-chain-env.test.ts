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
 * 断言 exit 0。另以静态 grep 兜底：8 个 tool 文件顶层无 push 链 static import。
 *
 * add-model-radar-recommender（组 A/C）：① allTools 7→8（组 C 注册 recommend_coding_subscription）+
 * recommend-coding.ts 纳入静态 grep 禁顶层 import（cache/build/db-index/config-env）；② 另写**剪裁 env 实跑
 * env-clean `build.ts` getter** 的子进程测——装载期测只 import `tools/index.ts`（注册 handler、不执行），
 * **抓不到** handler 运行期 `await import('build.js')` 的 parseEnv 崩溃，故须实跑 `buildModelRadarSnapshot`。
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
const snapshotBuild = resolve(repoRoot, 'src/mr/snapshot/build.ts');
const mcpDb = resolve(repoRoot, 'src/mcp/db.ts');

const databaseUrl = process.env.DATABASE_URL;

describe('env-clean 静态纪律（无需 DB，恒跑）', () => {
  it('allTools 注册 8 工具', async () => {
    // 进程内、DB 无关：本测试进程有完整 env，import tools/index.ts 不剥离 env，纯查 allTools 注册数。
    const { allTools } = await import('../tools/index.js');
    expect(Array.isArray(allTools)).toBe(true);
    expect(allTools.length).toBe(8);
  });

  it('静态兜底：8 个 tool 文件顶层 import 区不 static import 推送链/快照构建/全局 env', async () => {
    const files = [
      'get-today.ts',
      'search-events.ts',
      'search-products.ts',
      'source-quality.ts',
      'mark-event.ts',
      'mark-product.ts',
      'push-event-now.ts',
      'recommend-coding.ts', // 组 C 已建：纳入顶层 import 纪律校验。
    ];
    // 禁止出现在「顶层 import 语句」里的 specifier（push_event_now / recommend_coding 经 await import 动态加载、不算）。
    const forbidden = [
      '../../push/dispatcher.js',
      '../../push/telegram.js',
      '../../push/feishu.js',
      '../../push/push-date.js',
      '../../config/env.js',
      '../../db/index.js',
      '../../mr/snapshot/cache.js', // recommend-coding.ts 须动态 import env-clean build.ts、不顶层 import cache/build。
      '../../mr/snapshot/build.js',
      '../../selection/top-n.js', // 仅可 import type；下面单独放行 type-only。
    ];
    for (const f of files) {
      let src: string;
      try {
        src = await readFile(resolve(repoRoot, 'src/mcp/tools', f), 'utf8');
      } catch {
        // recommend-coding.ts 现已存在；try/catch 仅留作文件缺失安全网，不再宽容跳过该文件。
        continue;
      }
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

    // build.ts 前向脆弱性守卫：顶层 import db/index.js 须 `import type`、且不得顶层 import config/env.js
    //（把 `import type`→`import` 改回会编译通过但破坏 env-clean，此处静态拦住）。
    const buildSrc = await readFile(snapshotBuild, 'utf8');
    // 多行感知（非按行）：抓每条完整 `import … from '<spec>'` 语句，使跨行 value import 不漏网
    //（懒量词在每个 `from '…'` 处收口，单行/多行皆正确切分）。
    const buildImportStatements = buildSrc.match(/import\b[\s\S]*?from\s+['"][^'"]+['"]/g) ?? [];
    // db/index.js 须以 `import type`（块式）引入——运行期擦除；value import（含多行）即破坏 env-clean。
    for (const stmt of buildImportStatements.filter((s) => s.includes('../../db/index.js'))) {
      expect(stmt.startsWith('import type'), `build.ts db/index 须 import type：${stmt}`).toBe(true);
    }
    // config/env.js 顶层完全不得 import（type 亦不需要——build.ts env-clean 后阈值由参数注入）。
    expect(
      buildImportStatements.some((s) => s.includes('../../config/env.js')),
      'build.ts 顶层不得 import config/env.js',
    ).toBe(false);
  });
});

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
      if (!Array.isArray(m.allTools) || m.allTools.length !== 8) {
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

  it('剪裁 env（仅 DATABASE_URL）实跑 env-clean build.ts getter：首次调用不触 parseEnv 崩溃', async () => {
    // 装载期测（上面 import tools/index.ts）只注册 handler、不执行其运行期 `await import('build.js')`，
    // 故抓不到 build.ts 顶层 import db/index.ts/config/env.ts 时的 parseEnv 崩溃。此处剪裁 env 后实跑：
    // 动态 import env-clean build.ts + 经 mcp/db.ts 建仅-DATABASE_URL 连接 + 调 buildModelRadarSnapshot（显式 thresholdDays）。
    // 若 build.ts 未 env-clean（仍非 type-import db/index 或 config/env），`await import` 即触 parseEnv → 抛 → 子进程 exit 1 → 本用例红。
    const prunedEnv: NodeJS.ProcessEnv = {
      DATABASE_URL: databaseUrl,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    };

    const script = `(async () => {
      const buildMod = await import(${JSON.stringify(snapshotBuild)});
      const dbMod = await import(${JSON.stringify(mcpDb)});
      const db = dbMod.getMcpDb(process.env.DATABASE_URL);
      const snap = await buildMod.buildModelRadarSnapshot(db, new Date(), 30);
      await dbMod.closeMcpDb();
      if (!snap || !Array.isArray(snap.plans)) {
        console.error('BAD_SNAPSHOT');
        process.exit(2);
      }
      process.exit(0);
    })().catch((e) => {
      console.error('GETTER_THREW: ' + (e && e.message ? e.message : String(e)));
      process.exit(1);
    });`;

    const { stderr } = await execFileAsync('npx', ['tsx', '-e', script], {
      cwd: repoRoot,
      env: prunedEnv,
      timeout: 60_000,
    });
    // execFileAsync 非 0 退出即 reject（带 stderr）——能到这里即 exit 0、build 真正取到快照。
    expect(stderr).not.toContain('GETTER_THREW');
    expect(stderr).not.toContain('BAD_SNAPSHOT');
  });
});
