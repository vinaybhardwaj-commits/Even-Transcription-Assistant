import { test, expect, type Page } from "@playwright/test";

/**
 * Recording → submit e2e against the REAL deployed client bundle, with every
 * mutating/STT call mocked so nothing real is created/sent. The headline test
 * regression-guards B18/B19: with IndexedDB disabled (iOS Private Browsing),
 * Submit must STILL upload audio via the in-memory failsafe.
 */
const SLUG = process.env.PLAYWRIGHT_DOCTOR_SLUG || "dr-vinay-bhardwaj-cjzs";
const MOCK_R2 = "https://mock-r2.evenscribe-e2e.invalid/put";

type Hits = { uploadUrl: boolean; r2PutBytes: number; finalize: boolean };

/** Mock the whole client side of the pipeline; record what was hit. */
async function installMocks(page: Page): Promise<Hits> {
  const hits: Hits = { uploadUrl: false, r2PutBytes: 0, finalize: false };

  // Create draft encounter
  await page.route(`**/${SLUG}/api/encounters`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ encounter: { id: "enc_e2e_test", status: "draft" } }) }),
  );
  // Presigned upload URL → point at our intercepted mock R2
  await page.route(`**/${SLUG}/api/encounters/*/upload-url`, (route) => {
    hits.uploadUrl = true;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: MOCK_R2, key: "encounters/enc_e2e_test.webm", method: "PUT", content_type: "audio/webm" }) });
  });
  // The R2 PUT itself — capture the uploaded byte count (proves audio existed)
  await page.route(`${MOCK_R2}`, async (route) => {
    const body = route.request().postDataBuffer();
    hits.r2PutBytes = body ? body.length : 0;
    return route.fulfill({ status: 200, body: "" });
  });
  // Finalize
  await page.route(`**/${SLUG}/api/encounters/*/finalize-upload`, (route) => {
    hits.finalize = true;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ encounter: { id: "enc_e2e_test", status: "processing" } }) });
  });
  // Live STT / cleanup / speaker — benign so the live path quietly no-ops.
  await page.route("**/api/voice/stt-token", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE", message: "streaming_not_configured" } }) }));
  for (const p of ["**/api/transcribe/**", "**/api/voice/identify", "**/api/voice/transcribe-window"]) {
    await page.route(p, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  }
  // FAIL-CLOSED: any other POST/PUT to our encounters API that we did not mock
  // is aborted, so a missed mock can never create/mutate real prod data.
  await page.route("**/api/encounters/**", (route) => {
    const m = route.request().method();
    if (m === "GET") return route.continue();
    return route.abort();
  });
  return hits;
}

/** Click through the preflight modal (auto-proceeds when healthy; "Record anyway" when degraded). */
async function passPreflight(page: Page) {
  const recordAnyway = page.getByRole("button", { name: /record anyway/i });
  try { await recordAnyway.click({ timeout: 6000 }); } catch { /* auto-proceeded */ }
}

async function recordAndSubmit(page: Page) {
  await passPreflight(page);
  await page.getByRole("button", { name: /^record$/i }).click();
  await expect(page.getByRole("button", { name: /^stop$/i })).toBeVisible();
  await page.waitForTimeout(2500); // ~10 chunks at 250ms
  await page.getByRole("button", { name: /^stop$/i }).click();
  const submit = page.getByRole("button", { name: /submit recording/i });
  await expect(submit).toBeVisible({ timeout: 10000 });
  await submit.click();
}

test("authed recording page renders with a Record control (smoke)", async ({ page }) => {
  await installMocks(page);
  await page.goto(`/${SLUG}/record`);
  await passPreflight(page);
  await expect(page.getByRole("button", { name: /^record$/i })).toBeVisible();
});

test("B18 regression: Submit still uploads audio when IndexedDB is unavailable (Private Browsing)", async ({ page }) => {
  // Simulate iOS Safari Private Browsing: IndexedDB.open throws.
  await page.addInitScript(() => {
    const broken = { open() { throw new DOMException("IndexedDB disabled", "InvalidStateError"); } };
    try { Object.defineProperty(window, "indexedDB", { configurable: true, get: () => broken }); } catch { /* ignore */ }
  });
  const hits = await installMocks(page);
  await page.goto(`/${SLUG}/record`);
  await recordAndSubmit(page);
  // The in-memory failsafe must have supplied the chunks: audio reached R2 + finalize ran.
  await expect.poll(() => hits.finalize, { timeout: 15000 }).toBe(true);
  expect(hits.uploadUrl).toBe(true);
  expect(hits.r2PutBytes).toBeGreaterThan(0);
});

// TODO(next): mic-denied scenario (separate context without --use-fake-ui + denied
// microphone permission → assert graceful permission_denied UI, no crash).
