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
    // Unit tests have no database: the spend ledger (server/tl/usage.ts) is off for them. tests/integration/usage.integration.test.ts turns it on.
    env: { DESK_SPEND_METER: "off" },
    include: ["tests/**/*.test.ts"],
    // The database tests share one database and count its rows, so a file must not run while another is writing.
    fileParallelism: false
  }
});
