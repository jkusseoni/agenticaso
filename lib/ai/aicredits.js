/**
 * Shared AICredits OpenAI-compatible chat client (server-side only).
 */

export function getAicreditsConfig() {
  const base = process.env.AICREDITS_BASE_URL;
  const key = process.env.AICREDITS_API_KEY;
  return { base, key, configured: Boolean(base && key) };
}

/**
 * @param {string} model
 * @param {Array<{role: string, content: string}>} messages
 * @param {{ temperature?: number, max_tokens?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function aicreditsChat(model, messages, opts = {}) {
  const { base, key, configured } = getAicreditsConfig();
  if (!configured) {
    throw new Error("AICREDITS_BASE_URL / AICREDITS_API_KEY not configured");
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.max_tokens ?? 700,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`${model} ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}
