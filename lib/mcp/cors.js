/**
 * CORS for remote MCP clients (Cursor, Claude, ChatGPT). No cookies.
 */
export const MCP_CORS_ALLOW_HEADERS =
  "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id";

export function mcpCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": MCP_CORS_ALLOW_HEADERS,
    "Access-Control-Max-Age": "86400",
    "Access-Control-Allow-Credentials": "false",
  };
}

/**
 * @param {Response} response
 * @returns {Response}
 */
export function withMcpCors(response) {
  const headers = new Headers(response.headers);
  const cors = mcpCorsHeaders();
  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
