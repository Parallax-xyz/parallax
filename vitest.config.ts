import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

// Tests run against the TypeScript sources of every workspace package (no build needed).
export default defineConfig({
  resolve: {
    alias: {
      "@parallax/privacy/browser": src("privacy/src/browser.ts"),
      "@parallax/strategy": src("strategy/src/index.ts"),
      "@parallax/indicators": src("indicators/src/index.ts"),
      "@parallax/exchange": src("exchange/src/index.ts"),
      "@parallax/risk": src("risk/src/index.ts"),
      "@parallax/runner": src("runner/src/index.ts"),
      "@parallax/solana": src("solana/src/index.ts"),
      "@parallax/privacy": src("privacy/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
