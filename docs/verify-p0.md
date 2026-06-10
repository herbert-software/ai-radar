# P0 手动验证步骤

## 任务 5.6 — Value Judge 真实 LLM 往返（需真实 OpenRouter key）

CI 无 LLM 密钥，真实 `generateObject` 往返不进 CI（design D5）。需在带 OpenRouter key
的本地/有密钥环境手动跑一次，并把落库的 `ai_news_events` 行 dump 作为 PR artifact。

### 步骤

```bash
# 1. 起基础设施并迁移
docker compose up -d postgres redis
npm run migrate

# 2. 注入真实 OpenRouter 凭据
export LLM_BASE_URL='https://openrouter.ai/api/v1'   # 默认值，可省
export LLM_API_KEY='sk-or-...'                        # 真实 OpenRouter key
export LLM_MODEL='openai/gpt-4o-mini'                 # 或 anthropic/claude-3.5-sonnet 等
export DATABASE_URL='postgres://ai_radar:ai_radar@localhost:5432/ai_radar'
export REDIS_URL='redis://localhost:6379'

# 3. 跑完整往返：seed raw_item → generateObject+Zod → 按映射写 ai_news_events → 读回比对
npm run roundtrip
```

### 预期与证据

- 成功时 stderr 打印 `[roundtrip] OK — 往返一致`，退出码 0。
- stdout 输出一段结构化 JSON（`artifact: "value-judge-roundtrip"`），含 `agentOutput`
  与落库读回的 `persistedEvent`（各 `*_score` 列）。**把这段 JSON 作为 PR artifact 附上**，
  而非仅自由文本描述。
- 比对按数值相等（`Number()`），因 `NUMERIC(5,2)` driver 可能返回 `"82.00"` 字符串。

### 当前状态

本环境无真实 OpenRouter key，5.6 标记为 incomplete。已用真实 Postgres（compose）+ mock LLM
跑通落库往返（写入按字段映射 + 读回数值相等 + 校验失败不写库），证明除「真实 LLM 调用」外的
全链路正确；待有 key 时按上述步骤补一次真实往返并附 dump。
