/**
 * `resolveProductUrl` 纯函数单测（add-cross-segment-dedup-and-hn-purify，design D5，task 3.3）。
 *
 * 产品官网链接回退链：canonical_domain → github_repo → product_hunt_slug，每级畸形落下一级、
 * 皆空/畸形 → null。零 env/db 依赖，直接 import 纯函数测；不依赖库/网络。
 */
import { describe, expect, it } from 'vitest';
import { resolveProductUrl } from '../product-keys.js';

describe('resolveProductUrl 链接回退链（design D5）', () => {
  describe('三级回退各命中', () => {
    it('① canonical_domain 命中 → https://<domain>（不落下一级，即使 github/slug 也有值）', () => {
      expect(resolveProductUrl('tool.example.com', 'owner/repo', 'foo')).toBe(
        'https://tool.example.com',
      );
    });

    it('① canonical_domain 带端口（host:port）命中保留', () => {
      expect(resolveProductUrl('example.com:8080', null, null)).toBe(
        'https://example.com:8080',
      );
    });

    it('② canonical_domain 空 → github_repo 命中 → https://github.com/<owner>/<name>', () => {
      expect(resolveProductUrl(null, 'themartiano/luz', null)).toBe(
        'https://github.com/themartiano/luz',
      );
    });

    it('② canonical_domain 畸形（含空白）→ 落到 github_repo', () => {
      expect(resolveProductUrl('has space.com', 'owner/repo', null)).toBe(
        'https://github.com/owner/repo',
      );
    });

    it('③ canonical_domain/github_repo 皆空 → product_hunt_slug 命中 → producthunt 链接', () => {
      expect(resolveProductUrl(null, null, 'foo')).toBe(
        'https://www.producthunt.com/posts/foo',
      );
    });

    it('③ github_repo 畸形（非两段）→ 落到 product_hunt_slug', () => {
      expect(resolveProductUrl(null, 'only-one-segment', 'bar')).toBe(
        'https://www.producthunt.com/posts/bar',
      );
    });
  });

  describe('canonical_domain 畸形降级', () => {
    it('含 scheme（://）→ 落下一级（此处无 github/slug → null，不产生 https://https://…）', () => {
      expect(resolveProductUrl('https://evil.example.com', null, null)).toBeNull();
    });

    it('含空白 → 落下一级（无其它键 → null）', () => {
      expect(resolveProductUrl('has space.com', null, null)).toBeNull();
    });

    it('含 path（非纯 host）→ 落下一级（无其它键 → null）', () => {
      expect(resolveProductUrl('example.com/path', null, null)).toBeNull();
    });

    it('空字符串域 → 落下一级', () => {
      expect(resolveProductUrl('', null, null)).toBeNull();
    });
  });

  describe('github_repo 畸形降级', () => {
    it('只有一段（无 owner/name 分隔）→ 落下一级（无 slug → null）', () => {
      expect(resolveProductUrl(null, 'owner', null)).toBeNull();
    });

    it('三段（多于 owner/name）→ 落下一级', () => {
      expect(resolveProductUrl(null, 'owner/repo/extra', null)).toBeNull();
    });

    it('owner 段为空（前导斜杠）→ 落下一级', () => {
      expect(resolveProductUrl(null, '/repo', null)).toBeNull();
    });

    it('name 段为空（尾随斜杠）→ 落下一级', () => {
      expect(resolveProductUrl(null, 'owner/', null)).toBeNull();
    });

    it('含空白 → 落下一级', () => {
      expect(resolveProductUrl(null, 'owner /repo', null)).toBeNull();
    });
  });

  describe('product_hunt_slug 畸形降级（含 / 或空白即判畸形、落 null、不 %2F 编码强拼）', () => {
    it('slug 含 / → null（不强拼 producthunt.com/posts/a/b 或 %2F 编码）', () => {
      expect(resolveProductUrl(null, null, 'a/b')).toBeNull();
    });

    it('slug 含空白 → null', () => {
      expect(resolveProductUrl(null, null, 'has space')).toBeNull();
    });

    it('slug 合法 → 直接拼（不编码）', () => {
      expect(resolveProductUrl(null, null, 'my-product-2024')).toBe(
        'https://www.producthunt.com/posts/my-product-2024',
      );
    });
  });

  describe('三键全空/全畸形 → null', () => {
    it('全 null → null', () => {
      expect(resolveProductUrl(null, null, null)).toBeNull();
    });

    it('全 undefined → null', () => {
      expect(resolveProductUrl(undefined, undefined, undefined)).toBeNull();
    });

    it('全空字符串 → null', () => {
      expect(resolveProductUrl('', '', '')).toBeNull();
    });

    it('全畸形（域含 scheme + github 单段 + slug 含 /）→ null', () => {
      expect(resolveProductUrl('http://x', 'one', 'a/b')).toBeNull();
    });
  });
});
