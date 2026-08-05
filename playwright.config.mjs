// import { defineConfig, devices } from "@playwright/test";
import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.test.mjs",
  timeout: 20_000,
  retries: 0,
  reporter: "list",

  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
    // Don't persist any browser storage between tests
    storageState: undefined,
  },

  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 720 },
      },
    },
  ],

  webServer: {
    command: `node ${path.join(__dirname, "tests/e2e/serve.js")}`,
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
});
