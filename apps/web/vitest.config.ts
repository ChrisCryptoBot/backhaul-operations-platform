import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The database tests share one database and count its rows, so a file must not run while another is writing.
    fileParallelism: false
  }
});
