
import { createHash } from "node:crypto";
import { Resend } from "resend";
import { getPrisma } from "@/lib/db/prisma.js";
import { scanStore } from "@/lib/scan/scan.js";
import { buildScanReportEmail } from "@/lib/scan/report-email.js";

export const runtime = "nodejs";
export const maxDuration = 60;

const TOKEN_RE = /^[a-f0-9]{64}$/;
const MAX_ATTEMPTS = 3;
const MAX_BODY_BYTES = 1024;
const LOCK_MS = 5 * 60 * 1000;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(message, { success = false, token = null } = {}) {
  const button = token
    ? `<form method="POST" action="/api/lead/verify">
         <input type="hidden" name="token" value="${escapeHtml(token)}">
         <button type="submit" style="background:#5A47F5;color:white;border:0;padding:14px 22px;border-radius:10px;cursor:pointer">
           Verify &amp; Send Report
         </button>
       </form>`
    : "";

  return new Response(
    `<!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta name="referrer" content="no-referrer">
      <title>Agenticaso Email Verification</title>
    </head>
    <body style="font-family:system-ui;text-align:center;padding:60px 20px">
      <h1>${success ? "Report requested" : "Agenticaso verification"}</h1>
      <p>${escapeHtml(message)}</p>
      ${button}
      <p><a href="https://agenticaso.com">Return to Agenticaso</a></p>
    </body>
    </html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      },
    }
  );
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

// GET must never consume the verification token.
export async function GET(request) {
  const token = new URL(request.url).searchParams.get("token");

  if (!token || !TOKEN_RE.test(token)) {
    return page("Invalid verification link.");
  }

  return page(
    "Confirm your email address to receive your technical readiness report.",
    { token }
  );
}

export async function POST(request) {
  let db = null;
  let lead = null;
  let claimed = false;
  let providerAccepted = false;
  let claimTime = null;

  try {
    const origin = request.headers.get("origin");
    const expectedOrigin = new URL(request.url).origin;

    if (!origin || origin !== expectedOrigin) {
      return page("Invalid request origin.");
    }

    const contentType = request.headers.get("content-type") || "";

    if (!contentType.toLowerCase().startsWith(
      "application/x-www-form-urlencoded"
    )) {
      return page("Invalid form format.");
    }

    const length = Number(request.headers.get("content-length") || 0);

    if (!Number.isFinite(length) || length > MAX_BODY_BYTES) {
      return page("Request too large.");
    }

    const raw = await request.text();

    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return page("Request too large.");
    }

    const token = new URLSearchParams(raw).get("token");

    if (!token || !TOKEN_RE.test(token)) {
      return page("Invalid verification token.");
    }

    db = getPrisma();

    if (!db || !process.env.RESEND_API_KEY) {
      return page("Report delivery is temporarily unavailable.");
    }

    const verificationHash = tokenHash(token);

    lead = await db.reportEmailLead.findUnique({
      where: { verificationHash },
    });

    if (!lead || lead.expiresAt <= new Date()) {
      return page("This verification link has expired.");
    }

    if (lead.status === "verified" || lead.reportSentAt) {
      return page(
        "Your report request has already been submitted for email delivery.",
        { success: true }
      );
    }

    if (lead.attemptCount >= MAX_ATTEMPTS) {
      return page(
        "Maximum delivery attempts reached. Please request a new report."
      );
    }

    const now = new Date();
    claimTime = now;

    const staleBefore = new Date(now.getTime() - LOCK_MS);

    const eligible =
      lead.status === "pending" ||
      lead.status === "failed" ||
      (
        lead.status === "processing" &&
        lead.processingStartedAt &&
        lead.processingStartedAt < staleBefore
      );

    if (!eligible) {
      return page(
        "Your report is already being prepared. Please try again shortly."
      );
    }

    // Atomic claim prevents simultaneous processing.
    const result = await db.reportEmailLead.updateMany({
      where: {
        id: lead.id,
        status: lead.status,
        attemptCount: lead.attemptCount,
        expiresAt: { gt: now },
        reportSentAt: null,
        ...(lead.status === "processing"
          ? { processingStartedAt: { lt: staleBefore } }
          : {}),
      },
      data: {
        status: "processing",
        processingStartedAt: now,
        attemptCount: { increment: 1 },
        verifiedAt: lead.verifiedAt || now,
      },
    });

    if (result.count !== 1) {
      return page(
        "Another request is processing this report. Please try again shortly."
      );
    }

    claimed = true;

    // Always perform a fresh server-side scan.
    const report = await scanStore(lead.websiteUrl);

    if (!report || report.error) {
      throw new Error("scan_failed");
    }

    const emailReport = buildScanReportEmail(report);
    const resend = new Resend(process.env.RESEND_API_KEY);

    const { error } = await resend.emails.send(
      {
        from: "Agenticaso Reports <reports@agenticaso.com>",
        to: [lead.email],
        subject: emailReport.subject,
        html: emailReport.html,
        text: emailReport.text,
      },
      {
        idempotencyKey: `report-${lead.id}`,
      }
    );

    if (error) {
      throw new Error(`resend_${error.name || "error"}`);
    }

    providerAccepted = true;

    const saved = await db.reportEmailLead.updateMany({
      where: {
        id: lead.id,
        status: "processing",
        processingStartedAt: claimTime,
      },
      data: {
        status: "verified",
        reportSentAt: new Date(),
        processingStartedAt: null,
      },
    });

    if (saved.count !== 1) {
      throw new Error("delivery_confirmation_not_saved");
    }

    return page(
      "Your Agenticaso technical readiness report has been submitted for email delivery.",
      { success: true }
    );
  } catch (error) {
    console.error("Report verification failed:", error);

    if (claimed && db && lead && !providerAccepted) {
      await db.reportEmailLead.updateMany({
        where: {
          id: lead.id,
          status: "processing",
          processingStartedAt: claimTime,
        },
        data: {
          status: "failed",
          processingStartedAt: null,
        },
      }).catch((dbError) => {
        console.error("Unable to record failed report attempt:", dbError);
      });
    }

    if (providerAccepted) {
      return page(
        "The email provider accepted your report, but confirmation could not be saved. Please contact support instead of retrying."
      );
    }

    return page(
      "Report processing failed. Please request a new verification link if the problem continues."
    );
  }
}
