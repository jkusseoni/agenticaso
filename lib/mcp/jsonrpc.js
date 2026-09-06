/**
 * JSON-RPC 2.0 / MCP error helpers. Never put secrets in messages.
 */
import { sanitizeErrorMessage, SAFE_MESSAGES } from "../api/safe-error.js";
import { withMcpCors } from "./cors.js";

export const JSONRPC_VERSION = "2.0";

/** JSON-RPC / MCP error codes */
export const MCP_RPC = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  SERVER: -32000,
  UNAUTHORIZED: -32001,
});

export function jsonRpcIdFromBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (!Object.prototype.hasOwnProperty.call(body, "id")) return null;
  const id = body.id;
  if (id === null || typeof id === "string" || typeof id === "number") return id;
  return null;
}

export function jsonRpcErrorBody(id, code, message, data) {
  const error = {
    code,
    message: sanitizeErrorMessage(message, SAFE_MESSAGES.GENERIC),
  };
  if (data !== undefined) error.data = data;
  return {
    jsonrpc: JSONRPC_VERSION,
    error,
    id: id === undefined ? null : id,
  };
}

export function jsonRpcErrorResponse(httpStatus, id, code, message, data, extraHeaders = {}) {
  return withMcpCors(
    Response.json(jsonRpcErrorBody(id, code, message, data), {
      status: httpStatus,
      headers: { "Content-Type": "application/json", ...extraHeaders },
    })
  );
}
