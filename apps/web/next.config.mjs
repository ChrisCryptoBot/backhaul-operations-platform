/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Prisma must not be bundled: webpack would pull the stub PrismaClient and throw
  // "@prisma/client did not initialize yet" at runtime.
  experimental: {
    serverComponentsExternalPackages: ["@prisma/client"]
  }
};

export default nextConfig;
