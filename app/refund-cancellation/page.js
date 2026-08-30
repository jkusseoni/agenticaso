import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";
import { DEFAULT_PRO_PRICE_LABEL } from "@/lib/billing/plans";
import { C } from "@/lib/dashboard/theme";

export const metadata = {
  title: "Refund and Cancellation Policy | Agenticaso",
  description:
    "Cancellation and refund policy for Agenticaso Pro, a monthly SaaS subscription.",
  robots: { index: true, follow: true },
};

export default function RefundCancellationPage() {
  return (
    <LegalPage
      title="Refund and Cancellation Policy"
      description="This policy applies to Agenticaso Pro, a monthly software subscription. It is not legal advice and does not create rights beyond applicable law."
    >
      <LegalSection title="The product">
        Agenticaso is a SaaS product for AI visibility audits (Agentic Search Optimization). Paid access is sold as <strong>Agenticaso Pro</strong> at {DEFAULT_PRO_PRICE_LABEL} unless a different amount is shown at checkout.
      </LegalSection>
      <LegalSection title="Who processes payment">
        Payments are processed by Paddle. Where applicable, Paddle acts as the Merchant of Record. Agenticaso does not collect or store full card numbers. Checkout, invoices, and payment-method data are handled by Paddle.
      </LegalSection>

      <LegalSection title="Billing frequency">
        Pro is billed <strong>monthly in advance</strong> until you cancel. Each paid period covers subscription access for that month according to your verified server-side subscription status. We do not sell one-time physical goods.
      </LegalSection>

      <LegalSection title="How to cancel">
        Signed-in customers can cancel from the{" "}
        <Link href="/billing" style={{ color: C.violetDeep }}>Billing</Link> page (cancel at period end). You may also request cancellation via the{" "}
        <Link href="/contact" style={{ color: C.violetDeep }}>Contact</Link> page. We do not require you to call a phone number to cancel.
      </LegalSection>

      <LegalSection title="When cancellation takes effect">
        Cancellation is typically scheduled <strong>at the end of the current paid period</strong> (cancel at period end), so you keep Pro access until that date when the provider and our records confirm it. After the period ends, the subscription is treated as cancelled or expired and Free entitlements apply. If a provider-side cancellation is immediate instead, access follows the verified subscription state on our servers.
      </LegalSection>

      <LegalSection title="What happens after cancellation">
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          <li>New Pro usage (for example extra audits, monitoring slots, exports, and advanced diagnosis) is limited to the Free plan once paid access ends.</li>
          <li>We do <strong>not</strong> automatically delete your websites, historical audits, reports, or account history when you cancel. Cancellation does not erase historical account data.</li>
          <li>You may continue to sign in and view retained history, subject to Free limits on new usage.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Refund eligibility">
        Cancellation is not the same as a refund. Cancelling at period end stops the next renewal; it does not automatically refund the current paid period. Because Pro is a digital subscription for a period of access, <strong>fees for a billing period that has already started are generally not refunded</strong>, including where you have used audits, monitoring, or other Pro features during that period — except where a refund is required by applicable Indian consumer or payment law, or where we agree in writing after reviewing a specific request. This page does not promise a refund in every case.
      </LegalSection>

      <LegalSection title="Failed or duplicate payments">
        If a charge fails, Pro access follows the verified subscription state (for example past_due or expired) and we do not treat a failed charge as a completed purchase. If you are charged twice in error for the same period, contact us with the payment or subscription identifiers shown on your Paddle receipt. Confirmed duplicate charges may be corrected or refunded for the duplicate amount through Paddle. Timing depends on Paddle and your bank; we do not guarantee a specific posting date.
      </LegalSection>

      <LegalSection title="How to request a refund">
        Send a refund request through our{" "}
        <Link href="/contact" style={{ color: C.violetDeep }}>Contact</Link> page. Include your account email and, if available, the Paddle transaction or subscription id from your receipt. We will review the request against this policy and applicable law. If a refund is approved, Paddle processes it to the original payment method. Agenticaso does not charge or credit cards directly. We do not guarantee when the credit will appear on your statement.
      </LegalSection>

      <LegalSection title="Chargebacks">
        If you dispute a charge with your bank, we may share subscription and usage records needed to explain the transaction. Please contact us first so we can help resolve failed, duplicate, or unrecognized payments.
      </LegalSection>
    </LegalPage>
  );
}
