## 1. 纯函数护栏

- [x] 1.1 新建 `src/dedup/merge-guard.ts`，导出 `shouldVetoMerge(titleA: string | null, titleB: string | null): boolean`：小写化 → 正则 `/\d+(?:\.\d+)+|\d+/g` 抽数字/版本 token（小数原子串）→ `Set` → 两集不相等（对称差非空）即返回 `true`。null/空标题视为空集。约 8-10 行、无依赖、无 DB/LLM/网络。

## 2. 纯函数单测（先于注入，TDD 锚定行为）

- [x] 2.1 新建 `src/dedup/__tests__/merge-guard.test.ts`，覆盖：
  - A（必须否决=true）：o1↔o3-mini、Part 1↔Part 2/2、Update #2↔#4、Mistral 3↔3.1、Gemma↔Gemma 2、SD 3↔3.5、Antigravity↔Antigravity 2.0、Scholars 2019↔2020、**GPT-5↔GPT-5.5（小数不拆回归锚点）**
  - B（不可误否决=false）：Formal Methods↔formal methods（大小写）、跨源同新闻两措辞（均无数字）、Introducing GPT-5↔GPT-5 for developers（均 `{5}`）
  - C（边界）：两空串不抛、null 标题=否决、一侧有数字一侧无=否决、`Part 2/2`↔`Part 2`=放行（Set 去重）、`v1.2.3`↔`v1.2.4`=否决（多段版本原子串）、年份差=否决、专名差（Europe/Asia、Teen/Child）=**false 负向断言**（记录护栏边界=已知限制）

## 3. 注入编排层

- [x] 3.1 `src/dedup/semantic-merge.ts`：在候选降序循环顶部统一 `const candTitle = await loadTitle(dbh, cand.eventId)` 一次，灰区路 judge 的 `titleB` 改复用此变量（省一次 DB 往返）。
- [x] 3.2 在调 `mergeEvents` 之前（high-auto 与 llm-confirmed 两路汇合处）插 `if (shouldVetoMerge(ev.representativeTitle, candTitle)) { vetoedByGuard += 1; continue; }`——`continue` 不 `break`。
- [x] 3.3 `SemanticMergeResult` 增字段 `vetoedByGuard: number`，循环外 `let vetoedByGuard = 0`，函数尾 return 带上。

## 4. 运营注释

- [x] 4.1 `.env.example`：在 `SEMANTIC_DEDUP_LLM` 处补注释——不应低于 0.82（附原因：更低会把仅主题相近的版本/系列变体喂进 LLM 灰区致误合，见本变更审计）。

## 5. 验证

- [x] 5.1 `npx tsc --noEmit` 0 错、`npm run lint` 0 错、`npx vitest run src/dedup` 全绿（含新 merge-guard 单测与既有 semantic-merge 测试不回归）。
