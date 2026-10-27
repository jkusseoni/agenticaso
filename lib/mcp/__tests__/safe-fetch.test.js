import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { isPublicIp, safeFetchText } from "../../scan/safe-fetch.js";

test("isPublicIp rejects private/reserved IPv4 and IPv6", () => {
  const blocked = [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::",
    "fc00::1",
    "fd00::1",
    "fe80::1",
  ];

  for (const ip of blocked) {
    assert.equal(isPublicIp(ip), false, ip);
  }

  assert.equal(isPublicIp("8.8.8.8"), true);
  assert.equal(isPublicIp("1.1.1.1"), true);
});

test("safeFetchText rejects direct private IP targets", async () => {
  await assert.rejects(
    () => safeFetchText("http://127.0.0.1/"),
    /private|reserved/i
  );

  await assert.rejects(
    () => safeFetchText("http://169.254.169.254/"),
    /private|reserved/i
  );

  await assert.rejects(
    () => safeFetchText("http://[::1]/"),
    /private|reserved/i
  );
});

test("safeFetchText rejects redirects to private addresses", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(302, {
      Location: "http://127.0.0.1/internal",
    });
    res.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();

    // The initial localhost target itself is private, so this verifies
    // that private sockets cannot be used as scan origins either.
    await assert.rejects(
      () => safeFetchText(`http://127.0.0.1:${address.port}/`),
      /private|reserved/i
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("safeFetchText rejects credentials and non-http protocols", async () => {
  await assert.rejects(
    () => safeFetchText("http://user:pass@example.com/"),
    /credentials/i
  );

  await assert.rejects(
    () => safeFetchText("file:///etc/passwd"),
    /http/i
  );
});

test("safeFetchText rejects hostnames that resolve to private IPs", async () => {
  const lookupFn = async () => [
    { address: "127.0.0.1", family: 4 },
  ];

  await assert.rejects(
    () =>
      safeFetchText("https://example.com/", {
        lookupFn,
        requestFn: async () => {
          throw new Error("requestFn should not be reached");
        },
      }),
    /private|reserved/i
  );
});

test("safeFetchText rejects redirects whose destination resolves private", async () => {
  const lookups = [];

  const lookupFn = async (hostname) => {
    lookups.push(hostname);

    if (hostname === "public.example") {
      return [{ address: "93.184.216.34", family: 4 }];
    }

    if (hostname === "internal.example") {
      return [{ address: "127.0.0.1", family: 4 }];
    }

    throw new Error(`Unexpected hostname: ${hostname}`);
  };

  let requests = 0;

  const requestFn = async (url) => {
    requests += 1;

    assert.equal(url.hostname, "public.example");

    return {
      status: 302,
      headers: {
        location: "http://internal.example/secret",
      },
      text: "",
    };
  };

  await assert.rejects(
    () =>
      safeFetchText("https://public.example/", {
        lookupFn,
        requestFn,
      }),
    /private|reserved/i
  );

  assert.equal(requests, 1);
  assert.deepEqual(lookups, ["public.example", "internal.example"]);
});

test("safeFetchText stops after max redirects", async () => {
  const lookupFn = async () => [
    { address: "93.184.216.34", family: 4 },
  ];

  let calls = 0;

  const requestFn = async () => {
    calls += 1;
    return {
      status: 302,
      headers: { location: "https://example.com/again" },
      text: "",
    };
  };

  await assert.rejects(
    () =>
      safeFetchText("https://example.com/", {
        lookupFn,
        requestFn,
        maxRedirects: 2,
      }),
    /too many redirects/i
  );

  assert.equal(calls, 3);
});

test("safeFetchText preserves successful public responses", async () => {
  const lookupFn = async () => [
    { address: "93.184.216.34", family: 4 },
  ];

  const requestFn = async (url, address) => {
    assert.equal(url.hostname, "example.com");
    assert.equal(address.address, "93.184.216.34");

    return {
      status: 200,
      headers: {
        "content-type": "text/html",
      },
      text: "<html>ok</html>",
    };
  };

  const result = await safeFetchText("https://example.com/", {
    lookupFn,
    requestFn,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.text, "<html>ok</html>");
  assert.equal(result.finalUrl, "https://example.com/");
});
