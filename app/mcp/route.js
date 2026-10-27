import { handleMcpHttp } from "@/lib/mcp/http";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /mcp — stateless Streamable HTTP MCP (JSON responses, no SSE).
 * Auth: Authorization Bearer API key. Clerk cookies are ignored.
 */
export async function POST(req) {
  return handleMcpHttp(req);
}

export async function OPTIONS(req) {
  return handleMcpHttp(req);
}

export async function GET(req) {
  return handleMcpHttp(req);
}

export async function DELETE(req) {
  return handleMcpHttp(req);
}
