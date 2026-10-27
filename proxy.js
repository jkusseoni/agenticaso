import { clerkMiddleware } from "@clerk/nextjs/server";

// All routes stay public by default — no Clerk route protection yet.
// Landing, /api/scan, /api/lead remain open; Engine 2 will be gated later.
// `/mcp` is excluded from this matcher so Clerk never cookie-redirects MCP clients.
// Key management (`/api/mcp/keys`) still runs through Clerk (signed-in dashboard).
export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|mcp(?:/|$)|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
