import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ROOT_HOST_ATTEMPTS,
  ROOT_FAILURE_KIND,
  ROOT_HOST_VARIANT_ELIGIBLE,
  apexWwwVariantHref,
  classifyRootFetchFailure,
  detectPossibleBotBlockHint,
  formatRootFailureMessage,
  isEligibleForRootHostVariant,
} from "../root-reachability.js";
import { classifyResearchCollectionFailure, GROWTH_ERROR_CODES } from "../persist-run.js";

describe("root fetch failure taxonomy", () => {
  it("classifies HTTP statuses without treating 403 as proven bot blocking", () => {
    const forbidden = classifyRootFetchFailure({ status: 403, error: "HTTP 403", body: "<html>ok</html>" });
    assert.equal(forbidden.kind, ROOT_FAILURE_KIND.HTTP_FORBIDDEN);
    assert.equal(forbidden.possibleBotBlock, false);
    assert.equal(forbidden.eligibleForHostVariant, true);

    assert.equal(classifyRootFetchFailure({ status: 401 }).kind, ROOT_FAILURE_KIND.HTTP_UNAUTHORIZED);
    assert.equal(classifyRootFetchFailure({ status: 429 }).kind, ROOT_FAILURE_KIND.HTTP_RATE_LIMITED);
    assert.equal(classifyRootFetchFailure({ status: 404 }).kind, ROOT_FAILURE_KIND.HTTP_NOT_FOUND);
    assert.equal(classifyRootFetchFailure({ status: 503 }).kind, ROOT_FAILURE_KIND.HTTP_SERVER_ERROR);
    assert.equal(classifyRootFetchFailure({ status: 418 }).kind, ROOT_FAILURE_KIND.OTHER_HTTP_ERROR);
  });

  it("classifies network, SSRF, redirect, and size errors", () => {
    assert.equal(classifyRootFetchFailure({ error: "Request timed out." }).kind, ROOT_FAILURE_KIND.NETWORK_TIMEOUT);
    assert.equal(classifyRootFetchFailure({ error: "getaddrinfo ENOTFOUND" }).kind, ROOT_FAILURE_KIND.NETWORK_ERROR);
    assert.equal(
      classifyRootFetchFailure({ error: "Private or reserved network addresses are not allowed." }).kind,
      ROOT_FAILURE_KIND.SSRF_REJECTED
    );
    assert.equal(classifyRootFetchFailure({ error: "Too many redirects." }).kind, ROOT_FAILURE_KIND.REDIRECT_REJECTED);
    assert.equal(classifyRootFetchFailure({ error: "Response body too large." }).kind, ROOT_FAILURE_KIND.CONTENT_TOO_LARGE);
  });

  it("keeps possible_bot_block as a hint when challenge markers exist", () => {
    const hinted = classifyRootFetchFailure({
      status: 403,
      headers: { server: "cloudflare", "cf-mitigated": "challenge" },
      body: "Just a moment... Checking your browser",
    });
    assert.equal(hinted.possibleBotBlock, true);
    assert.equal(detectPossibleBotBlockHint(ROOT_FAILURE_KIND.HTTP_FORBIDDEN, 403, { server: "cloudflare" }, ""), true);
    const emptyGet = classifyRootFetchFailure({ status: 403, headers: { get: () => null }, body: "Forbidden" });
    assert.equal(emptyGet.possibleBotBlock, false);
  });

  it("maps collection failures to Growth error codes without HTML bodies", () => {
    const mapped = classifyResearchCollectionFailure({
      error: "Root fetch returned HTTP 403. rootAttempts=2 variantAttempted=true",
      failure: { kind: "HTTP_FORBIDDEN", httpStatus: 403, possibleBotBlock: true },
    });
    assert.equal(mapped.code, GROWTH_ERROR_CODES.RESEARCH_ROOT_FORBIDDEN);
    assert.equal(/<!DOCTYPE|<html/i.test(mapped.code), false);
    assert.equal(
      classifyResearchCollectionFailure({ failure: { kind: "SSRF_REJECTED" } }).code,
      GROWTH_ERROR_CODES.RESEARCH_URL_REJECTED
    );
  });

  it("formats persisted messages without response bodies", () => {
    const msg = formatRootFailureMessage(
      { kind: ROOT_FAILURE_KIND.HTTP_FORBIDDEN, httpStatus: 403, possibleBotBlock: true },
      { rootAttempts: 2, variantAttempted: true }
    );
    assert.equal(msg.includes("HTTP 403"), true);
    assert.equal(msg.includes("rootAttempts=2"), true);
    assert.equal(/just a moment|cloudflare|<html/i.test(msg), false);
  });

  it("only toggles apex and www on the same registrable HTTPS host", () => {
    assert.equal(apexWwwVariantHref("https://shop.example/", "shop.example"), "https://www.shop.example/");
    assert.equal(apexWwwVariantHref("https://www.shop.example/", "shop.example"), "https://shop.example/");
    assert.equal(apexWwwVariantHref("https://shop.example.com/path", "shop.example.com"), "https://www.shop.example.com/path");
    assert.equal(apexWwwVariantHref("http://shop.example/", "shop.example"), null);
    assert.equal(apexWwwVariantHref("https://store.shop.example/", "shop.example"), null);
    assert.equal(apexWwwVariantHref("https://www2.shop.example/", "shop.example"), null);
    assert.equal(MAX_ROOT_HOST_ATTEMPTS, 2);
    assert.equal(isEligibleForRootHostVariant({ eligibleForHostVariant: true }), true);
    assert.equal(ROOT_HOST_VARIANT_ELIGIBLE.includes(ROOT_FAILURE_KIND.SSRF_REJECTED), false);
    assert.equal(ROOT_HOST_VARIANT_ELIGIBLE.includes(ROOT_FAILURE_KIND.HTTP_SERVER_ERROR), false);
  });
});
