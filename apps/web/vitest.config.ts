import { defineConfig } from "vitest/config";
import path from "node:path";

const alias = {
  "@": path.resolve(__dirname, "src")
};

export default defineConfig({
  resolve: {
    alias
  },
  test: {
    projects: [
      {
        resolve: {
          alias
        },
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/components/**/*.test.tsx", "tests/clerk-fallback.test.tsx"]
        }
      },
      {
        resolve: {
          alias
        },
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["tests/components/**/*.test.tsx", "tests/clerk-fallback.test.tsx"],
          setupFiles: ["tests/setup-dom.ts"]
        }
      }
    ],
  }
});
