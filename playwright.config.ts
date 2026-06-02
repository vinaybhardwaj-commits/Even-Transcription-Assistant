import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config for ETA / Evenscribe. Runs against a deployed URL (default prod)
 * but every mutating/STT call is mocked in the specs (page.route), so tests
 * are hermetic and never create real encounters or send anything. Chromium is
 * launched with a fake audio device so MediaRecorder produces real chunks.
 *
 * Auth: global-setup logs in once with a real doctor PIN and saves the
 * eta_session cookie to storageState (so the server-gated /record page renders).
 *
 * NOTE: must be excluded from tsconfig (it imports @playwright/test, a CI-only
 * dep) so it doesn't break the Next prod typecheck.
 */
const BASE_URL = process.env.BASE_URL || "https://www.evenscribe.app";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: BASE_URL,
    storageState: "tests/e2e/.auth/doctor.json",
    permissions: ["microphone"],
    trace: "on-first-retry",
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
