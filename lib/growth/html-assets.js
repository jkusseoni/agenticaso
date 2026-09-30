/**
 * DOM-context resource classification from already-observed HTML.
 * Classifies by tag/rel, not by filename substring.
 */

/**
 * @param {string} html
 * @param {string|null} [baseUrl]
 * @returns {{ scriptUrls: string[], stylesheetUrls: string[], linkUrls: string[] }}
 */
export function extractTypedAssets(html, baseUrl) {
  const scriptUrls = [];
  const stylesheetUrls = [];
  const linkUrls = [];
  if (!html) return { scriptUrls, stylesheetUrls, linkUrls };

  const scriptRe = /<script\b([^>]*)>/gi;
  let m;
  while ((m = scriptRe.exec(html))) {
    const src = attr(m[1], "src");
    const abs = absolutize(src, baseUrl);
    if (abs) scriptUrls.push(abs);
  }

  const linkRe = /<link\b([^>]*)>/gi;
  while ((m = linkRe.exec(html))) {
    const href = attr(m[1], "href");
    const abs = absolutize(href, baseUrl);
    if (!abs) continue;
    const rel = attr(m[1], "rel") || "";
    if (/\bstylesheet\b/i.test(rel)) stylesheetUrls.push(abs);
    else linkUrls.push(abs);
  }

  const aRe = /<a\b([^>]*)>/gi;
  while ((m = aRe.exec(html))) {
    const href = attr(m[1], "href");
    const abs = absolutize(href, baseUrl);
    if (abs) linkUrls.push(abs);
  }

  return { scriptUrls, stylesheetUrls, linkUrls };
}

function attr(openTag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i");
  const m = String(openTag || "").match(re);
  return m ? m[1].trim() : "";
}

function absolutize(raw, baseUrl) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (!baseUrl) return value;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}
