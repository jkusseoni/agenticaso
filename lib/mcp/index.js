/**
 * MCP V1 — API keys (Phase A) + stateless Streamable HTTP server (Phase B).
 */
export {
  MCP_ACTIVE_KEYS_FREE,
  MCP_ACTIVE_KEYS_PAID,
  MCP_DEFAULT_SCOPES,
  MCP_KEY_DISPLAY_PREFIX_LENGTH,
  MCP_KEY_LIVE_PREFIX,
  MCP_KEY_TEST_PREFIX,
  MCP_MAX_REQUEST_BYTES,
  getMcpKeyPepper,
  isMcpEnabled,
  isMcpKeyFormat,
  isMcpProtocolPath,
  maxActiveMcpKeys,
} from "./config.js";

export {
  assertActiveKeyLimit,
  countActiveApiKeys,
  createApiKey,
  generateApiKeySecret,
  hashApiKey,
  keyDisplayPrefix,
  listApiKeys,
  mcpKeysPrecheck,
  resolveActiveApiKey,
  revokeApiKey,
  toPublicApiKey,
  verifyApiKeyHash,
} from "./keys.js";

export {
  GET_ACCOUNT_STATUS_TOOL,
  SCAN_STORE_TOOL,
  LIST_AUDITS_TOOL,
  GET_AUDIT_TOOL,
  DIAGNOSE_AUDIT_TOOL,
  RUN_VISIBILITY_AUDIT_TOOL,
  MCP_V1_TOOL_NAMES,
  MCP_SERVER_INFO,
  createAgenticasoMcpServer,
  dispatchMcpProtocol,
} from "./server.js";

export { handleMcpHttp } from "./http.js";
export { buildAccountStatus, getMcpPublicSiteUrl, remainingOf } from "./account-status.js";
export { authenticateMcpApiKey } from "./context.js";
export { MCP_RPC, jsonRpcErrorBody, jsonRpcIdFromBody } from "./jsonrpc.js";
export { consumeMcpRateLimit, MCP_SCAN_STORE_PER_HOUR, MCP_SCAN_STORE_ACTION, MCP_HTTP_ACTION, MCP_HTTP_PER_HOUR, MCP_AUDIT_ACTION, MCP_AUDIT_PER_HOUR } from "./rate-limit.js";
export { buildMcpUpgradeUrl, withMcpConversion, remainingFromBillingView } from "./upgrade.js";
export { runScanStoreTool } from "./tools/scan-store.js";
export { runListAuditsTool } from "./tools/list-audits.js";
export { runGetAuditTool } from "./tools/get-audit.js";
export { runDiagnoseAuditTool } from "./tools/diagnose-audit.js";
export { runVisibilityAuditTool } from "./tools/run-visibility-audit.js";
