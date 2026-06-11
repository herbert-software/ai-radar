/**
 * 中文 mojibake 检测单测（快修 A）。
 *
 * 覆盖：
 * - 真实坏样本（UTF-8 中文被当 Latin-1 解码）判为 true。
 * - 干净中文 + 英文术语不误判（false）。
 * - 正常文本偶发 ©®° 等在容差内（false）。
 */
import { describe, expect, it } from 'vitest';
import { looksLikeMojibake } from '../mojibake.js';

describe('looksLikeMojibake', () => {
  it('真实 mojibake 样本判为 true', () => {
    expect(looksLikeMojibake('æ¬ææ é¢ä¸ºNotes on DeepSeek')).toBe(true);
  });

  it('干净中文 + 英文术语不误判（false）', () => {
    expect(
      looksLikeMojibake('本文标题为Notes on DeepSeek，目前缺乏信息'),
    ).toBe(false);
  });

  it('正常文本偶发版权符在容差内（false）', () => {
    expect(looksLikeMojibake('正常摘要©2024')).toBe(false);
  });

  it('合法重音拉丁字母（café/naïve/résumé 等）不误判（false）', () => {
    // 这些字母在 U+00C0–U+00FF，不在续字节区 U+0080–U+00BF，不应触发 mojibake。
    expect(
      looksLikeMojibake('café résumé naïve über Beyoncé 的模型发布'),
    ).toBe(false);
  });

  it('空串为 false', () => {
    expect(looksLikeMojibake('')).toBe(false);
  });
});
