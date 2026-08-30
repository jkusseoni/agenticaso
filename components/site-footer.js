import Link from "next/link";
import { C, BODY } from "@/lib/dashboard/theme";
import { LEGAL_NAV } from "@/lib/site/public-config";

/**
 * Public footer legal links — no auth required.
 */
export function SiteFooter({ extra = null }) {
  return (
    <footer style={{ borderTop: `1px solid ${C.border}`, background: "#fff", fontFamily: BODY }}>
      <div
        style={{
          maxWidth: 880,
          margin: "0 auto",
          padding: "22px 20px 28px",
          display: "flex",
          flexWrap: "wrap",
          gap: 14,
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <nav aria-label="Legal" style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", fontSize: 13.5 }}>
          <Link href="/pricing" style={{ color: C.muted, textDecoration: "none" }}>Pricing</Link>
          {LEGAL_NAV.map((item) => (
            <Link key={item.href} href={item.href} style={{ color: C.muted, textDecoration: "none", fontWeight: 600 }}>
              {item.label}
            </Link>
          ))}
        </nav>
        {extra}
      </div>
    </footer>
  );
}
