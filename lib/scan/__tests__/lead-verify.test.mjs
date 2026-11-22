import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rootUrl = pathToFileURL(root + path.sep).href;

function dataModule(source) {
  return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
}

const state = {
  lead: null,
  updates: [],
  scans: 0,
  sends: 0,
};
globalThis.__leadVerify = state;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL || "";
    if (!parent.includes("/app/api/lead/verify/route.js")) return nextResolve(specifier, context);
    if (specifier === "resend") {
      return dataModule(`
        export class Resend {
          constructor() {}
          emails = { send: async () => { globalThis.__leadVerify.sends += 1; return { error: null }; } };
        }
      `);
    }
    if (specifier === "@/lib/db/prisma.js") {
      return dataModule(`
        export function getPrisma() {
          return {
            reportEmailLead: {
              findUnique: async () => globalThis.__leadVerify.lead,
              updateMany: async (args) => {
                globalThis.__leadVerify.updates.push(args);
                return { count: 1 };
              },
            },
          };
        }
      `);
    }
    if (specifier === "@/lib/scan/scan.js") {
      return dataModule(`
        export async function scanStore() {
          globalThis.__leadVerify.scans += 1;
          return { total: 50, clean: "example.com" };
        }
      `);
    }
    if (specifier === "@/lib/scan/report-email.js") {
      return dataModule(`
        export function buildScanReportEmail() {
          return { subject: "Report", html: "<p>Report</p>", text: "Report" };
        }
      `);
    }
    if (specifier.startsWith("@/")) {
      return { url: new URL(specifier.slice(2), rootUrl).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

process.env.RESEND_API_KEY = "test-not-a-real-key";
const { POST } = await import("../../../app/api/lead/verify/route.js");

const TOKEN = "a".repeat(64);

function post(token) {
  const body = new URLSearchParams({ token }).toString();
  return POST(new Request("https://agenticaso.com/api/lead/verify", {
    method: "POST",
    headers: {
      origin: "https://agenticaso.com",
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(Buffer.byteLength(body)),
    },
    body,
  }));
}

function freshLead(overrides = {}) {
  return {
    id: "lead-1",
    email: "reader@example.com",
    websiteUrl: "https://example.com/",
    verificationHash: createHash("sha256").update(TOKEN).digest("hex"),
    status: "pending",
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    verifiedAt: null,
    processingStartedAt: null,
    attemptCount: 0,
    reportSentAt: null,
    ...overrides,
  };
}

test("verification sends the report for a valid pending token", async () => {
  state.lead = freshLead();
  state.updates = [];
  state.scans = 0;
  state.sends = 0;
  const response = await post(TOKEN);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /submitted for email delivery/);
  assert.equal(state.scans, 1);
  assert.equal(state.sends, 1);
  assert.equal(state.updates.length, 2);
  assert.equal(state.updates[0].data.status, "processing");
  assert.equal(state.updates[1].data.status, "verified");
});

test("an expired verification token is rejected before a claim", async () => {
  state.lead = freshLead({ expiresAt: new Date(Date.now() - 1000) });
  state.updates = [];
  state.scans = 0;
  const response = await post(TOKEN);
  const html = await response.text();
  assert.match(html, /verification link has expired/);
  assert.equal(state.updates.length, 0);
  assert.equal(state.scans, 0);
});

test("an invalid token is rejected", async () => {
  state.updates = [];
  state.scans = 0;
  const response = await post("not-a-token");
  const html = await response.text();
  assert.match(html, /Invalid verification token/);
  assert.equal(state.updates.length, 0);
  assert.equal(state.scans, 0);
});

test("an already verified token is not claimed again", async () => {
  state.lead = freshLead({ status: "verified", reportSentAt: new Date() });
  state.updates = [];
  state.scans = 0;
  const response = await post(TOKEN);
  const html = await response.text();
  assert.match(html, /already been submitted/);
  assert.equal(state.updates.length, 0);
  assert.equal(state.scans, 0);
});
