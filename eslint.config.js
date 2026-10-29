// ESLint: typescript-eslint's recommended rules over the page, the tests and the scripts.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: { globals: { ...globals.browser, ...globals.node, ergoConnector: "readonly" } },
  },
  {
    files: ["scripts/**/*.{ts,mjs}", "*.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
);
