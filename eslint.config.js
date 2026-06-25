// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'drizzle/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // 允许以 `_` 前缀显式标记「有意未使用」的参数（如内存 Redis 桩按接口签名占位 mode/ttl/nx），
      // 这是 TS-ESLint 的惯例豁免；未加 `_` 前缀的未使用仍报错（防真遗漏）。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Model Radar（5b，design D7）结构守卫：把「抓取改不了事实」从人的纪律降为 lint 错误。
    // `src/mr/scrape/`（三档抓取）与 `event-consumer*`（事件消费者）只允许 import `src/mr/write/`
    // （flag / fingerprint / last_checked 更新器）——**禁 import `src/mr/ingest/`** 的事实 writer
    // （`upsert*` + **点名 `recordPriceChange`**：它改 `mr_plans.current_price` 是事实写）。
    files: [
      'src/mr/scrape/**',
      'src/mr/freshness/event-consumer*',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // 禁 `src/mr/ingest/` 全部事实 writer（upsert*/record-price-change），含相对 .js 后缀路径。
              group: ['**/mr/ingest/*', '**/ingest/upsert*', '**/ingest/record-price-change*'],
              message:
                '抓取链 / 事件消费者禁止 import src/mr/ingest/ 事实 writer（upsert*/recordPriceChange）——只能改不了事实，仅可 import src/mr/write/（flag/fingerprint/last_checked）。design D7。',
            },
            {
              // 点名覆盖 recordPriceChange（D7：它改 mr_plans.current_price 是事实写，绝不可被抓取链可达）。
              group: ['**/record-price-change*'],
              importNames: ['recordPriceChange', '_recordPriceChangeTx'],
              message:
                'recordPriceChange 是事实写入口（改 mr_plans.current_price）——抓取链 / 事件消费者禁止 import。design D7。',
            },
          ],
        },
      ],
    },
  },
  {
    // Model Radar（5b，design D10/D12）SSRF 结构守卫：把「必过 SSRF chokepoint」从纪律升为 lint。
    // `src/mr/scrape/**` 禁裸调出站原语绕过 wrapper（safeFetch / ssrf-guard）：
    // - `no-restricted-globals`：封 `fetch`（任何 scrape 文件都不该裸 fetch——走 safeFetch 经 SSRF 守卫）；
    // - `no-restricted-syntax`：封 `globalThis.fetch`(.…) 与 `require('node:http'…)` 形式（绕 import 静态分析）；
    // - `no-restricted-imports`：封 `node:net`/`node:dgram` + `node:http(s)`/`node:dns`（出站/解析原语）。
    // **唯一豁免**：wrapper 自身（`ssrf-guard.ts`/`http-tier.ts`）须用 `node:http(s)`/`node:dns` 实现守卫
    // （design D10 ④ 用 node:https 原生 lookup，无新依赖）——故该 import-ban 块 `ignores` 这两文件，
    // 它们仍受 globals/syntax 块约束（不裸 fetch）。本块**追加**，不动 B 的 ingest import-ban 块。
    // __tests__ 自建 loopback server（node:http/net）验头契约——非抓取链出站，豁免。
    files: ['src/mr/scrape/**'],
    ignores: ['src/mr/scrape/__tests__/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            '抓取链禁裸 fetch——必走 safeFetch（src/mr/scrape/http-tier.ts）经 SSRF chokepoint。design D10/D12。',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name='globalThis'][property.name='fetch']",
          message:
            '抓取链禁 globalThis.fetch——必走 safeFetch 经 SSRF chokepoint。design D10/D12。',
        },
        {
          // computed member 绕过：globalThis['fetch'] / global['fetch']。
          selector:
            "MemberExpression[computed=true][object.name=/^(globalThis|global)$/][property.value='fetch']",
          message:
            "抓取链禁 globalThis['fetch']/global['fetch'] computed 取 fetch——必走 safeFetch 经 SSRF chokepoint。design D10/D12。",
        },
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.value=/^node:(http|https|net|dgram|dns)$/]",
          message:
            '抓取链禁 require 形式调出站/解析原语绕过 SSRF wrapper——走 safeFetch。design D10/D12。',
        },
        {
          // 动态 import 出站/解析原语绕过 import 静态分析：await import('node:http') 等。
          selector:
            "ImportExpression[source.value=/^node:(http|https|net|dgram|dns)$/]",
          message:
            "抓取链禁 import() 动态导入 node:http(s)/net/dgram/dns 绕过 SSRF wrapper——走 safeFetch。design D10/D12。",
        },
      ],
    },
  },
  {
    // 出站/解析原语 import-ban（与上块分开是因须 `ignores` wrapper 文件）。
    // ⚠️ flat-config 同名规则 last-wins（不 merge options）——本块对 scrape 文件覆盖 B 的
    // `no-restricted-imports`，故**必须连 B 的 ingest 事实 writer 禁令一并重述**（patterns），
    // 否则会清空 B 对 scrape 的「禁 import upsert*/recordPriceChange」守卫（被 guard 文件豁免的
    // ssrf-guard/http-tier 仍由 B 块覆盖 → 它们的 ingest 禁令不丢）。
    files: ['src/mr/scrape/**'],
    ignores: [
      'src/mr/scrape/ssrf-guard.ts',
      'src/mr/scrape/http-tier.ts',
      'src/mr/scrape/__tests__/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // 重述 B 块：禁 src/mr/ingest/ 事实 writer（upsert*/record-price-change），含相对 .js 路径。
              group: ['**/mr/ingest/*', '**/ingest/upsert*', '**/ingest/record-price-change*'],
              message:
                '抓取链禁止 import src/mr/ingest/ 事实 writer（upsert*/recordPriceChange）——只能改不了事实，仅可 import src/mr/write/。design D7。',
            },
            {
              group: ['**/record-price-change*'],
              importNames: ['recordPriceChange', '_recordPriceChangeTx'],
              message:
                'recordPriceChange 是事实写入口（改 mr_plans.current_price）——抓取链禁止 import。design D7。',
            },
          ],
          paths: [
            {
              name: 'node:http',
              message:
                '抓取链禁裸调 node:http——必走 safeFetch（http-tier.ts）经 SSRF chokepoint。design D10/D12。',
            },
            {
              name: 'node:https',
              message:
                '抓取链禁裸调 node:https——必走 safeFetch（http-tier.ts）经 SSRF chokepoint。design D10/D12。',
            },
            {
              name: 'node:net',
              message: '抓取链禁裸调 node:net 绕过 SSRF wrapper。design D10/D12。',
            },
            {
              name: 'node:dgram',
              message: '抓取链禁裸调 node:dgram 绕过 SSRF wrapper。design D10/D12。',
            },
            {
              name: 'node:dns',
              message:
                '抓取链禁裸调 node:dns——DNS-rebind 闭合在 ssrf-guard.ts 的 guarded lookup。design D10。',
            },
          ],
        },
      ],
    },
  },
);
