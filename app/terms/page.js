import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";
import { DEFAULT_PRO_PRICE_LABEL } from "@/lib/billing/plans";
import { C } from "@/lib/dashboard/theme";

export const metadata = {
  title: "Terms of Service | Agenticaso",
  description:
    "Terms of Service for Agenticaso, an Indian SaaS product for AI visibility audits and Pro subscriptions.",
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      description="These terms govern use of Agenticaso. They are not a substitute for professional legal counsel."
    >
      <LegalSection title="The service">
        Agenticaso provides tools to estimate how AI assistants may mention or recommend brands/websites based on buyer-style questions. Results are informational estimates, not guarantees of ranking, traffic, sales, or AI behavior.
      </LegalSection>
      <LegalSection title="Accounts">
        You must provide accurate account information and keep credentials secure. You are responsible for activity under your account. Do not attempt to bypass entitlements, rate limits, or ownership checks.
      </LegalSection>
      <LegalSection title="Submitted websites">
        You represent that you have the right to submit URLs and related content for analysis. Do not submit unlawful content, secrets, or personal data of others without a lawful basis. You remain responsible for content published on sites you analyze and for any copy suggestions you choose to publish.
      </LegalSection>
      <LegalSection title="AI outputs">
        Diagnoses and suggested fixes are generated from audit signals and may be incomplete or incorrect. Always review before publishing. Agenticaso does not claim SOC 2, ISO, HIPAA, or similar certifications unless separately documented in writing.
      </LegalSection>
      <LegalSection title="Plans and billing">
        Free and paid entitlements are enforced server-side. The canonical paid plan is <strong>Agenticaso Pro</strong> at {DEFAULT_PRO_PRICE_LABEL} unless you are shown a different amount at checkout. Pro is a recurring monthly SaaS subscription. Signing in or verifying an email does not unlock Pro — paid access requires a verified successful payment. Cancelled subscriptions may retain Pro access until the end of an already-paid period when applicable; after expiry, Free limits apply while historical data is retained. Refunds and cancellations are described in our{" "}
        <Link href="/refund-cancellation" style={{ color: C.violetDeep }}>Refund and Cancellation Policy</Link>.
      </LegalSection>
      <LegalSection title="Payments">
        Payments for Agenticaso Pro are processed by Paddle. Where applicable, Paddle acts as the Merchant of Record: Paddle handles checkout, invoices, sales taxes where they apply, and the payment itself. Agenticaso does not collect or store full card numbers. Payment details are handled by Paddle under Paddle&apos;s terms and privacy policy.
      </LegalSection>
      <LegalSection title="Acceptable use">
        Do not abuse the APIs, scrape the product, reverse engineer in violation of law, interfere with other customers, or use the service to harm others. We may suspend accounts that threaten security or fair use.
      </LegalSection>
      <LegalSection title="Limitation of liability">
        To the fullest extent permitted by law, Agenticaso is provided as-is without warranties of merchantability or fitness for a particular purpose. We are not liable for indirect, incidental, or consequential damages arising from AI provider outages, incorrect recommendations, or decisions you make based on audits.
      </LegalSection>
      <LegalSection title="Governing law">
        These terms are intended for a SaaS offering used from India and are governed by the laws of India, without prejudice to any mandatory consumer protections that apply to you. Courts of competent jurisdiction in India may hear disputes, except where applicable law requires otherwise.
      </LegalSection>
      <LegalSection title="Contact">
        Questions about these terms: see our{" "}
        <Link href="/contact" style={{ color: C.violetDeep }}>Contact</Link> page.
      </LegalSection>
      <LegalSection title="Changes">
        We may update these terms. Continued use after material changes constitutes acceptance of the updated terms where permitted by law.
      </LegalSection>
    </LegalPage>
  );
}
