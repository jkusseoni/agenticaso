/**
 * Per-request MCP server (stateless). Tools close over the authenticated workspace.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { sanitizeErrorMessage } from "../api/safe-error.js";
import { buildAccountStatus, getMcpPublicSiteUrl } from "./account-status.js";
import { runDiagnoseAuditTool } from "./tools/diagnose-audit.js";
import { runGetAuditTool } from "./tools/get-audit.js";
import { runListAuditsTool } from "./tools/list-audits.js";
import { runScanStoreTool } from "./tools/scan-store.js";
import { runVisibilityAuditTool } from "./tools/run-visibility-audit.js";

export const MCP_SERVER_INFO = Object.freeze({
  name: "agenticaso",
  version: "0.1.0",
  instructions:
    "Use get_account_status for plan and remaining usage. scan_store checks agent-readiness of a public store URL (no AI quota). run_visibility_audit runs a billed Multi-AI visibility audit. list_audits, get_audit, and diagnose_audit read this workspace's audits only. Do not send API keys or plan/quota fields in tool arguments.",
});

export const GET_ACCOUNT_STATUS_TOOL = "get_account_status";
export const SCAN_STORE_TOOL = "scan_store";
export const LIST_AUDITS_TOOL = "list_audits";
export const GET_AUDIT_TOOL = "get_audit";
export const DIAGNOSE_AUDIT_TOOL = "diagnose_audit";
export const RUN_VISIBILITY_AUDIT_TOOL = "run_visibility_audit";

export const MCP_V1_TOOL_NAMES = Object.freeze([
  GET_ACCOUNT_STATUS_TOOL,
  SCAN_STORE_TOOL,
  LIST_AUDITS_TOOL,
  GET_AUDIT_TOOL,
  DIAGNOSE_AUDIT_TOOL,
  RUN_VISIBILITY_AUDIT_TOOL,
]);

/**
 * @param {object} context authenticated MCP workspace context
 */
export function createAgenticasoMcpServer(context) {
  const server = new McpServer(MCP_SERVER_INFO, {
    capabilities: { tools: {} },
  });

  server.registerTool(
    GET_ACCOUNT_STATUS_TOOL,
    {
      title: "Get account status",
      description:
        "Return this workspace's Agenticaso plan, paid status, remaining entitlements, dashboard URL, and upgrade URL.",
    },
    async () => {
      const payload = buildAccountStatus({
        billingView: context.billingView,
        siteUrl: context.siteUrl || getMcpPublicSiteUrl(),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
      };
    }
  );

  server.registerTool(
    SCAN_STORE_TOOL,
    {
      title: "Scan store",
      description:
        "Scan a public http(s) store URL for AI-agent readiness (crawl, schema, checkout signals). Does not use AI-test quota.",
      inputSchema: {
        url: z.string().describe("Public http(s) store URL"),
      },
    },
    async ({ url }) => runScanStoreTool(context, { url })
  );

  server.registerTool(
    LIST_AUDITS_TOOL,
    {
      title: "List audits",
      description: "List compact audit metadata for this workspace, capped by plan history limits.",
      inputSchema: {
        websiteId: z.string().optional().describe("Optional website id to filter"),
        limit: z.number().int().min(1).max(50).optional().describe("Max rows to return"),
      },
    },
    async (args) => runListAuditsTool(context, args || {})
  );

  server.registerTool(
    GET_AUDIT_TOOL,
    {
      title: "Get audit",
      description: "Return a compact owned audit (scores and intelligence). Does not include raw AI answers.",
      inputSchema: {
        auditId: z.string().describe("Audit id"),
      },
    },
    async ({ auditId }) => runGetAuditTool(context, { auditId })
  );

  server.registerTool(
    DIAGNOSE_AUDIT_TOOL,
    {
      title: "Diagnose audit",
      description:
        "Evidence-based diagnosis of an owned audit. Free plans receive a 2-issue preview; Pro receives the full set.",
      inputSchema: {
        auditId: z.string().describe("Audit id"),
      },
    },
    async ({ auditId }) => runDiagnoseAuditTool(context, { auditId })
  );

  server.registerTool(
    RUN_VISIBILITY_AUDIT_TOOL,
    {
      title: "Run visibility audit",
      description:
        "Run a Multi-AI visibility audit for a public store URL. Uses this workspace's plan and AI-test quota. Optional brand and buyer questions. Does not accept plan or paid flags from the client.",
      inputSchema: {
        url: z.string().describe("Public http(s) store URL"),
        brand: z.string().optional().describe("Optional brand name override"),
        question: z.string().optional().describe("Optional single buyer question"),
        questions: z.array(z.string()).optional().describe("Optional list of buyer questions"),
      },
    },
    async (args) => runVisibilityAuditTool(context, args || {})
  );

  return server;
}

/**
 * Dispatch one JSON-RPC message through a fresh stateless JSON transport.
 * @param {Request} request
 * @param {{ parsedBody: unknown, context: object }} opts
 */
export async function dispatchMcpProtocol(request, { parsedBody, context }) {
  const server = createAgenticasoMcpServer(context);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  transport.onerror = (err) => {
    console.error("mcp transport:", sanitizeErrorMessage(err?.message));
  };

  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody });
  } finally {
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
    try {
      await server.close();
    } catch {
      /* ignore */
    }
  }
}
