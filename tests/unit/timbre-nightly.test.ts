/**
 * timbre-nightly.test.ts — Timbre T-10 (#79): the consult list the nightly job scores, the 36-month retention cron and the
 * WavLM retirement switch. SQL / the consult_index store are mocked; all ids are fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const M = vi.hoisted(() => ({ sql: vi.fn(), listIndexDay: vi.fn(), blind: new Set<string>() }));
vi.mock("@/lib/db", () => ({ sql: M.sql }));
vi.mock("@/lib/room-access/consult-index-store", () => ({ listIndexDay: M.listIndexDay }));
vi.mock("@/lib/rubrics/blind-room-days", async (orig) => ({ ...(await orig<Record<string, unknown>>()), isBlindRoomDay: (d: string, r: string) => M.blind.has(`${d}|${r}`) }));

import { checkTimbreGet, signTimbreGet } from "@/lib/timbre/auth";
import { GET as consultsGET } from "@/app/api/timbre/consults/route";
import { GET as retentionGET } from "@/app/api/cron/timbre-retention/route";
import { purgeTimbre, timbreRetentionEnabled, TIMBRE_RETENTION_MONTHS } from "@/lib/timbre/retention";
import { emotionEnabled, wavlmRetired } from "@/lib/emotion/gate";
import { NextRequest } from "next/server";

const SECRET = "test-timbre-secret";
const SAVED = { ...process.env };
const row = (over: Record<string, unknown> = {}) => ({
  consult_uid: "cu_fake_1", room_id: "room_fake", room_slug: "opd-fake", ist_date: "2026-10-10", session_id: "sess_fake", t0_ms: 1000, t1_ms: 301000,
  clip_r2_key: "clips/fake/cu_fake_1.ogg", doctor_uid: "docFAKE1-rest-of-uid", doctor_identified: true, cut_version: "sig:x", code_commit: "c", sealed: true,
  voice_isolated: true, minutes: 5, bytes: 1, quality: "ok", coverage: 1, synced_at: "", first_seen_at: "", ...over,
});
const signed = (pq: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)) =>
  new NextRequest(`https://x.test${pq}`, { headers: { "x-timbre-ts": String(ts), "x-timbre-signature": signTimbreGet(pq, secret, ts) } });

beforeEach(() => {
  process.env.TIMBRE_INGEST = "1";
  process.env.TIMBRE_INGEST_SECRET = SECRET;
  process.env.CRON_SECRET = "cron-s3cret";
  delete process.env.TIMBRE_RETENTION;
  M.sql.mockReset();
  M.sql.mockResolvedValue([]);
  M.listIndexDay.mockReset();
  M.blind = new Set();
});
afterEach(() => { process.env = { ...SAVED }; });

describe("GET /api/timbre/consults", () => {
  it("404 while TIMBRE_INGEST is off; 503 without a secret; 401 on a bad or stale signature", async () => {
    process.env.TIMBRE_INGEST = "0";
    expect((await consultsGET(signed("/api/timbre/consults?date=2026-10-10"))).status).toBe(404);
    process.env.TIMBRE_INGEST = "1";
    expect((await consultsGET(signed("/api/timbre/consults?date=2026-10-10", "wrong"))).status).toBe(401);
    expect((await consultsGET(signed("/api/timbre/consults?date=2026-10-10", SECRET, Math.floor(Date.now() / 1000) - 3600))).status).toBe(401);
    // the signature covers the query: re-pointing a signed request at another day fails
    const ts = Math.floor(Date.now() / 1000);
    const forged = new NextRequest("https://x.test/api/timbre/consults?date=2026-10-09", { headers: { "x-timbre-ts": String(ts), "x-timbre-signature": signTimbreGet("/api/timbre/consults?date=2026-10-10", SECRET, ts) } });
    expect((await consultsGET(forged)).status).toBe(401);
    delete process.env.TIMBRE_INGEST_SECRET;
    expect((await consultsGET(signed("/api/timbre/consults?date=2026-10-10"))).status).toBe(503);
    expect(M.listIndexDay).not.toHaveBeenCalled();
  });
  it("400 on a bad date", async () => {
    for (const d of ["2026-13-01", "2026-02-30", "yesterday", ""]) expect((await consultsGET(signed(`/api/timbre/consults?date=${d}`))).status).toBe(400);
  });
  it("drops blind room-days before answering (counted, never named), skips clipless/unclosed rows (not unsealed), doctor_uid8 only", async () => {
    M.blind.add("2026-10-10|room_blind");
    M.listIndexDay.mockResolvedValue({ total: 5, rows: [row(), row({ consult_uid: "cu_fake_2", room_id: "room_blind", room_slug: "opd-blind" }), row({ consult_uid: "cu_fake_3", quality: "unclosed" }), row({ consult_uid: "cu_fake_5", sealed: false }), row({ consult_uid: "cu_fake_4", clip_r2_key: null })] });
    const res = await consultsGET(signed("/api/timbre/consults?date=2026-10-10"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(M.listIndexDay).toHaveBeenCalledWith("2026-10-10", null, 2000);
    expect(body).toMatchObject({ ok: true, date: "2026-10-10", withheld_blind: 1, skipped: 2, total: 5 });
    expect(body.consults).toHaveLength(2);
    expect(body.consults[1]).toMatchObject({ consult_uid: "cu_fake_5", sealed: false });
    expect(body.consults[0]).toEqual({ consult_uid: "cu_fake_1", cut_version: "sig:x", t0_ms: 1000, t1_ms: 301000, clip_r2_key: "clips/fake/cu_fake_1.ogg", room_id: "room_fake", room_slug: "opd-fake", session_id: "sess_fake", doctor_uid8: "docFAKE1", minutes: 5, quality: "ok", sealed: true });
    expect(JSON.stringify(body)).not.toMatch(/room_blind|opd-blind|rest-of-uid/);
  });
  it("adds no SQL outside the consult_index store", () => {
    expect(readFileSync("lib/timbre/consults.ts", "utf8")).not.toMatch(/from "@\/lib\/db"/);
  });
});

describe("checkTimbreGet", () => {
  it("is the nightly.py signature", () => {
    // tools/timbre/nightly.py::sign_get: hmac.new(secret, f"{ts}.GET {pq}", sha256)
    expect(signTimbreGet("/api/timbre/consults?date=2026-10-10", "k", 1_760_000_000)).toBe("5346d1846297634db9b5a4542f28154aee72da55d1acddc0003b0af042b68065"); // pinned in tools/timbre/tests/test_nightly.py too
    const h = new Headers({ "x-timbre-ts": "1760000000", "x-timbre-signature": signTimbreGet("/p?q=1", "k", 1_760_000_000) });
    expect(checkTimbreGet(h, "/p?q=1", { TIMBRE_INGEST_SECRET: "k" }, 1_760_000_100)).toBeNull();
    expect(checkTimbreGet(h, "/p?q=2", { TIMBRE_INGEST_SECRET: "k" }, 1_760_000_100)).toEqual({ status: 401, error: "unauthorized" });
  });
});

describe("36-month retention (/api/cron/timbre-retention)", () => {
  const req = (auth?: string) => new Request("https://x.test/api/cron/timbre-retention", { headers: auth ? { authorization: auth } : {} });
  it("auth: 503 without CRON_SECRET, 401 on a wrong bearer; nothing runs", async () => {
    delete process.env.CRON_SECRET;
    expect((await retentionGET(req("Bearer x"))).status).toBe(503);
    process.env.CRON_SECRET = "cron-s3cret";
    expect((await retentionGET(req("Bearer nope"))).status).toBe(401);
    expect(M.sql).not.toHaveBeenCalled();
  });
  it("TIMBRE_RETENTION=0 switches it off; default is on", async () => {
    expect(timbreRetentionEnabled({})).toBe(true);
    expect(timbreRetentionEnabled({ TIMBRE_RETENTION: "0" })).toBe(false);
    process.env.TIMBRE_RETENTION = "0";
    const res = await retentionGET(req("Bearer cron-s3cret"));
    expect(await res.json()).toMatchObject({ enabled: false, windows: 0 });
    expect(M.sql).not.toHaveBeenCalled();
  });
  it("36 months for every table, windows -> consults -> runs -> unreferenced maps, batched until empty", async () => {
    expect(TIMBRE_RETENTION_MONTHS).toBe(36);
    M.sql.mockResolvedValueOnce(Array(5000).fill(1)).mockResolvedValueOnce(Array(7).fill(1)).mockResolvedValueOnce([])
      .mockResolvedValueOnce(Array(3).fill(1)).mockResolvedValueOnce([])
      .mockResolvedValueOnce([1]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([1, 1]);
    const res = await retentionGET(req("Bearer cron-s3cret"));
    expect(await res.json()).toEqual({ enabled: true, windows: 5007, consults: 3, runs: 1, calibration_maps: 2, budget_hit: false });
    const texts = M.sql.mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?"));
    expect(texts[0]).toMatch(/DELETE FROM affect_window/);
    expect(texts[3]).toMatch(/DELETE FROM affect_consult/);
    expect(texts[5]).toMatch(/DELETE FROM affect_run/);
    expect(texts[7]).toMatch(/DELETE FROM affect_calibration_map[\s\S]*NOT EXISTS/);
    for (const c of M.sql.mock.calls) expect(c.slice(1)).toContain(36);
    for (const t of texts) expect(t).not.toMatch(/room_emotion|room_span|consult_index|bench_/);
  });
  it("stops at the budget", async () => {
    let t = 0;
    M.sql.mockResolvedValue([1]);
    const out = await purgeTimbre({ budgetMs: 10, now: () => (t += 3) });
    expect(out.budget_hit).toBe(true);
  });
  it("is a daily cron in vercel.json", () => {
    const crons = (JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> }).crons;
    expect(crons.find((c) => c.path === "/api/cron/timbre-retention")?.schedule).toBe("50 21 * * *");
  });
});

describe("WavLM retirement (EMOTION_WAVLM_RETIRED)", () => {
  it("unset means retired: EMOTION_ENABLED alone enables nothing", () => {
    expect(wavlmRetired({})).toBe(true);
    expect(emotionEnabled({ EMOTION_ENABLED: "1" })).toBe(false);
    expect(emotionEnabled({ EMOTION_ENABLED: "1", EMOTION_WAVLM_RETIRED: "on" })).toBe(false);
    expect(emotionEnabled({ EMOTION_ENABLED: "1", EMOTION_WAVLM_RETIRED: "0" })).toBe(true);
    expect(emotionEnabled({ EMOTION_WAVLM_RETIRED: "0" })).toBe(false);
  });
});
