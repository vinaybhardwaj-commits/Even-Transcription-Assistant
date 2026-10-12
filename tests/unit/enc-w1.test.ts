/**
 * enc-w1.test.ts — ENC-W1: zod schemas, the sync (sha check + upsert only of changed dates), the steward token door, item state transitions, and the PHI guard on body_md.
 * The store (SQL) and the lab store are fakes. All ids are fake. No real call is made.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({
  synced: new Map<string, { sha256: string | null; isolation_sha256: string | null }>(),
  roomDays: [] as unknown[],
  isolations: [] as unknown[],
  written: [] as Array<[string, unknown]>,
  items: new Map<string, string>(),
  moves: [] as Array<{ id: string; from: string; to: string; decided_by?: unknown; result?: unknown }>,
  created: [] as unknown[],
  admin: null as string | null,
  gate: { enabled: true, mode: "advise" } as { enabled: boolean; mode: string },
  settings: [] as Array<Record<string, unknown>>,
  openRuns: new Set<string>(),
}));
vi.mock("@/lib/db", () => ({ sql: () => { throw new Error("no sql in a unit test"); } }));
vi.mock("@/lib/enc/store", () => ({
  readSyncedShas: async () => new Map(S.synced),
  writeSyncedSha: async (d: string, v: unknown) => { S.written.push([d, v]); },
  upsertRoomDays: async (rows: unknown[]) => { S.roomDays.push(...rows); return rows.length; },
  upsertIsolations: async (rows: unknown[]) => { S.isolations.push(...rows); return rows.length; },
  getStewardGate: async () => ({ ...S.gate }),
  upsertStewardSettings: async (p: Record<string, unknown>) => { S.settings.push(p); },
  createRun: async () => "11111111-1111-4111-8111-111111111111",
  closeRun: async (id: string) => S.openRuns.has(id),
  createItem: async (v: { run_id: string }) => { S.created.push(v); return S.openRuns.has(v.run_id) ? "22222222-2222-4222-8222-222222222222" : null; },
  listItemsByState: async (state: string) => [{ state }],
  getItemState: async (id: string) => S.items.get(id) ?? null,
  moveItem: async (id: string, from: string, to: string, f: { decided_by?: unknown; result?: unknown } = {}) => {
    if (S.items.get(id) !== from) return false;
    S.items.set(id, to); S.moves.push({ id, from, to, ...f }); return true;
  },
}));
vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => (S.admin ? "jwt" : null) }));
vi.mock("@/lib/auth", () => ({ verifyAdminJwt: async () => ({ admin_id: S.admin ?? "x" }) }));

import { setLabStoreForTests, labReadable, type LabStore } from "@/lib/sarvam-lab";
import { isolationRowSchema, itemCreateSchema, roomDayRowSchema, runBodySchema } from "@/lib/enc/schemas";
import { changedDates, encDailyKey, encIsolationKey, parseDaily, parseIsolation, parseManifest, sha256Hex, syncEnc } from "@/lib/enc/sync";
import { phiGuard, phiGuardJson } from "@/lib/enc/phi-guard";
import { canTransition } from "@/lib/enc/transitions";
import { GET as syncGet, POST as syncPost } from "@/app/api/admin/enc-sync/route";
import { POST as runPost } from "@/app/api/admin/steward/run/route";
import { GET as itemsGet, POST as itemsPost } from "@/app/api/admin/steward/items/route";
import { PATCH as decide } from "@/app/api/admin/steward/items/[id]/route";
import { PATCH as settingsPatch } from "@/app/api/admin/steward/settings/route";
import { POST as resultPost } from "@/app/api/admin/steward/items/[id]/result/route";

const D = "2026-10-11";
const ROOM = "room_fake0001";
const UID = "fakeconsultuid0000001";
const RUN = "11111111-1111-4111-8111-111111111111";
const ITEM = "33333333-3333-4333-8333-333333333333";
const TOKEN = "fake-steward-token-for-tests";

const dayRow = (o: Record<string, unknown> = {}) => ({
  ist_date: D, room_id: ROOM, visits: 10, placed: 9, isolated: 8, isolated_pulse: 5, isolated_pqm: 3, not_isolated: 1,
  lane_sarvam: 8, lane_nemotron: 7, lane_role: 6, lane_parts: 0, rx_matched: 0, tape_hours: 7.5, status: "ok",
  alerts: [{ code: "GAP", message: "gap in tape", count: 1 }], computed_at: "2026-10-12T01:00:00+05:30", source: "recon-v1", ...o,
});
const isoRow = (o: Record<string, unknown> = {}) => ({
  consult_uid: UID, ist_date: D, room_id: ROOM, doctor_uid: "DOCFAKE1", t_start: "2026-10-11T10:00:00+05:30", t_end: "2026-10-11T10:10:00+05:30",
  boundary_source: "pulse", room_source: null, confidence: 0.9, status: "cut", skip_reason: null, r2_prefix: `consult-clips/${D}/x/${UID}`,
  lanes: { sarvam: true, nemotron: true, role: false, parts: false }, parts: null, rx: null, pqm_step_uid: null, ...o,
});

function fakeLab(files: Record<string, string>): LabStore {
  return {
    get: async (k) => (k in files ? { body: files[k]!, etag: "e" } : null),
    put: async () => "precondition_failed",
    list: async () => [],
  };
}
function setupLab(opts: { daily?: string; iso?: string; manifestSha?: string; isoSha?: string } = {}) {
  const daily = opts.daily ?? JSON.stringify([dayRow()]);
  const iso = opts.iso ?? JSON.stringify(isoRow()) + "\n";
  const manifest = { [D]: { sha256: opts.manifestSha ?? sha256Hex(daily), rows: 1, isolation_sha256: opts.isoSha ?? sha256Hex(iso), isolation_rows: 1 }, note: "ignored" };
  setLabStoreForTests(fakeLab({ "enc/manifest.json": JSON.stringify(manifest), [encDailyKey(D)]: daily, [encIsolationKey(D)]: iso }));
  return { daily, iso };
}

const req = (url: string, init: { method?: string; token?: string | null; body?: unknown } = {}) =>
  new NextRequest(`http://x.test${url}`, {
    method: init.method ?? "POST",
    headers: { ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` }), "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  S.synced.clear(); S.roomDays.length = 0; S.isolations.length = 0; S.written.length = 0; S.items.clear(); S.moves.length = 0; S.created.length = 0;
  S.settings.length = 0; S.gate = { enabled: true, mode: "advise" }; S.admin = null; S.openRuns = new Set([RUN]);
  setLabStoreForTests(null);
  process.env.ENC_STEWARD_TOKEN = TOKEN;
  process.env.CRON_SECRET = "fake-cron"; process.env.MIGRATION_SECRET = "fake-mig";
  process.env.SCRIBE_LAB_R2_ACCESS_KEY_ID = "a"; process.env.SCRIBE_LAB_R2_SECRET_ACCESS_KEY = "b"; process.env.SCRIBE_LAB_R2_ENDPOINT = "https://r2.invalid";
});

describe("schemas", () => {
  it("accepts a good room-day row and refuses a bad status, a negative count, an extra key and a bad date", () => {
    expect(roomDayRowSchema.safeParse(dayRow()).success).toBe(true);
    expect(roomDayRowSchema.safeParse(dayRow({ status: "bad" })).success).toBe(false);
    expect(roomDayRowSchema.safeParse(dayRow({ visits: -1 })).success).toBe(false);
    expect(roomDayRowSchema.safeParse(dayRow({ transcript: "text" })).success).toBe(false);
    expect(roomDayRowSchema.safeParse(dayRow({ ist_date: "11-10-2026" })).success).toBe(false);
  });
  it("accepts a good isolation row and refuses a bad boundary_source, a confidence over 1 and a free-text field", () => {
    expect(isolationRowSchema.safeParse(isoRow()).success).toBe(true);
    expect(isolationRowSchema.safeParse(isoRow({ parts: [{ part: "a", t0: 0, t1: 5, score: 0.5 }], rx: { matched: true, rx_ref: "ref1", mismatch: [] } })).success).toBe(true);
    expect(isolationRowSchema.safeParse(isoRow({ boundary_source: "guess" })).success).toBe(false);
    expect(isolationRowSchema.safeParse(isoRow({ confidence: 1.5 })).success).toBe(false);
    expect(isolationRowSchema.safeParse(isoRow({ transcript_text: "x" })).success).toBe(false);
  });
  it("run and item bodies: an action needs proposed_action, an unknown action type is refused", () => {
    expect(runBodySchema.safeParse({ op: "create", mode: "advise" }).success).toBe(true);
    expect(runBodySchema.safeParse({ op: "create", mode: "root" }).success).toBe(false);
    const base = { run_id: RUN, kind: "action", ist_date: D, title: "t", body_md: "b" };
    expect(itemCreateSchema.safeParse(base).success).toBe(false);
    expect(itemCreateSchema.safeParse({ ...base, proposed_action: { type: "recut", args: { consult_uid: UID } } }).success).toBe(true);
    expect(itemCreateSchema.safeParse({ ...base, proposed_action: { type: "deploy", args: {} } }).success).toBe(false);
    expect(itemCreateSchema.safeParse({ ...base, kind: "suggestion" }).success).toBe(true);
  });
});

describe("sync parsing", () => {
  it("manifest: ignores non-date keys, drops a bad entry, rejects a non-object", () => {
    const m = parseManifest(JSON.stringify({ [D]: { sha256: "a".repeat(64), rows: 1, isolation_sha256: "b".repeat(64), isolation_rows: 1 }, "2026-10-10": { sha256: "nope", rows: 1 }, "2026-10-09": { sha256: "a".repeat(64), rows: 1 }, other: 1 }));
    expect([...m!.entries.keys()]).toEqual([D]);
    expect(m!.dropped).toBe(2);
    expect(parseManifest("[]")).toBeNull();
    expect(parseManifest("not json")).toBeNull();
  });
  it("changedDates: only dates whose sha differs from the recorded one, newest first", () => {
    const e = (s: string) => ({ sha256: s.repeat(64), rows: 1, isolation_sha256: s.repeat(64), isolation_rows: 1 });
    const entries = new Map([["2026-10-09", e("a")], ["2026-10-10", e("b")], ["2026-10-11", e("c")]]);
    const synced = new Map([["2026-10-09", { sha256: "a".repeat(64), isolation_sha256: "a".repeat(64) }], ["2026-10-10", { sha256: "x".repeat(64), isolation_sha256: "b".repeat(64) }]]);
    expect(changedDates(entries, synced)).toEqual(["2026-10-11", "2026-10-10"]);
    expect(changedDates(entries, synced, 1)).toEqual(["2026-10-11"]);
  });
  it("daily and isolation files: bad rows and other-date rows are counted and dropped", () => {
    const d = parseDaily(JSON.stringify([dayRow(), dayRow({ status: "bad" }), dayRow({ ist_date: "2026-10-01" })]), D)!;
    expect(d.rows.length).toBe(1); expect(d.skipped).toBe(2);
    expect(parseDaily("{}", D)).toBeNull();
    const i = parseIsolation([JSON.stringify(isoRow()), "garbage", JSON.stringify(isoRow({ boundary_source: "x" })), ""].join("\n"), D);
    expect(i.rows.length).toBe(1); expect(i.skipped).toBe(2);
  });
});

describe("syncEnc", () => {
  it("reads the manifest, verifies sha256 and upserts a new date, then records its sha", async () => {
    const { daily, iso } = setupLab();
    const r = await syncEnc();
    expect(r.ok && r.dates_ok).toBe(1);
    expect(S.roomDays.length).toBe(1); expect(S.isolations.length).toBe(1);
    expect(S.written).toEqual([[D, { sha256: sha256Hex(daily), isolation_sha256: sha256Hex(iso) }]]);
  });
  it("upserts only changed dates: a date whose sha is already recorded writes nothing", async () => {
    const { daily, iso } = setupLab();
    S.synced.set(D, { sha256: sha256Hex(daily), isolation_sha256: sha256Hex(iso) });
    const r = await syncEnc();
    expect(r.ok && r.dates_changed).toBe(0);
    expect(S.roomDays.length).toBe(0); expect(S.written.length).toBe(0);
  });
  it("a sha256 mismatch writes NOTHING and records nothing", async () => {
    setupLab({ manifestSha: createHash("sha256").update("other").digest("hex") });
    const r = await syncEnc();
    expect(r.ok && r.outcomes.sha_mismatch).toBe(1);
    expect(S.roomDays.length).toBe(0); expect(S.isolations.length).toBe(0); expect(S.written.length).toBe(0);
  });
  it("an isolation sha mismatch also writes nothing for that date", async () => {
    setupLab({ isoSha: "0".repeat(64) });
    const r = await syncEnc();
    expect(r.ok && r.outcomes.sha_mismatch).toBe(1);
    expect(S.roomDays.length).toBe(0);
  });
  it("a skipped (invalid) row: valid rows are written, the date is NOT recorded as synced", async () => {
    setupLab({ daily: JSON.stringify([dayRow(), dayRow({ status: "bad" })]) });
    const r = await syncEnc();
    expect(r.ok && r.outcomes.bad_rows).toBe(1);
    expect(S.roomDays.length).toBe(1); expect(S.written.length).toBe(0);
  });
  it("a missing store or manifest is enc_unavailable; a manifest that is not an object is enc_manifest_bad", async () => {
    expect(await syncEnc()).toEqual({ ok: false, error: "enc_unavailable" });
    setLabStoreForTests(fakeLab({}));
    expect(await syncEnc()).toEqual({ ok: false, error: "enc_unavailable" });
    setLabStoreForTests(fakeLab({ "enc/manifest.json": "[]" }));
    expect(await syncEnc()).toEqual({ ok: false, error: "enc_manifest_bad" });
  });
  it("the lab store allowlist reads exactly the three enc key shapes", () => {
    expect(labReadable("enc/manifest.json")).toBe(true);
    expect(labReadable(`enc/daily/${D}.json`)).toBe(true);
    expect(labReadable(`enc/isolation/${D}.jsonl`)).toBe(true);
    expect(labReadable("enc/daily/../../secret.json")).toBe(false);
    expect(labReadable("enc/other.json")).toBe(false);
  });
  it("the cron door: GET needs CRON_SECRET or MIGRATION_SECRET; POST needs the admin cookie or MIGRATION_SECRET", async () => {
    expect((await syncGet(req("/api/admin/enc-sync", { method: "GET", token: null }))).status).toBe(401);
    expect((await syncGet(req("/api/admin/enc-sync", { method: "GET", token: "wrong" }))).status).toBe(401);
    setupLab();
    const ok = await syncGet(req("/api/admin/enc-sync", { method: "GET", token: "fake-cron" }));
    expect(ok.status).toBe(200);
    expect((await syncPost(req("/api/admin/enc-sync", { token: null }))).status).toBe(401);
    S.admin = "adm1";
    expect((await syncPost(req("/api/admin/enc-sync", { token: null }))).status).toBe(200);
  });
});

describe("steward token door", () => {
  it("unset token: 503 on every steward route; wrong or absent token: 401", async () => {
    delete process.env.ENC_STEWARD_TOKEN;
    expect((await runPost(req("/api/admin/steward/run", { body: { op: "create", mode: "advise" } }))).status).toBe(503);
    process.env.ENC_STEWARD_TOKEN = TOKEN;
    for (const token of [null, "wrong", ""]) {
      expect((await runPost(req("/api/admin/steward/run", { token, body: { op: "create", mode: "advise" } }))).status).toBe(401);
      expect((await itemsPost(req("/api/admin/steward/items", { token, body: {} }))).status).toBe(401);
      expect((await itemsGet(req("/api/admin/steward/items?state=approved", { method: "GET", token }))).status).toBe(401);
      expect((await resultPost(req(`/api/admin/steward/items/${ITEM}/result`, { token, body: { ok: true } }), params(ITEM))).status).toBe(401);
    }
  });
  it("a bad token never reaches the store", async () => {
    await runPost(req("/api/admin/steward/run", { token: "wrong", body: { op: "create", mode: "advise" } }));
    expect(S.created.length).toBe(0);
  });
  it("create run, close run (open run only), list approved items", async () => {
    const c = await runPost(req("/api/admin/steward/run", { body: { op: "create", mode: "advise", model: "m1" } }));
    expect(c.status).toBe(200); expect((await c.json()).id).toBe(RUN);
    expect((await runPost(req("/api/admin/steward/run", { body: { op: "close", id: RUN, status: "ok", summary_md: "3 rooms checked, 2 alerts" } }))).status).toBe(200);
    expect((await runPost(req("/api/admin/steward/run", { body: { op: "close", id: "44444444-4444-4444-8444-444444444444", status: "ok" } }))).status).toBe(409);
    const g = await itemsGet(req("/api/admin/steward/items?state=approved", { method: "GET" }));
    expect((await g.json()).items).toEqual([{ state: "approved" }]);
    expect((await itemsGet(req("/api/admin/steward/items?state=bogus", { method: "GET" }))).status).toBe(400);
  });
});

describe("PHI guard on body_md", () => {
  it("passes ids, counts, dates and times", () => {
    expect(phiGuard(`Room ${ROOM} on ${D}: 8 of 9 isolated, consult ${UID}, run ${RUN}, tape 7.5 h, 10:00 to 10:10.`)).toBeNull();
    expect(phiGuard("re-cut 3 consults, cost 0.42 usd, 12345 tokens")).toBeNull();
  });
  it("refuses long digit runs, emails and phone numbers", () => {
    expect(phiGuard("uhid 12345678901")).not.toBeNull();
    expect(phiGuard("ref 1234567")).not.toBeNull();
    expect(phiGuard("call +91 98765 43210")).not.toBeNull();
    expect(phiGuard("call 98765-43210")).not.toBeNull();
    expect(phiGuard("mail fake.person@example.com")).toBe("email");
  });
  it("walks nested JSON strings", () => {
    expect(phiGuardJson({ a: { b: ["fine", "9876543210"] } })).not.toBeNull();
    expect(phiGuardJson({ a: 5, b: "fine" })).toBeNull();
  });
  it("POST items: refuses PHI in body_md and in title with 422, writes nothing", async () => {
    const base = { run_id: RUN, kind: "suggestion", ist_date: D, title: "ok title", body_md: "ok body" };
    expect((await itemsPost(req("/api/admin/steward/items", { body: { ...base, body_md: "patient phone 9876543210" } }))).status).toBe(422);
    expect((await itemsPost(req("/api/admin/steward/items", { body: { ...base, body_md: "write to a.b@example.org" } }))).status).toBe(422);
    expect((await itemsPost(req("/api/admin/steward/items", { body: { ...base, title: "uhid 12345678901" } }))).status).toBe(422);
    expect(S.created.length).toBe(0);
    expect((await itemsPost(req("/api/admin/steward/items", { body: base }))).status).toBe(200);
    expect(S.created.length).toBe(1);
  });
  it("POST items: a closed or unknown run is 409; a bad body is 400", async () => {
    const base = { run_id: "55555555-5555-4555-8555-555555555555", kind: "suggestion", ist_date: D, title: "t", body_md: "b" };
    expect((await itemsPost(req("/api/admin/steward/items", { body: base }))).status).toBe(409);
    expect((await itemsPost(req("/api/admin/steward/items", { body: { ...base, kind: "nope" } }))).status).toBe(400);
  });
  it("POST result: PHI in result is refused with 422", async () => {
    S.gate.mode = "act"; S.items.set(ITEM, "approved");
    const r = await resultPost(req(`/api/admin/steward/items/${ITEM}/result`, { body: { ok: true, result: { note: "call 9876543210" } } }), params(ITEM));
    expect(r.status).toBe(422);
    expect(S.items.get(ITEM)).toBe("approved");
  });
});

describe("state transitions", () => {
  it("the table: only open->approved|rejected and approved->done|failed", () => {
    expect(canTransition("open", "approved")).toBe(true);
    expect(canTransition("open", "rejected")).toBe(true);
    expect(canTransition("approved", "done")).toBe(true);
    expect(canTransition("approved", "failed")).toBe(true);
    for (const [f, t] of [["open", "done"], ["open", "failed"], ["approved", "rejected"], ["approved", "open"], ["rejected", "approved"], ["done", "failed"], ["failed", "done"], ["done", "open"]] as const) {
      expect(canTransition(f, t)).toBe(false);
    }
  });
  it("PATCH needs an admin session: no cookie is 401, a steward bearer alone does not count", async () => {
    S.items.set(ITEM, "open");
    expect((await decide(req(`/api/admin/steward/items/${ITEM}`, { method: "PATCH", body: { state: "approved" } }), params(ITEM))).status).toBe(401);
    expect(S.items.get(ITEM)).toBe("open");
  });
  it("PATCH: open -> approved records decided_by; a second decision is 409; approved -> rejected is 409", async () => {
    S.admin = "adm1"; S.items.set(ITEM, "open");
    const ok = await decide(req(`/api/admin/steward/items/${ITEM}`, { method: "PATCH", token: null, body: { state: "approved" } }), params(ITEM));
    expect(ok.status).toBe(200);
    expect(S.moves[0]).toMatchObject({ from: "open", to: "approved", decided_by: "adm1" });
    expect((await decide(req(`/api/admin/steward/items/${ITEM}`, { method: "PATCH", token: null, body: { state: "rejected" } }), params(ITEM))).status).toBe(409);
    expect((await decide(req(`/api/admin/steward/items/${ITEM}`, { method: "PATCH", token: null, body: { state: "done" } }), params(ITEM))).status).toBe(400);
  });
  it("PATCH: unknown item is 404, a malformed id is 400", async () => {
    S.admin = "adm1";
    expect((await decide(req(`/api/admin/steward/items/${ITEM}`, { method: "PATCH", token: null, body: { state: "approved" } }), params(ITEM))).status).toBe(404);
    expect((await decide(req("/api/admin/steward/items/not-a-uuid", { method: "PATCH", token: null, body: { state: "approved" } }), params("not-a-uuid"))).status).toBe(400);
  });
  it("result: approved -> done / failed; an open item cannot get a result; a done item cannot be changed again", async () => {
    S.gate.mode = "act"; S.items.set(ITEM, "open");
    const r = (body: unknown) => resultPost(req(`/api/admin/steward/items/${ITEM}/result`, { body }), params(ITEM));
    expect((await r({ ok: true, result: { n: 1 } })).status).toBe(409);
    S.items.set(ITEM, "approved");
    const d = await r({ ok: true, result: { clips: 2 } });
    expect(d.status).toBe(200); expect((await d.json()).state).toBe("done");
    expect(S.moves[0]).toMatchObject({ from: "approved", to: "done", result: { clips: 2 } });
    expect((await r({ ok: false, result: {} })).status).toBe(409);
    S.items.set(ITEM, "approved");
    expect((await (await r({ ok: false, result: { reason: "timeout" } })).json()).state).toBe("failed");
  });
  it("result for an unknown item is 404", async () => {
    S.gate.mode = "act";
    expect((await resultPost(req(`/api/admin/steward/items/${ITEM}/result`, { body: { ok: true } }), params(ITEM))).status).toBe(404);
  });
});

describe("PATCH steward settings", () => {
  const patch = (body: unknown) => settingsPatch(req("/api/admin/steward/settings", { method: "PATCH", token: null, body }));
  it("needs an admin session; the steward bearer alone is 401", async () => {
    expect((await settingsPatch(req("/api/admin/steward/settings", { method: "PATCH", body: { enabled: true } }))).status).toBe(401);
    expect(S.settings.length).toBe(0);
  });
  it("upserts any of enabled, mode advise, daily_cap_usd, model_id", async () => {
    S.admin = "adm1";
    const r = await patch({ enabled: true, mode: "advise", daily_cap_usd: 5, model_id: "fake.model-v1:0" });
    expect(r.status).toBe(200);
    expect(S.settings[0]).toEqual({ enabled: true, mode: "advise", daily_cap_usd: 5, model_id: "fake.model-v1:0" });
    expect((await patch({ enabled: false })).status).toBe(200);
    expect(S.settings[1]).toEqual({ enabled: false });
  });
  it("mode act is 409 and writes nothing", async () => {
    S.admin = "adm1";
    expect((await patch({ mode: "act" })).status).toBe(409);
    expect((await patch({ enabled: true, mode: "act" })).status).toBe(409);
    expect(S.settings.length).toBe(0);
  });
  it("refuses an empty body, a cap outside 0..50, a wrong type and an unknown key", async () => {
    S.admin = "adm1";
    for (const b of [{}, { daily_cap_usd: 51 }, { daily_cap_usd: -1 }, { enabled: "yes" }, { mode: "root" }, { model_id: "" }, { other: 1 }]) {
      expect((await patch(b)).status).toBe(400);
    }
    expect((await patch({ daily_cap_usd: 0 })).status).toBe(200);
    expect((await patch({ daily_cap_usd: 50 })).status).toBe(200);
    expect(S.settings.length).toBe(2);
  });
});

describe("advise mode and the kill switch", () => {
  const item = (o: Record<string, unknown> = {}) => ({ run_id: RUN, kind: "suggestion", ist_date: D, title: "t", body_md: "b", ...o });
  const action = item({ kind: "action", proposed_action: { type: "recut", args: { consult_uid: UID } } });
  const result = (ok: boolean) => resultPost(req(`/api/admin/steward/items/${ITEM}/result`, { body: { ok, result: {} } }), params(ITEM));

  it("mode advise (and mode absent): a kind 'action' item is 409, a suggestion and a question are accepted", async () => {
    expect((await itemsPost(req("/api/admin/steward/items", { body: action }))).status).toBe(409);
    expect(S.created.length).toBe(0);
    expect((await itemsPost(req("/api/admin/steward/items", { body: item() }))).status).toBe(200);
    expect((await itemsPost(req("/api/admin/steward/items", { body: item({ kind: "question" }) }))).status).toBe(200);
  });
  it("mode act: an action item is accepted", async () => {
    S.gate.mode = "act";
    expect((await itemsPost(req("/api/admin/steward/items", { body: action }))).status).toBe(200);
  });
  it("mode advise: a result with ok:true (done) is 409 and the item does not move; ok:false (failed) is allowed", async () => {
    S.items.set(ITEM, "approved");
    expect((await result(true)).status).toBe(409);
    expect(S.items.get(ITEM)).toBe("approved");
    expect((await result(false)).status).toBe(200);
    expect(S.items.get(ITEM)).toBe("failed");
  });
  it("enabled=false: every steward POST is 423 and writes nothing; GET still reads", async () => {
    S.gate.enabled = false; S.items.set(ITEM, "approved");
    expect((await runPost(req("/api/admin/steward/run", { body: { op: "create", mode: "advise" } }))).status).toBe(423);
    expect((await itemsPost(req("/api/admin/steward/items", { body: item() }))).status).toBe(423);
    expect((await result(false)).status).toBe(423);
    expect(S.created.length).toBe(0); expect(S.moves.length).toBe(0);
    expect((await itemsGet(req("/api/admin/steward/items?state=approved", { method: "GET" }))).status).toBe(200);
  });
  it("a bad token is still 401 when the steward is disabled (auth first)", async () => {
    S.gate.enabled = false;
    expect((await runPost(req("/api/admin/steward/run", { token: "wrong", body: { op: "create", mode: "advise" } }))).status).toBe(401);
  });
});

describe("manifest needs both files", () => {
  it("an entry without isolation_sha256 is dropped, so its date is never synced", async () => {
    const daily = JSON.stringify([dayRow()]);
    setLabStoreForTests(fakeLab({ "enc/manifest.json": JSON.stringify({ [D]: { sha256: sha256Hex(daily), rows: 1 } }), [encDailyKey(D)]: daily }));
    const r = await syncEnc();
    expect(r.ok && r.dates_in_manifest).toBe(0);
    expect(S.roomDays.length).toBe(0);
  });
  it("a missing isolation file is 'missing' and writes nothing", async () => {
    const daily = JSON.stringify([dayRow()]);
    setLabStoreForTests(fakeLab({ "enc/manifest.json": JSON.stringify({ [D]: { sha256: sha256Hex(daily), rows: 1, isolation_sha256: "c".repeat(64), isolation_rows: 1 } }), [encDailyKey(D)]: daily }));
    const r = await syncEnc();
    expect(r.ok && r.outcomes.missing).toBe(1);
    expect(S.roomDays.length).toBe(0);
  });
});

describe("W2 client and W1 route agree", () => {
  it("the steward page sends one setting as { <name>: value }, which the route's schema accepts; the old { key, value } shape is refused", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/admin/enc/StewardClient.tsx", "utf8");
    expect(src).toContain('patchJson("/api/admin/steward/settings", { [key]: value })');
    const { settingsPatchSchema } = await import("@/lib/enc/schemas");
    expect(settingsPatchSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ mode: "advise" }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ key: "enabled", value: true }).success).toBe(false);
  });
});
