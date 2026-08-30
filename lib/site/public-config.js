/**
 * Public, non-secret site copy for legal/contact pages.
 * Support email is resolved server-side only (never from browser-supplied values).
 */

export const SITE_NAME = "Agenticaso";
export const SITE_TAGLINE = "Agentic Search Optimization — see whether AI assistants recommend your store.";
export const LEGAL_EFFECTIVE_DATE = "30 August 2026";
export const DEFAULT_PUBLIC_SUPPORT_EMAIL = "support@agenticaso.com";

export const LEGAL_NAV = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/refund-cancellation", label: "Refund & Cancellation" },
  { href: "/contact", label: "Contact" },
];

/**
 * Public support inbox for display on /contact.
 * Env overrides may replace the published inbox; empty values are ignored.
 * Does not fall back to lead/notification inboxes.
 */
export function getPublicSupportEmail() {
  const candidates = [
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL,
    process.env.SUPPORT_EMAIL,
  ];
  for (const raw of candidates) {
    const email = String(raw || "").trim();
    if (email && email.includes("@") && !email.includes(" ")) return email;
  }
  return DEFAULT_PUBLIC_SUPPORT_EMAIL;
}
