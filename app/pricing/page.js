// app/pricing/page.js  (route: /pricing)
"use client";
import React, { useEffect, useState } from "react";
import { SignInButton, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { DEFAULT_PRO_PRICE_LABEL } from "@/lib/billing/plans";
import { SiteFooter } from "@/components/site-footer";
import { openPaddleOverlay, loadPaddle } from "@/components/billing/paddle-checkout";
import { track } from "@vercel/analytics";

const C = {
  paper: "#F5F6FB", ink: "#15152B", muted: "#5B5B78",
  violet: "#5A47F5", violetDeep: "#3A2AC0", teal: "#0FB88E",
  card: "#FFFFFF", border: "#E7E8F3", dark: "#111024",
};
const DISPLAY = "'Bricolage Grotesque', system-ui, sans-serif";
const BODY = "'Inter', system-ui, sans-serif";

const FEATURES = [
  "Multi-AI visibility — ChatGPT, Perplexity & Gemini",
  "Up to 50 buyer questions per audit",
  "Weekly monitoring on 3 websites",
  "Advanced competitors + diagnosis & fixes",
  "Unlimited audit history + exports",
  "Priority email support",
];

const FAQS = [
  { q: "What is AI visibility?", a: "It's whether AI assistants like ChatGPT and Perplexity recommend your store when a shopper asks them to buy. We measure it by asking real buyer questions and checking if your brand shows up." },
  { q: "How is this different from SEO?", a: "SEO gets you ranked on Google. AI visibility gets you recommended by the AI agents your customers increasingly shop through. Different game, different optimization." },
  { q: "Can I cancel anytime?", a: "Yes. It's a monthly plan — cancel whenever you want, no lock-in. Your historical audits stay after downgrade." },
  { q: "How soon does it activate?", a: "Pro activates only after a verified successful payment. Signing in or verifying your email does not unlock Pro." },
];

export default function PricingPage() {
  const { isSignedIn } = useUser();
  const [openFaq, setOpenFaq] = useState(0);
  const [priceLabel, setPriceLabel] = useState(DEFAULT_PRO_PRICE_LABEL);
  const [billingPaid, setBillingPaid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isPaid = billingPaid === true;

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    fetch("/api/billing/status")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.billing) setBillingPaid(Boolean(d.billing.isPaid));
        if (d.pricing?.pro?.label) setPriceLabel(d.pricing.pro.label);
      })
      .catch(() => {});
    loadPaddle().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

  const startCheckout = async () => {
    setBusy(true);
    setError("");
    try {
      track("pro_checkout_started", {
        source: "pricing_page",
        plan: "pro",
      });
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Checkout failed");
      if (data.alreadyActive) {
        setBillingPaid(true);
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
      throw new Error("Checkout is not available yet. Pro activates only after a verified successful payment.");
    } catch (e) {
      setError(e.message || "Checkout failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ background: C.paper, color: C.ink, fontFamily: BODY, minHeight: "100vh" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; }
        .pw { max-width: 880px; margin: 0 auto; padding: 0 24px; }
        @keyframes rise { from{opacity:0;transform:translateY(18px)} to{opacity:1;transform:translateY(0)} }
        @keyframes glow { 0%,100%{box-shadow:0 24px 60px -34px rgba(58,42,192,.55)} 50%{box-shadow:0 24px 70px -30px rgba(58,42,192,.85)} }
        .rise { animation: rise .6s ease both; }
        .plan { animation: rise .6s ease both, glow 4s ease-in-out infinite 1s; }
        .btn:focus-visible, a:focus-visible { outline: 3px solid ${C.violet}; outline-offset: 3px; border-radius: 10px; }
        @media (max-width:640px){ .h1{font-size:34px!important} }
      `}</style>

      <div className="pw" style={{ paddingTop: 60, paddingBottom: 70, textAlign: "center" }}>
        <div className="rise" style={{ display: "inline-block", fontSize: 12.5, fontWeight: 600, color: C.violetDeep, background: "#ECEAFE", padding: "6px 13px", borderRadius: 999, marginBottom: 18 }}>
          Agenticaso Pro
        </div>
        <h1 className="h1 rise" style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 44, lineHeight: 1.05, letterSpacing: -1.3, marginBottom: 14 }}>
          See if AI actually<br />recommends your store.
        </h1>
        <p className="rise" style={{ fontSize: 17, color: C.muted, lineHeight: 1.55, maxWidth: 520, margin: "0 auto 40px" }}>
          Free includes limited AI checks. <b>Pro</b> unlocks 50 buyer questions, monitoring, diagnosis, and exports.
        </p>

        <div className="plan" style={{ maxWidth: 460, margin: "0 auto", background: C.card, border: `1px solid ${C.border}`, borderRadius: 22, padding: 32, textAlign: "left" }}>
          <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 20, marginBottom: 4 }}>Pro</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
            <span style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 40, letterSpacing: -1 }}>{priceLabel.replace(/\/month$/i, "")}</span>
            <span style={{ color: C.muted, fontSize: 16 }}>/ month</span>
          </div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 22 }}>Cancel anytime · activates after payment confirmation</div>

          <div style={{ display: "grid", gap: 11, marginBottom: 26 }}>
            {FEATURES.map((f) => (
              <div key={f} style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14.5, lineHeight: 1.45 }}>
                <span style={{ color: C.teal, fontWeight: 800, flexShrink: 0 }}>✓</span>
                <span>{f}</span>
              </div>
            ))}
          </div>

          {!isSignedIn ? (
            <SignInButton mode="modal">
              <button className="btn" style={primaryBtn()}>Sign in to upgrade →</button>
            </SignInButton>
          ) : isPaid ? (
            <div style={{ textAlign: "center", background: "#EAFBF4", border: `1px solid #CFF3E6`, borderRadius: 12, padding: 14, color: C.teal, fontWeight: 600 }}>
              ✓ You&apos;re on Pro — <a href="/billing" style={{ color: C.teal }}>manage billing</a>
            </div>
          ) : (
            <button className="btn" type="button" disabled={busy} onClick={startCheckout} style={{ ...primaryBtn(), width: "100%" }}>
              {busy ? "Starting checkout…" : `Upgrade to Pro — ${priceLabel}`}
            </button>
          )}

          {error && (
            <div style={{ fontSize: 13, color: "#E85D4C", textAlign: "center", marginTop: 12 }}>{error}</div>
          )}
        </div>

        <div style={{ marginTop: 22, fontSize: 13, color: C.muted }}>Pro is $19/month · activates after verified payment</div>

        <div style={{ maxWidth: 620, margin: "56px auto 0", textAlign: "left" }}>
          <h2 style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 26, letterSpacing: -0.6, marginBottom: 20, textAlign: "center" }}>Questions</h2>
          {FAQS.map((f, i) => (
            <div key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
              <button onClick={() => setOpenFaq(openFaq === i ? -1 : i)} style={{ width: "100%", background: "none", border: "none", cursor: "pointer", padding: "18px 4px", display: "flex", justifyContent: "space-between", alignItems: "center", textAlign: "left", fontFamily: BODY, fontSize: 16, fontWeight: 600, color: C.ink }}>
                {f.q}
                <span style={{ color: C.violet, fontSize: 20, transform: openFaq === i ? "rotate(45deg)" : "none", transition: "transform .2s" }}>+</span>
              </button>
              {openFaq === i && <div style={{ fontSize: 14.5, color: C.muted, lineHeight: 1.55, padding: "0 4px 18px" }}>{f.a}</div>}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 48 }}>
          <Link href="/" style={{ color: C.muted, fontSize: 14 }}>← Back to Agenticaso</Link>
        </div>
      </div>
      <SiteFooter />
    </div>
  );
}

function primaryBtn() {
  return {
    width: "100%",
    border: "none",
    borderRadius: 14,
    padding: "14px 18px",
    background: `linear-gradient(135deg,${C.violet},${C.violetDeep})`,
    color: "#fff",
    fontWeight: 700,
    fontSize: 15.5,
    cursor: "pointer",
    fontFamily: BODY,
  };
}
