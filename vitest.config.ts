import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // test/e2e runs against a real `vscode` module inside a real extension
    // host (see test/e2e/runTest.ts, `npm run test:e2e`) -- vitest has no
    // such module to resolve and isn't the right runner for it.
    exclude: ["**/node_modules/**", "test/e2e/**"],
  },
});
