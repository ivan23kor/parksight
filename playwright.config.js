const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30000,
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:8080",
    headless: process.env.HEADLESS !== "false", // Run headless by default, use HEADLESS=false for headed
    viewport: { width: 1280, height: 720 },
    trace: "on", // Record trace for all tests (view with: npx playwright show-trace trace.zip)
    video: process.env.RECORD_VIDEO === "on" ? "on" : "off", // Record video if RECORD_VIDEO=on (for eval inspector tests)
  },
  webServer: {
    command: "bun run start",
    url: "http://127.0.0.1:8080",
    reuseExistingServer: true,
    timeout: 120000,
  },
});
