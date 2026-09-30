import "server-only";
import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { isGrowthAdminClerkId } from "./admin.js";

/**
 * Signed-out and non-allowlisted users get the same 404.
 * Call this before any funnel query.
 */
export async function requireGrowthAdmin() {
  let userId = null;
  try {
    const session = await auth();
    userId = session?.userId || null;
  } catch {
    userId = null;
  }
  if (!isGrowthAdminClerkId(userId)) notFound();
}
