import type { NextConfig } from 'next';

/**
 * Next.js configuration for the Rizoma web app.
 *
 * Why there is no `rewrites()` for the API: a rewrite is a transport-level
 * map, it cannot read the session cookie nor add an `Authorization` header, so
 * a rewritten `/api/*` would reach the API as an anonymous caller. The API
 * binds every business route to a verified tenant (403 `tenant.missing`), so
 * the proxy is implemented as a Route Handler instead
 * (`app/api/proxy/[...path]/route.ts`), which injects the bearer token, the
 * `Idempotency-Key` and the `x-trace-id` correlation header on every call.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Local demo data only; no remote image host is ever contacted at build time.
  images: {
    remotePatterns: [],
  },
};

export default nextConfig;
