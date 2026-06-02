import { test, expect, type Page } from "@playwright/test";

/**
 * Recording → submit e2e against the REAL deployed client bundle, with every
 * mutating/STT call mocked so nothing real is created/sent. The headline test
 * regression-guards B18/B19: with IndexedDB disabled (iOS Private Browsing),
 * Submit must STILL upload audio via the in-memory failsafe.
 *
 * Button accessible names (aria-label) are "Start recording" (idle) and
 * "Finalize recording" (while recording) — NOT the visible "Record"/"Stop".
 */
const SLUG = process.env.PLAYWRIGHT_DOCTOR_SLUG || "dr-vinay-bhardwaj-cjzs";
const MOCK_R2 = "https://mock-r2.evenscribe-e2e.invalid/put";

type Hits = { uploadUrl: boolean; r2PutBytes: number; finalize: boolean };

/** Mock the whole client side of the pipeline; record what was hit.
 *  Playwright checks the LAST-registered matching route first, so the broad
 *  fail-closed guard is registered FIRST and the specific mocks AFTER it. */
async function installMocks(page: Page): Promise<Hits> {
  const hits: Hits = { uploadUrl: false, r2PutBytes: 0, finalize: false };

  // Fail-closed FIRST (lowest precedence): any unmocked mutating call to the
  // encounters API is aborted so a missed mock can never touch real prod data.
  await page.route("**/api/encounters/**", (route) =>
    route.request().method() === "GET" ? route.continue() : route.abort(),
  );

  // Specific mocks AFTER (higher precedence):
  await page.route(`**/${SLUG}/api/encounters`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ encounter: { id: "enc_e2e_test", status: "draft" } }) }),
  );
  await page.route(`**/${SLUG}/api/encounters/*/upload-url`, (route) => {
    hits.uploadUrl = true;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: MOCK_R2, key: "encounters/enc_e2e_test.webm", method: "PUT", content_type: "audio/webm" }) });
  });
  await page.route(MOCK_R2, async (route) => {
    const body = route.request().postDataBuffer();
    hits.r2PutBytes = body ? body.length : 0;
    return route.fulfill({ status: 200, body: "" });
  });
  await page.route(`**/${SLUG}/api/encounters/*/finalize-upload`, (route) => {
    hits.finalize = true;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ encounter: { id: "enc_e2e_test", status: "processing" } }) });
  });
  // Live STT / cleanup / speaker — benign so the live path quietly no-ops.
  await page.route("**/api/voice/stt-token", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE", message: "streaming_not_configured" } }) }));
  for (const p of ["**/api/transcribe/**", "**/api/voice/**"]) {
    await page.route(p, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  }
  // Deterministic preflight: all services healthy (avoids slow real /api/health
  // from the CI runner to the Mac Mini tunnels making preflight flaky).
  await page.route("**/api/health", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, sha: "e2e", region: "ci", services: { db: { ok: true }, kb: { ok: true }, llm: { ok: true }, whisper: { ok: true }, resend: { ok: true }, r2: { ok: true } } }) }));
  return hits;
}

/** Dismiss preflight deterministically: wait until EITHER the "Record anyway"
 *  modal button (degraded — e.g. IndexedDB blocked) OR the record button is
 *  visible, then click "Record anyway" if it's the one showing. */
async function passPreflight(page: Page) {
  const recordAnyway = page.getByRole("button", { name: /record anyway/i });
  const recordBtn = page.getByRole("button", { name: "Start recording" });
  await expect(recordAnyway.or(recordBtn)).toBeVisible({ timeout: 20000 });
  if (await recordAnyway.isVisible().catch(() => false)) await recordAnyway.click();
}

const RECORD = "Start recording";
const STOP = "Finalize recording";

async function recordAndSubmit(page: Page) {
  await passPreflight(page);
  await page.getByRole("button", { name: RECORD }).click();
  await expect(page.getByRole("button", { name: STOP })).toBeVisible();
  await page.waitForTimeout(2500); // ~10 chunks at 250ms
  await page.getByRole("button", { name: STOP }).click();
  const submit = page.getByRole("button", { name: /submit recording/i });
  await expect(submit).toBeVisible({ timeout: 10000 });
  await submit.click();
}

test("authed recording page renders with a Record control (smoke)", async ({ page }) => {
  await installMocks(page);
  await page.goto(`/${SLUG}/record`);
  await passPreflight(page);
  await expect(page.getByRole("button", { name: RECORD })).toBeVisible({ timeout: 20000 });
});

test("B18 regression: Submit still uploads audio when IndexedDB is unavailable (Private Browsing)", async ({ page }) => {
  await page.addInitScript(() => {
    const broken = { open() { throw new DOMException("IndexedDB disabled", "InvalidStateError"); } };
    try { Object.defineProperty(window, "indexedDB", { configurable: true, get: () => broken }); } catch { /* ignore */ }
  });
  const hits = await installMocks(page);
  await page.goto(`/${SLUG}/record`);
  await recordAndSubmit(page);
  await expect.poll(() => hits.finalize, { timeout: 15000 }).toBe(true);
  expect(hits.uploadUrl).toBe(true);
  expect(hits.r2PutBytes).toBeGreaterThan(0);
});

// TODO(next): mic-denied scenario (separate context, denied mic permission).
