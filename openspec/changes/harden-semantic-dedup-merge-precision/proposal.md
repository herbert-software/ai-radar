## 为什么

P3 语义去重在生产环境**过度误合**。对 ts.mac-mini 实跑数据（2362 事件 / 8 天）审计已合并的 114 条 tombstone：全相似度区间都有误合，最高到 **0.988**。典型——把**版本/系列/序号/年份变体**当成同一事件合掉：

- OpenAI **o1** ↔ **o3-mini** System Card @0.885
- Q-Learning **Part 1** ↔ **Part 2** @0.916
- Open R1 Update **#2** ↔ **#4** @0.951
- Mistral Small **3** ↔ **3.1** @0.955 / Welcome **Gemma** ↔ **Gemma 2** @0.955
- GPT-**5.3** ↔ **5.5** Instant System Card @0.988

后果：不同的真实事件被塌缩成一条、survivor 之外的事件被 tombstone 隐藏、不再推送——对情报产品是直接的内容损失。`semantic-dedup` spec 早已登记「过合并是危险方向」并要求 provenance 可回滚，本变更补上事前防线。

根因有二，本变更只解其一：embedding auto-merge（`> SEMANTIC_DEDUP_HIGH`）对版本/系列变体天然近同形，余弦相似度区分不了。另一根因「prod `.env` 把 `SEMANTIC_DEDUP_LLM` 覆盖成 0.75（默认 0.82）使灰区过宽」是独立的运营动作（env 回 0.82），不在本变更代码范围，仅在 design 登记并补 `.env.example` 注释防再调低。

## 变更内容

- 新增纯确定性函数 `shouldVetoMerge(titleA, titleB)`：抽两侧 `representative_title` 的**数字/版本 token**（小写化 → 正则 `\d+(?:\.\d+)+|\d+` → Set，小数当原子串不拆），两 Set 不相等即**否决合并**。
- 在 `semantic-merge.ts` 候选降序循环、调 `mergeEvents` 之前注入护栏，**high-auto 与 llm-confirmed 两路都套**；否决后 `continue` 看下一候选（不 break）——避免高相似度的版本变体邻居埋掉更低相似度的真同事件候选。
- `SemanticMergeResult` 增计数字段 `vetoedByGuard`（仅计数，不默认 per-veto 日志）。
- 补 `.env.example` 注释：`SEMANTIC_DEDUP_LLM` 不应低于 0.82（附原因），防再次调低。

## 功能 (Capabilities)

### 新增功能
<!-- 无新增能力；护栏是对既有语义去重合并行为的精度约束 -->

### 修改功能
- `semantic-dedup`: 「确定性事件合并」新增**合并前确定性精度护栏**需求——程序据 `representative_title` 数字/版本 token 集不同即否决该候选合并，作用于 high-auto 与 llm-confirmed 两路；护栏只会减少合并（更保守），不新增任何 LLM 决策权。

## 非目标

- **不把去重事实/状态交给 LLM**：护栏是纯确定性程序逻辑，LLM 仍只产 `same_event` 建议、是否合并仍由程序+DB 决定；护栏不触碰唯一约束/幂等/tombstone 语义。
- **不抓专名差误合**（Europe/Asia、Schibsted/Guardian、Teen/Child）：确定性专名护栏会大面积误否决正确跨源合并（标题共享大量专名），违反「不误否决真同事件」；列为已知限制——灰区部分靠 `SEMANTIC_DEDUP_LLM` 回 0.82 收，auto 区残留记 provenance 待后续迭代。
- **不改阈值逻辑**：`SEMANTIC_DEDUP_HIGH`/`LLM` 的分流不变；env 回 0.82 是独立运营动作，不在本变更代码内。
- **不引新依赖、不加抽象层/配置项、不下沉到 `mergeEvents` 入口**（职责分离：落库原语不长标题语义判断）。

## 影响

- 代码：新增 `src/dedup/merge-guard.ts`（纯函数）；改 `src/dedup/semantic-merge.ts`（注入 + `vetoedByGuard` 计数）；改 `.env.example`（注释）。
- 测试：新增 `src/dedup/__tests__/merge-guard.test.ts`（纯函数单测，无 DB/LLM/网络）。
- 行为：语义合并更保守，残留风险全偏向**欠合并**（最多留一条重复），零新增误合方向。无迁移、无 schema 改动、无依赖变动。
