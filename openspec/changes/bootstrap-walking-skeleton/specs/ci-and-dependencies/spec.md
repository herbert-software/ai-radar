## 新增需求

### 需求:CI 守正确性
系统必须提供 GitHub Actions CI 工作流，在每次 push 与 pull request 上运行 lint、TypeScript typecheck、`drizzle-kit migrate` smoke（对临时数据库执行迁移验证可落表）、以及 vitest。本期 vitest 为占位（仅保证测试框架在 CI 可运行）；具体不变量测试（幂等 / 去重 / URL 归一，对应 ROADMAP P1 起的三个 Vitest）由各自能力的提案随实现补充，不在本期 spec 固化清单。任一步骤失败时 CI 必须红灯（非静默通过）。

#### 场景:CI 在变更上全绿
- **当** 向仓库 push 或开启 pull request
- **那么** GitHub Actions 运行 lint、typecheck、migrate smoke、vitest，全部通过时为绿

#### 场景:某一步失败时 CI 红灯
- **当** typecheck 或测试失败
- **那么** CI 工作流以失败状态结束，不放行合并

### 需求:依赖自动更新
系统必须提供 Dependabot 配置，覆盖 `npm` 与 `github-actions` 两个 ecosystem，使依赖与 Actions 版本能被自动提交更新 PR。

#### 场景:Dependabot 覆盖两个 ecosystem
- **当** 检视 `.github/dependabot.yml`
- **那么** 配置中同时存在 `npm` 与 `github-actions` 两个 package ecosystem 的更新条目
