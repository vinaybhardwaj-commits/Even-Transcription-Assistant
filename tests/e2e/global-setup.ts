import { request } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Log in once with a real doctor PIN and persist the eta_session cookie so the
 * server-gated /{slug}/record page renders in tests. A CORRECT PIN does not
 * trigger lockout. Requires PLAYWRIGHT_DOCTOR_PIN (a CI secret).
 */
const BASE_URL = process.env.BASE_URL || "https://www.evenscribe.app";
const SLUG = process.env.PLAYWRIGHT_DOCTOR_SLUG || "dr-vinay-bhardwaj-cjzs";
const PIN = process.env.PLAYWRIGHT_DOCTOR_PIN;

export default async function globalSetup() {
  if (!PIN) throw new Error("PLAYWRIGHT_DOCTOR_PIN env var required (real 4-digit PIN for PLAYWRIGHT_DOCTOR_SLUG)");
  mkdirSync("tests/e2e/.auth", { recursive: true });
  const ctx = await request.newContext({ baseURL: BASE_URL });
  const res = await ctx.post("/api/auth/pin", { data: { slug: SLUG, pin: PIN } });
  if (!res.ok()) throw new Error(`PIN login failed: HTTP ${res.status()} — ${(await res.text()).slice(0, 200)}`);
  await ctx.storageState({ path: "tests/e2e/.auth/doctor.json" });
  await ctx.dispose();
}
