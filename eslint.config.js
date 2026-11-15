import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    ".next/**",
    ".open-next/**",
    ".wrangler/**",
    "dist/**",
    "dist-ssr/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "docs/experiments/**",
    "experiments/**",
    "**/*.d.ts",
  ]),
  js.configs.recommended,
  nextVitals,
  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: [
          "./tsconfig.json",
          "./tsconfig.tools.json",
          "./tsconfig.worker.json",
          "./tsconfig.worker-tests.json",
          "./tsconfig.auth-tests.json",
          "./tsconfig.db-tests.json",
          "./tests/e2e/tsconfig.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: ["src/{components,hooks,stores,lib}/**/*.{ts,tsx}", "src/App.tsx", "src/main.tsx"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["*.{js,ts}", "src/app/api/**/*.ts", "src/db/**/*.ts", "tests/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["src/{components,hooks,stores}/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/db/**",
                "@/auth/**",
                "@/server/**",
                "@/providers/**",
                "@/services/**",
                "@/telemetry/**",
                "**/db/**",
                "**/auth/**",
                "**/server/**",
                "**/providers/**",
                "**/services/**",
                "**/telemetry/**",
                "node:*",
                "assemblyai",
                "groq-sdk",
                "postgres",
                "drizzle-orm",
                "drizzle-orm/**",
                "@pydantic/**",
                "@opennextjs/**",
                "wrangler",
              ],
              message:
                "Client code calls an API; server services, providers and secrets stay on the server.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/{domain,services}/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "next",
                "next/**",
                "react",
                "react-dom",
                "react-dom/**",
                "@/components/**",
                "@/stores/**",
              ],
              message: "Application operations must be callable from both routes and Workers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/{db,domain,services,providers,telemetry}/**/*.ts", "src/app/api/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "window", message: "This module runs on the server." },
        { name: "document", message: "This module runs on the server." },
        { name: "localStorage", message: "This module runs on the server." },
      ],
    },
  },
  prettier,
);
