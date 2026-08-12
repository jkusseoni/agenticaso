// app/api/lead/route.js
// Emails each captured lead straight to your inbox via Resend. No database.
// Env needed: RESEND_API_KEY, LEAD_NOTIFY_EMAIL (your Zoho address).

import { Resend } from "resend";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const url = body.url ? String(body.url) : "—";
    const score = Number.isFinite(body.score) ? Math.round(body.score) : "—";
    const source = ["report", "landing"].includes(body.source) ? body.source : "report";

    if (!EMAIL_RE.test(email)) {
      return Response.json({ error: "Please enter a valid email." }, { status: 422 });
    }

    const resend = new Resend(process.env.RESEND_API_KEY);

    const { error } = await resend.emails.send({
      // Use onboarding@resend.dev today (no domain verify needed).
      // Later, verify agenticaso.com in Resend and switch to leads@agenticaso.com.
      from: "Agenticaso Leads <onboarding@resend.dev>",
      to: [process.env.LEAD_NOTIFY_EMAIL],
      replyTo: email,
      subject: `New Agenticaso lead: ${email}`,
      text:
        `New lead captured on Agenticaso\n\n` +
        `Email:   ${email}\n` +
        `Scanned: ${url}\n` +
        `Score:   ${score}/100\n` +
        `Source:  ${source}\n` +
        `Time:    ${new Date().toISOString()}\n`,
    });

    if (error) {
      console.error("resend error:", error);
      return Response.json({ error: "Couldn't send right now. Try again." }, { status: 500 });
    }

    return Response.json({ ok: true });
  } catch (e) {
    console.error("lead route error:", e);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }
}