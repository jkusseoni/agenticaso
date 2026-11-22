/**
 * Conservative brand detection — avoids aggressive fuzzy matching.
 */

/**
 * @param {string} s
 * @returns {string}
 */
export function normBrand(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.(com|in|co|shop|store|net|org|io|ai).*$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Build a small set of reasonable brand variants (exact / spaced / concatenated).
 * @param {string} brandName
 * @param {string} [websiteUrl]
 * @returns {string[]}
 */
export function brandVariants(brandName, websiteUrl = "") {
  const variants = new Set();
  const raw = String(brandName || "").trim();
  if (raw) {
    variants.add(raw.toLowerCase());
    variants.add(normBrand(raw));
    variants.add(raw.toLowerCase().replace(/[^a-z0-9]/g, ""));
    variants.add(raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
  }

  try {
    const host = new URL(
      /^https?:\/\//i.test(websiteUrl) ? websiteUrl : `https://${websiteUrl || "x.invalid"}`
    ).hostname.replace(/^www\./, "");
    if (host.includes(".")) {
      variants.add(host.toLowerCase());
      const stem = host.split(".")[0];
      if (stem && stem.length >= 3) {
        variants.add(stem.toLowerCase());
        variants.add(normBrand(stem));
      }
    }
  } catch {
    /* ignore invalid URL */
  }

  return [...variants].filter((v) => v && v.length >= 3);
}

/**
 * Determine whether the brand appears in an AI answer.
 * Matching is case-insensitive substring / word-boundary for short tokens.
 *
 * @param {string} answer
 * @param {string} brandName
 * @param {string} [websiteUrl]
 * @returns {{ mentioned: boolean, position: number|null, recommended: boolean, status: "recommended"|"ranked"|"mentioned"|"not_mentioned" }}
 */
export function detectBrand(answer, brandName, websiteUrl = "") {
  const text = String(answer || "");
  const lower = text.toLowerCase();
  const variants = brandVariants(brandName, websiteUrl);

  let mentioned = false;
  let firstIndex = -1;

  for (const v of variants) {
    const idx = lower.indexOf(v);
    if (idx === -1) continue;
    // Reject mid-word false positives for short stems (e.g. "art" in "smart")
    if (v.length < 5) {
      const before = idx === 0 ? " " : lower[idx - 1];
      const after = lower[idx + v.length] || " ";
      if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
    }
    mentioned = true;
    if (firstIndex === -1 || idx < firstIndex) firstIndex = idx;
  }

  if (!mentioned) {
    return { mentioned: false, position: null, recommended: false, status: "not_mentioned" };
  }

  // Estimate rank from list markers before the first brand hit
  const before = text.slice(0, firstIndex === -1 ? text.length : firstIndex);
  const listNums = [...before.matchAll(/(?:^|\n)\s*(\d+)[.)]\s+/g)].map((m) => Number(m[1]));
  let position = listNums.length ? listNums[listNums.length - 1] : null;

  // Also check "1. Brand" pattern on the matching line
  const lineStart = text.lastIndexOf("\n", firstIndex === -1 ? 0 : firstIndex) + 1;
  const line = text.slice(lineStart, firstIndex + 80);
  const lineNum = line.match(/^\s*(\d+)[.)]\s+/);
  if (lineNum) position = Number(lineNum[1]);

  const window = text.slice(Math.max(0, firstIndex - 80), firstIndex + 120).toLowerCase();
  const recommendRe =
    /\b(recommend|recommended|top pick|best (choice|option)|go with|choose|prefer|standout)\b/;
  const recommended = recommendRe.test(window) || position === 1;

  let status = "mentioned";
  if (recommended) status = "recommended";
  else if (position != null) status = "ranked";

  return { mentioned: true, position, recommended, status };
}

/**
 * @param {string} answer
 * @param {string} brand
 * @param {string} [domain]
 * @returns {boolean}
 */
export function mentioned(answer, brand, domain = "") {
  return detectBrand(answer, brand, domain ? `https://${domain}` : "").mentioned;
}
