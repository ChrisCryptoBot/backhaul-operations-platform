/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A production build can go to its own folder (NEXT_DIST_DIR=.next-prod) so checking it never disturbs the dev server's .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The Brokers page is the Customers page now (a broker is one kind of customer); old links and bookmarks still land on it, query and all.
  async redirects() {
    return [
      { source: "/brokers", destination: "/customers", permanent: true },
      { source: "/brokers/:path*", destination: "/customers/:path*", permanent: true }
    ];
  },
  // Prisma must not be bundled: webpack would pull the stub PrismaClient and throw
  // "@prisma/client did not initialize yet" at runtime.
  experimental: {
    serverComponentsExternalPackages: ["@prisma/client"],
    // A rate confirmation chosen on the Rate confirmations page travels as a server-action upload; the default cap is 1 MB.
    serverActions: { bodySizeLimit: "10mb" }
  }
};

export default nextConfig;
