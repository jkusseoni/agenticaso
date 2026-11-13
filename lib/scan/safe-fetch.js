import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 2_000_000;

// Conservative SSRF policy: reject private, reserved,
// special-purpose and transition address ranges.

const ipv4Block = new net.BlockList();
const ipv6Block = new net.BlockList();

const blockedIpv4Cidrs = [
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
];

const blockedIpv6Cidrs = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],   // IPv4-mapped IPv6
  ["::ffff:0:0:0", 96], // IPv4-translated IPv6
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

for (const [address, prefix] of blockedIpv4Cidrs) {
  ipv4Block.addSubnet(address, prefix, "ipv4");
}

for (const [address, prefix] of blockedIpv6Cidrs) {
  ipv6Block.addSubnet(address, prefix, "ipv6");
}

export function isPublicIp(address) {
  const family = net.isIP(address);

  if (family === 4) {
    return !ipv4Block.check(address, "ipv4");
  }

  if (family === 6) {
    return !ipv6Block.check(address, "ipv6");
  }

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
  const normalizedHost =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  if (net.isIP(normalizedHost)) {
    if (!isPublicIp(normalizedHost)) {
      throw new Error("Private or reserved network addresses are not allowed.");
    }
    return {
      address: normalizedHost,
      family: net.isIP(normalizedHost),
    };
  }

  const records = await lookupFn(normalizedHost, {
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
        lookup(_hostname, options, callback) {
          const record = {
            address: addressRecord.address,
            family: addressRecord.family,
          };

          if (options?.all) {
            callback(null, [record]);
            return;
          }

          callback(null, record.address, record.family);
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

res.on("error", (error) => {
  stopped = true;
  reject(error);
});

res.on("aborted", () => {
  stopped = true;
  reject(new Error("Response aborted before completion."));
});

res.on("close", () => {
  if (!res.complete) {
    stopped = true;
    reject(new Error("Response closed before completion."));
  }
});

      }
    );



    const deadlineTimer = setTimeout(() => {
      req.destroy(new Error("Request timed out."));
    }, timeoutMs);

    deadlineTimer.unref();

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Request timed out."));
    });

    req.on("close", () => {
      clearTimeout(deadlineTimer);
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
async function withDeadline(promise, deadline) {
  const remaining = deadline - Date.now();

  if (remaining <= 0) {
    throw new Error("Request timed out.");
  }

  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Request timed out."));
        }, remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid request timeout.");
  }

  const deadline = Date.now() + timeoutMs;

  for (
    let redirectCount = 0;
    redirectCount <= maxRedirects;
    redirectCount += 1
  ) {
    // Check the remaining budget before each redirect.
    if (deadline - Date.now() <= 0) {
      throw new Error("Request timed out.");
    }

    // Reject non-standard ports before DNS/network access.
    if (current.port && !["80", "443"].includes(current.port)) {
      throw new Error("Only standard web ports are allowed.");
    }

    // DNS lookup must finish within the shared deadline.
    const address = await withDeadline(
      resolvePublicAddress(current.hostname, lookupFn),
      deadline
    );

    // Every redirect consumes the same timeout budget.
    const remaining = deadline - Date.now();

    if (remaining <= 0) {
      throw new Error("Request timed out.");
    }

    // The default requestOnce() actively destroys timed-out requests.
    const response = await requestFn(current, address, {
      timeoutMs: remaining,
      headers,
    });

    const status = response.status;
    const location = response.headers?.location;

    if (status >= 300 && status < 400 && location) {
      if (redirectCount >= maxRedirects) {
        throw new Error("Too many redirects.");
      }

      // Validate the next URL before another DNS lookup.
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
