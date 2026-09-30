/**
 * Collect JSON-LD objects from observed HTML. Treats markup as data only.
 */

export function extractJsonLdNodes(html) {
  if (typeof html !== "string" || !html) return [];
  const nodes = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      walkJsonLd(JSON.parse(m[1].trim()), nodes);
    } catch {
      /* malformed JSON-LD is ignored */
    }
  }
  return nodes;
}

function walkJsonLd(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item) => walkJsonLd(item, out));
    return;
  }
  out.push(node);
  if (node["@graph"]) walkJsonLd(node["@graph"], out);
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") walkJsonLd(value, out);
  }
}
