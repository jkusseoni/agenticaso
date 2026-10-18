/**
 * Public website targets for server-side fetches.
 * Only http/https on default ports, no credentials, no IP literals, and no
 * hostnames that resolve to private, loopback, link-local, or reserved space.
 */
import dns from "node:dns";
import net from "node:net";

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet", ".corp"];
const HOSTNAME_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  blocked.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  // Unspecified, loopback, and deprecated IPv4-compatible (::a.b.c.d).
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
]) {
  blocked.addSubnet(address, prefix, "ipv6");
}

/**
 * True for any address a server-side fetch must not connect to.
 * Unparseable input is treated as blocked.
 * @param {unknown} address
 */
export function isBlockedAddress(address) {
  if (typeof address !== "string") return true;
  const ip = address.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const family = net.isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family !== 6) return true;
  const mapped = ip.match(/^::ffff:(?:0:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isBlockedAddress(mapped[1]);
  const mappedHex = ip.match(/^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (ip.startsWith("::ffff:")) return true;
  return blocked.check(ip, "ipv6");
}

/**
 * Validate a URL that came from a user or from a redirect.
 * @param {unknown} raw
 * @param {{ base?: string|URL }} [opts]
 * @returns {URL|null}
 */
export function parsePublicHttpUrl(raw, { base } = {}) {
  if (raw instanceof URL) raw = raw.href;
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (!text || text.length > 2048) return null;
  if (!base && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;

  let url;
  try {
    url = base ? new URL(text, base) : new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) return null;

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || net.isIP(host.replace(/^\[|\]$/g, ""))) return null;
  if (host === "localhost" || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return null;
  if (!HOSTNAME_RE.test(host)) return null;
  url.hostname = host;
  url.hash = "";
  return url;
}

/**
 * Normalize the homepage / API input into a public target.
 * @param {unknown} raw
 * @returns {{ url: URL, domain: string } | null}
 */
export function normalizeVisibilityTarget(raw) {
  const url = parsePublicHttpUrl(raw);
  if (!url) return null;
  return { url, domain: url.hostname.replace(/^www\./, "") };
}

/**
 * dns.lookup replacement for http(s).request that refuses blocked addresses.
 * Runs at connect time, so a hostname cannot pass validation and then
 * resolve to an internal address for the actual connection.
 * @param {typeof dns.lookup} [resolver]
 */
export function createSafeLookup(resolver = dns.lookup) {
  return function safeLookup(hostname, options, callback) {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "object" && options ? options : {};
    resolver(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return cb(err);
      const list = Array.isArray(addresses) ? addresses : [];
      if (!list.length || list.some((entry) => isBlockedAddress(entry?.address))) {
        const error = new Error("Target resolves to a non-public address.");
        /** @type {any} */ (error).code = "BLOCKED_ADDRESS";
        return cb(error);
      }
      if (opts.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}
