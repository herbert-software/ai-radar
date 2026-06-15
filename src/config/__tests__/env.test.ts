/**
 * env 校验单元测试（任务 1.3）。
 *
 * 守住不变量：关键变量缺失时 `parseEnv` 启动即抛错（快速失败），
 * 禁止静默用空值/默认值继续运行。同时验证 P1 新增的数值/比率配置：
 * - 默认值在未提供时生效；
 * - 非法值（NaN / 越界）被拒绝；
 * - RSS_FEEDS 逗号分隔解析为去空白的非空数组。
 *
 * 纯函数测试，不触发 import 期的 `env` 单例校验（直接调用导出的 parseEnv）。
 */
import { beforeAll, describe, expect, it } from 'vitest';

// env.ts 在 import 期会以 process.env 评估 `env` 单例（缺关键变量即 throw）。
// 本套件只测纯函数 parseEnv，注入占位让 import 期单例校验通过后再动态取 parseEnv，
// 使套件在不完整 shell env 下也能干净运行（占位绝不影响 parseEnv 的入参——它收显式 source）。
let parseEnv: typeof import('../env.js').parseEnv;
let isFeishuEnabled: typeof import('../env.js').isFeishuEnabled;

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.LLM_API_KEY ||= 'test-key';
  process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
  process.env.LLM_BASE_URL ||= 'https://example.invalid/v1';
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
  process.env.TELEGRAM_CHAT_ID ||= 'test-chat-id';
  // 纯净 CI 无 .env 时 import env.js 的单例校验会因缺 PRODUCT_HUNT_TOKEN throw、整套件 import 期崩溃假绿（FIX-C，比照 product-hunt.test.ts）。
  process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';
  ({ parseEnv, isFeishuEnabled } = await import('../env.js'));
});

/** 一份能通过校验的最小合法 env。各用例在其上做删除/改写。 */
function validEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://ai_radar:ai_radar@localhost:5432/ai_radar',
    REDIS_URL: 'redis://localhost:6379',
    LLM_API_KEY: 'sk-test',
    LLM_MODEL: 'openai/gpt-4o-mini',
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_CHAT_ID: '123456',
    PRODUCT_HUNT_TOKEN: 'ph-dev-token',
  } as NodeJS.ProcessEnv;
}

describe('parseEnv —— 关键变量缺失快速失败', () => {
  it('完整合法 env 通过校验并填充默认值', () => {
    const env = parseEnv(validEnv());
    expect(env.PUSH_TIMEZONE).toBe('Asia/Shanghai');
    expect(env.TOP_N).toBe(8);
    expect(env.RANK_WEIGHT_IMPORTANCE).toBe(0.45);
    expect(env.RANK_WEIGHT_DEVELOPER_RELEVANCE).toBe(0.25);
    expect(env.RANK_WEIGHT_NOVELTY).toBe(0.2);
    expect(env.RANK_WEIGHT_HYPE_RISK).toBe(0.1);
    expect(env.IMPORTANCE_FLOOR).toBe(60);
    expect(env.DEGRADE_ABORT_RATIO).toBe(0.5);
    expect(env.FIRST_SEEN_WINDOW_DAYS).toBe(3);
    expect(env.RSS_FEEDS).toEqual([]);
    expect(env.GITHUB_TOKEN).toBe('');
  });

  it.each([
    'DATABASE_URL',
    'REDIS_URL',
    'LLM_API_KEY',
    'LLM_MODEL',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'PRODUCT_HUNT_TOKEN',
  ])('缺失 %s 时抛错', (key) => {
    const source = validEnv();
    delete source[key];
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('LLM_BASE_URL 缺失时用默认 OpenRouter 端点', () => {
    const env = parseEnv(validEnv());
    expect(env.LLM_BASE_URL).toBe('https://openrouter.ai/api/v1');
  });
});

describe('parseEnv —— P1 数值/比率配置校验', () => {
  it('非数字 TOP_N 被拒绝', () => {
    const source = { ...validEnv(), TOP_N: 'not-a-number' } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('DEGRADE_ABORT_RATIO 越界（>1）被拒绝', () => {
    const source = { ...validEnv(), DEGRADE_ABORT_RATIO: '1.5' } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('IMPORTANCE_FLOOR 越界（>100）被拒绝', () => {
    const source = { ...validEnv(), IMPORTANCE_FLOOR: '200' } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('TOP_N 非正数（0）被拒绝', () => {
    const source = { ...validEnv(), TOP_N: '0' } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('自定义数值生效', () => {
    const source = {
      ...validEnv(),
      TOP_N: '5',
      IMPORTANCE_FLOOR: '70',
      DEGRADE_ABORT_RATIO: '0.3',
      FIRST_SEEN_WINDOW_DAYS: '7',
      PUSH_TIMEZONE: 'UTC',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.TOP_N).toBe(5);
    expect(env.IMPORTANCE_FLOOR).toBe(70);
    expect(env.DEGRADE_ABORT_RATIO).toBe(0.3);
    expect(env.FIRST_SEEN_WINDOW_DAYS).toBe(7);
    expect(env.PUSH_TIMEZONE).toBe('UTC');
  });
});

describe('parseEnv —— PUBLISHED_AT_INFERENCE_MAX_PER_RUN 经 envSchema 校验（任务 6.1 / design D4）', () => {
  // 固化「进 zod 校验、非法即启动失败」：证明该配置走 envSchema（coerce + int + positive），
  // 非裸读 process.env（裸读会绕过校验、让非法值静默生效，违反 env 全局不变量）。

  it('未提供时取默认 20', () => {
    const env = parseEnv(validEnv());
    expect(env.PUBLISHED_AT_INFERENCE_MAX_PER_RUN).toBe(20);
  });

  it('合法值（"20"）coerce 为 number 20', () => {
    const source = {
      ...validEnv(),
      PUBLISHED_AT_INFERENCE_MAX_PER_RUN: '20',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.PUBLISHED_AT_INFERENCE_MAX_PER_RUN).toBe(20);
    expect(typeof env.PUBLISHED_AT_INFERENCE_MAX_PER_RUN).toBe('number');
  });

  it('负数（"-5"）启动即报错（positive 校验，非裸读）', () => {
    const source = {
      ...validEnv(),
      PUBLISHED_AT_INFERENCE_MAX_PER_RUN: '-5',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('NaN（"abc"）启动即报错（number coerce 校验）', () => {
    const source = {
      ...validEnv(),
      PUBLISHED_AT_INFERENCE_MAX_PER_RUN: 'abc',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('0 启动即报错（positive，0 不合法）', () => {
    const source = {
      ...validEnv(),
      PUBLISHED_AT_INFERENCE_MAX_PER_RUN: '0',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('小数（"3.5"）启动即报错（int 校验）', () => {
    const source = {
      ...validEnv(),
      PUBLISHED_AT_INFERENCE_MAX_PER_RUN: '3.5',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });
});

describe('parseEnv —— 飞书可选通道（feishu-push 5.1）', () => {
  it('两者均缺 → 飞书 disabled，纯 Telegram 部署照常启动（向后兼容）', () => {
    const env = parseEnv(validEnv()); // validEnv 不含 FEISHU_*。
    expect(env.FEISHU_WEBHOOK_URL).toBeUndefined();
    expect(env.FEISHU_SIGN_SECRET).toBeUndefined();
    expect(isFeishuEnabled(env)).toBe(false);
  });

  it('两者全配 → enabled', () => {
    const source = {
      ...validEnv(),
      FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/hook/abc',
      FEISHU_SIGN_SECRET: 'secret',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(isFeishuEnabled(env)).toBe(true);
  });

  it('仅配 webhook（缺 secret）→ 快速失败', () => {
    const source = {
      ...validEnv(),
      FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/hook/abc',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
    expect(() => parseEnv(source)).toThrow(/FEISHU_SIGN_SECRET/);
  });

  it('仅配 secret（缺 webhook）→ 快速失败', () => {
    const source = {
      ...validEnv(),
      FEISHU_SIGN_SECRET: 'secret',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
    expect(() => parseEnv(source)).toThrow(/FEISHU_WEBHOOK_URL/);
  });

  it('webhook 非法 URL → 报错', () => {
    const source = {
      ...validEnv(),
      FEISHU_WEBHOOK_URL: 'not-a-url',
      FEISHU_SIGN_SECRET: 'secret',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });
});

describe('parseEnv —— 每日 cron 默认避整点/半点（feishu-push 5.5）', () => {
  it('DAILY_DIGEST_CRON 默认分钟字段 ∉ {0, 30}', () => {
    const env = parseEnv(validEnv());
    const minuteField = env.DAILY_DIGEST_CRON.trim().split(/\s+/)[0]!;
    expect(['0', '30']).not.toContain(minuteField);
  });
});

describe('parseEnv —— RSS_FEEDS 带 vendor 的 feed 配置解析（design D2）', () => {
  it('逗号分隔的 url|vendor 解析为 {url, vendor}[]，去空白', () => {
    const source = {
      ...validEnv(),
      RSS_FEEDS:
        ' https://a.example/feed.xml|openai , https://b.example/rss|deepmind ,, ',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.RSS_FEEDS).toEqual([
      { url: 'https://a.example/feed.xml', vendor: 'openai' },
      { url: 'https://b.example/rss', vendor: 'deepmind' },
    ]);
  });

  it('空 RSS_FEEDS → 空数组', () => {
    const env = parseEnv({ ...validEnv(), RSS_FEEDS: '' } as NodeJS.ProcessEnv);
    expect(env.RSS_FEEDS).toEqual([]);
  });

  it('url|（尾随空 vendor）→ vendor 取 null，不报错、不阻塞', () => {
    const source = {
      ...validEnv(),
      RSS_FEEDS: 'https://blog.example/feed|',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.RSS_FEEDS).toEqual([
      { url: 'https://blog.example/feed', vendor: null },
    ]);
  });

  it('旧裸 URL 格式（无 |）启动即报错并提示新格式', () => {
    const source = {
      ...validEnv(),
      RSS_FEEDS: 'https://legacy.example/feed.xml',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
    expect(() => parseEnv(source)).toThrow(/url\|vendor/);
  });

  it('混入一条旧裸 URL（其余合法）整体报错', () => {
    const source = {
      ...validEnv(),
      RSS_FEEDS: 'https://a.example/feed|openai,https://legacy.example/feed',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('URL 含 | 字符（条目含多于一个 |）→ 配置错误报错', () => {
    const source = {
      ...validEnv(),
      RSS_FEEDS: 'https://a.example/feed?x=1|2|openai',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
    expect(() => parseEnv(source)).toThrow(/多于一个/);
  });
});

describe('parseEnv —— SITEMAP_SOURCES 解析（add-tier1-ai-sources / design D3，FIX-6）', () => {
  it('合法 3 段（url|pathPrefix|vendor）解析为 {sitemapUrl, pathPrefix, vendor}', () => {
    const source = {
      ...validEnv(),
      SITEMAP_SOURCES:
        ' https://www.anthropic.com/sitemap.xml|/news/|anthropic , https://lab-b.example.com/sitemap.xml|/blog/|lab_b ',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.SITEMAP_SOURCES).toEqual([
      {
        sitemapUrl: 'https://www.anthropic.com/sitemap.xml',
        pathPrefix: '/news/',
        vendor: 'anthropic',
      },
      {
        sitemapUrl: 'https://lab-b.example.com/sitemap.xml',
        pathPrefix: '/blog/',
        vendor: 'lab_b',
      },
    ]);
  });

  it('空字符串 → 空数组（该源不采）', () => {
    const env = parseEnv({ ...validEnv(), SITEMAP_SOURCES: '' } as NodeJS.ProcessEnv);
    expect(env.SITEMAP_SOURCES).toEqual([]);
  });

  it('缺省（未设置）→ 默认含 Anthropic News 一条', () => {
    const env = parseEnv(validEnv()); // validEnv 不含 SITEMAP_SOURCES。
    expect(env.SITEMAP_SOURCES).toEqual([
      {
        sitemapUrl: 'https://www.anthropic.com/sitemap.xml',
        pathPrefix: '/news/',
        vendor: 'anthropic',
      },
    ]);
  });

  it('2 段（缺 vendor、| 不足 2 个）→ 报错', () => {
    const source = {
      ...validEnv(),
      SITEMAP_SOURCES: 'https://www.anthropic.com/sitemap.xml|/news/',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('含空段（中间段为空）→ 报错', () => {
    const source = {
      ...validEnv(),
      SITEMAP_SOURCES: 'https://www.anthropic.com/sitemap.xml||anthropic',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('pathPrefix 不以 / 开头 → 报错', () => {
    const source = {
      ...validEnv(),
      SITEMAP_SOURCES: 'https://www.anthropic.com/sitemap.xml|news/|anthropic',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });
});

describe('parseEnv —— P3 语义去重 + 知识库 embedding 配置（add-semantic-dedup-and-store-hardening，任务 7.1）', () => {
  it('未提供时取默认值', () => {
    const env = parseEnv(validEnv());
    expect(env.EMBEDDING_MODEL).toBe('text-embedding-3-small');
    expect(env.EMBEDDING_TEXT_MAX_CHARS).toBe(2000);
    expect(env.EMBEDDING_BOOTSTRAP_MAX_PER_RUN).toBe(500);
    expect(env.SEMANTIC_DEDUP_HIGH).toBe(0.88);
    expect(env.SEMANTIC_DEDUP_LLM).toBe(0.82);
    expect(env.SEMANTIC_WINDOW_DAYS).toBe(14);
    expect(env.SEMANTIC_DEDUP_ENABLED).toBe('on');
  });

  it('自定义合法值生效', () => {
    const source = {
      ...validEnv(),
      EMBEDDING_MODEL: 'text-embedding-3-large',
      EMBEDDING_TEXT_MAX_CHARS: '4000',
      EMBEDDING_BOOTSTRAP_MAX_PER_RUN: '200',
      SEMANTIC_DEDUP_HIGH: '0.9',
      SEMANTIC_DEDUP_LLM: '0.8',
      SEMANTIC_WINDOW_DAYS: '7',
      SEMANTIC_DEDUP_ENABLED: 'off',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.EMBEDDING_MODEL).toBe('text-embedding-3-large');
    expect(env.EMBEDDING_TEXT_MAX_CHARS).toBe(4000);
    expect(env.EMBEDDING_BOOTSTRAP_MAX_PER_RUN).toBe(200);
    expect(env.SEMANTIC_DEDUP_HIGH).toBe(0.9);
    expect(env.SEMANTIC_DEDUP_LLM).toBe(0.8);
    expect(env.SEMANTIC_WINDOW_DAYS).toBe(7);
    expect(env.SEMANTIC_DEDUP_ENABLED).toBe('off');
  });

  it('EMBEDDING_TEXT_MAX_CHARS 非正（"0"）→ 报错', () => {
    const source = {
      ...validEnv(),
      EMBEDDING_TEXT_MAX_CHARS: '0',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('EMBEDDING_BOOTSTRAP_MAX_PER_RUN 非整（"1.5"）→ 报错', () => {
    const source = {
      ...validEnv(),
      EMBEDDING_BOOTSTRAP_MAX_PER_RUN: '1.5',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('SEMANTIC_DEDUP_HIGH 越界（>1）→ 报错', () => {
    const source = {
      ...validEnv(),
      SEMANTIC_DEDUP_HIGH: '1.2',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('SEMANTIC_WINDOW_DAYS 负数（"-1"）→ 报错', () => {
    const source = {
      ...validEnv(),
      SEMANTIC_WINDOW_DAYS: '-1',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('SEMANTIC_DEDUP_ENABLED 非枚举值（"true"）→ 报错', () => {
    const source = {
      ...validEnv(),
      SEMANTIC_DEDUP_ENABLED: 'true',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('阈值倒挂（LLM >= HIGH）→ 快速失败（superRefine 跨字段校验）', () => {
    const source = {
      ...validEnv(),
      SEMANTIC_DEDUP_HIGH: '0.8',
      SEMANTIC_DEDUP_LLM: '0.85',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
    expect(() => parseEnv(source)).toThrow(/SEMANTIC_DEDUP_LLM/);
  });

  it('阈值相等（LLM == HIGH）→ 快速失败（灰区为空）', () => {
    const source = {
      ...validEnv(),
      SEMANTIC_DEDUP_HIGH: '0.85',
      SEMANTIC_DEDUP_LLM: '0.85',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });
});

describe('parseEnv —— HF_PAPERS_MAX_PER_RUN 校验（add-tier1-ai-sources，FIX-6）', () => {
  it('合法值（"30"）coerce 为 number 30', () => {
    const source = {
      ...validEnv(),
      HF_PAPERS_MAX_PER_RUN: '30',
    } as NodeJS.ProcessEnv;
    const env = parseEnv(source);
    expect(env.HF_PAPERS_MAX_PER_RUN).toBe(30);
    expect(typeof env.HF_PAPERS_MAX_PER_RUN).toBe('number');
  });

  it('缺省 → 默认 50', () => {
    const env = parseEnv(validEnv());
    expect(env.HF_PAPERS_MAX_PER_RUN).toBe(50);
  });

  it('非正（"0"）→ 报错（positive 校验）', () => {
    const source = {
      ...validEnv(),
      HF_PAPERS_MAX_PER_RUN: '0',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('负数（"-1"）→ 报错', () => {
    const source = {
      ...validEnv(),
      HF_PAPERS_MAX_PER_RUN: '-1',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });

  it('非整（"3.5"）→ 报错（int 校验）', () => {
    const source = {
      ...validEnv(),
      HF_PAPERS_MAX_PER_RUN: '3.5',
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv(source)).toThrow(/环境配置校验失败/);
  });
});
