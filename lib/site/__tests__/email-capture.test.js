import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const page = fs.readFileSync(path.join(root, "app/page.js"), "utf8");

describe("EmailCapture copy", () => {
  it("shows the report heading and does not promise weekly tracking", () => {
    assert.match(page, /📧 Email me this report/);
    assert.match(page, /✓ Done — we'll email this report\./);
    assert.equal(page.includes("Get your full report + weekly agent-tracking"), false);
    assert.equal(page.includes("weekly agent-tracking"), false);
    assert.equal(page.includes("weekly tracking"), false);
  });
});
