/**
 * Retired Razorpay webhook processor. Does not grant, activate, or restore Pro.
 */
export async function processRazorpayWebhook(_prisma, { eventId } = {}) {
  void _prisma;
  if (!eventId) {
    const err = new Error("Missing webhook event id.");
    err.code = "VALIDATION";
    throw err;
  }
  return { processed: false, granted: false, action: "retired", provider: "razorpay" };
}

export { mapRazorpayStatus } from "./razorpay.js";
