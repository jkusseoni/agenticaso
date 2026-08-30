import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";
import { SITE_NAME, SITE_TAGLINE, getPublicSupportEmail } from "@/lib/site/public-config";
import { C } from "@/lib/dashboard/theme";

export const metadata = {
  title: "Contact | Agenticaso",
  description: "Contact Agenticaso for product, billing, cancellation, and refund questions.",
  robots: { index: true, follow: true },
};

export const dynamic = "force-dynamic";

export default function ContactPage() {
  const email = getPublicSupportEmail();

  return (
    <LegalPage
      title="Contact"
      description="Public contact details for Agenticaso. No login is required to read this page."
    >
      <LegalSection title={SITE_NAME}>
        {SITE_TAGLINE} We help brands measure whether assistants such as ChatGPT, Perplexity, and Gemini mention or recommend their websites, and we offer Agenticaso Pro as a monthly subscription for higher limits, monitoring, and related features.
      </LegalSection>

      <LegalSection title="Support">
        {email ? (
          <p style={{ margin: 0 }}>
            Email:{" "}
            <a href={`mailto:${email}`} style={{ color: C.violetDeep, fontWeight: 600 }}>
              {email}
            </a>
          </p>
        ) : (
          <p style={{ margin: 0 }}>
            A public support email is not published in this deployment yet. Signed-in customers can manage subscriptions on{" "}
            <Link href="/billing" style={{ color: C.violetDeep }}>Billing</Link>
            . We respond to account-related requests sent from the email on your Agenticaso login.
          </p>
        )}
      </LegalSection>

      <LegalSection title="What to include">
        For billing, cancellation, or refund questions, include the email on your Agenticaso account and any payment or subscription id from your receipt. Do not send passwords, API keys, or full card numbers.
      </LegalSection>

      <LegalSection title="Related policies">
        <p style={{ margin: "0 0 8px" }}>
          <Link href="/terms" style={{ color: C.violetDeep }}>Terms of Service</Link>
        </p>
        <p style={{ margin: "0 0 8px" }}>
          <Link href="/privacy" style={{ color: C.violetDeep }}>Privacy Policy</Link>
        </p>
        <p style={{ margin: 0 }}>
          <Link href="/refund-cancellation" style={{ color: C.violetDeep }}>Refund and Cancellation Policy</Link>
        </p>
      </LegalSection>
    </LegalPage>
  );
}
