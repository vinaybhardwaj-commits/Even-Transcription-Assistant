/**
 * Box reads for the FreeScript nightly: Sarvam consult_result export, REB role.llm-roles, FreeScript day.
 * Auth is checked before any SQL. Ids are synthetic. A role-track text field must not come back.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const H = vi.hoisted(() => ({ calls: 0, rows: [] as unknown[] }));
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray) => {
    H.calls += 1;
    void strings;
    return Promise.resolve(H.rows);
  },
}));

import { GET as dayGET } from "@/app/api/freescript/day/route";
import { GET as rolesGET } from "@/app/api/reb/roles/route";
import { GET as sarvamGET } from "@/app/api/sarvam/consult-results/route";
import { signFreescriptGet } from "@/lib/freescript/auth";
import { checkRebReadBearer } from "@/lib/reb/read-auth";
import { roleTrackPublic } from "@/lib/room-access/readers/reb-role-export";
import { setLabStoreForTests } from "@/lib/sarvam-lab";

const MARKER = "SYNTH_MARKER_NOT_A_NAME";
const UID = "synthuid01";
const KEY = `reb/2026-10-05/synthroom/_consults/${UID}/tracks/role.json`;
const sha = (b: string) => createHash("sha256").update(b, "utf8").digest("hex");

const mem = new Map<string, string>();
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["REB_INDEX_READ_TOKEN", "REB_INDEX_TOKEN", "FREESCRIPT_INGEST_SECRET", "ETA_FREESCRIPT"];

beforeEach(() => {
  H.calls = 0;
  H.rows = [];
  mem.clear();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  setLabStoreForTests({
    get: async (k) => (mem.has(k) ? { body: mem.get(k)!, etag: "e" } : null),
    put: async () => "ok",
    list: async () => [],
  });
});

afterEach(() => {
  setLabStoreForTests(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("REB read bearer", () => {
  it("503 when neither token is set, 401 on a mismatch, and accepts either name", () => {
    expect(checkRebReadBearer("Bearer rtok", {})).toEqual({ status: 503, error: "not_configured" });
    expect(checkRebReadBearer(null, { REB_INDEX_READ_TOKEN: "rtok" })).toEqual({ status: 401, error: "unauthorized" });
    expect(checkRebReadBearer("Bearer nope", { REB_INDEX_READ_TOKEN: "rtok" })).toEqual({ status: 401, error: "unauthorized" });
    expect(checkRebReadBearer("Bearer rtok", { REB_INDEX_READ_TOKEN: "rtok" })).toBeNull();
    expect(checkRebReadBearer("Bearer wtok", { REB_INDEX_TOKEN: "wtok" })).toBeNull();
    expect(H.calls).toBe(0);
  });
});

describe("roleTrackPublic", () => {
  it("copies roles and times and drops segment text", () => {
    const pub = roleTrackPublic({
      status: "ok",
      engine: "llm-roles",
      layer: "role",
      segments: [{ t0_ms: 0, t1_ms: 1000, speaker: "0", role: "doctor", text: MARKER }],
    });
    expect(pub).toEqual({ segments: [{ t0_ms: 0, t1_ms: 1000, speaker: "0", role: "doctor" }], flags: null });
    expect(JSON.stringify(pub)).not.toContain(MARKER);
  });
});

describe("GET /api/sarvam/consult-results", () => {
  const get = (qs: string, token: string | null) =>
    sarvamGET(new NextRequest(`http://x/api/sarvam/consult-results?${qs}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }));

  it("refuses before SQL when the token is unset or wrong", async () => {
    expect((await get("ist_date=2026-10-05", null)).status).toBe(503);
    process.env.REB_INDEX_READ_TOKEN = "rtok";
    expect((await get("ist_date=2026-10-05", "nope")).status).toBe(401);
    expect(H.calls).toBe(0);
  });

  it("returns heads for a day and refuses a bad date or an oversized batch", async () => {
    process.env.REB_INDEX_READ_TOKEN = "rtok";
    const day = await get("ist_date=2026-10-05", "rtok");
    expect(day.status).toBe(200);
    expect(await day.json()).toMatchObject({ ok: true, selector: "ist_date", ist_date: "2026-10-05", n: 0, rows: [], include_text: false });
    expect((await get("ist_date=2026-13-40", "rtok")).status).toBe(400);
    const many = Array.from({ length: 26 }, (_, i) => `synthuid${String(i).padStart(2, "0")}`).join(",");
    const over = await get(`consult_uids=${many}`, "rtok");
    expect(over.status).toBe(400);
    expect(await over.json()).toMatchObject({ ok: false, error: "bad_args" });
    expect(JSON.stringify(await (await get("consult_uids=synthuid01,synthuid02", "rtok")).json())).not.toContain("consult_uid_invalid");
  });
});

describe("GET /api/reb/roles", () => {
  const get = (qs: string, token: string | null) =>
    rolesGET(new NextRequest(`http://x/api/reb/roles?${qs}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }));

  it("refuses before SQL when the token is unset", async () => {
    expect((await get(`consult_uid=${UID}`, null)).status).toBe(503);
    expect(H.calls).toBe(0);
  });

  it("returns the role track without segment text", async () => {
    process.env.REB_INDEX_TOKEN = "wtok";
    const body = JSON.stringify({
      status: "ok",
      engine: "llm-roles",
      layer: "role",
      segments: [{ t0_ms: 10, t1_ms: 20, speaker: "1", role: "patient", text: MARKER }],
      extras: { two_consults: { flag: false } },
    });
    mem.set(KEY, body);
    H.rows = [{ window_id: `consult-${UID}`, room_id: "synthroom", r2_key: KEY, sha256: sha(body), config_hash: "c0ffee", ist_date: "2026-10-05" }];
    const res = await get(`consult_uid=${UID}`, "wtok");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      ok: true,
      selector: "consult_uids",
      n: 1,
      rows: [{ ok: true, consult_uid: UID, engine: "llm-roles", layer: "role", segments: [{ t0_ms: 10, t1_ms: 20, speaker: "1", role: "patient" }] }],
    });
    expect(JSON.stringify(json)).not.toContain(MARKER);
    expect(JSON.stringify(json)).not.toContain("text");
  });
});

describe("GET /api/freescript/day", () => {
  const path = "/api/freescript/day?ist_date=2026-10-05";
  const ts = Math.floor(Date.now() / 1000);
  const get = (qs: string, headers: Record<string, string> = {}) =>
    dayGET(new NextRequest(`http://x/api/freescript/day?${qs}`, { headers }));

  it("404 when the kill switch is off, before auth and SQL", async () => {
    process.env.ETA_FREESCRIPT = "0";
    process.env.FREESCRIPT_INGEST_SECRET = "s3cret";
    expect((await get("ist_date=2026-10-05")).status).toBe(404);
    expect(H.calls).toBe(0);
  });

  it("503 when the HMAC secret is unset, and 401 on a bad signature, before SQL", async () => {
    expect((await get("ist_date=2026-10-05")).status).toBe(503);
    process.env.FREESCRIPT_INGEST_SECRET = "s3cret";
    const bad = await get("ist_date=2026-10-05", { "x-freescript-ts": String(ts), "x-freescript-signature": "ab".repeat(32) });
    expect(bad.status).toBe(401);
    expect(H.calls).toBe(0);
  });

  it("returns stored rows for the day and refuses a bad date", async () => {
    process.env.FREESCRIPT_INGEST_SECRET = "s3cret";
    H.rows = [{
      run_id: 1,
      consult_uid: "synth-fs-1",
      ist_date: "2026-10-05",
      room_slug: "synth-room",
      room_id: "synth-room",
      validator_ok: true,
      validator_errors: [],
      artifact: { schema_version: "eta.freescript.v0.2", note_text: "Medication:" },
      completion_required: [],
    }];
    const headers = { "x-freescript-ts": String(ts), "x-freescript-signature": signFreescriptGet(path, "s3cret", ts) };
    const ok = await get("ist_date=2026-10-05", headers);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, selector: "ist_date", ist_date: "2026-10-05", n: 1, withheld_blind: 0 });
    const badDate = "/api/freescript/day?ist_date=2026-13-40";
    const refused = await get("ist_date=2026-13-40", {
      "x-freescript-ts": String(ts),
      "x-freescript-signature": signFreescriptGet(badDate, "s3cret", ts),
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ ok: false, error: "bad_date" });
  });
});
