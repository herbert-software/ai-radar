/**
 * MCP 工具注册聚合（design D1，task 2.4）。
 *
 * import 全部 8 个 tool 描述符，导出 `allTools` 数组供 server.ts 统一 `registerTool`。
 *
 * **N2 / D8 关键**：本聚合及其 import 的全部 tool 文件、共享 lib、自建 db/env **均不 static import**
 * dispatcher/push-date/top-n(value)/telegram/feishu 等触达全局 env 的模块——push_event_now 的推送链
 * 在其 handler 内**动态 import**（见 push-event-now.ts）。故 import 本聚合（server.ts 启动）只需
 * DATABASE_URL、不触发全局 parseEnv。
 *
 * 工具分组（design D3/D4）：
 * - 查询（声明 outputSchema、readOnlyHint:true）：get_today / search_events / search_products /
 *   source_quality / recommend_coding_subscription（后者 handler 内动态 import env-clean build.ts 现 build 快照）。
 * - 干预（不声明 outputSchema、isError 错误约定）：mark_event / mark_product / push_event_now ——
 *   handler 由组 C 填。
 */
import { getTodayTool } from './get-today.js';
import { searchEventsTool } from './search-events.js';
import { searchProductsTool } from './search-products.js';
import { sourceQualityTool } from './source-quality.js';
import { markEventTool } from './mark-event.js';
import { markProductTool } from './mark-product.js';
import { pushEventNowTool } from './push-event-now.js';
import { recommendCodingTool } from './recommend-coding.js';
import type { McpToolDescriptor } from './types.js';

/** 全部 8 个工具描述符（server.ts 遍历 registerTool）。 */
export const allTools: readonly McpToolDescriptor[] = [
  getTodayTool,
  searchEventsTool,
  searchProductsTool,
  sourceQualityTool,
  markEventTool,
  markProductTool,
  pushEventNowTool,
  recommendCodingTool,
];
