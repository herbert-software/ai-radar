import { describe, it, expect } from 'vitest';
import { shouldVetoMerge } from '../merge-guard.js';

describe('shouldVetoMerge', () => {
  // A. 生产审计里的误合——必须全部否决（true）。
  describe('版本/系列/序号/年份变体必须否决', () => {
    const veto: ReadonlyArray<[string, string, string]> = [
      ['OpenAI o1 System Card', 'OpenAI o3-mini System Card', 'o1↔o3-mini {1}≠{3}'],
      ['An Introduction to Q-Learning Part 1', 'An Introduction to Q-Learning Part 2/2', 'Part 1↔Part 2 {1}≠{2}'],
      ['Open R1: Update #2', 'Open R1: Update #4', 'Update #2↔#4 {1,2}≠{1,4}'],
      ['Mistral Small 3', 'Mistral Small 3.1', '整数↔小数 {3}≠{3.1}'],
      ['Welcome Gemma', 'Welcome Gemma 2', '无数字↔有数字 {}≠{2}'],
      ['Diffusers welcomes Stable Diffusion 3', 'SD 3.5 Large', '{3}≠{3.5}'],
      ['Google Antigravity', 'Google Antigravity 2.0', '{}≠{2.0}'],
      ['OpenAI Scholars 2019: Final projects', 'OpenAI Scholars 2020: Final projects', '年份 {2019}≠{2020}'],
      // 决定性回归锚点：小数若被拆成 {5} 会与 GPT-5 的 {5} 相等而漏判（@0.988 误合）。
      ['Introducing GPT-5', 'GPT-5.5 Instant System Card', '小数原子串不拆 {5}≠{5.5}'],
      ['GPT-5.3 Instant System Card', 'GPT-5.5 Instant System Card', '{5.3}≠{5.5}'],
    ];
    it.each(veto)('否决: %s ↔ %s (%s)', (a, b) => {
      expect(shouldVetoMerge(a, b)).toBe(true);
    });
  });

  // B. 真正的同一事件——必须全部放行（false）。
  describe('真同事件不可误否决', () => {
    const pass: ReadonlyArray<[string, string, string]> = [
      ['Formal Methods and the Future of Programming', 'Formal methods and the future of programming', '仅大小写差，均无数字'],
      ["Police officer accused of using AI to 'create evidence'", 'Officer used an AI tool to fabricate police evidence', '跨源改写、均无数字'],
      ['Introducing GPT-5', 'GPT-5 for developers', '同版本号 {5}={5}'],
    ];
    it.each(pass)('放行: %s ↔ %s (%s)', (a, b) => {
      expect(shouldVetoMerge(a, b)).toBe(false);
    });
  });

  // C. 边界。
  describe('边界', () => {
    it('两空串不抛、放行', () => {
      expect(shouldVetoMerge('', '')).toBe(false);
    });
    it('两侧均无数字 → 放行', () => {
      expect(shouldVetoMerge('Some news about AI', 'Other news on AI')).toBe(false);
    });
    it('null 标题视为空集：一侧 null 一侧有数字 → 否决', () => {
      expect(shouldVetoMerge(null, 'GPT-5 news')).toBe(true);
    });
    it('null + 无数字标题 → 放行', () => {
      expect(shouldVetoMerge(null, 'plain headline')).toBe(false);
    });
    it('一侧有数字一侧无 → 否决', () => {
      expect(shouldVetoMerge('Model X launches', 'Model X v2 launches')).toBe(true);
    });
    it('Set 去重：Part 2/2 与 Part 2 同集 → 放行', () => {
      expect(shouldVetoMerge('Part 2/2 done', 'Part 2 done')).toBe(false);
    });
    it('多段版本号原子串：1.2.3 ↔ 1.2.4 → 否决', () => {
      expect(shouldVetoMerge('v1.2.3 shipped', 'v1.2.4 shipped')).toBe(true);
    });
    it('同整数版本不同措辞 → 放行', () => {
      expect(shouldVetoMerge('Llama 3 release', 'Meet Llama 3')).toBe(false);
    });
    it('大小写 + 同数字 → 放行', () => {
      expect(shouldVetoMerge('Welcome GPT-5', 'welcome gpt-5')).toBe(false);
    });
  });

  // 已知限制：专名差变体本护栏不否决（负向断言，锁定边界、防误改）。
  describe('已知限制：专名差不由数字护栏处理（false）', () => {
    const proper: ReadonlyArray<[string, string]> = [
      ['Introducing data residency in Europe', 'Introducing data residency in Asia'],
      ['OpenAI partners with Schibsted', 'OpenAI and Guardian launch content partnership'],
      ['Introducing the Teen Safety Blueprint', 'Introducing the Child Safety Blueprint'],
    ];
    it.each(proper)('不否决（已知限制）: %s ↔ %s', (a, b) => {
      expect(shouldVetoMerge(a, b)).toBe(false);
    });
  });
});
