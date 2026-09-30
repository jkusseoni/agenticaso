import { getPrisma } from "@/lib/db/prisma.js";
import { requireGrowthAdmin } from "@/lib/growth/admin-access.js";
import {
  GROWTH_TRACKING_NOTE,
  buildGrowthDashboardView,
  growthWindowFromSearchParams,
} from "@/lib/growth/dashboard.js";
import { getGrowthFunnelSummary } from "@/lib/growth/funnel.js";
import { C, BODY, DISPLAY } from "@/lib/dashboard/theme";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Growth",
  robots: { index: false, follow: false },
};

export default async function GrowthAdminPage({ searchParams }) {
  await requireGrowthAdmin();

  const query = await searchParams;
  const window = growthWindowFromSearchParams(query);
  let summary = null;
  let unavailable = false;
  try {
    const db = getPrisma();
    if (!db) unavailable = true;
    else summary = await getGrowthFunnelSummary(db, { from: window.from, to: window.to });
  } catch {
    unavailable = true;
  }

  const view = buildGrowthDashboardView(summary, window.days);

  return (
    <main style={{ background: C.paper, color: C.ink, fontFamily: BODY, minHeight: "100vh" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "40px 24px 64px" }}>
        <h1 style={{ fontFamily: DISPLAY, fontSize: 32, fontWeight: 800, letterSpacing: -0.6, margin: "0 0 8px" }}>
          Growth
        </h1>
        <p style={{ color: C.muted, margin: "0 0 20px", lineHeight: 1.5 }}>
          Internal totals for the last {view.days} days. First paid customers include historical and backfilled subscriptions. Attributed checkout → paid counts only a workspace whose first payment is on or after its earliest recorded Pro checkout start.
        </p>
        <nav style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          {[7, 30, 90].map((days) => (
            <a
              key={days}
              href={`/admin/growth?days=${days}`}
              aria-current={days === view.days ? "page" : undefined}
              style={{
                color: days === view.days ? C.violetDeep : C.muted,
                fontWeight: days === view.days ? 700 : 500,
                textDecoration: "none",
              }}
            >
              {days} days
            </a>
          ))}
        </nav>
        {unavailable ? (
          <p style={{ marginTop: 8 }}>Metrics could not be loaded.</p>
        ) : (
          <dl style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, margin: 0 }}>
            <Metric label="ChatGPT CTA clicks" value={view.chatgptPluginCtaClicks} />
            <Metric label="Pro checkout starts" value={view.proCheckoutStarts} />
            <Metric label="Distinct checkout workspaces" value={view.distinctCheckoutWorkspaces} />
            <Metric label="First paid customers" value={view.firstPaidCustomers} />
            <Metric label="Attributed checkout → paid" value={view.checkoutToPaid} />
            <Metric label="Checkout-to-paid conversion rate" value={view.checkoutToPaidRateLabel} />
            <Metric label="First-paid revenue" value={view.revenueLabel} wide />
          </dl>
        )}
        <p style={{ color: C.muted, fontSize: 13, lineHeight: 1.5, marginTop: 24 }}>{GROWTH_TRACKING_NOTE}</p>
      </div>
    </main>
  );
}

function Metric({ label, value, wide = false }) {
  return (
    <div
      style={{
        gridColumn: wide ? "1 / -1" : undefined,
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: "14px 16px",
      }}
    >
      <dt style={{ color: C.muted, fontSize: 13, marginBottom: 6 }}>{label}</dt>
      <dd style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{value}</dd>
    </div>
  );
}
