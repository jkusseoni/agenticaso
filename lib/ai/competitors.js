import { normBrand } from "./brand.js";

/**
 * Try to parse a trailing / embedded JSON brands array from a model answer.
 * @param {string} answer
 * @returns {{ brands?: Array<{name?: string, position?: number, recommended?: boolean}>, citations?: string[] } | null}
 */
export function tryParseStructuredAppendix(answer) {
  const text = String(answer || "");
  const candidates = [];

  // Prefer fenced JSON
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());

  // Any JSON object that looks like our appendix (brands / competitors / citations)
  const marker = /\{[\s\S]*"(?:brands|competitors|citations)"\s*:/g;
  let m;
  while ((m = marker.exec(text))) {
    const start = m.index;
    const sliced = text.slice(start);
    const end = findMatchingBrace(sliced);
    if (end !== -1) candidates.push(sliced.slice(0, end + 1).trim());
  }

  // Last JSON object fallback
  const lastBrace = text.lastIndexOf("{");
  if (lastBrace !== -1) {
    const sliced = text.slice(lastBrace);
    const end = findMatchingBrace(sliced);
    candidates.push((end === -1 ? sliced : sliced.slice(0, end + 1)).trim());
  }

  for (const raw of candidates) {
    try {
      const cleaned = raw.replace(/,\s*([}\]])/g, "$1");
      const obj = JSON.parse(cleaned);
      if (obj && (Array.isArray(obj.brands) || Array.isArray(obj.competitors) || Array.isArray(obj.citations))) {
        return {
          brands: obj.brands || obj.competitors || [],
          citations: Array.isArray(obj.citations) ? obj.citations.map(String) : [],
        };
      }
    } catch {
      /* continue */
    }
  }
  return null;
}

/** @param {string} s */
function findMatchingBrace(s) {
  if (!s.startsWith("{")) return -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Deterministic competitor extraction from free-text AI answers.
 * Prefers structured appendix when present; otherwise list-style names.
 *
 * @param {string} answer
 * @param {string} brandName
 * @returns {{ name: string, position: number|null, mentioned: boolean }[]}
 */
export function extractCompetitors(answer, brandName) {
  const b = normBrand(brandName);
  const structured = tryParseStructuredAppendix(answer);

  if (structured?.brands?.length) {
    const out = [];
    const seen = new Set();
    for (const item of structured.brands) {
      const name = String(item?.name || "").trim().replace(/\*+$/, "");
      if (!name || normBrand(name) === b) continue;
      const key = normBrand(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({
        name,
        position: typeof item.position === "number" ? item.position : out.length + 1,
        mentioned: true,
      });
      if (out.length >= 8) break;
    }
    return out;
  }

  const names = new Map(); // norm -> { name, position }
  const re = /(?:^|\n)\s*(?:(\d+)[.)]\s*|\*\*\s*|\-\s+|\•\s+)([A-Z][A-Za-z0-9&'.\- ]{1,40})/gm;
  let m;
  while ((m = re.exec(answer)) && names.size < 8) {
    const position = m[1] ? Number(m[1]) : names.size + 1;
    const name = m[2].trim().replace(/\*+$/, "").replace(/\s{2,}/g, " ");
    if (!name || normBrand(name) === b) continue;
    // Skip generic non-brands
    if (/^(best|top|here|these|some|other|also|finally|overall|note|source)/i.test(name)) continue;
    const key = normBrand(name);
    if (!key || names.has(key)) continue;
    names.set(key, { name, position, mentioned: true });
  }

  return [...names.values()].slice(0, 5);
}

/**
 * Legacy helper used by v1 visibility — returns string names only.
 * @param {string} answer
 * @param {string} brand
 * @returns {string[]}
 */
export function extractCompetitorNames(answer, brand) {
  return extractCompetitors(answer, brand).map((c) => c.name);
}
