/** Hard cap on MCP tool JSON so clients never receive raw dumps. */
export const MCP_MAX_TOOL_JSON_CHARS = 48_000;

function stripRawAnswers(value) {
  if (Array.isArray(value)) return value.map(stripRawAnswers);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "answer" || key === "rawAnswer" || key === "raw_answer") continue;
      out[key] = stripRawAnswers(child);
    }
    return out;
  }
  return value;
}

export function mcpToolJson(payload) {
  const safe = stripRawAnswers(payload);
  const text = JSON.stringify(safe);
  if (text.length > MCP_MAX_TOOL_JSON_CHARS) {
    return mcpToolError({
      error: "Response too large.",
      code: "OUTPUT_TOO_LARGE",
      truncated: true,
    });
  }
  return {
    content: [{ type: "text", text }],
  };
}

export function mcpToolError(payload) {
  const safe = stripRawAnswers(payload);
  let text = JSON.stringify(safe);
  if (text.length > MCP_MAX_TOOL_JSON_CHARS) {
    text = JSON.stringify({ error: "Response too large.", code: "OUTPUT_TOO_LARGE", truncated: true });
  }
  return {
    isError: true,
    content: [{ type: "text", text }],
  };
}
