import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 2_000_000;

function isPrivateIpv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }

  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(ip) {
  const value = ip.toLowerCase().split("%")[0];

  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb") ||
    value.startsWith("ff") ||
    value.startsWith("2001:db8:")
  );
}

export function isPublicIp(address) {
  const family = net.isIP(address);

  if (family === 4) return !isPrivateIpv4(address);
  if (family === 6) return !isPrivateIpv6(address);

  return false;
}

function validateHttpUrl(raw) {
  let url;

  try {
    url = raw instanceof URL ? new URL(raw.href) : new URL(String(raw));
  } catch {
    throw new Error("Invalid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed.");
  }

  if (url.username || url.password) {
    throw new Error("Credentials in URLs are not allowed.");
  }

  return url;
}

async function resolvePublicAddress(hostname, lookupFn = dns.lookup) {
  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) {
      throw new Error("Private or reserved network addresses are not allowed.");
    }
    return {
      address: hostname,
      family: net.isIP(hostname),
    };
  }

  const records = await lookupFn(hostname, {
    all: true,
    verbatim: true,
  });

  if (!records.length) {
    throw new Error("Hostname did not resolve.");
  }

  for (const record of records) {
    if (!isPublicIp(record.address)) {
      throw new Error("Hostname resolves to a private or reserved network address.");
    }
  }

  return records[0];
}

function requestOnce(url, addressRecord, { timeoutMs, headers }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        servername: url.protocol === "https:" ? url.hostname : undefined,
        lookup(_hostname, _options, callback) {
          callback(null, addressRecord.address, addressRecord.family);
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        let stopped = false;

        res.on("data", (chunk) => {
          if (stopped) return;

          size += chunk.length;

          if (size > MAX_BODY_BYTES) {
            stopped = true;
            req.destroy(new Error("Response body too large."));
            return;
          }

          chunks.push(chunk);
        });

        res.on("end", () => {
          if (stopped) return;

          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Request timed out."));
    });

    req.on("error", reject);
    req.end();
  });
}

function headersObject(headers) {
  return {
    get(name) {
      const value = headers?.[String(name).toLowerCase()];
      if (Array.isArray(value)) return value.join(", ");
      return value == null ? null : String(value);
    },
  };
}

export async function safeFetchText(
  rawUrl,
  {
    timeoutMs = 7000,
    headers = {},
    maxRedirects = MAX_REDIRECTS,
    lookupFn = dns.lookup,
    requestFn = requestOnce,
  } = {}
) {
  let current = validateHttpUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const address = await resolvePublicAddress(current.hostname, lookupFn);

    const response = await requestFn(current, address, {
      timeoutMs,
      headers,
    });

    const status = response.status;
    const location = response.headers?.location;

    if (status >= 300 && status < 400 && location) {
      if (redirectCount >= maxRedirects) {
        throw new Error("Too many redirects.");
      }

      current = validateHttpUrl(new URL(location, current));
      continue;
    }

    return {
      ok: status >= 200 && status < 300,
      status,
      text: response.text,
      headers: headersObject(response.headers),
      finalUrl: current.href,
    };
  }

  throw new Error("Too many redirects.");
}

