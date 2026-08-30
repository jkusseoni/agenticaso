export const runtime = "nodejs";

/**
 * POST /api/billing/webhook
 * Retired Razorpay endpoint. Paddle is the only payment provider.
 * Does not grant, activate, or restore Pro.
 */
export async function POST() {
  return Response.json(
    {
      error: "This billing webhook is retired. Paddle is the only payment provider.",
      code: "PROVIDER_RETIRED",
    },
    { status: 410 }
  );
}
