const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:8080",
    headless: process.env.HEADLESS !== "false", // Run headless by default, use HEADLESS=false for headed
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: "bun run serve",
    url: "http://127.0.0.1:8080",
    reuseExistingServer: true,
    timeout: 30000,
  },
});
