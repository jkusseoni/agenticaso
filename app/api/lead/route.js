
import { createHash, randomBytes } from "node:crypto";
import { Resend } from "resend";
import { getPrisma } from "@/lib/db/prisma.js";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EXPIRY_MINUTES = 30;
const MAX_BODY_BYTES = 4096;

function jsonError(message, status) {
  return Response.json({ error: message }, { status });
}

export async function POST(req) {
  try {
    const contentLength = Number(req.headers.get("content-length") || 0);

    if (!Number.isFinite(contentLength) || contentLength > MAX_BODY_BYTES) {
      return jsonError("Request too large.", 413);
    }

    const raw = await req.text();

    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return jsonError("Request too large.", 413);
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return jsonError("Invalid request.", 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError("Invalid request.", 400);
    }

    const email =
      typeof body.email === "string"
        ? body.email.trim().toLowerCase()
        : "";

    if (!EMAIL_RE.test(email) || email.length > 254) {
      return jsonError("Please enter a valid email address.", 422);
    }

    if (typeof body.url !== "string" || !body.url.trim()) {
      return jsonError("Scan a website before requesting its report.", 422);
    }

    const websiteUrl = body.url.trim();

    if (websiteUrl.length > 2048) {
      return jsonError("Website URL is too long.", 422);
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(
        /^https?:\/\//i.test(websiteUrl)
          ? websiteUrl
          : `https://${websiteUrl}`
      );
    } catch {
      return jsonError("Enter a valid website URL.", 422);
    }

    if (
      !["http:", "https:"].includes(parsedUrl.protocol) ||
      !parsedUrl.hostname ||
      parsedUrl.username ||
      parsedUrl.password
    ) {
      return jsonError("Enter a valid public website URL.", 422);
    }

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
    let siteOrigin;

    try {
      const parsedSite = new URL(siteUrl);

      const isHttps = parsedSite.protocol === "https:";
      const isLocalDev =
        process.env.NODE_ENV === "development" &&
        parsedSite.protocol === "http:" &&
        parsedSite.hostname === "localhost" &&
        parsedSite.port === "3000";

      if (
        (!isHttps && !isLocalDev) ||
        parsedSite.username ||
        parsedSite.password ||
        parsedSite.search ||
        parsedSite.hash
      ) {
        throw new Error("Invalid site URL");
      }

      siteOrigin = parsedSite.origin;
    } catch {
      console.error("Invalid NEXT_PUBLIC_SITE_URL configuration.");
      return jsonError("Email service is temporarily unavailable.", 503);
    }

    const db = getPrisma();

    if (!db || !process.env.RESEND_API_KEY) {
      console.error("Report email service is not configured.");
      return jsonError("Email service is temporarily unavailable.", 503);
    }

    // Basic database-backed email throttling.
    // Production also requires edge-level IP rate limiting.
    const since = new Date(Date.now() - 60 * 60 * 1000);

    const recentRequests = await db.reportEmailLead.count({
      where: {
        email,
        createdAt: { gte: since },
      },
    });

    if (recentRequests >= 3) {
      return jsonError("Too many requests. Try again later.", 429);
    }

    const token = randomBytes(32).toString("hex");
    const verificationHash = createHash("sha256")
      .update(token)
      .digest("hex");

    const expiresAt = new Date(
      Date.now() + EXPIRY_MINUTES * 60 * 1000
    );

    const lead = await db.reportEmailLead.create({
      data: {
        email,
        websiteUrl: parsedUrl.toString(),
        verificationHash,
        expiresAt,
      },
    });



    const verifyUrl = new URL("/api/lead/verify", siteOrigin);
    verifyUrl.searchParams.set("token", token);

    const resend = new Resend(process.env.RESEND_API_KEY);

    const { error } = await resend.emails.send({
      from: "Agenticaso Reports <reports@agenticaso.com>",
      to: [email],
      subject: "Verify your Agenticaso report request",
      text:
        `You requested an Agenticaso technical readiness report.\n\n` +
        `Website: ${parsedUrl.hostname}\n\n` +
        `Verify your email using this link:\n${verifyUrl.toString()}\n\n` +
        `This link expires in ${EXPIRY_MINUTES} minutes.\n` +
        `If you did not request this report, ignore this email.`,
    });

    if (error) {
      console.error("Verification email delivery failed:", error.name);
      await db.reportEmailLead.delete({
        where: { id: lead.id },
      }).catch(() => {});

      return jsonError("Couldn't send verification email.", 502);
    }

    return Response.json({
      ok: true,
      message: "Check your inbox for a verification link.",
    });
  } catch (error) {
    console.error("Lead verification request failed:", error);
    return jsonError("Something went wrong. Please try again.", 500);
  }
}
