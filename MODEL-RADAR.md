# ModelRadar

AI Coding / Agent Subscription Intelligence Platform

---

## Project Vision

Create a unified platform that continuously tracks, compares, and analyzes AI coding subscriptions, coding plans, token plans, and developer memberships across Chinese and international AI vendors.

The platform should help developers answer questions such as:

- Which subscription includes GLM-5.2?
- Which plan includes Claude-compatible endpoints?
- Which plan supports Claude Code?
- Which plan supports Cursor?
- Which plan supports OpenClaw?
- Which plan is cheapest for coding?
- Which plan provides the best token-per-dollar ratio?
- Which vendors recently changed pricing?
- Which vendors recently added or removed models?

The platform is not a simple pricing page.

It is an intelligence system for AI developer subscriptions.

---

## Core User Scenarios

### Scenario 1

User wants GLM-5.2.

System should answer:

Current plans supporting GLM-5.2:

- Z.ai Coding Plan
- ...
- ...

Sort by:

- monthly cost
- token cost
- request quota
- popularity

---

### Scenario 2

User wants Claude Code compatible plans.

System should answer:

Supported:

- Z.ai
- Baidu Qianfan Coding Plan
- Alibaba Bailian Coding Plan
- Tencent TokenHub
- Xunfei Astron

Sort by:

- monthly price
- model count
- quota

---

### Scenario 3

User wants cheapest plan for heavy coding.

System should compare:

- price
- request limits
- token limits
- 5-hour window
- weekly limits
- monthly limits

Generate recommendation.

---

## Core Features

### Vendor Directory

Maintain vendor information.

Example:

- Alibaba
- Tencent
- Baidu
- Z.ai
- MiniMax
- Moonshot
- StepFun
- Xiaomi MiMo
- Xunfei
- Volcengine

---

### Plan Directory

Maintain plan information.

Example:

- Lite
- Pro
- Max
- Team
- Enterprise

---

### Model Directory

Maintain model metadata.

Example:

- GLM-5.2
- GLM-5-Turbo
- Kimi K2.7
- DeepSeek V3
- DeepSeek R1
- Qwen3
- MiniMax M1
- Spark X2
- Step-Reasoner

---

### Compatibility Matrix

Relationships:

Plan
    -> Models

Plan
    -> Tools

Plan
    -> Protocols

Example:

GLM Coding Plan

Supports:

- Claude Code
- OpenClaw
- OpenCode
- Cline

Protocols:

- OpenAI
- Anthropic

---

### Price History

Track every price change.

Store:

- old price
- new price
- timestamp

Generate charts.

---

### Model Availability History

Track:

- model added
- model removed

Example:

2026-06-13

GLM-5.2 added to GLM Coding Plan.

---

### Change Feed

Daily change log.

Example:

Today:

- GLM-5.2 added
- Lite price changed
- Pro quota increased

---

### Search

Examples:

"GLM-5.2"

"Claude Code"

"Cursor"

"DeepSeek"

"OpenAI protocol"

Return filtered plans.

---

### Compare

Compare plans side-by-side.

Columns:

- Price
- Models
- Quota
- Protocol
- Tool support

---

## Ranking Metrics

### Cheapest

Monthly price.

### Best Value

Quota / Price.

### Most Models

Model count.

### Most Compatible

Tool compatibility score.

### Developer Score

Weighted score.

---

## MVP Scope

Must have:

- vendor pages
- plan pages
- model pages
- search
- compare
- price history

Can be added later:

- user accounts
- alerts
- subscriptions
- API
- browser extension

---

## Success Criteria

User can answer:

- Which plan includes GLM-5.2?
- Which plan supports Claude Code?
- Which plan is cheapest?
- Which plan changed recently?

within 10 seconds.
