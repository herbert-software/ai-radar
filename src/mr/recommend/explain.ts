/**
 * 模板解释层 v1（add-model-radar-recommender 组 B，task 2.6 / design D4）。
 *
 * **纯函数、固定话术、绝无 LLM/RAG**——逐条候选填事实 + `candidates[].reasons` 规则原因 + per-fact
 * `source_url`/`lastCheckedDate`/`source_confidence`（可溯源）。撞窗结论（⚠ 估算）已在 reasons 内。
 * v1 **忽略** `query`/`evidence`、同步 resolve 字符串；v2 LLM 经**同一接口**消费 `evidence`，召回/候选 schema 不变。
 *
 * 空结果（`primary=null`）的落选缘由组合说明由推荐主函数（./recommend.ts）按缘由计算后拼在 explanation 前段——
 * 那是规则/结构层职责（需 snapshot 二次 query），非本候选话术层。本层只负责逐条候选的「为什么」。
 */
import type { ExplanationInput, RankedCandidate, Verdict } from './schema.js';

const VERDICT_LABEL: Record<Verdict, string> = {
  primary: '首选',
  alternative: '备选',
  not_recommended: '不推荐',
  insufficient_data: '待核',
};

function renderCandidate(c: RankedCandidate): string {
  const cost = c.monthlyCost !== null ? `${c.monthlyCost} ${c.currency ?? ''}/月` : '价格未核';
  const staleNote = c.stale ? ' ⚠ 数据可能陈旧（last_checked 偏旧）' : '';
  const reasons = c.reasons.map((r) => r.detail).join('；');
  const prov = `依据：${c.provenance.sourceUrl}（${c.provenance.sourceConfidence}，核对于 ${c.provenance.lastCheckedDate}）`;
  return `【${VERDICT_LABEL[c.verdict]}】${c.vendorName} · ${c.name}（${cost}）${staleNote}\n  ${reasons}\n  ${prov}`;
}

/** v1 模板解释层：纯从 candidates 渲染逐条话术（忽略 query/evidence、无 LLM）。 */
export function renderTemplate(input: ExplanationInput): Promise<string> {
  return Promise.resolve(input.candidates.map(renderCandidate).join('\n'));
}
