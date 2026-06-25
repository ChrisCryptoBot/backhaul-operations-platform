import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devHelperModulePath = path.resolve(__dirname, "src/app/(auth)/sign-in/[[...sign-in]]/dev-signin-helper.tsx");
const devHelperStubPath = path.resolve(__dirname, "src/app/(auth)/sign-in/[[...sign-in]]/dev-signin-helper.stub.tsx");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Prisma must not be bundled: webpack would pull the stub PrismaClient and throw
  // "@prisma/client did not initialize yet" at runtime.
  experimental: {
    serverComponentsExternalPackages: ["@prisma/client"]
  },
  webpack: (config, { dev }) => {
    if (!dev) {
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        [devHelperModulePath]: devHelperStubPath
      };
    }
    return config;
  }
};

export default nextConfig;
