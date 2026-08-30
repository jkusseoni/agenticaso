/** Shared AgenticASO visual tokens for the intelligence dashboard. */
export const C = {
  paper: "#F5F6FB",
  ink: "#15152B",
  muted: "#5B5B78",
  violet: "#5A47F5",
  violetDeep: "#3A2AC0",
  teal: "#12B886",
  coral: "#FF6A5A",
  amber: "#F5A623",
  card: "#FFFFFF",
  border: "#E7E8F3",
  dark: "#111024",
};

export const DISPLAY = "'Bricolage Grotesque', system-ui, sans-serif";
export const BODY = "'Inter', system-ui, sans-serif";

export const PROVIDER_LABELS = {
  openai: "ChatGPT",
  perplexity: "Perplexity",
  gemini: "Gemini",
};

export function scoreColor(s) {
  if (s == null || Number.isNaN(Number(s))) return C.muted;
  const n = Number(s);
  if (n >= 70) return C.teal;
  if (n >= 45) return C.amber;
  return C.coral;
}

export function formatDelta(delta) {
  if (delta == null || Number.isNaN(Number(delta))) return null;
  const n = Number(delta);
  const sign = n > 0 ? "+" : "";
  return `${sign}${Math.round(n * 10) / 10}`;
}

export function formatDate(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}
