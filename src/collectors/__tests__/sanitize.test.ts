/**
 * store 层文本净化纯函数单测（add-semantic-dedup-and-store-hardening，任务 1.1）——纯函数、不触网/库。
 *
 * 覆盖边界：NUL、`&#0;`（解码后的原始 NUL）、lone surrogate、合法 emoji 代理对、
 * 保留 \t\n\r、metadata 递归净化（嵌套对象/数组里的字符串值、在 JSON.stringify 之前）。
 *
 * 不在源/fixture 写字面控制字节：测试内用 String.fromCharCode 构造（同 hf-papers/sitemap 测试范式），
 * 断言正则也用 new RegExp('\\uXXXX...') 转义形式（绝不写字面控制字节到源）。
 */
import { describe, expect, it } from 'vitest';
import { sanitizeText, sanitizeDeep } from '../sanitize.js';

const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7); // C0 控制符 U+0007。
const VT = String.fromCharCode(0x0b); // 垂直制表 U+000B（C0）。
const FF = String.fromCharCode(0x0c); // 换页 U+000C（C0）。
const UNIT_SEP = String.fromCharCode(0x1f); // U+001F（C0 区上界）。
const LONE_HIGH = String.fromCharCode(0xd800); // lone high surrogate。
const LONE_LOW = String.fromCharCode(0xdc00); // lone low surrogate。

// 检测「危险码点」：NUL/C0（保留 \t=09 \n=0a \r=0d）+ **lone** surrogate（合法 emoji 代理对不算）。
// 用 new RegExp 转义、不写字面字节（故无需 no-control-regex 豁免）。lone-surrogate 分支须与 sanitize.ts
// 同款（仅匹配孤立高/低代理项），否则会把合法 emoji 的成对代理误判为危险，断言失真。
const UNSAFE_RE = new RegExp(
  '[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]' +
    '|[\\ud800-\\udbff](?![\\udc00-\\udfff])' +
    '|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]',
);

describe('sanitizeText', () => {
  it('剔 NUL，保留正常字符', () => {
    expect(sanitizeText(`Safe${NUL}Title`)).toBe('SafeTitle');
    expect(UNSAFE_RE.test(sanitizeText(`a${NUL}b`))).toBe(false);
  });

  it('`&#0;` 解码出的原始 NUL 被剔除（净化作用于已解码字符串）', () => {
    // 上游实体解码把 `&#0;` 变成原始 NUL 字节；净化函数对该原始码点剔除。
    const decodedNul = String.fromCharCode(parseInt('0', 10)); // = NUL，模拟 &#0; 解码值。
    expect(sanitizeText(`x${decodedNul}y`)).toBe('xy');
    // 字面文本 `&#0;`（未解码）不含 NUL 码点，原样保留（非净化职责）。
    expect(sanitizeText('x&#0;y')).toBe('x&#0;y');
  });

  it('剔各 C0 控制符（BEL/VT/FF/US），保留 \\t \\n \\r', () => {
    expect(sanitizeText(`a${BEL}${VT}${FF}${UNIT_SEP}b`)).toBe('ab');
    // 保留 tab/换行/回车。
    expect(sanitizeText('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('剔 lone surrogate（孤立高/低代理项）', () => {
    expect(sanitizeText(`pre${LONE_HIGH}post`)).toBe('prepost');
    expect(sanitizeText(`pre${LONE_LOW}post`)).toBe('prepost');
    expect(UNSAFE_RE.test(sanitizeText(`x${LONE_HIGH}y${LONE_LOW}z`))).toBe(false);
  });

  it('保留合法 emoji 代理对（成对高+低代理）', () => {
    const rocket = '🚀'; // U+1F680，由合法代理对组成。
    expect(sanitizeText(`go ${rocket} now`)).toBe(`go ${rocket} now`);
    // emoji 仍完整（长度 2 个 UTF-16 码元），未被误剔。
    const grin = '😀'; // U+1F600。
    expect(sanitizeText(grin)).toBe(grin);
    expect(sanitizeText(grin).length).toBe(2);
  });

  it('混合：危险字符剔除、emoji 与正常文本保留', () => {
    const rocket = '🚀';
    // 注意 emoji 与 LONE_HIGH 之间留一个空格，避免 emoji 的低代理与紧随的孤立高代理被相邻解读。
    const out = sanitizeText(`Launch${NUL} ${rocket} ${LONE_HIGH} v2\t`);
    expect(UNSAFE_RE.test(out)).toBe(false);
    expect(out).toContain('Launch');
    expect(out).toContain(rocket);
    expect(out).toContain('\t'); // tab 保留。
  });

  it('幂等：净化两次与一次结果相同', () => {
    const s = `a${NUL}${LONE_HIGH}b🚀`;
    expect(sanitizeText(sanitizeText(s))).toBe(sanitizeText(s));
  });
});

describe('sanitizeDeep（递归净化字符串值，保结构）', () => {
  it('扁平对象的字符串值被净化', () => {
    const out = sanitizeDeep({ a: `x${NUL}y`, b: `${BEL}z`, n: 1, ok: true });
    expect(out).toEqual({ a: 'xy', b: 'z', n: 1, ok: true });
  });

  it('嵌套对象 + 数组里的字符串值递归净化、结构不变', () => {
    const out = sanitizeDeep({
      vendor: `Lab${NUL}A`,
      tags: [`a${BEL}`, `b${LONE_HIGH}`, 2],
      nested: { title: `T${NUL}`, deeper: { v: `${LONE_LOW}q` } },
    });
    expect(out).toEqual({
      vendor: 'LabA',
      tags: ['a', 'b', 2],
      nested: { title: 'T', deeper: { v: 'q' } },
    });
    // 结构保持：数组仍是数组、对象仍是对象。
    expect(Array.isArray(out.tags)).toBe(true);
    expect(typeof out.nested).toBe('object');
  });

  it('净化后 JSON.stringify 不抛（lone surrogate 会破坏序列化）', () => {
    const raw = { title: `T${LONE_HIGH}`, list: [`${LONE_LOW}x`] };
    const cleaned = sanitizeDeep(raw);
    expect(() => JSON.stringify(cleaned)).not.toThrow();
    expect(JSON.stringify(cleaned)).toBe('{"title":"T","list":["x"]}');
  });

  it('null / undefined / number / boolean 原样返回', () => {
    expect(sanitizeDeep(null)).toBeNull();
    expect(sanitizeDeep(undefined)).toBeUndefined();
    expect(sanitizeDeep(42)).toBe(42);
    expect(sanitizeDeep(false)).toBe(false);
  });

  it('保留 \\t\\n\\r 与合法 emoji 于嵌套值', () => {
    const rocket = '🚀';
    const out = sanitizeDeep({ s: `a\tb${rocket}`, arr: [`c\nd`] });
    expect(out).toEqual({ s: `a\tb${rocket}`, arr: ['c\nd'] });
  });
});
