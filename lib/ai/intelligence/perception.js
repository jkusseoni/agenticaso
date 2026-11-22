/**
 * Deterministic AI perception gap (Phase 2).
 * Keyword/phrase extraction only — no LLM claims.
 *
 * Theme extractor interface is isolated so a future LLM provider can plug in
 * without changing callers.
 */

/** @typedef {{ extractThemes: (text: string) => string[] }} ThemeExtractor */

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "your", "you", "are", "was",
  "were", "have", "has", "had", "not", "but", "all", "can", "our", "out", "any",
  "about", "into", "than", "then", "them", "they", "their", "what", "when", "where",
  "which", "who", "will", "would", "could", "should", "also", "just", "like", "more",
  "most", "some", "such", "only", "other", "over", "after", "before", "between",
  "because", "while", "there", "these", "those", "been", "being", "does", "did",
  "best", "top", "buy", "online", "india", "store", "brand", "brands", "product",
  "products", "shop", "shopping", "recommend", "recommended", "option", "options",
]);

const THEME_PHRASES = [
  "organic", "natural", "premium", "affordable", "cheap", "luxury", "handmade",
  "sustainable", "eco-friendly", "vegan", "gluten-free", "cruelty-free", "ayurvedic",
  "herbal", "fast delivery", "free shipping", "same day", "made in india", "local",
  "artisan", "artisanal", "custom", "personalized", "durable", "waterproof",
  "lightweight", "wireless", "bluetooth", "skin care", "skincare", "hair care",
  "haircare", "protein", "vitamin", "supplement", "fitness", "wellness", "beauty",
  "fashion", "ethnic wear", "kids", "baby", "pet", "gourmet", "spice", "tea",
  "coffee", "chocolate", "jewelry", "jewellery", "furniture", "home decor",
];

/**
 * Default deterministic extractor.
 * @type {ThemeExtractor}
 */
export const deterministicThemeExtractor = {
  extractThemes(text) {
    const lower = String(text || "").toLowerCase();
    const found = new Set();

    for (const phrase of THEME_PHRASES) {
      if (lower.includes(phrase)) found.add(phrase);
    }

    // Also pull meaningful 1–2 word tokens from capitalized brand-adjacent adjectives in copy
    const words = lower
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));

    for (const w of words) {
      if (THEME_PHRASES.includes(w)) found.add(w);
    }

    return [...found].sort();
  },
};

/**
 * @param {object} opts
 * @param {string} [opts.brandDescription]
 * @param {string} [opts.category]
 * @param {string} [opts.whatTheySell]
 * @param {string[]} [opts.buyerQuestions]
 * @param {Array<{ providers?: Array<{ answer?: string, error?: string|null }> }>} [opts.byQuestion]
 * @param {ThemeExtractor} [opts.extractor]
 */
export function computePerceptionGap({
  brandDescription = "",
  category = "",
  whatTheySell = "",
  buyerQuestions = [],
  byQuestion = [],
  extractor = deterministicThemeExtractor,
} = {}) {
  const brandText = [brandDescription, category, whatTheySell, ...(buyerQuestions || [])]
    .filter(Boolean)
    .join(" ");

  const aiText = [];
  for (const row of byQuestion || []) {
    for (const p of row.providers || []) {
      if (p && !p.error && p.answer) aiText.push(p.answer);
    }
  }

  const brandThemes = extractor.extractThemes(brandText);
  const aiThemes = extractor.extractThemes(aiText.join(" "));

  const brandSet = new Set(brandThemes);
  const aiSet = new Set(aiThemes);

  const missingThemes = brandThemes.filter((t) => !aiSet.has(t));
  const unexpectedThemes = aiThemes.filter((t) => !brandSet.has(t));

  return {
    brandThemes,
    aiThemes,
    missingThemes,
    unexpectedThemes,
    method: "deterministic_keywords",
    note: "Theme lists are keyword-based heuristics, not LLM judgments.",
  };
}
