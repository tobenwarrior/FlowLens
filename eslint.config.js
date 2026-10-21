import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      ".local/**",
      "artifacts/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      // TypeScript resolves names, including DOM and Node globals.
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    files: ["**/*.{js,mjs}"],
    extends: [js.configs.recommended],
    rules: { "no-unused-vars": ["error", { ignoreRestSiblings: true }] },
    languageOptions: {
      globals: Object.fromEntries(
        [
          "Buffer",
          "console",
          "process",
          "URL",
          "fetch",
          "setTimeout",
          "clearTimeout",
          "document",
          "localStorage",
          "window",
          "structuredClone",
        ].map((name) => [name, "readonly"]),
      ),
    },
  },
]);
