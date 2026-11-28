import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import prettier from "eslint-config-prettier/flat";
import stylistic from "@stylistic/eslint-plugin";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import tseslint from "typescript-eslint";

// Grow this list with each verified domain slice instead of reformatting unrelated work.
const qualityFiles = [
  "src/ai/**/*.ts",
  "src/{contracts,db}/analysis/**/*.ts",
  "src/server/analysis.ts",
  "src/config/**/*.ts",
  "src/queries/**/*.{ts,tsx}",
  "src/{contracts,server,db,stores}/notes{.ts,/**/*.ts}",
  "src/{contracts,server,db,stores}/people{.ts,/**/*.ts}",
  "src/server/trpc/http.ts",
  "src/server/trpc/{assistant,research}.ts",
  "src/server/{assistant,research}.ts",
  "src/{contracts,db}/{assistant,inference,research,conversation-summaries}/**/*.ts",
  "src/db/{assistant,inference,research,conversation-summary}-schema.ts",
  "src/app/api/[[]procedure]/route.ts",
  "src/lib/{query-runtime,workspace-api}.ts",
  "src/hooks/{use-note-autosave,use-workspace-queries,use-transcript-corrections}.ts",
];

const domainImports = {
  regex: "^@/(contracts|server|db|queries|stores|components)/(notes|people|analysis)/",
  message: "Import the domain's public entry point; internal files use sibling imports.",
};

export default defineConfig(
  globalIgnores([
    ".next/**",
    ".open-next/**",
    "**/.wrangler/**",
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
      "no-restricted-imports": ["error", { patterns: [domainImports] }],
    },
  },
  // Pick the owning program for test/tool files instead of loading every
  // overlapping application/Worker program during typed linting.
  ...[
    {
      files: ["scripts/*.ts", "{drizzle,open-next,playwright,vite}.config.ts"],
      project: "./tsconfig.tools.json",
    },
    { files: ["tests/db/**/*.ts"], project: "./tsconfig.db-tests.json" },
    { files: ["tests/auth/**/*.ts"], project: "./tsconfig.auth-tests.json" },
    { files: ["tests/worker/**/*.ts"], project: "./tsconfig.worker-tests.json" },
    { files: ["tests/e2e/**/*.ts"], project: "./tests/e2e/tsconfig.json" },
  ].map(({ files, project }) => ({
    files,
    languageOptions: { parserOptions: { project: [project] } },
  })),
  {
    files: [
      "src/{components,hooks,stores,queries,lib}/**/*.{ts,tsx}",
      "src/App.tsx",
      "src/main.tsx",
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["*.{js,ts}", "src/app/api/**/*.ts", "src/db/**/*.ts", "tests/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["src/{components,hooks,stores,queries}/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            domainImports,
            {
              group: [
                "@/db/**",
                "@/auth/**",
                "@/server/**",
                "@/providers/**",
                "@/services/**",
                "@/telemetry/**",
                "@/ai/**",
                "**/db/**",
                "**/auth/**",
                "**/server/**",
                "**/providers/**",
                "**/services/**",
                "**/telemetry/**",
                "**/ai/**",
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
            domainImports,
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
  {
    files: qualityFiles,
    plugins: { "@stylistic": stylistic, "simple-import-sort": simpleImportSort },
    rules: {
      curly: ["error", "all"],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      // These add semantic spacing without fighting Prettier's line wrapping.
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: "return" },
        { blankLine: "always", prev: "*", next: ["function", "class", "interface", "type"] },
        { blankLine: "always", prev: ["function", "class", "interface", "type"], next: "*" },
        { blankLine: "always", prev: "block-like", next: "*" },
      ],
    },
  },
  {
    files: [
      "src/ai/{assistant,inference,research,conversation-summaries}/**/*.ts",
      "src/ai/assistant-services.ts",
      "src/{contracts,db}/{assistant,inference,research,conversation-summaries}/**/*.ts",
      "src/config/{assistant,research,conversation-summary}.ts",
      "src/server/{assistant,research}.ts",
      "src/server/trpc/{assistant,research}.ts",
    ],
    rules: {
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
        { blankLine: "always", prev: "*", next: ["if", "for", "while", "switch", "try", "return"] },
        { blankLine: "always", prev: "*", next: ["function", "class", "interface", "type"] },
        { blankLine: "always", prev: ["function", "class", "interface", "type"], next: "*" },
        { blankLine: "always", prev: "block-like", next: "*" },
      ],
    },
  },
);
