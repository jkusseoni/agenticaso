import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildAicreditsChatBody, aicreditsChatDetailed, AicreditsTimeoutError, createAicreditsTimeout } from "../aicredits.js";

describe("aicredits request body", () => {
  it("omits response_format by default so visibility callers stay unchanged", () => {
    const body = buildAicreditsChatBody("openai/gpt-4o-mini", [{ role: "user", content: "hi" }], {
      temperature: 0.3,
      max_tokens: 700,
    });
    assert.equal(Object.prototype.hasOwnProperty.call(body, "response_format"), false);
  });

  it("includes response_format only when Growth supplies it", () => {
    const body = buildAicreditsChatBody("openai/gpt-4o-mini", [{ role: "user", content: "hi" }], {
      temperature: 0,
      max_tokens: 700,
      response_format: { type: "json_object" },
    });
    assert.deepEqual(body.response_format, { type: "json_object" });
  });
});

describe("aicredits optional timeout", () => {
  it("does not attach a signal when timeoutMs is unset", () => {
    const t = createAicreditsTimeout(undefined);
    assert.equal(t.signal, undefined);
  });

  it("returns a structured timeout error without leaking secrets", async () => {
    process.env.AICREDITS_BASE_URL = "https://example.invalid";
    process.env.AICREDITS_API_KEY = "sk-test-secret-key";
    const original = globalThis.fetch;
    globalThis.fetch = (_url, opts) =>
      new Promise((_, reject) => {
        opts.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    try {
      await assert.rejects(
        () => aicreditsChatDetailed("openai/gpt-4o-mini", [{ role: "user", content: "hi" }], { timeoutMs: 5 }),
        (err) => {
          assert.equal(err instanceof AicreditsTimeoutError, true);
          assert.equal(err.code, "AI_TIMEOUT");
          assert.equal(/sk-test/.test(err.message), false);
          return true;
        }
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
