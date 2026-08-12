// app/pricing/page.js  (route: /pricing)
"use client";
import React, { useState } from "react";
import { SignInButton, useUser } from "@clerk/nextjs";

// TODO: paste your Razorpay payment link here:
const RAZORPAY_LINK = "https://rzp.io/rzp/1aOQb9z";

const C = {
  paper: "#F5F6FB", ink: "#15152B", muted: "#5B5B78",
  violet: "#5A47F5", violetDeep: "#3A2AC0", teal: "#0FB88E",
  card: "#FFFFFF", border: "#E7E8F3", dark: "#111024",
};
const DISPLAY = "'Bricolage Grotesque', system-ui, sans-serif";
const BODY = "'Inter', system-ui, sans-serif";

const FEATURES = [
  "Real AI-visibility check — see if ChatGPT & Perplexity actually recommend you",
  "Share-of-voice score across 5 real buyer questions",
  "Live web-search vs AI-memory breakdown",
  "See which competitors AI recommends instead of you",
  "Unlimited agent-readiness scans",
  "Priority email support",
];

const FAQS = [
  { q: "What is AI visibility?", a: "It's whether AI assistants like ChatGPT and Perplexity recommend your store when a shopper asks them to buy. We measure it by asking real buyer questions and checking if your brand shows up." },
  { q: "How is this different from SEO?", a: "SEO gets you ranked on Google. AI visibility gets you recommended by the AI agents your customers increasingly shop through. Different game, different optimization." },
  { q: "Can I cancel anytime?", a: "Yes. It's a monthly plan — cancel whenever you want, no lock-in." },
  { q: "How soon does it activate?", a: "Right after payment we activate your account. You'll get access to run AI-visibility checks on any store." },
];

export default function PricingPage() {
  const { isSignedIn, user } = useUser();
  const isPaid = user?.publicMetadata?.paid === true;
  const [openFaq, setOpenFaq] = useState(0);

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
        {/* hero */}
        <div className="rise" style={{ display: "inline-block", fontSize: 12.5, fontWeight: 600, color: C.violetDeep, background: "#ECEAFE", padding: "6px 13px", borderRadius: 999, marginBottom: 18 }}>
          Agenticaso Pro
        </div>
        <h1 className="h1 rise" style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 44, lineHeight: 1.05, letterSpacing: -1.3, marginBottom: 14 }}>
          See if AI actually<br />recommends your store.
        </h1>
        <p className="rise" style={{ fontSize: 17, color: C.muted, lineHeight: 1.55, maxWidth: 520, margin: "0 auto 40px" }}>
          Free scans show if your site is agent-ready. <b>Pro</b> shows the number that matters — whether ChatGPT and Perplexity send you sales, or your competitors.
        </p>

        {/* plan card */}
        <div className="plan" style={{ maxWidth: 460, margin: "0 auto", background: C.card, border: `1px solid ${C.border}`, borderRadius: 22, padding: 32, textAlign: "left" }}>
          <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 20, marginBottom: 4 }}>Pro</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
            <span style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 46, letterSpacing: -1 }}>₹499</span>
            <span style={{ color: C.muted, fontSize: 16 }}>/ month</span>
          </div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 22 }}>Cancel anytime · activates right after payment</div>

          <div style={{ display: "grid", gap: 11, marginBottom: 26 }}>
            {FEATURES.map((f) => (
              <div key={f} style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14.5, lineHeight: 1.45 }}>
                <span style={{ color: C.teal, fontWeight: 800, flexShrink: 0 }}>✓</span>
                <span>{f}</span>
              </div>
            ))}
          </div>

          {/* CTA — depends on auth state */}
          {!isSignedIn ? (
            <SignInButton mode="modal">
              <button className="btn" style={primaryBtn()}>Sign in to upgrade →</button>
            </SignInButton>
          ) : isPaid ? (
            <div style={{ textAlign: "center", background: "#EAFBF4", border: `1px solid #CFF3E6`, borderRadius: 12, padding: 14, color: C.teal, fontWeight: 600 }}>
              ✓ You're on Pro — enjoy your AI-visibility checks!
            </div>
          ) : (
            <a className="btn" href={RAZORPAY_LINK} target="_blank" rel="noopener noreferrer" style={{ ...primaryBtn(), display: "block", textAlign: "center", textDecoration: "none" }}>
              Upgrade to Pro — ₹499/mo
            </a>
          )}

          {isSignedIn && !isPaid && (
            <div style={{ fontSize: 12, color: C.muted, textAlign: "center", marginTop: 12 }}>
              After payment, your account is activated within a few hours. You'll get an email.
            </div>
          )}
        </div>

        {/* trust line */}
        <div style={{ marginTop: 22, fontSize: 13, color: C.muted }}>Secure payment via Razorpay · UPI, cards, netbanking</div>

        {/* FAQ */}
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

        <div style={{ marginTop: 50 }}>
          <a href="/" style={{ color: C.violet, textDecoration: "none", fontSize: 14, fontWeight: 600 }}>← Back to Agenticaso</a>
        </div>
      </div>
    </div>
  );
}

function primaryBtn() {
  return { width: "100%", padding: "14px 20px", borderRadius: 12, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 15.5, color: "#fff", background: `linear-gradient(135deg,${C.violet},${C.violetDeep})`, fontFamily: BODY };
}
