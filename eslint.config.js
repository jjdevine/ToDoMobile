const eslint = require("@eslint/js");
const globals = require("globals");

module.exports = [
  eslint.configs.recommended,
  {
    files: ["core.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ["app.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        SUPABASE_ANON_KEY: "readonly",
        SUPABASE_PUBLISHABLE_KEY: "readonly",
        SUPABASE_URL: "readonly",
      },
    },
  },
  {
    files: ["sw.js"],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
        CACHE_FILES: "readonly",
        CACHE_VERSION: "readonly",
      },
    },
  },
  {
    files: ["build.js", "eslint.config.js", "tests/*.test.mjs", "tests/core*.test.mjs", "tests/e2e/serve.js"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["tests/e2e/**"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
];