const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:8080",
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: "bun run serve",
    url: "http://127.0.0.1:8080",
    reuseExistingServer: true,
    timeout: 30000,
  },
});
