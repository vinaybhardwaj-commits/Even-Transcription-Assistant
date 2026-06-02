#!/usr/bin/env node
/**
 * ETA / Evenscribe production smoke test — non-mutating health/canary checks.
 * Run after every deploy and on a schedule. Catches server-side regressions
 * (services down, migrations not applied, pages 500ing, STT engines unhealthy)
 * before a clinician hits them. Does NOT create encounters or send anything.
 *
 * Usage:  node scripts/smoke.mjs
 * Env:    BASE_URL (default https://www.evenscribe.app)
 *         EXPECT_SHA (optional — assert the live build sha)
 *         SMOKE_DOCTOR_SLUG (optional — assert the doctor PIN page renders)
 *         SMOKE_ADMIN_EMAIL + SMOKE_ADMIN_PASSWORD (optional — assert STT-lab engine health)
 */
const BASE = (process.env.BASE_URL || "https://www.evenscribe.app").replace(/\/$/, "");
const EXPECT_SHA = process.env.EXPECT_SHA || null;
const results = [];
const rec = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const get = (path, opts = {}) => fetch(BASE + path, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(20000), ...opts });

async function checkHealth() {
  try {
    const r = await get("/api/health");
    const j = await r.json();
    rec("health.ok", j.ok === true, `sha=${j.sha} region=${j.region}`);
    if (EXPECT_SHA) rec("health.sha", (j.sha || "").startsWith(EXPECT_SHA), `live=${j.sha} expect=${EXPECT_SHA}`);
    for (const svc of ["db", "kb", "llm", "whisper", "resend", "r2"]) {
      const p = j.services?.[svc];
      rec(`service.${svc}`, !!p && p.ok === true, p ? `${p.latency_ms}ms` : "missing");
    }
  } catch (e) { rec("health.reachable", false, String(e).slice(0, 120)); }
}

async function checkMigrations() {
  try {
    const r = await get("/api/run-migrations");
    const j = await r.json();
    const applied = Array.isArray(j.applied) ? j.applied.length : 0;
    rec("migrations.applied", applied > 0 && j.errored == null, `${applied} applied, errored=${JSON.stringify(j.errored)}`);
  } catch (e) { rec("migrations.reachable", false, String(e).slice(0, 120)); }
}

async function checkPage(path, name) {
  try {
    const r = await get(path);
    rec(name, r.status === 200 || r.status === 307 || r.status === 308, `HTTP ${r.status}`);
  } catch (e) { rec(name, false, String(e).slice(0, 120)); }
}

async function checkSttLab() {
  const email = process.env.SMOKE_ADMIN_EMAIL, password = process.env.SMOKE_ADMIN_PASSWORD;
  if (!email || !password) { console.log("SKIP  stt-lab.health (no SMOKE_ADMIN_* creds)"); return; }
  try {
    const login = await fetch(BASE + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(20000) });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    rec("admin.login", login.status === 200 && cookie.includes("eta_admin_session"), `HTTP ${login.status}`);
    if (!cookie) return;
    const h = await fetch(BASE + "/api/admin/stt-lab/health", { headers: { cookie }, cache: "no-store", signal: AbortSignal.timeout(25000) });
    const j = await h.json();
    const engines = j.engines || [];
    const unhealthy = engines.filter((e) => e.has_adapter && e.enabled && !(e.health && e.health.ok)).map((e) => e.id);
    rec("stt-lab.engines", unhealthy.length === 0, unhealthy.length ? `unhealthy: ${unhealthy.join(",")}` : `${engines.length} engines ok`);
  } catch (e) { rec("stt-lab.health", false, String(e).slice(0, 120)); }
}

(async () => {
  console.log(`# ETA smoke test → ${BASE}`);
  await checkHealth();
  await checkMigrations();
  await checkPage("/", "page.home");
  if (process.env.SMOKE_DOCTOR_SLUG) await checkPage(`/${process.env.SMOKE_DOCTOR_SLUG}`, "page.doctor");
  await checkSttLab();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n# ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log(`# FAILURES: ${failed.map((f) => f.name).join(", ")}`); process.exit(1); }
})();
