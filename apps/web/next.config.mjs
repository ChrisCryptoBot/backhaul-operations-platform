/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Prisma must not be bundled: webpack would pull the stub PrismaClient and throw
  // "@prisma/client did not initialize yet" at runtime.
  experimental: {
    serverComponentsExternalPackages: ["@prisma/client"],
    // A rate confirmation chosen on the Rate confirmations page travels as a server-action upload; the default cap is 1 MB.
    serverActions: { bodySizeLimit: "10mb" }
  }
};

export default nextConfig;
