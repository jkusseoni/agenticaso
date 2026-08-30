"use client";

import React, { useCallback, useEffect, useState } from "react";
import { SignInButton, UserButton, useAuth, useUser } from "@clerk/nextjs";
import { C, DISPLAY, BODY, formatDate } from "@/lib/dashboard/theme";
import { BillingUsageCard } from "@/components/agentic";
import { SiteFooter } from "@/components/site-footer";
import { openPaddleOverlay } from "@/components/billing/paddle-checkout";

export default function BillingPage() {
  const { isSignedIn, isLoaded: authLoaded } = useAuth();
  const { isLoaded: userLoaded } = useUser();
  const [billing, setBilling] = useState(null);
  const [pricing, setPricing] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/billing/status");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to load billing");
    setBilling(data.billing || null);
    setPricing(data.pricing || null);
  }, []);

  useEffect(() => {
    if (!authLoaded || !userLoaded || !isSignedIn) return;
    load().catch((e) => setError(e.message || "Failed to load"));
  }, [authLoaded, userLoaded, isSignedIn, load]);

  const upgrade = async () => {
    setBusy(true);
    setError("");
    setMsg("");
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Checkout failed");
      if (data.alreadyActive) {
        setMsg(data.message || "Already on Pro.");
        await load();
        return;
      }
      if (data.transactionId) {
        await openPaddleOverlay({
          transactionId: data.transactionId,
          customerEmail: data.customerEmail,
        });
        return;
      }
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      setMsg("Checkout is not available yet. Pro activates only after a verified successful payment.");
      await load();
    } catch (e) {
      setError(e.message || "Upgrade failed");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!window.confirm("Cancel at period end? Your data and history stay — Pro features pause after the period.")) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/billing/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Cancel failed");
      setMsg(data.message || "Cancellation scheduled.");
      await load();
    } catch (e) {
      setError(e.message || "Cancel failed");
    } finally {
      setBusy(false);
    }
  };

  const renewal = billing?.currentPeriodEnd
    ? formatDate(billing.currentPeriodEnd)
    : "—";

  return (
    <div style={{ minHeight: "100vh", background: C.paper, color: C.ink, fontFamily: BODY }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Inter:wght@400;500;600;700;800&display=swap');
      `}</style>

      <header style={{ borderBottom: `1px solid ${C.border}`, background: "rgba(245,246,251,.9)" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 20px", height: 64, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <a href="/dashboard" style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 18, textDecoration: "none", color: C.ink }}>
            Agenticaso
          </a>
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <a href="/dashboard" style={{ fontSize: 14, color: C.muted }}>Dashboard</a>
            <a href="/pricing" style={{ fontSize: 14, color: C.muted }}>Pricing</a>
            {isSignedIn ? <UserButton /> : null}
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 720, margin: "0 auto", padding: "36px 20px 64px" }}>
        <h1 style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 32, letterSpacing: -0.6, marginBottom: 8 }}>
          Billing
        </h1>
        <p style={{ color: C.muted, fontSize: 15, marginBottom: 28, lineHeight: 1.5 }}>
          Plan, usage, and subscription — managed server-side. Pro requires a verified successful payment.
        </p>

        {!authLoaded || !userLoaded ? (
          <p style={{ color: C.muted }}>Loading…</p>
        ) : !isSignedIn ? (
          <SignInButton mode="modal">
            <button type="button" style={btn()}>Sign in to manage billing →</button>
          </SignInButton>
        ) : (
          <div style={{ display: "grid", gap: 16 }}>
            <BillingUsageCard billing={billing} />

            <div style={panel()}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, letterSpacing: 0.4 }}>SUBSCRIPTION</div>
              <div style={{ marginTop: 10, fontSize: 14.5, lineHeight: 1.6 }}>
                <div>
                  Status:{" "}
                  <b style={{ textTransform: "capitalize" }}>
                    {(billing?.status || "none").replace(/_/g, " ")}
                  </b>
                </div>
                <div>Renewal / period end: {renewal}</div>
                {pricing?.pro?.label && (
                  <div style={{ color: C.muted, marginTop: 6 }}>Pro: {pricing.pro.label}</div>
                )}
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 18 }}>
                {!billing?.isPaid && (
                  <button type="button" disabled={busy} onClick={upgrade} style={btn()}>
                    Upgrade to Pro
                  </button>
                )}
                {billing?.isPaid && !billing?.cancelAtPeriodEnd && (
                  <button type="button" disabled={busy} onClick={cancel} style={ghost()}>
                    Cancel at period end
                  </button>
                )}
                <a href="/pricing" style={{ ...ghost(), textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
                  View plans
                </a>
              </div>
            </div>

            {msg && <div style={{ color: C.teal, fontSize: 14 }}>{msg}</div>}
            {error && <div style={{ color: "#E85D4C", fontSize: 14 }}>{error}</div>}
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}

function panel() {
  return {
    background: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 16,
    padding: 18,
  };
}

function btn() {
  return {
    border: "none",
    borderRadius: 12,
    padding: "12px 18px",
    background: `linear-gradient(135deg,${C.violet},${C.violetDeep})`,
    color: "#fff",
    fontWeight: 700,
    fontSize: 14,
    cursor: "pointer",
    fontFamily: BODY,
  };
}

function ghost() {
  return {
    border: `1px solid ${C.border}`,
    borderRadius: 12,
    padding: "12px 18px",
    background: C.card,
    color: C.ink,
    fontWeight: 600,
    fontSize: 14,
    cursor: "pointer",
    fontFamily: BODY,
  };
}
