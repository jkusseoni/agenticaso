import { clerkMiddleware } from "@clerk/nextjs/server";

// All routes stay public by default — no auth.protect() yet.
// Landing, /api/scan, /api/lead remain open; Engine 2 will be gated later.
export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
