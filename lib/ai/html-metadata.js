
function normalizeText(value, maxLength = 300) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function attributes(tag) {
  const result = {};

  const pattern =
    /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;

  for (const match of tag.matchAll(pattern)) {
    result[match[1].toLowerCase()] =
      match[2] ?? match[3] ?? match[4] ?? "";
  }

  return result;
}

function metaContent(html, attribute, expected) {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];

  for (const tag of tags) {
    const attrs = attributes(tag);

    if (
      String(attrs[attribute] ?? "").toLowerCase() === expected
    ) {
      return normalizeText(attrs.content);
    }
  }

  return "";
}

export function extractSiteMetadata(html) {
  const source = String(html ?? "");

  const title = normalizeText(
    source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  );

  const desc =
    metaContent(source, "name", "description") ||
    metaContent(source, "property", "og:description");

  const ogTitle = metaContent(source, "property", "og:title");

  const h1 = normalizeText(
    source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
  );

  const bodyText = normalizeText(
    source
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " "),
    1200
  );

  return { title, desc, ogTitle, h1, bodyText };
}
