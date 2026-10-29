/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
