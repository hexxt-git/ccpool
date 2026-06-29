import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Resolve workspace packages to their source so the suite runs without a build,
// identically under Node and Bun.
export default defineConfig({
  resolve: {
    alias: {
      "@ccshare/core": r("./packages/core/src/index.ts"),
      "@ccshare/storage-libsql": r("./packages/storage-libsql/src/index.ts"),
      "@ccshare/storage-postgres": r("./packages/storage-postgres/src/index.ts"),
      "@ccshare/daemon": r("./packages/daemon/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "apps/**/*.test.tsx"],
    environment: "node",
  },
});
