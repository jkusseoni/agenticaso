import test from "node:test";
import assert from "node:assert/strict";
import { isPublicIp, safeFetchText } from "../safe-fetch.js";

test("rejects private and reserved IP destinations", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "::1", "fc00::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPublicIp(ip), false, ip);
  }
  assert.equal(isPublicIp("8.8.8.8"), true);
});

test("blocks private resolved IPs without requesting", async () => {
  let requested = false;
  await assert.rejects(safeFetchText("https://example.com/", {
    lookupFn: async () => [{ address: "169.254.169.254", family: 4 }],
    requestFn: async () => { requested = true; return { status: 200, headers: {}, text: "ok" }; },
  }), /private|reserved/i);
  assert.equal(requested, false);
});

test("blocks redirects to private hosts and nonstandard ports", async () => {
  const lookupFn = async () => [{ address: "8.8.8.8", family: 4 }];
  const requestFn = async () => ({ status: 302, headers: { location: "http://127.0.0.1/admin" }, text: "" });
  await assert.rejects(safeFetchText("https://example.com", { lookupFn, requestFn }), /private|reserved/i);
  await assert.rejects(safeFetchText("https://example.com", {
    lookupFn, requestFn: async () => ({ status: 302, headers: { location: "https://example.com:8443/internal" }, text: "" }),
  }), /standard web ports/i);
});

test("rejects credentials and non-http schemes", async () => {
  for (const url of ["file:///etc/passwd", "http://user:pass@example.com/", "http://example.com:3000/"]) {
    await assert.rejects(safeFetchText(url), /allowed|credentials|standard/i);
  }
});

test("pins request to validated public DNS answer", async () => {
  let seen;
  const result = await safeFetchText("https://example.com/", {
    lookupFn: async () => [{ address: "8.8.8.8", family: 4 }],
    requestFn: async (url, record) => { seen = { url: url.href, record }; return { status: 200, headers: {}, text: "ok" }; },
  });
  assert.equal(seen.record.address, "8.8.8.8");
  assert.equal(result.ok, true);
});

test("rejects IPv6 tunnel addresses that can embed nonpublic IPv4 targets", () => {
  for (const ip of ["2002:0a00:0001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2"]) {
    assert.equal(isPublicIp(ip), false, ip);
  }
});
