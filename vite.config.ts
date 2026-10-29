import { defineConfig } from "vitest/config";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  base: "./",
  // the sigma-rust binding imports its .wasm as a module (wasm-bindgen's bundler target); the plugin makes that a
  // fetched asset instantiated at load, in the chunk that is only imported when the phone path is chosen
  plugins: [wasm()],
  build: { target: "esnext", outDir: "dist", sourcemap: true },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
