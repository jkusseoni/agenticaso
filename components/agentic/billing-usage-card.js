"use client";

import React from "react";
import { C, DISPLAY, BODY } from "@/lib/dashboard/theme";

function fmtLimit(limit) {
  if (limit == null || limit === -1) return "∞";
  return String(limit);
}

function UsageRow({ label, used, limit }) {
  const max = limit == null || limit === -1 ? null : Number(limit);
  const u = Number(used) || 0;
  const pct = max && max > 0 ? Math.min(100, Math.round((u / max) * 100)) : 0;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
        <span style={{ color: C.muted }}>{label}</span>
        <span style={{ fontWeight: 600 }}>
          {u.toLocaleString("en-IN")} / {fmtLimit(max)}
        </span>
      </div>
      {max != null && (
        <div style={{ height: 6, borderRadius: 999, background: "#ECECF6", overflow: "hidden" }}>
          <div
            style={{
              width: `${pct}%`,
              height: "100%",
              background: pct >= 100 ? C.coral || "#E85D4C" : `linear-gradient(90deg,${C.violet},${C.violetDeep})`,
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Compact plan + usage panel for dashboard / billing.
 */
export function BillingUsageCard({ billing, upgradeHint }) {
  if (!billing) {
    return (
      <div style={card()}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, letterSpacing: 0.4 }}>PLAN</div>
        <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 22, marginTop: 4 }}>—</div>
        <div style={{ fontSize: 13, color: C.muted, marginTop: 8 }}>Loading billing…</div>
      </div>
    );
  }

  const plan = String(billing.planName || billing.plan || "Free").toUpperCase();
  const status = billing.status && billing.status !== "none" ? billing.status : null;
  const usage = billing.usage || {};

  return (
    <div style={card()}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, letterSpacing: 0.4 }}>CURRENT PLAN</div>
          <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 26, marginTop: 2 }}>{plan}</div>
          {status && (
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 4, textTransform: "capitalize" }}>
              Status: {status.replace(/_/g, " ")}
              {billing.cancelAtPeriodEnd ? " · Cancels at period end" : ""}
            </div>
          )}
        </div>
        <a href="/billing" style={{ fontSize: 13, fontWeight: 600, color: C.violetDeep, textDecoration: "underline" }}>
          Manage Subscription
        </a>
      </div>

      <div style={{ marginTop: 18 }}>
        <UsageRow label="AI tests" used={usage.aiTests?.used} limit={usage.aiTests?.limit} />
        <UsageRow label="Websites" used={usage.websites?.used} limit={usage.websites?.limit} />
        <UsageRow label="Monitoring" used={usage.monitoring?.used} limit={usage.monitoring?.limit} />
      </div>

      {upgradeHint && !billing.isPaid && (
        <div style={{ marginTop: 8, fontSize: 13.5, color: C.ink, lineHeight: 1.45 }}>
          {upgradeHint}
          {" "}
          <a href="/pricing" style={{ color: C.violetDeep, fontWeight: 600 }}>Upgrade to Pro →</a>
        </div>
      )}
    </div>
  );
}

function card() {
  return {
    background: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 16,
    padding: 18,
    fontFamily: BODY,
  };
}
