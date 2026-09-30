/**
 * Internal growth dashboard helpers. No database and no Clerk session.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { isGrowthAdminClerkId, parseGrowthAdminClerkIds } from "../admin.js";
import {
  GROWTH_TRACKING_NOTE,
  buildGrowthDashboardView,
  formatCheckoutToPaidRate,
  formatMinorRevenue,
  formatRevenueLines,
  growthWindowFromSearchParams,
  parseGrowthRangeDays,
} from "../dashboard.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("GROWTH_ADMIN_CLERK_IDS", () => {
  it("trims entries and drops empties", () => {
    assert.deepEqual(parseGrowthAdminClerkIds(" user_a , , user_b "), ["user_a", "user_b"]);
    assert.deepEqual(parseGrowthAdminClerkIds(""), []);
    assert.deepEqual(parseGrowthAdminClerkIds(null), []);
    assert.deepEqual(parseGrowthAdminClerkIds(" , "), []);
  });

  it("accepts only an exact allowlisted id", () => {
    const raw = "user_10, user_11";
    assert.equal(isGrowthAdminClerkId("user_10", raw), true);
    assert.equal(isGrowthAdminClerkId("user_11", raw), true);
    assert.equal(isGrowthAdminClerkId("user_1", raw), false);
    assert.equal(isGrowthAdminClerkId("user_100", raw), false);
    assert.equal(isGrowthAdminClerkId(" user_10", raw), false);
    assert.equal(isGrowthAdminClerkId("", raw), false);
    assert.equal(isGrowthAdminClerkId(null, raw), false);
    assert.equal(isGrowthAdminClerkId("user_10", ""), false);
  });
});

describe("growth date range", () => {
  it("allows 7, 30, and 90 days and defaults everything else to 30", () => {
    const now = new Date("2027-06-30T00:00:00.000Z");
    for (const days of [7, 30, 90]) {
      assert.equal(parseGrowthRangeDays(String(days)), days);
      const window = growthWindowFromSearchParams({ days: String(days) }, now);
      assert.equal(window.days, days);
      assert.equal(window.to.toISOString(), now.toISOString());
      assert.equal(window.from.toISOString(), new Date(now.getTime() - days * 86400000).toISOString());
    }
    for (const value of [undefined, null, "", "14", "0", "365", "30abc", " 30 ", ["7", "90"], ["30"]]) {
      assert.equal(parseGrowthRangeDays(value), 30);
    }
  });
});

describe("dashboard aggregates", () => {
  it("shows an em dash when no checkout workspaces exist and 0% when none convert", () => {
    assert.equal(formatCheckoutToPaidRate(1, 0), "—");
    assert.equal(formatCheckoutToPaidRate(0, 0), "—");
    assert.equal(formatCheckoutToPaidRate(0, 4), "0%");
    assert.equal(formatCheckoutToPaidRate(1, 4), "25%");
    assert.equal(formatCheckoutToPaidRate(1, 3), "33.3%");
  });

  it("formats minor units with the currency fraction digits and skips null amounts", () => {
    assert.match(formatMinorRevenue(1900, "USD"), /19\.00/);
    const yen = formatMinorRevenue(1900, "JPY");
    assert.match(yen, /1,900|1900/);
    assert.equal(yen.includes(".00"), false);
    assert.match(formatMinorRevenue(1900, "BHD"), /1\.900/);
    assert.equal(formatMinorRevenue(1900, "usd"), formatMinorRevenue(1900, "USD"));
    assert.equal(formatMinorRevenue(null, "USD"), null);
    assert.equal(formatMinorRevenue(1900, "US"), null);
    assert.deepEqual(
      formatRevenueLines([
        { currency: "USD", amountMinor: 1900 },
        { currency: "USD", amountMinor: null },
        { currency: null, amountMinor: 1900 },
      ]),
      [formatMinorRevenue(1900, "USD")]
    );
    assert.equal(formatRevenueLines([]).length, 0);
  });

  it("builds a view from counts only", () => {
    const view = buildGrowthDashboardView(
      {
        chatgptPluginCtaClicks: 3,
        proCheckoutStarts: 2,
        distinctCheckoutWorkspaces: 2,
        firstPaidCustomers: 4,
        checkoutToPaid: 1,
        revenueByCurrency: [{ currency: "USD", amountMinor: 1900 }],
      },
      30
    );
    assert.equal(view.firstPaidCustomers, 4);
    assert.equal(view.checkoutToPaid, 1);
    assert.equal(view.checkoutToPaidRateLabel, "50%");
    assert.match(view.revenueLabel, /19\.00/);
    assert.equal(view.trackingNote, GROWTH_TRACKING_NOTE);
    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes("ws_"), false);
    assert.equal(serialized.includes("user_"), false);
    assert.equal(serialized.includes("sess_"), false);
    assert.equal(serialized.includes("txn_"), false);
    assert.equal(serialized.includes("@"), false);
    assert.equal(serialized.includes("ctm_"), false);

    const empty = buildGrowthDashboardView(
      {
        chatgptPluginCtaClicks: 0,
        proCheckoutStarts: 0,
        distinctCheckoutWorkspaces: 0,
        firstPaidCustomers: 2,
        checkoutToPaid: 0,
        revenueByCurrency: [],
      },
      30
    );
    assert.equal(empty.revenueLabel, "—");
    assert.equal(empty.checkoutToPaidRateLabel, "—");
    assert.equal(empty.firstPaidCustomers, 2);
  });
});

describe("admin page wiring", () => {
  it("is a dynamic server page that checks the allowlist before loading metrics", () => {
    const page = fs.readFileSync(path.join(repoRoot, "app/admin/growth/page.js"), "utf8");
    const access = fs.readFileSync(path.join(repoRoot, "lib/growth/admin-access.js"), "utf8");
    assert.equal(page.includes("use client"), false);
    assert.match(page, /export const dynamic = "force-dynamic"/);
    assert.ok(page.indexOf("requireGrowthAdmin") < page.indexOf("getGrowthFunnelSummary"));
    assert.equal(page.includes("publicMetadata"), false);
    assert.equal(page.includes("NEXT_PUBLIC_"), false);
    assert.match(page, /GROWTH_TRACKING_NOTE/);
    assert.match(access, /import "server-only"/);
    assert.match(access, /notFound\(\)/);
    assert.match(access, /auth\(\)/);
    assert.equal(access.includes("publicMetadata"), false);

    for (const rel of ["app/page.js", "app/layout.js", "app/pricing/page.js", "app/billing/page.js"]) {
      const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
      assert.equal(text.includes("/admin/growth"), false, rel);
    }
  });
});
