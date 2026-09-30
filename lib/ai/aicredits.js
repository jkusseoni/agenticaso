/**
 * Shared AICredits OpenAI-compatible chat client (server-side only).
 *
 * Existing callers use aicreditsChat() → string (unchanged).
 * Growth may pass optional response_format via aicreditsChatDetailed only.
 */

export function getAicreditsConfig() {
  const base = process.env.AICREDITS_BASE_URL;
  const key = process.env.AICREDITS_API_KEY;
  return { base, key, configured: Boolean(base && key) };
}

/**
 * Build the OpenAI-compatible request body. response_format is omitted unless set.
 */
export function buildAicreditsChatBody(model, messages, opts = {}) {
  const body = {
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.max_tokens ?? 700,
  };
  if (opts.response_format) body.response_format = opts.response_format;
  return body;
}

export class AicreditsTimeoutError extends Error {
  constructor(message = "AI request timed out") {
    super(message);
    this.name = "AicreditsTimeoutError";
    this.code = "AI_TIMEOUT";
  }
}

/**
 * Optional AbortController timeout. Unset timeoutMs leaves default fetch behavior
 * unchanged for visibility callers.
 */
export function createAicreditsTimeout(timeoutMs) {
  if (timeoutMs == null || timeoutMs === "") {
    return { signal: undefined, cleanup() {}, didTimeout: () => false };
  }
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) {
    return { signal: undefined, cleanup() {}, didTimeout: () => false };
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
    },
    didTimeout: () => timedOut,
  };
}

/**
 * @param {string} model
 * @param {Array<{role: string, content: string}>} messages
 * @param {{ temperature?: number, max_tokens?: number, response_format?: object, timeoutMs?: number }} [opts]
 * @returns {Promise<{ content: string, usage: object|null, model: string, ok: true }>}
 */
export async function aicreditsChatDetailed(model, messages, opts = {}) {
  const { base, key, configured } = getAicreditsConfig();
  if (!configured) {
    throw new Error("AICREDITS_BASE_URL / AICREDITS_API_KEY not configured");
  }

  const timeout = createAicreditsTimeout(opts.timeoutMs);
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(buildAicreditsChatBody(model, messages, opts)),
      ...(timeout.signal ? { signal: timeout.signal } : {}),
    });
  } catch (err) {
    timeout.cleanup();
    if (timeout.didTimeout() || err?.name === "AbortError") {
      throw new AicreditsTimeoutError("AI request timed out");
    }
    throw err;
  }
  timeout.cleanup();

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`${model} ${res.status}: ${sanitizeAdapterError(t).slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    content: data?.choices?.[0]?.message?.content || "",
    usage: data?.usage && typeof data.usage === "object" ? data.usage : null,
    model: data?.model || model,
    ok: true,
  };
}

/**
 * @param {string} model
 * @param {Array<{role: string, content: string}>} messages
 * @param {{ temperature?: number, max_tokens?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function aicreditsChat(model, messages, opts = {}) {
  const detailed = await aicreditsChatDetailed(model, messages, opts);
  return detailed.content;
}

function sanitizeAdapterError(text) {
  return String(text || "")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/sk-[a-zA-Z0-9]+/g, "[redacted]")
    .replace(/aso_(?:live|test)_[a-zA-Z0-9]+/g, "[redacted]");
}
