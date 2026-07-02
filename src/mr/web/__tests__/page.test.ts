/**
 * 组 C SSR 页测（add-model-radar-compare-web-page / task 7.x）——注入合成快照、`app.request()` 取 HTML，
 * 对 HTML 串断言（不需浏览器 e2e）。**全合成、不触 DB/Redis**（getSnapshot 可注入；测试安全红线）。
 *
 * 覆盖：7.1 筛选/溯源/分组、7.2 诚实分层 + 未核不入最划算 + 桶2 gate、7.3 XSS + CSP、
 * 7.4 不挂 version-304（无 ETag、每请求重渲）、7.5 只读 + 冷启动 503、7.6 估算页面侧、7.7 a11y。
 */
import { describe, expect, it, vi } from 'vitest';
import { modelRadarQueryParamsSchema } from '../../snapshot/query.js';
import { client, known, limit, model, prov, provider, snap, unknown } from './fixtures.js';

// 页面静态导入链 cache→db→env 会在 import 时校验 env（dotenv 不覆盖已存在值）。本仓 .env 缺省时先设占位、
// 再**动态** import 页面（静态 import 会提升到占位赋值之上 → 触发校验失败）。全 dummy，且注入 getSnapshot 后
// DB/Redis 永不被拨号（pg Pool 惰性、页面不导入 redis；守「测试绝不连真 DB/Redis」红线）。镜像 snapshot/cache.test.ts。
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { createModelRadarWebApp } = await import('../model-radar-page.js');

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** 取页面 HTML（默认 GET /model-radar）。 */
async function render(getSnapshot: () => Promise<{ snapshot: ReturnType<typeof snap>; version: string }>, path = '/model-radar') {
  const app = createModelRadarWebApp(getSnapshot);
  const res = await app.request(path);
  return { res, html: await res.text() };
}

describe('7.1 SSR 渲染：按模型筛选答「谁含 X」+ 每格可溯源 + 分组不跨桶/币', () => {
  it('?model=glm:5.2 → 表只列含该模型的 plan，其余不出现', async () => {
    const alpha = known('Alpha', '30', 'CNY', { models: [model('glm', '5.2')], clients: [client('tool', 'claude-code')] });
    const beta = known('Beta', '40', 'CNY', { models: [model('other', '1.0')] });
    const { res, html } = await render(provider(snap(alpha, beta)), '/model-radar?model=glm:5.2');

    expect(res.status).toBe(200);
    expect(html).toContain('scope="row">Alpha'); // 名格；名后可能跟 availability 标签（unknown→状态未知）
    expect(html).not.toContain('scope="row">Beta'); // 不含 glm:5.2 → 被 queryModelRadarSnapshot 过滤
  });

  it('每格可溯源：行展开 <details> 呈现 source_url 链接（http 经 safeHref）', async () => {
    const p = known('Alpha', '30', 'CNY', {
      models: [model('glm', '5.2', { sourceUrl: 'https://docs.example.com/compat' })],
    });
    const { html } = await render(provider(snap(p)));
    expect(html).toContain('<details');
    expect(html).toContain('查看来源');
    expect(html).toContain('href="https://docs.example.com/compat"');
  });

  it('排序经 queryModelRadarSnapshot：混币种分独立组（不跨币比）', async () => {
    const { html } = await render(provider(snap(known('A', '30', 'CNY'), known('B', '20', 'USD'))));
    // 两个 (category,currency) 组 → 两张表两个 caption，各自只含本币种
    expect((html.match(/<caption/g) ?? []).length).toBe(2);
    expect(html).toContain('Coding Plan · CNY');
    expect(html).toContain('Coding Plan · USD');
  });
});

describe('7.2 诚实呈现：徽标分层 + 未核不入最划算 + 桶2 gate', () => {
  it('plan 级 🔴 待复核 与 per-fact 🟢🟡 分层共存', async () => {
    // 价格 provenance 设未来日 → 🟢 今日；model fact 设远古日 → 🟡 N 天前；reviewStatus.pending → 🔴 待复核。
    const p = known('Rev', '30', 'CNY', {
      reviewStatus: { pending: true },
      provenance: prov({ lastCheckedDate: '2099-01-01' }),
      models: [model('x', '1', { lastCheckedDate: '2020-01-01' })],
    });
    const { html } = await render(provider(snap(p)));
    expect(html).toContain('待复核'); // plan 级
    expect(html).toContain('今日核对'); // per-fact 🟢（价格格）
    expect(html).toContain('天前核对'); // per-fact 🟡（新鲜度列最旧 fact）
  });

  it('已核≥2 + N 个未核 → 最划算标已核最低 + 「另有 N 个未核价未参与」，未核不入', async () => {
    const { html } = await render(provider(snap(known('Alpha', '30', 'CNY'), known('Beta', '40', 'CNY'), unknown('Gamma'))));
    expect(html).toContain('class="badge badge-cheap"'); // 渲染出最划算徽标
    expect(html).toContain('最划算：Alpha'); // 已核中最低
    expect(html).toContain('另有 1 个未核价未参与'); // 跨引 currency=null 组的 unknownCount
    expect(html).toContain('待核'); // Gamma 显式占位
  });

  it('已核 <2（数 plans.length）→ 不输出最划算、标「已核价不足 2」', async () => {
    const { html } = await render(provider(snap(known('Solo', '30', 'CNY'), unknown('U1'))));
    expect(html).toContain('已核价不足 2');
    expect(html).not.toContain('class="badge badge-cheap"');
    expect(html).not.toContain('最划算：'); // 不编造名次
  });

  it('桶2 gate：?category=token_plan 仍只显 coding_plan（用户无 category 手段切桶）', async () => {
    const tok = known('TokPlan', '5', 'USD', { category: 'token_plan' });
    const cod = known('CodPlan', '30', 'CNY');
    const { html } = await render(provider(snap(cod, tok)), '/model-radar?category=token_plan');
    expect(html).toContain('scope="row">CodPlan'); // 名格；名后可能跟 availability 标签
    expect(html).not.toContain('scope="row">TokPlan'); // token_plan 数据在库但本期 UI 不暴露
  });
});

describe('5d-C 桶2 真价策展：≥2 真月价转出 cheapest 赢家 + 1 价仍数据不足（task 2.2，合成 fixture）', () => {
  // 组 A 已策展的 6 个 (coding_plan, CNY) 真月价（讯飞无忧 ¥19 为同档最低）。合成 fixture 镜像真价、不触 DB。
  const curatedCny = (): ReturnType<typeof known>[] => [
    known('讯飞星火 Coding Plan 无忧', '19', 'CNY'),
    known('千帆 Coding Plan Lite', '40', 'CNY'),
    known('火山方舟 Coding Plan Lite', '40', 'CNY'),
    known('GLM Coding Plan Lite', '49', 'CNY'),
    known('GLM Coding Plan Pro', '149', 'CNY'),
    known('百炼 Coding Plan Pro', '200', 'CNY'),
  ];

  it('6 个真月价 + 腾讯停售未核 → 最划算转出讯飞无忧 ¥19、腾讯未核不入', async () => {
    const tencent = unknown('腾讯混元 Coding Plan', { reviewStatus: { pending: true } }); // 停售占位（NULL 价 + 停售待复核）
    const { html } = await render(provider(snap(...curatedCny(), tencent)));
    expect(html).toContain('class="badge badge-cheap"'); // 渲出最划算徽标
    expect(html).toContain('最划算：讯飞星火 Coding Plan'); // ¥19 同档最低赢家
    expect(html).toContain('另有 1 个未核价未参与'); // 腾讯停售未核不参与
    expect(html).toContain('待核'); // 腾讯显式占位
    expect(html).toContain('待复核'); // 腾讯停售 → plan 级待复核徽标（已停售≠普通待核，render 层验证）
  });

  it('对照：仅 1 个真月价（讯飞 ¥19）→ 仍 render「已核价不足 2」、不评最划算（证 compare-web ≥2 闸生效）', async () => {
    const { html } = await render(provider(snap(known('讯飞星火 Coding Plan 无忧', '19', 'CNY'))));
    expect(html).toContain('已核价不足 2');
    expect(html).not.toContain('class="badge badge-cheap"');
    expect(html).not.toContain('最划算：'); // 不编造名次
  });
});

describe('7.3 XSS：危险 scheme source_url 降级纯文本 + CSP 头', () => {
  it('javascript:/data: source_url → 无可点 <a href>、以纯文本出现、无原始 <script>', async () => {
    const p = known('Xss', '30', 'CNY', {
      provenance: prov({ sourceUrl: 'javascript:alert(1)' }),
      models: [model('glm', '5.2', { sourceUrl: 'data:text/html,<script>alert(1)</script>' })],
    });
    const { res, html } = await render(provider(snap(p)));

    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
    expect(html).toContain('javascript:alert(1)'); // 纯文本呈现（已转义、不可点）
    expect(html).not.toContain('<script>alert(1)'); // hono/jsx 默认转义，无原始脚本注入
    expect(res.headers.get('content-security-policy')).toBe(CSP);
  });
});

describe('7.4 不挂 version-304：每请求 live 重渲、无 ETag', () => {
  it('HTML 响应无 ETag、状态 200（不会 304-with-stale 出陈旧 age）', async () => {
    const { res } = await render(provider(snap(known('A', '30', 'CNY'))));
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeNull();
  });
});

describe('7.5 只读不变量：合成快照唯一数据源、不写库、冷启动失败 503', () => {
  it('每请求都经注入 getSnapshot 重渲（无 304 短路）、无副作用', async () => {
    let calls = 0;
    const getSnapshot = async () => {
      calls += 1;
      return { snapshot: snap(known('A', '30', 'CNY')), version: 'v1' };
    };
    const app = createModelRadarWebApp(getSnapshot);
    const r1 = await app.request('/model-radar');
    const r2 = await app.request('/model-radar');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(calls).toBe(2); // 渲染路径只读注入快照（不碰 DB writer）；每请求各取一次、不挂版本缓存
  });

  it('冷启动首建失败（getSnapshot 抛错）→ 503，不渲坏快照', async () => {
    // 本例**有意**走 fail-closed 的 console.error 日志路径；本地 stub 掉以免污染 CI stderr（不弱化断言）。
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = createModelRadarWebApp(async () => {
        throw new Error('snapshot build failed (DB down)');
      });
      const res = await app.request('/model-radar');
      expect(res.status).toBe(503);
      expect(errSpy).toHaveBeenCalled(); // 确证确实走了 fail-closed 日志路径
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('7.6 估算旋钮（页面侧）：区间随假设重算、标 ⚠ 估算、不入 strict schema', () => {
  const tokenPlan = known('Est', '30', 'CNY', { limits: [limit('monthly_tokens', '300000', 'monthly')] });

  it('tokensPerRound 改变 → 区间文案变 + 文字「估算」+ ⚠', async () => {
    const { html: h5k } = await render(provider(snap(tokenPlan)), '/model-radar?tokensPerRound=5000');
    const { html: h40k } = await render(provider(snap(tokenPlan)), '/model-radar?tokensPerRound=40000');
    expect(h5k).toContain('约 40–120 轮');
    expect(h40k).toContain('约 5–15 轮');
    expect(h5k).toContain('估算'); // 文字承载（非仅 emoji）
    expect(h5k).toContain('⚠');
  });

  it('limit.value=null → 优雅降级：不输出估算徽标、不 NPE（仍 200）', async () => {
    const nullLimit = known('NullLim', '30', 'CNY', { limits: [limit('monthly_tokens', null, 'monthly')] });
    const { res, html } = await render(provider(snap(nullLimit)));
    expect(res.status).toBe(200);
    expect(html).toContain('不限 / 待定'); // 限额占位
    expect(html).not.toContain('badge badge-estimate'); // 无估算区间
  });

  it('tokensPerRound 是 web-only param、不在 .strict() 查询 schema（不进哈希/不喂 query）', () => {
    // 从**有效**查询（仅 category 即可过）出发，再加 tokensPerRound → .strict() 必拒：
    // 证明确是 tokensPerRound 被排除，而非因缺 category 顺带失败（避免「断言因错误原因通过」）。
    expect(modelRadarQueryParamsSchema.safeParse({ category: 'coding_plan' }).success).toBe(true);
    expect(
      modelRadarQueryParamsSchema.safeParse({ category: 'coding_plan', tokensPerRound: '5000' }).success,
    ).toBe(false);
  });
});

describe('7.7 a11y：原生语义 + 文字徽标 + 地标/lang/aria-sort', () => {
  it('渲染 HTML 含原生表语义、details、lang、aria-sort、文字徽标、地标、skip-link', async () => {
    const p = known('Alpha', '30', 'CNY', {
      reviewStatus: { pending: true },
      models: [model('glm', '5.2')],
      clients: [client('tool', 'claude-code')],
      limits: [limit('monthly_tokens', '300000', 'monthly')],
    });
    const { html } = await render(provider(snap(p)));

    // 原生表语义（禁 div-grid）
    expect(html).toContain('<table');
    expect(html).toContain('<caption');
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    // 无 JS 行展开
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    // 外壳：lang / 地标 / skip-link
    expect(html).toContain('lang="zh-Hans"');
    expect(html).toContain('<main');
    expect(html).toContain('<nav');
    expect(html).toContain('<header');
    expect(html).toContain('跳到主内容'); // skip-link
    // 排序列可访问性
    expect(html).toContain('aria-sort');
    expect(html).toContain('按价格升序排序'); // 方向性可访问名
    // 徽标文字标签（非仅色/emoji）+ emoji aria-hidden 装饰
    expect(html).toContain('待复核');
    expect(html).toContain('aria-hidden="true"');
    // 链接描述性可访问名（2.4.4，非裸 URL）
    expect(html).toContain('查看来源');
  });
});
