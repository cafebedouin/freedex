import { defineConfig } from "vitest/config";

// base "./" so the built page works at any path (user.github.io/repo/ or a bare host)
export default defineConfig({
  base: "./",
  build: { target: "esnext", outDir: "dist", sourcemap: true },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
