/**
 * Public, non-secret site copy for legal/contact pages.
 * Support email is resolved server-side only (never from browser-supplied values).
 */

export const SITE_NAME = "Agenticaso";
export const SITE_TAGLINE = "Agentic Search Optimization — see whether AI assistants recommend your store.";
export const LEGAL_EFFECTIVE_DATE = "13 August 2026";

export const LEGAL_NAV = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/refund-cancellation", label: "Refund & Cancellation" },
  { href: "/contact", label: "Contact" },
];

/**
 * Public support inbox for display on /contact.
 * Prefers an explicit public/support env var. Falls back to LEAD_NOTIFY_EMAIL
 * only as an existing configured inbox — never invents an address.
 */
export function getPublicSupportEmail() {
  const candidates = [
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL,
    process.env.SUPPORT_EMAIL,
    process.env.LEAD_NOTIFY_EMAIL,
  ];
  for (const raw of candidates) {
    const email = String(raw || "").trim();
    if (email && email.includes("@") && !email.includes(" ")) return email;
  }
  return null;
}
