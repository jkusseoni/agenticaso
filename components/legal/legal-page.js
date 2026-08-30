import Link from "next/link";
import { C, DISPLAY, BODY } from "@/lib/dashboard/theme";
import { LEGAL_EFFECTIVE_DATE } from "@/lib/site/public-config";
import { SiteFooter } from "@/components/site-footer";

export function LegalPage({ title, description, children }) {
  return (
    <div style={{ minHeight: "100vh", background: C.paper, color: C.ink, fontFamily: BODY, display: "flex", flexDirection: "column" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=Inter:wght@400;500;600&display=swap');
        @media (max-width: 640px) {
          .legal-h1 { font-size: 28px !important; }
        }
      `}</style>
      <header style={{ borderBottom: `1px solid ${C.border}`, background: "#fff" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 20px", height: 64, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <Link href="/" style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 18, textDecoration: "none", color: C.ink }}>
            Agenticaso
          </Link>
          <Link href="/pricing" style={{ fontSize: 14, color: C.muted, textDecoration: "none" }}>
            Pricing
          </Link>
        </div>
      </header>
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "40px 20px 48px", lineHeight: 1.65, fontSize: 15, flex: 1, width: "100%" }}>
        <h1 className="legal-h1" style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 34, letterSpacing: -0.6, marginBottom: 8 }}>
          {title}
        </h1>
        {description ? (
          <p style={{ color: C.muted, marginBottom: 12 }}>{description}</p>
        ) : null}
        <p style={{ color: C.muted, marginBottom: 28, fontSize: 13.5 }}>
          Effective / last updated: {LEGAL_EFFECTIVE_DATE}. This page is for informational purposes and is not legal advice.
        </p>
        {children}
      </main>
      <SiteFooter
        extra={
          <div style={{ fontSize: 12, color: C.muted, maxWidth: 360, lineHeight: 1.45 }}>
            Agenticaso · Agentic Search Optimization
          </div>
        }
      />
    </div>
  );
}

export function LegalSection({ title, children }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <h2 style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, marginBottom: 8 }}>{title}</h2>
      <div style={{ color: C.ink }}>{children}</div>
    </section>
  );
}
