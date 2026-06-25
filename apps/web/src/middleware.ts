import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Truly public surfaces only. The board ("/") self-redirects unauthenticated users in its
 * RSC, and the visual-regression harness must render without a session. Authenticated app
 * surfaces (/dashboard, /review, /settings, /reference) are protected at the edge here in
 * addition to their RSC-level checks.
 */
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/visual-regression(.*)"
]);

export default clerkMiddleware(async (auth, req) => {
  // Demo mode: bypass edge auth checks so API routes
  // can be exercised without an active Clerk session.
  if (process.env.BYPASS_AUTH === "true") {
    return;
  }
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico)).*)"]
};
