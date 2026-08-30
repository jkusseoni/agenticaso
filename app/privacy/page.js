import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";
import { C } from "@/lib/dashboard/theme";

export const metadata = {
  title: "Privacy Policy | Agenticaso",
  description:
    "How Agenticaso handles account data, submitted websites, audit results, AI provider processing, and payments.",
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      description="This is a plain-language summary for Agenticaso users. It is not legal advice."
    >
      <LegalSection title="Who we are">
        Agenticaso provides AI visibility audits and related dashboards for websites you choose to analyze.
      </LegalSection>
      <LegalSection title="Account information">
        When you sign in (via Clerk), we process identifiers such as your user id and email address to authenticate you and associate workspaces, websites, and audits with your account.
      </LegalSection>
      <LegalSection title="Websites and content you submit">
        You may submit website URLs and related signals for analysis. We store domain, URL, brand/category metadata, buyer questions, audit scores, competitor and perception snapshots derived from those runs, and monitoring settings you enable. You are responsible for having the right to submit those URLs and for the content of sites you analyze.
      </LegalSection>
      <LegalSection title="Audit results">
        Audit outputs (scores, provider results summaries, diagnoses, alerts, usage counters) are stored so you can view history and trends. Optional raw AI answers may be retained depending on server configuration (STORE_RAW_ANSWERS).
      </LegalSection>
      <LegalSection title="AI provider processing">
        To run audits we send buyer questions and limited brand/site context to third-party AI providers (for example OpenAI/ChatGPT, Perplexity, and Google Gemini, via our configured gateways). Those providers process prompts according to their own terms and privacy policies. Do not submit secrets or personal data you do not want processed by AI providers.
      </LegalSection>
      <LegalSection title="Payments">
        Paid plans are processed by Paddle. Where applicable, Paddle acts as the Merchant of Record. We store subscription identifiers and status needed for entitlements (for example plan, status, and period dates). We do not store full card numbers on Agenticaso servers. Card and other payment details are handled by Paddle under Paddle&apos;s policies. Cancellation and refund handling is described in our{" "}
        <Link href="/refund-cancellation" style={{ color: C.violetDeep }}>Refund and Cancellation Policy</Link>.
      </LegalSection>
      <LegalSection title="Cookies and analytics">
        We use authentication/session cookies required to keep you signed in (Clerk). We do not currently operate a separate product analytics suite on the app. If analytics are added later, this page will be updated.
      </LegalSection>
      <LegalSection title="Data retention">
        Account, website, audit, and billing entitlement records are retained while your account is active and as needed for product history, security, and billing disputes. After downgrade we retain historical audits and website data; Pro features are limited going forward rather than deleting history by default. Cancelling a subscription does not automatically erase historical account data.
      </LegalSection>
      <LegalSection title="Your choices">
        You may stop using the product, cancel a subscription through the billing flow, or contact us to request account deletion. Some records may be retained where required for security, fraud prevention, or legal obligations.
      </LegalSection>
      <LegalSection title="Contact">
        For privacy questions, use our{" "}
        <Link href="/contact" style={{ color: C.violetDeep }}>Contact</Link> page.
      </LegalSection>
    </LegalPage>
  );
}
