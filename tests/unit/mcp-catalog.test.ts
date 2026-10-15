/**
 * CATALOG-1 (14 Oct 2026) — scribe_catalog: search filters, get layers and the contract's selection rules, the clip URL, the room-access and blind rules, the door.
 * The lab store is an in-memory LabStore (setLabStoreForTests, so the real allowlist runs); sql, R2 signing, jev, rubric and freescript reads are mocked. Ids are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const H = vi.hoisted(() => ({
  sqlCalls: [] as Array<{ text: string; values: unknown[] }>,
  rooms: [] as Array<{ id: string; slug: string; name: string; disabled_at: null }>,
  freescriptRows: [] as Array<Record<string, unknown>>,
  indexRows: [] as Array<Record<string, unknown>>,
  identity: [] as Array<Record<string, unknown>>,
  identityThrows: null as string | null,
  identityQueries: [] as Array<{ uids: string[]; withRx: boolean }>,
  clip: null as Uint8Array | null,
  clipRangeHeader: true,
  clipIgnoreRange: false,
  clipReadThrows: false,
  rangeCalls: [] as Array<{ key: string; start: number; end: number }>,
  headCalls: [] as string[],
  matchQueries: [] as Array<{ individual: string | null; prescription: string | null; from: string; to: string; cap: number }>,
  freescriptThrows: false,
  signCalls: [] as Array<Record<string, unknown>>,
  jev: [] as Array<Record<string, unknown>>,
  rubric: [] as Array<Record<string, unknown>>,
  rubricThrows: false,
  rubricFilters: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    H.sqlCalls.push({ text, values });
    if (/FROM room\b/.test(text) && /disabled_at/.test(text)) {
      const want = values.filter((v): v is string => typeof v === "string");
      return Promise.resolve(H.rooms.filter((r) => want.some((w) => w === r.id || w === r.slug || w.toLowerCase() === r.name.toLowerCase())));
    }
    if (/SELECT consult_uid FROM encounter_catalog/.test(text)) {
      if (H.identityThrows) return Promise.reject(Object.assign(new Error("no such table"), { code: H.identityThrows }));
      const both = /individual_uid = \?(::text)? AND prescription_uid = \?/.test(text);
      const ind = /individual_uid = \?/.test(text);
      const v = values as string[];
      const q = both ? { individual: v[0]!, prescription: v[1]!, from: v[2]!, to: v[3]!, cap: Number(v[4]) } : ind ? { individual: v[0]!, prescription: null, from: v[1]!, to: v[2]!, cap: Number(v[3]) } : { individual: null, prescription: v[0]!, from: v[1]!, to: v[2]!, cap: Number(v[3]) };
      H.matchQueries.push(q);
      return Promise.resolve(H.identity
        .filter((r) => (q.individual === null || r.individual_uid === q.individual) && (q.prescription === null || r.prescription_uid === q.prescription) && String(r.ist_date ?? "2026-10-05") >= q.from && String(r.ist_date ?? "2026-10-05") <= q.to)
        .slice(0, q.cap).map((r) => ({ consult_uid: r.consult_uid })));
    }
    if (/FROM encounter_catalog/.test(text)) {
      if (H.identityThrows) return Promise.reject(Object.assign(new Error("no such table"), { code: H.identityThrows }));
      const withRx = values[0] === true;
      const uids = values[1] as string[];
      H.identityQueries.push({ uids, withRx });
      return Promise.resolve(H.identity.filter((r) => uids.includes(r.consult_uid as string)).map((r) => ({ ...r, has_prescription: (r.prescription !== null && r.prescription !== undefined) || (r.prescription_uid !== null && r.prescription_uid !== undefined), prescription: withRx ? r.prescription ?? null : null })));
    }
    if (/FROM reb_track_index/.test(text)) return Promise.resolve(H.indexRows);
    if (/FROM freescript_latest/.test(text)) {
      if (H.freescriptThrows) return Promise.reject(Object.assign(new Error("boom"), { code: "42P01" }));
      return Promise.resolve(H.freescriptRows);
    }
    return Promise.resolve([]);
  };
  (sql as unknown as { transaction: unknown }).transaction = async () => [];
  return { sql, db: {} };
});
vi.mock("@/lib/r2", () => ({
  getObjectRange: vi.fn(async (key: string, start: number, end: number) => {
    H.rangeCalls.push({ key, start, end });
    if (H.clipReadThrows) throw new Error("r2 down");
    if (!H.clip) return null;
    if (start >= H.clip.length) return { outOfRange: true };
    if (H.clipIgnoreRange) return { bytes: H.clip.slice(), totalBytes: null }; // a server that ignores Range: the whole object, no Content-Range
    return { bytes: H.clip.slice(start, Math.min(end + 1, H.clip.length)), totalBytes: H.clipRangeHeader ? H.clip.length : null };
  }),
  headObject: vi.fn(async (key: string) => {
    H.headCalls.push(key);
    return { size: H.clip ? H.clip.length : null, content_type: null };
  }),
  signGetUrl: vi.fn(async (o: Record<string, unknown>) => {
    H.signCalls.push(o);
    return "https://signed.example/clip?X-Amz-Signature=SECRETSIG";
  }),
}));
vi.mock("@/lib/room-access/tool-reads", () => ({ listJevDecisions: vi.fn(async () => ({ rows: H.jev })) }));
vi.mock("@/lib/rubrics/store", () => ({
  listResults: vi.fn(async (f: Record<string, unknown>) => {
    H.rubricFilters.push(f);
    if (H.rubricThrows) throw Object.assign(new Error("down"), { code: "08006" });
    return H.rubric;
  }),
}));
vi.mock("@/lib/rubrics/blind-room-days", () => ({
  BLIND_ROOM_DAYS: [["2026-10-01", "room_blind"]],
  isBlindRoomDay: (d: string | null, r: string | null) => typeof d === "string" && typeof r === "string" && d.slice(0, 10) === "2026-10-01" && r === "room_blind",
  BlindRoomDayError: class extends Error {},
}));

import { setLabStoreForTests, ENCOUNTER_CATALOG_KEY, labReadable, type LabStore } from "@/lib/sarvam-lab";
import { catalogTool } from "@/lib/mcp/tools/catalog";
import { resetCatalogCacheForTests, readAudioFeaturesLayer, selectTrack, parseCatalog, type Track } from "@/lib/room-access/readers/catalog-consult";
import { ROOM_RESTRICTED_ALLOWED_TOOLS, type ToolContext } from "@/lib/mcp/registry";
import type { McpScope } from "@/lib/mcp/auth";

const CTX: ToolContext = { actor: "mcp:test", origin: "https://example.test", scopes: new Set<McpScope>(["read"]) };
const run = async (args: Row): Promise<Row> => (await catalogTool.handler(args, CTX)) as Row;
const ADMIN_CTX: ToolContext = { actor: "mcp:admin:tester", origin: "https://example.test", scopes: new Set<McpScope>(["read", "admin"]) };
const runA = async (args: Row): Promise<Row> => (await catalogTool.handler(args, ADMIN_CTX)) as Row;

// --- fixtures ---------------------------------------------------------------------------------------------------------------------------------
const UID = "UIDABCDEFGH1";
const tk = (kind: string, uid = UID, room = "room_a", day = "2026-10-05", cfg = "ab12cd34") => `reb/${day}/${room}/_consults/${uid}/tracks/${kind}__v1__${cfg}.json`;
const layer = (kind: string, uid = UID, status = "ok", extra: Row = {}) => ({ r2_key: tk(kind, uid), status, ...extra });
const crow = (uid: string, o: Row = {}): Row => ({
  consult_uid: uid, ist_date: "2026-10-05", doctor_uid: "doc00001", room_id: "room_a", t_open: 1_000_000, t_close: 1_000_000 + 600_000, source: "cutter",
  clip: { r2_key: `consult-clips/2026-10-05/opd-a/${uid}/consult.flac`, r2_status: "mirrored", signature_sha256: "s".repeat(64), audio_sha256: "a".repeat(64), bytes: 1234, minutes: 0.1 },
  layers: { stt: layer("stt.sarvam-saaras-v3", uid), translate: layer("translate.sarvam-saaras-v3", uid), diar_sarvam: null, diar_nemotron: null, role: layer("role.llm-roles", uid), parts: null },
  freescript: { artifact_id: 4, state: "ok" }, stages: { stt: { state: "ok", reason: null } }, first_gap: null, allowance: { earned_min: 1, spent_min: 1 },
  catalog_version: "c1", generated_at: "2026-10-14T01:00:00Z", extra_field: { keep: "me" }, ...o,
});
const jsonl = (rows: Row[], extra: string[] = []) => [...rows.map((r) => JSON.stringify(r)), ...extra].join("\n") + "\n";

const store = new Map<string, { body: string; etag: string | null; last_modified?: string | null }>();
const reads: string[] = [];
let failKey: string | null = null;
const lab: LabStore = {
  async get(key) {
    reads.push(key);
    if (failKey === key) throw new Error("r2 down");
    return store.get(key) ?? null;
  },
  async put() { return "ok"; },
  async list() { return []; },
};
const setCatalog = (rows: Row[], extra: string[] = [], etag: string | null = '"e1"') => store.set(ENCOUNTER_CATALOG_KEY, { body: jsonl(rows, extra), etag });
const setTrack = (key: string, body: Row, lm: string | null = null) => store.set(key, { body: JSON.stringify(body), etag: '"t"', last_modified: lm });

const T0 = 1_760_000_000_000; // manifest t0_ms (epoch): consult-scope segment times are epoch ms (X1)
const E = (rel: number) => T0 + rel;
const mkey = (uid = UID, room = "room_a", day = "2026-10-05") => `reb/${day}/${room}/_consults/${uid}/manifest.json`;
const setManifest = (o: Row = {}, uid = UID) => store.set(mkey(uid), { body: JSON.stringify({ source_kind: "consult_clip", clock: "tape_utc", t0_ms: T0, t1_ms: E(6000), audio: { duration_ms: 6000 }, ...o }), etag: null });
// 0.1 min = 6,000 ms clip. Sarvam overruns the end by <= 0.56 s: the last stt segment ends at 6,400.
const stt = (o: Row = {}): Row => ({
  layer: "stt", engine: "sarvam-saaras-v3", version: "v1", status: "ok", extras: {}, config: {},
  segments: [
    { t0_ms: E(0), t1_ms: E(2000), speaker: "0", lang: "hi-IN", text: "NATIVE0" },
    { t0_ms: E(2000), t1_ms: E(4000), speaker: "1", lang: "en-IN", text: "ENGLISH1" },
    { t0_ms: E(4000), t1_ms: E(6400), speaker: 2, lang: "hi-IN", text: "NATIVE2" },
  ], ...o,
});
const translate = (o: Row = {}): Row => ({
  layer: "translate", engine: "sarvam-saaras-v3", version: "v1", status: "ok", extras: {}, config: {},
  segments: [{ t0_ms: E(0), t1_ms: E(2000), speaker: "0", text: "TR0" }, { t0_ms: E(2000), t1_ms: E(4000), speaker: "1", text: "TR1" }, { t0_ms: E(4000), t1_ms: E(6400), speaker: "2", text: "TR2" }], ...o,
});
const roles = (o: Row = {}): Row => ({
  layer: "role", engine: "llm-roles", version: "v1", status: "ok", extras: { map: { "0": "doctor", "1": "patient", "2": "attender" } }, config: {},
  segments: [{ t0_ms: E(0), t1_ms: E(1900), speaker: "0", role: "doctor" }, { t0_ms: E(1900), t1_ms: E(4000), speaker: "1", role: "patient" }, { t0_ms: E(4000), t1_ms: E(6400), speaker: "2", role: "staff" }], ...o,
});
const seedLayers = () => {
  setManifest();
  setTrack(tk("stt.sarvam-saaras-v3"), stt());
  setTrack(tk("translate.sarvam-saaras-v3"), translate());
  setTrack(tk("role.llm-roles"), roles());
};

let logs: string[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T06:00:00Z")); // 11:30 IST on 2026-10-14
  H.sqlCalls = [];
  H.rooms = [{ id: "room_a", slug: "opd-a", name: "OPD A", disabled_at: null }, { id: "room_b", slug: "opd-b", name: "OPD B", disabled_at: null }];
  H.freescriptRows = [];
  H.indexRows = [];
  H.identity = [];
  H.identityThrows = null;
  H.identityQueries = [];
  H.matchQueries = [];
  H.clip = null;
  H.clipRangeHeader = true;
  H.clipIgnoreRange = false;
  H.clipReadThrows = false;
  H.rangeCalls = [];
  H.headCalls = [];
  H.freescriptThrows = false;
  H.signCalls = [];
  H.jev = [];
  H.rubric = [];
  H.rubricThrows = false;
  H.rubricFilters = [];
  store.clear();
  reads.length = 0;
  failKey = null;
  resetCatalogCacheForTests();
  setLabStoreForTests(lab);
  process.env.ETA_FREESCRIPT = "1";
  logs = [];
  for (const m of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); });
});
afterEach(() => {
  vi.useRealTimers();
  setLabStoreForTests(null);
  vi.restoreAllMocks();
});

// --- search -----------------------------------------------------------------------------------------------------------------------------------
describe("search", () => {
  const many = () => [
    crow("AAAAAA01", { t_open: 100, ist_date: "2026-10-01", doctor_uid: "docA", room_id: "room_a" }),
    crow("AAAAAA02", { t_open: 300, ist_date: "2026-10-03", doctor_uid: "docB", room_id: "room_b", source: "caa" }),
    crow("AAAAAA03", { t_open: 200, ist_date: "2026-10-02", doctor_uid: "docA", room_id: "room_a" }),
    crow("AAAAAA04", { t_open: 50, ist_date: "2026-09-10", doctor_uid: "docA", room_id: "room_a" }),
    crow("AAAAAA05", { t_open: 10, ist_date: "2026-09-01", doctor_uid: "docA", room_id: "room_a" }),
  ];
  const ALL = { from: "2026-09-09", to: "2026-10-14" };
  const uids = (o: Row) => (o.rows as Row[]).map((r) => r.consult_uid);

  it("reads the one exact key, sorts newest t_open first, and returns the documented envelope; the pre-2026-09-09 row never appears", async () => {
    setCatalog(many());
    const o = await run({ action: "search", ...ALL });
    expect(o).toMatchObject({ ok: true, total_matched: 4, next_cursor: null, n_bad_lines: 0, n_blind_excluded: 0, catalog_generated_at: "2026-10-14T01:00:00Z" });
    expect(uids(o)).toEqual(["AAAAAA02", "AAAAAA03", "AAAAAA01", "AAAAAA04"]);
    expect(reads).toEqual([ENCOUNTER_CATALOG_KEY]);
  });
  it("F4: neither from nor to = the last 30 IST days ending today, default_window:true; a to in the future is clamped to today with clamped:true", async () => {
    setCatalog([...many(), crow("AAAAAA06", { t_open: 400, ist_date: "2026-09-15" }), crow("AAAAAA07", { t_open: 20, ist_date: "2026-09-14" }), crow("AAAAAA08", { t_open: 500, ist_date: "2026-10-14" }), crow("AAAAAA09", { t_open: 600, ist_date: "2027-03-01" })]);
    const o = await run({ action: "search" });
    expect(o).toMatchObject({ ok: true, default_window: true });
    expect("clamped" in o).toBe(false);
    expect(uids(o)).toEqual(["AAAAAA08", "AAAAAA06", "AAAAAA02", "AAAAAA03", "AAAAAA01"]); // 2026-09-15 .. 2026-10-14 inclusive = 30 days; 09-14 and the 2027 row are out
    const f = await run({ action: "search", from: "2026-10-01", to: "2027-12-31" });
    expect(f).toMatchObject({ ok: true, clamped: true });
    expect("default_window" in f).toBe(false);
    expect(uids(f)).toEqual(["AAAAAA08", "AAAAAA02", "AAAAAA03", "AAAAAA01"]);
    expect(await run({ action: "search", from: "2026-10-01", to: "2026-10-14" })).not.toHaveProperty("clamped");
  });
  it("F3: from is clamped to 2026-09-09 BEFORE the 92-day check", async () => {
    vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
    setCatalog(many());
    const o = await run({ action: "search", from: "2026-06-01", to: "2026-10-05" });
    expect(o).toMatchObject({ ok: true, clamped: true });
    expect(uids(o)).toEqual(["AAAAAA02", "AAAAAA03", "AAAAAA01", "AAAAAA04"]);
  });
  it("filters: doctor_uid, room (slug, id and name resolve), source, from/to", async () => {
    setCatalog(many());
    expect(uids(await run({ action: "search", doctor_uid: "docA", ...ALL }))).toEqual(["AAAAAA03", "AAAAAA01", "AAAAAA04"]);
    expect(uids(await run({ action: "search", room: "opd-b", ...ALL }))).toEqual(["AAAAAA02"]);
    expect(uids(await run({ action: "search", room: "room_b", ...ALL }))).toEqual(["AAAAAA02"]);
    expect(uids(await run({ action: "search", room: "opd b", ...ALL }))).toEqual(["AAAAAA02"]);
    expect(uids(await run({ action: "search", source: "caa", ...ALL }))).toEqual(["AAAAAA02"]);
    expect(uids(await run({ action: "search", from: "2026-10-02", to: "2026-10-03" }))).toEqual(["AAAAAA02", "AAAAAA03"]);
    expect(await run({ action: "search", room: "nowhere" })).toEqual({ ok: false, error: "unknown_room" });
    expect(await run({ action: "search", source: "other" })).toMatchObject({ ok: false, error: "bad_args" });
  });
  it("a span over 92 days is bad_args; exactly 92 days passes; from alone and to alone get a 92-day partner", async () => {
    setCatalog(many());
    vi.setSystemTime(new Date("2027-03-01T06:00:00Z")); // far enough on that the clamped span can exceed 92 days
    expect(await run({ action: "search", from: "2026-09-09", to: "2026-12-10" })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await run({ action: "search", from: "2026-09-09", to: "2026-12-09" })).toMatchObject({ ok: true });
    expect(await run({ action: "search", from: "2026-13-40" })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await run({ action: "search", from: "2026-10-04", to: "2026-10-01" })).toMatchObject({ ok: false, error: "bad_args" });
    vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
    expect(uids(await run({ action: "search", from: "2026-10-02" }))).toEqual(["AAAAAA02", "AAAAAA03"]);
    expect(uids(await run({ action: "search", to: "2026-10-01" }))).toEqual(["AAAAAA01", "AAAAAA04"]);
  });
  it("nothing before 2026-09-09: an earlier from is clamped and says clamped:true; no clamp, no key", async () => {
    setCatalog(many());
    const o = await run({ action: "search", from: "2026-08-01", to: "2026-09-20" });
    expect(o).toMatchObject({ ok: true, clamped: true });
    expect(uids(o)).toEqual(["AAAAAA04"]);
    expect("clamped" in (await run({ action: "search", from: "2026-09-09", to: "2026-09-20" }))).toBe(false);
  });
  it("cursor pages through every row once; a made-up cursor is bad_args; limit caps at 200", async () => {
    setCatalog(many());
    const p1 = await run({ action: "search", limit: 3, ...ALL });
    expect(uids(p1)).toHaveLength(3);
    expect(typeof p1.next_cursor).toBe("string");
    const p2 = await run({ action: "search", limit: 3, cursor: p1.next_cursor, ...ALL });
    expect([...uids(p1), ...uids(p2)]).toEqual(["AAAAAA02", "AAAAAA03", "AAAAAA01", "AAAAAA04"]);
    expect(p2.next_cursor).toBeNull();
    expect(await run({ action: "search", cursor: "not a cursor!" })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await run({ action: "search", cursor: "AAAA" })).toMatchObject({ ok: false, error: "bad_args" });
    const big = Array.from({ length: 230 }, (_, i) => crow(`BIGROW${String(i).padStart(3, "0")}`, { t_open: i }));
    setCatalog(big);
    resetCatalogCacheForTests();
    expect(uids(await run({ action: "search", limit: 9999 }))).toHaveLength(200);
  });
  it("bad lines are skipped and counted; unknown keys pass through; layers lose r2_key and layers_present names the non-null ones", async () => {
    setCatalog([crow(UID)], ["{not json", "[1,2]", JSON.stringify({ no_uid: true }), ""]);
    const o = await run({ action: "search" });
    expect(o).toMatchObject({ ok: true, total_matched: 1, n_bad_lines: 3 });
    const r = (o.rows as Row[])[0]!;
    expect(r.extra_field).toEqual({ keep: "me" });
    expect(r.layers_present).toEqual(["stt", "translate", "role"]);
    expect(JSON.stringify(r.layers)).not.toContain("r2_key");
    expect((r.layers as Row).stt).toEqual({ status: "ok" });
    expect((r.layers as Row).parts).toBeNull();
  });
  it("blind room-days are left out and counted", async () => {
    setCatalog([crow("BLINDROW1", { ist_date: "2026-10-01", room_id: "room_blind" }), crow("OKROW0001")]);
    const o = await run({ action: "search" });
    expect(uids(o)).toEqual(["OKROW0001"]);
    expect(o).toMatchObject({ n_blind_excluded: 1, total_matched: 1 });
  });
  it("catalog_unavailable: no lab store, no object, a failing read", async () => {
    setLabStoreForTests(null);
    delete process.env.SCRIBE_LAB_R2_ACCESS_KEY_ID;
    expect(await run({ action: "search" })).toEqual({ ok: false, error: "catalog_unavailable" });
    setLabStoreForTests(lab);
    resetCatalogCacheForTests();
    expect(await run({ action: "search" })).toEqual({ ok: false, error: "catalog_unavailable" });
    setCatalog([crow(UID)]);
    failKey = ENCOUNTER_CATALOG_KEY;
    resetCatalogCacheForTests();
    expect(await run({ action: "search" })).toEqual({ ok: false, error: "catalog_unavailable" });
  });
  it("the process cache: a second call inside 5 minutes does not read; the parse is reused when the etag is unchanged", async () => {
    setCatalog([crow(UID)]);
    await run({ action: "search" });
    await run({ action: "search" });
    expect(reads).toHaveLength(1);
    const { loadCatalog } = await import("@/lib/room-access/readers/catalog-consult");
    const a = await loadCatalog(Date.now());
    const later = Date.now() + 6 * 60_000;
    const b = await loadCatalog(later);
    expect(reads).toHaveLength(2);
    expect(b).toBe(a); // same etag: the parsed index is reused
    setCatalog([crow(UID), crow("SECONDROW1")], [], '"e2"');
    const c = await loadCatalog(later + 6 * 60_000);
    expect(c!.rows.size).toBe(2);
  });
  it("the allowlist: the catalog key is readable, nothing near it is", () => {
    expect(labReadable(ENCOUNTER_CATALOG_KEY)).toBe(true);
    for (const k of ["palimpsest/ledger/", "palimpsest/ledger/other.jsonl", `${ENCOUNTER_CATALOG_KEY}.bak`, "palimpsest/ledger/../x", "palimpsest/ledger/encounter-catalog.json"]) expect(labReadable(k), k).toBe(false);
  });
  it("parseCatalog: a later line for a uid replaces the earlier", () => {
    const c = parseCatalog(jsonl([crow(UID, { generated_at: "2026-10-01T00:00:00Z", first: true }), crow(UID, { generated_at: "2026-10-02T00:00:00Z" })]));
    expect(c.rows.size).toBe(1);
    expect(c.rows.get(UID)!.first).toBeUndefined();
    expect(c.generated_at).toBe("2026-10-02T00:00:00Z");
  });
});

// --- get --------------------------------------------------------------------------------------------------------------------------------------
describe("get: arguments and the row", () => {
  it("bad uid is bad_args; unknown uid is not_found; blind is refused", async () => {
    setCatalog([crow(UID), crow("BLINDROW1", { ist_date: "2026-10-01", room_id: "room_blind" })]);
    for (const bad of ["", "abc", "has space1", "x".repeat(65), "a/b/c/d/e", "../../etc1"]) expect(await run({ action: "get", consult_uid: bad }), bad).toMatchObject({ ok: false, error: "bad_args" });
    expect(await run({ action: "get" })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await run({ action: "get", consult_uid: "NOSUCHUID1" })).toEqual({ ok: false, error: "not_found" });
    expect(await run({ action: "get", consult_uid: "BLINDROW1" })).toEqual({ ok: false, error: "blind_room_day" });
    expect(reads.filter((k) => k !== ENCOUNTER_CATALOG_KEY)).toEqual([]); // a refused uid reads no layer
  });
  it("returns the full row (unknown keys included) and all seven layer names, each {status, source, data}", async () => {
    setCatalog([crow(UID)]);
    seedLayers();
    const o = await run({ action: "get", consult_uid: UID });
    expect(o.ok).toBe(true);
    expect((o.row as Row).extra_field).toEqual({ keep: "me" });
    expect(((o.row as Row).layers as Row).stt).toMatchObject({ r2_key: tk("stt.sarvam-saaras-v3") });
    const layers = o.layers as Record<string, Row>;
    expect(Object.keys(layers)).toEqual(["transcript", "parts", "audio_features", "freescript", "rubric", "jev", "identity", "cdmss", "rx"]);
    for (const l of Object.values(layers)) expect(Object.keys(l).filter((k) => k !== "error").sort()).toEqual(["data", "source", "status"]);
    expect(layers.cdmss).toEqual({ status: "not_available", source: ["consult-audit S5 (pending)"], data: null });
  });
});

describe("get: transcript (contract §5)", () => {
  beforeEach(() => {
    setCatalog([crow(UID)]);
    seedLayers();
  });
  const tr = async (args: Row = {}) => ((await run({ action: "get", consult_uid: UID, ...args })).layers as Record<string, Row>).transcript!;

  it("include_text false (the default): no text_native, no text_en anywhere in the answer, and the transcript text is not in the JSON", async () => {
    const t = await tr();
    expect(t.status).toBe("ok");
    const d = t.data as Row;
    for (const s of d.segments as Row[]) {
      expect("text_native" in s).toBe(false);
      expect("text_en" in s).toBe(false);
    }
    const whole = JSON.stringify(await run({ action: "get", consult_uid: UID }));
    for (const w of ["NATIVE0", "ENGLISH1", "NATIVE2", "TR0", "TR1", "TR2"]) expect(whole).not.toContain(w);
    expect(d).toMatchObject({ clock: "ms_from_clip_start", duration_ms: 6000, n_segments: 3 });
    expect(t.source).toEqual([tk("stt.sarvam-saaras-v3"), tk("translate.sarvam-saaras-v3"), tk("role.llm-roles"), mkey()]);
  });
  it("include_text true: text_native from stt, text_en from translate at the same index; segments carry i, times, speaker, role, lang", async () => {
    const segs = ((await tr({ include_text: true })).data as Row).segments as Row[];
    expect(segs[0]).toEqual({ i: 0, t0_ms: 0, t1_ms: 2000, speaker: "0", role: "doctor", lang: "hi-IN", text_native: "NATIVE0", text_en: "TR0" });
    expect(segs[2]).toMatchObject({ speaker: "2", text_native: "NATIVE2", text_en: "TR2" }); // numeric speaker 2 becomes "2"
  });
  it("t1_ms is clamped to the clip duration (a Sarvam end overrun)", async () => {
    const segs = ((await tr()).data as Row).segments as Row[];
    expect(segs[2]!.t1_ms).toBe(6000);
    expect(Math.max(...segs.map((s) => s.t1_ms as number))).toBe(6000);
  });
  it("no translate track: text_en is the stt text where lang starts en, else null", async () => {
    store.delete(tk("translate.sarvam-saaras-v3"));
    const t = await tr({ include_text: true });
    const segs = (t.data as Row).segments as Row[];
    expect(segs.map((s) => s.text_en)).toEqual([null, "ENGLISH1", null]);
    expect(t.status).toBe("ok");
  });
  it("translate with a different segment count is matched by time overlap, not index", async () => {
    setTrack(tk("translate.sarvam-saaras-v3"), translate({ segments: [{ t0_ms: E(1000), t1_ms: E(3900), text: "ONE" }] }));
    const segs = ((await tr({ include_text: true })).data as Row).segments as Row[];
    expect(segs.map((s) => s.text_en)).toEqual(["ONE", "ONE", null]); // seg 2 (4000-6400) overlaps nothing; lang hi: no fallback
  });
  it("role: the role segment with the most overlap wins over the speaker map; then the map; else unknown", async () => {
    // seg 0 (0-2000) overlaps doctor (0-1900) by 1900 and patient (1900-4000) by 100: doctor. seg 2 overlaps "staff" though the map says attender: overlap wins.
    let segs = ((await tr()).data as Row).segments as Row[];
    expect(segs.map((s) => s.role)).toEqual(["doctor", "patient", "staff"]);
    // no overlapping role segment for seg 2: the track's speaker map answers
    setTrack(tk("role.llm-roles"), roles({ segments: [{ t0_ms: E(0), t1_ms: E(2000), speaker: "0", role: "doctor" }] }));
    segs = ((await tr()).data as Row).segments as Row[];
    expect(segs.map((s) => s.role)).toEqual(["doctor", "patient", "attender"]);
    // no map either: unknown
    setTrack(tk("role.llm-roles"), roles({ extras: {}, segments: [] }));
    segs = ((await tr()).data as Row).segments as Row[];
    expect(segs.map((s) => s.role)).toEqual(["unknown", "unknown", "unknown"]);
    // an invalid role string is unknown, never passed through
    setTrack(tk("role.llm-roles"), roles({ extras: {}, segments: [{ t0_ms: E(0), t1_ms: E(6400), speaker: "0", role: "wizard" }] }));
    segs = ((await tr()).data as Row).segments as Row[];
    expect(segs.every((s) => s.role === "unknown")).toBe(true);
  });
  it("no role layer on the row: roles are unknown and the call still succeeds", async () => {
    setCatalog([crow(UID, { layers: { stt: layer("stt.sarvam-saaras-v3"), translate: layer("translate.sarvam-saaras-v3"), role: null } })]);
    resetCatalogCacheForTests();
    const t = await tr();
    expect(t.status).toBe("ok");
    expect((((t.data as Row).segments) as Row[]).every((s) => s.role === "unknown")).toBe(true);
  });
  it("a translate read that fails degrades text_en only and says so; it does not fail the layer", async () => {
    failKey = tk("translate.sarvam-saaras-v3");
    const t = await tr({ include_text: true });
    expect(t.status).toBe("ok");
    expect((t.data as Row).degraded).toEqual(["translate:read_failed"]);
  });
  it("status: a track that is not ok is not used (layer absent); an empty or failed stt gives no transcript", async () => {
    for (const status of ["empty", "failed"]) {
      setTrack(tk("stt.sarvam-saaras-v3"), stt({ status }));
      const t = await tr();
      expect(t.status, status).toBe("absent");
      expect(t.data).toBeNull();
    }
  });
  it("a layer with no stt entry is absent; an absent object is absent", async () => {
    store.delete(tk("stt.sarvam-saaras-v3"));
    expect((await tr()).status).toBe("absent");
    setCatalog([crow(UID, { layers: { stt: null, translate: null, role: null, parts: null } })]);
    resetCatalogCacheForTests();
    const t = await tr();
    expect(t).toEqual({ status: "absent", source: [], data: null });
  });
  it("bad JSON and a track with no segments are layer errors, not call errors", async () => {
    store.set(tk("stt.sarvam-saaras-v3"), { body: "{nope", etag: null });
    expect(await tr()).toMatchObject({ status: "error", error: "bad_json", data: null });
    setTrack(tk("stt.sarvam-saaras-v3"), { status: "ok" });
    expect(await tr()).toMatchObject({ status: "error", error: "bad_track" });
  });
});

describe("selectTrack (contract §5 steps 1-3), pure", () => {
  const t = (key: string, body: Row, modified: string | null = null): Track => ({ key, modified, body });
  it("status ok only", () => {
    expect(selectTrack([t("a", { status: "failed" }), t("b", { status: "empty" })], "cutter")).toBeNull();
    expect(selectTrack([t("a", { status: "failed" }), t("b", { status: "ok" })], "cutter")!.key).toBe("b");
  });
  it("newest by extras.created_at, else last-modified; created_at beats an older modified time", () => {
    const a = t("a", { status: "ok", extras: { created_at: "2026-10-02T00:00:00Z" } }, "2026-10-09T00:00:00Z");
    const b = t("b", { status: "ok", extras: { created_at: "2026-10-03T00:00:00Z" } }, "2026-10-01T00:00:00Z");
    expect(selectTrack([a, b], "cutter")!.key).toBe("b");
    expect(selectTrack([t("old", { status: "ok" }, "2026-10-01T00:00:00Z"), t("new", { status: "ok" }, "2026-10-05T00:00:00Z")], "cutter")!.key).toBe("new");
  });
  it("version caa is never taken for a cutter consult, but is for a caa one", () => {
    const caa = t("caa", { status: "ok", version: "caa", extras: { created_at: "2026-10-09T00:00:00Z" } });
    const own = t("own", { status: "ok", version: "v1", extras: { created_at: "2026-10-01T00:00:00Z" } });
    expect(selectTrack([caa, own], "cutter")!.key).toBe("own");
    expect(selectTrack([caa], "cutter")).toBeNull();
    expect(selectTrack([caa, own], "caa")!.key).toBe("caa");
  });
  it("a cutter consult whose only transcript track is a caa version has no transcript", async () => {
    setCatalog([crow(UID)]);
    seedLayers();
    setTrack(tk("stt.sarvam-saaras-v3"), stt({ version: "caa" }));
    const t2 = ((await run({ action: "get", consult_uid: UID })).layers as Record<string, Row>).transcript!;
    expect(t2.status).toBe("absent");
  });
});

describe("get: key safety (D6)", () => {
  it("a layer key outside the REB consult shape is refused key_not_readable and nothing is read for it", async () => {
    const bad = ["reb/2026-10-05/room_a/w1/tracks/stt.x__v1__ab.json", "reb/2026-10-05/room_a/_consults/UIDABCDEFGH1/tracks/../../x.json", "bench/room/2026-10-05/s1/chunk_00001.webm", "palimpsest/ledger/encounter-catalog.jsonl", "consult/index/latest.jsonl"];
    for (const k of bad) {
      resetCatalogCacheForTests();
      setCatalog([crow(UID, { layers: { stt: { r2_key: k, status: "ok" }, translate: null, role: null, parts: { r2_key: k, status: "ok" } } })]);
      reads.length = 0;
      const l = (await run({ action: "get", consult_uid: UID })).layers as Record<string, Row>;
      expect(l.transcript, k).toMatchObject({ status: "error", error: "key_not_readable", data: null });
      expect(l.parts, k).toMatchObject({ status: "error", error: "key_not_readable" });
      expect(reads.filter((r) => r !== ENCOUNTER_CATALOG_KEY && !r.endsWith("/manifest.json")), k).toEqual([]);
    }
  });
  it("a non-string key is key_not_readable too", async () => {
    setCatalog([crow(UID, { layers: { stt: { r2_key: 42, status: "ok" }, translate: null, role: null, parts: null } })]);
    const l = (await run({ action: "get", consult_uid: UID })).layers as Record<string, Row>;
    expect(l.transcript).toMatchObject({ status: "error", error: "key_not_readable" });
  });
});

describe("get: parts", () => {
  const parts = (mode: string): Row => ({ layer: "parts", engine: "clef-jev", version: "v0", status: "ok", config: { clef_mode: mode }, extras: {}, segments: [{ part: "history", t0_ms: E(0), t1_ms: E(900), score: 0.8, confidence: 0.7, source: "jev" }] });
  it("clef+jev only: other modes are absent; the rows carry part, times, score, confidence, source", async () => {
    setCatalog([crow(UID, { layers: { stt: null, translate: null, role: null, parts: layer("parts.clef-jev") } })]);
    setTrack(tk("parts.clef-jev"), parts("clef+jev"));
    setManifest();
    let p = ((await run({ action: "get", consult_uid: UID })).layers as Record<string, Row>).parts!;
    expect(p).toEqual({ status: "ok", source: [tk("parts.clef-jev"), mkey()], data: [{ part: "history", t0_ms: 0, t1_ms: 900, score: 0.8, confidence: 0.7, source: "jev" }], n_clamped: 0 });
    setTrack(tk("parts.clef-jev"), parts("clef"));
    p = ((await run({ action: "get", consult_uid: UID })).layers as Record<string, Row>).parts!;
    expect(p).toMatchObject({ status: "absent", data: null });
  });
});

describe("get: db layers", () => {
  beforeEach(() => {
    setCatalog([crow(UID)]);
    seedLayers();
  });
  const layers = async (args: Row = {}) => (await run({ action: "get", consult_uid: UID, ...args })).layers as Record<string, Row>;
  const fsRow = { run_id: 4, consult_uid: UID, ist_date: "2026-10-05", room_id: "room_a", room_slug: "opd-a", validator_ok: true, validator_errors: [], artifact: { gp: "ARTIFACTTEXT" }, completion_required: [] };

  it("freescript: artifact_id, state, validator_status; the artifact only with include_text", async () => {
    H.freescriptRows = [fsRow];
    let f = (await layers()).freescript!;
    expect(f).toMatchObject({ status: "ok", source: ["freescript_latest"] });
    expect(f.data).toEqual({ artifact_id: 4, state: "ok", validator_status: { ok: true, errors: [] } });
    expect(JSON.stringify(f)).not.toContain("ARTIFACTTEXT");
    f = (await layers({ include_text: true })).freescript!;
    expect((f.data as Row).artifact).toEqual({ gp: "ARTIFACTTEXT" });
  });
  it("freescript: no row is absent; a db failure is a layer error with the sqlstate", async () => {
    expect((await layers()).freescript).toMatchObject({ status: "absent", data: null });
    H.freescriptThrows = true;
    expect((await layers()).freescript).toMatchObject({ status: "error", error: "db_error:42P01", data: null });
  });
  it("freescript uses the scribe_freescript read path (its SQL, bound to the uid), with no SQL of this file", async () => {
    H.freescriptRows = [fsRow];
    await layers();
    const q = H.sqlCalls.filter((c) => /freescript_latest/.test(c.text));
    expect(q).toHaveLength(1);
    expect(q[0]!.values).toContain(UID);
  });
  it("rubric: filtered to this consult's unit key; rows carry rubric_id, version, run_id, status, score, verdict, created_at; never findings or evidence", async () => {
    H.rubric = [{ rubric_id: "pitch_detect", version: "1.0.0", unit_kind: "consult", unit_key: UID, run_id: "rub_1", status: "ok", score: { n: 3, ok: true, verdict: "pass", note: "x".repeat(200), nested: { a: 1 } }, findings: ["FINDINGTEXT"], created_at: "2026-10-06T00:00:00Z", evidence_key: "k" }];
    const r = (await layers()).rubric!;
    expect(H.rubricFilters[0]).toMatchObject({ unit_kind: "consult", unit_key: UID });
    expect(r.status).toBe("ok");
    expect((r.data as Row[])[0]).toEqual({ rubric_id: "pitch_detect", version: "1.0.0", run_id: "rub_1", status: "ok", score: { n: 3, ok: true }, verdict: "pass", created_at: "2026-10-06T00:00:00Z" });
    expect(JSON.stringify(r)).not.toContain("FINDINGTEXT");
  });
  it("rubric: none is absent; a failure is a layer error and the call still answers", async () => {
    expect((await layers()).rubric).toMatchObject({ status: "absent" });
    H.rubricThrows = true;
    const l = await layers();
    expect(l.rubric).toMatchObject({ status: "error", error: "db_error:08006", data: null });
    expect(l.transcript!.status).toBe("ok");
    expect(l.jev!.status).toBe("absent");
  });
  it("jev: the consult's decisions with the probability fields named as stored; evidence is not returned", async () => {
    H.jev = [{ question_id: "q1", question_set_id: "pitch-detect", prompt_version: "v3", mode: "live", answer: "yes", probabilities: { yes: 0.8 }, calibrated_p: 0.7, mock: false, evidence: "EVIDENCETEXT", created_at: "2026-10-06T00:00:00Z" }];
    const j = (await layers()).jev!;
    expect(j.status).toBe("ok");
    expect(j.data).toEqual([{ question_id: "q1", question_set_id: "pitch-detect", prompt_version: "v3", mode: "live", answer: "yes", probabilities: { yes: 0.8 }, calibrated_p: 0.7, mock: false, created_at: "2026-10-06T00:00:00Z" }]);
    expect(JSON.stringify(j)).not.toContain("EVIDENCETEXT");
    const { listJevDecisions } = await import("@/lib/room-access/tool-reads");
    expect(vi.mocked(listJevDecisions)).toHaveBeenLastCalledWith(expect.objectContaining({ subjectType: "consult", subjectId: UID }));
  });
  it("one layer throwing (transcript read) does not fail the call or any other layer", async () => {
    failKey = tk("stt.sarvam-saaras-v3");
    H.freescriptRows = [fsRow];
    const o = await run({ action: "get", consult_uid: UID });
    expect(o.ok).toBe(true);
    const l = o.layers as Record<string, Row>;
    expect(l.transcript).toMatchObject({ status: "error", error: "read_failed" });
    expect(l.freescript!.status).toBe("ok");
  });
  it("no PHI reaches a log line: nothing logged on a normal get", async () => {
    H.freescriptRows = [fsRow];
    await layers({ include_text: true });
    expect(logs.join("\n")).not.toMatch(/NATIVE|ENGLISH|TR[012]|ARTIFACTTEXT/);
  });
});

// --- clip -------------------------------------------------------------------------------------------------------------------------------------
describe("clip_audio_url", () => {
  it("presigns the row's own clip key for 900 s and returns the documented shape", async () => {
    setCatalog([crow(UID)]);
    const o = await run({ action: "clip_audio_url", consult_uid: UID });
    expect(o).toMatchObject({ ok: true, url: expect.stringContaining("https://signed.example/"), bytes: 1234, minutes: 0.1, signature_sha256: "s".repeat(64) });
    expect(Object.keys(o).sort()).toEqual(["bytes", "expires_at", "minutes", "ok", "signature_sha256", "url"]);
    expect(H.signCalls).toEqual([{ key: `consult-clips/2026-10-05/opd-a/${UID}/consult.flac`, expiresInSeconds: 900 }]);
    const ttl = Date.parse(o.expires_at as string) - Date.now();
    expect(ttl).toBeGreaterThan(890_000);
    expect(ttl).toBeLessThanOrEqual(900_000);
  });
  it("a key that is not under consult-clips/, holds .., is missing or is not a string is bad_clip_key and is never signed", async () => {
    for (const k of ["bench/room/2026-10-05/s1/chunk_00001.webm", "clips/s1/a.webm", "consult-clips/../bench/x.flac", "consult-clips/2026-10-05/../../x", "/consult-clips/x", "Consult-clips/x", "", 7, null, undefined]) {
      resetCatalogCacheForTests();
      setCatalog([crow(UID, { clip: { r2_key: k, bytes: 1, minutes: 1 } })]);
      expect(await run({ action: "clip_audio_url", consult_uid: UID }), String(k)).toEqual({ ok: false, error: "bad_clip_key" });
    }
    resetCatalogCacheForTests();
    setCatalog([crow(UID, { clip: undefined })]);
    expect(await run({ action: "clip_audio_url", consult_uid: UID })).toEqual({ ok: false, error: "bad_clip_key" });
    expect(H.signCalls).toEqual([]);
  });
  it("bad uid, unknown uid and a blind room-day are refused before signing", async () => {
    setCatalog([crow(UID), crow("BLINDROW1", { ist_date: "2026-10-01", room_id: "room_blind" })]);
    expect(await run({ action: "clip_audio_url", consult_uid: "x" })).toMatchObject({ error: "bad_args" });
    expect(await run({ action: "clip_audio_url", consult_uid: "NOSUCHUID1" })).toEqual({ ok: false, error: "not_found" });
    expect(await run({ action: "clip_audio_url", consult_uid: "BLINDROW1" })).toEqual({ ok: false, error: "blind_room_day" });
    expect(H.signCalls).toEqual([]);
  });
  it("a signing failure is a code, not an exception", async () => {
    setCatalog([crow(UID)]);
    const { signGetUrl } = await import("@/lib/r2");
    vi.mocked(signGetUrl).mockRejectedValueOnce(new Error("R2_BUCKET not set"));
    expect(await run({ action: "clip_audio_url", consult_uid: UID })).toEqual({ ok: false, error: "presign_failed" });
  });
});

// --- FIX1 --------------------------------------------------------------------------------------------------------------------------------------
describe("FIX1 X1: the clock (segment times are epoch ms; the answer is ms from clip start)", () => {
  const get = async (args: Row = {}) => ((await run({ action: "get", consult_uid: UID, ...args })).layers as Record<string, Row>);
  beforeEach(() => setCatalog([crow(UID, { t_open: E(-60_000), t_close: E(5_000) })]));

  it("offset = t - manifest.t0_ms; manifest_t0_ms and consult_span_ms (t_open/t_close minus t0) are reported; the manifest path is in source; the clock label stays", async () => {
    seedLayers();
    const t = (await get()).transcript!;
    const d = t.data as Row;
    expect((d.segments as Row[]).map((x) => [x.t0_ms, x.t1_ms])).toEqual([[0, 2000], [2000, 4000], [4000, 6000]]);
    expect(d).toMatchObject({ clock: "ms_from_clip_start", manifest_t0_ms: T0, consult_span_ms: { t0: -60_000, t1: 5_000 }, duration_ms: 6000, n_clamped: 3 }); // the 6,400 ms Sarvam overrun, in each of the three tracks, is clamped to 6,000
    expect(t.source).toContain(mkey());
  });
  it("a negative offset clamps to 0 and is counted; t1 is clamped to the duration AFTER the conversion (never row.t_open)", async () => {
    seedLayers();
    setTrack(tk("stt.sarvam-saaras-v3"), stt({ segments: [{ t0_ms: E(-5000), t1_ms: E(-1000), speaker: "0", lang: "en", text: "A" }, { t0_ms: E(-500), t1_ms: E(1500), speaker: "0", lang: "en", text: "B" }, { t0_ms: E(5000), t1_ms: E(9000), speaker: "0", lang: "en", text: "C" }, { t0_ms: E(1000), t1_ms: E(2000), speaker: "0", lang: "en", text: "D" }, { t0_ms: E(2000), t1_ms: E(3000), speaker: "0", lang: "en", text: "E" }] }));
    const d = (await get()).transcript!.data as Row;
    expect((d.segments as Row[]).map((x) => [x.t0_ms, x.t1_ms])).toEqual([[0, 0], [0, 1500], [5000, 6000], [1000, 2000], [2000, 3000]]);
    expect(d.n_clamped).toBe(6); // stt: -5000, -1000, -500, 9000 over the 6,000 ms duration; translate and role: their 6,400 overrun each
  });
  it("duration is the manifest's audio.duration_ms when present (even if clip.minutes differs), else the contract's `duration`, else clip.minutes", async () => {
    seedLayers();
    setManifest({ audio: { duration_ms: 5000 } });
    expect(((await get()).transcript!.data as Row).duration_ms).toBe(5000);
    setManifest({ audio: { duration: 4500 } });
    expect(((await get()).transcript!.data as Row).duration_ms).toBe(4500);
    setManifest({ audio: {} });
    expect(((await get()).transcript!.data as Row).duration_ms).toBe(6000); // clip.minutes 0.1
  });
  it("no manifest, or a manifest without a finite t0_ms, is no_clock for the transcript AND the parts; the clock is never guessed from row.t_open", async () => {
    seedLayers();
    setCatalog([crow(UID, { layers: { stt: layer("stt.sarvam-saaras-v3"), translate: null, role: null, parts: layer("parts.clef-jev") } })]);
    setTrack(tk("parts.clef-jev"), { layer: "parts", status: "ok", config: { clef_mode: "clef+jev" }, extras: {}, segments: [{ part: "history", t0_ms: E(0), t1_ms: E(900) }] });
    for (const bad of [null, { t0_ms: null }, { t0_ms: "x" }, { t0_ms: Number.NaN }, { t0_ms: undefined }]) {
      if (bad === null) store.delete(mkey());
      else setManifest(bad as Row);
      const l = await get();
      expect(l.transcript, JSON.stringify(bad)).toMatchObject({ status: "error", error: "no_clock", data: null });
      expect(l.parts, JSON.stringify(bad)).toMatchObject({ status: "error", error: "no_clock", data: null });
    }
    store.set(mkey(), { body: "{nope", etag: null });
    expect((await get()).transcript).toMatchObject({ status: "error", error: "no_clock" });
  });
  it("parts get the same conversion", async () => {
    setCatalog([crow(UID, { layers: { stt: null, translate: null, role: null, parts: layer("parts.clef-jev") } })]);
    setManifest();
    setTrack(tk("parts.clef-jev"), { layer: "parts", status: "ok", config: { clef_mode: "clef+jev" }, extras: {}, segments: [{ part: "exam", t0_ms: E(1000), t1_ms: E(2500), score: 1, confidence: 1, source: "jev" }] });
    expect(((await get()).parts!.data as Row[])[0]).toMatchObject({ t0_ms: 1000, t1_ms: 2500 });
  });
});

describe("FIX1 F1: layer and clip keys are bound to the row", () => {
  const get = async () => ((await run({ action: "get", consult_uid: UID, include_text: true })).layers as Record<string, Row>);
  it("N1: a layer key of another consult, another day, another room, or a held-out room-day is refused and NEVER read", async () => {
    seedLayers();
    const other = [tk("stt.sarvam-saaras-v3", "OTHERCONSULT9"), tk("stt.sarvam-saaras-v3", UID, "room_a", "2026-10-04"), tk("stt.sarvam-saaras-v3", UID, "room_b"), tk("stt.sarvam-saaras-v3", UID, "room_blind", "2026-10-01")];
    for (const k of other) {
      resetCatalogCacheForTests();
      store.set(k, { body: JSON.stringify(stt()), etag: null });
      setCatalog([crow(UID, { layers: { stt: { r2_key: k, status: "ok" }, translate: null, role: null, parts: { r2_key: k, status: "ok" } } })]);
      reads.length = 0;
      const l = await get();
      expect(l.transcript, k).toMatchObject({ status: "error", error: "key_not_readable", data: null });
      expect(l.parts, k).toMatchObject({ status: "error", error: "key_not_readable" });
      expect(reads, k).not.toContain(k);
      expect(JSON.stringify(l), k).not.toContain("NATIVE0");
    }
  });
  it("a held-out room-day in a (non-blind) row: the row's own pair matches the key's pair, so the key's blind check is what refuses it", async () => {
    // a row that is itself on a blind room-day is refused at the door of get; this proves the second line of defence in the reader
    const { bindRefusal } = await import("@/lib/room-access/readers/catalog-consult");
    const row = crow(UID, { ist_date: "2026-10-01", room_id: "room_blind" });
    expect(bindRefusal(tk("stt.sarvam-saaras-v3", UID, "room_blind", "2026-10-01"), row)).toBe("blind_room_day");
    expect(bindRefusal(tk("stt.sarvam-saaras-v3"), crow(UID))).toBeNull();
  });
  it("the manifest is bound the same way (a row whose room_id is not a legal key part gets key_not_readable, not a read)", async () => {
    seedLayers();
    setCatalog([crow(UID, { room_id: "room a/../x", layers: { stt: layer("stt.sarvam-saaras-v3"), translate: null, role: null, parts: null } })]);
    reads.length = 0;
    const l = await get();
    expect(l.transcript).toMatchObject({ status: "error" });
    expect(reads.filter((r) => r !== ENCOUNTER_CATALOG_KEY)).toEqual([]);
  });
  it("N2: a clip key of another day, another uid, or the wrong shape is bad_clip_key and never signed", async () => {
    const mk = (k: string) => crow(UID, { clip: { r2_key: k, bytes: 1, minutes: 1 } });
    for (const k of [`consult-clips/2026-10-04/opd-a/${UID}/consult.flac`, `consult-clips/2026-10-05/opd-a/OTHERCONSULT9/consult.flac`, `consult-clips/2026-10-05/opd-a/${UID}/other.flac`, `consult-clips/2026-10-05/${UID}/consult.flac`, `consult-clips/2026-10-05/opd-a/x/${UID}/consult.flac`, `consult-clips/2026-10-05/opd-a/${UID}/consult.flac/extra`, `consult-clips/2026-10-05/opd-a/${UID}/consult.flac?x=1`]) {
      resetCatalogCacheForTests();
      setCatalog([mk(k)]);
      expect(await run({ action: "clip_audio_url", consult_uid: UID }), k).toEqual({ ok: false, error: "bad_clip_key" });
    }
    expect(H.signCalls).toEqual([]);
    resetCatalogCacheForTests();
    setCatalog([mk(`consult-clips/2026-10-05/opd-a/${UID}/consult.flac`)]);
    expect(await run({ action: "clip_audio_url", consult_uid: UID })).toMatchObject({ ok: true });
  });
});

describe("FIX1 F2 and F5: no free text from rubric score or parts source", () => {
  it("rubric score keeps numbers and booleans only; verdict only when it is a short lowercase token, else null", async () => {
    setCatalog([crow(UID)]);
    const l = async () => (((await run({ action: "get", consult_uid: UID })).layers as Record<string, Row>).rubric!.data as Row[])[0]!;
    H.rubric = [{ rubric_id: "r", version: "1.0.0", run_id: "x", status: "ok", score: { n: 3, ok: true, note: "pt says chest pain", verdict: "pass_with_fixes" }, created_at: "t" }];
    expect(await l()).toMatchObject({ score: { n: 3, ok: true }, verdict: "pass_with_fixes" });
    for (const v of ["Pass", "pt says chest pain 3d", "1abc", "", "a".repeat(33), "pass fail"]) {
      H.rubric = [{ rubric_id: "r", version: "1.0.0", run_id: "x", status: "ok", score: { verdict: v, n: 1 }, created_at: "t" }];
      const row = await l();
      expect(row.verdict, v).toBeNull();
      expect(JSON.stringify(row), v).not.toContain("chest");
    }
  });
  it("parts source passes only as a short label", async () => {
    setCatalog([crow(UID, { layers: { stt: null, translate: null, role: null, parts: layer("parts.clef-jev") } })]);
    setManifest();
    const src = async (v: string) => {
      setTrack(tk("parts.clef-jev"), { layer: "parts", status: "ok", config: { clef_mode: "clef+jev" }, extras: {}, segments: [{ part: "exam", t0_ms: E(0), t1_ms: E(1), source: v }] });
      return (((await run({ action: "get", consult_uid: UID })).layers as Record<string, Row>).parts!.data as Row[])[0]!.source;
    };
    expect(await src("jev")).toBe("jev");
    expect(await src("clef:v0.1")).toBe("clef:v0.1");
    expect(await src("the patient said his chest hurts")).toBeNull();
    expect(await src("x".repeat(41))).toBeNull();
  });
});

describe("FIX2 Y1/Y2: consult uids with an underscore (1,507 of 3,242 cutter uids are 26 chars with _)", () => {
  const U = "ab12_cd34_ef56_gh78_ij90_k";
  it("a 26-char uid with _ is readable end to end: transcript ok (manifest bound), clip signed", async () => {
    expect(U).toHaveLength(26);
    setCatalog([crow(U)]);
    setManifest({}, U);
    setTrack(tk("stt.sarvam-saaras-v3", U), stt());
    setTrack(tk("translate.sarvam-saaras-v3", U), translate());
    setTrack(tk("role.llm-roles", U), roles());
    const o = await run({ action: "get", consult_uid: U, include_text: true });
    const t = (o.layers as Record<string, Row>).transcript!;
    expect(t).toMatchObject({ status: "ok" });
    expect(t.source).toContain(mkey(U));
    expect(((t.data as Row).segments as Row[])[0]).toMatchObject({ text_native: "NATIVE0", text_en: "TR0" });
    expect(await run({ action: "clip_audio_url", consult_uid: U })).toMatchObject({ ok: true });
    expect(H.signCalls).toEqual([{ key: `consult-clips/2026-10-05/opd-a/${U}/consult.flac`, expiresInSeconds: 900 }]);
  });
  it("., /, - and .. inside the uid segment, and lengths 9 and 61, are refused by the allowlist, the row binding and the clip shape", async () => {
    const { bindRefusal, clipKeyOf } = await import("@/lib/room-access/readers/catalog-consult");
    const base = "ab12_cd34_ef56";
    const bad = [`${base}.x`, `${base}-x`, `${base}/x`, `${base}..x`, "a".repeat(9), "a".repeat(61), `${base} x`];
    for (const u of bad) {
      const key = tk("stt.sarvam-saaras-v3", u);
      expect(labReadable(key), u).toBe(false);
      expect(bindRefusal(key, crow(u)), u).toBe("key_not_readable");
      expect(clipKeyOf(crow(u, { clip: { r2_key: `consult-clips/2026-10-05/opd-a/${u}/consult.flac` } })), u).toBeNull();
      expect(labReadable(mkey(u)), u).toBe(false);
    }
    for (const u of ["a".repeat(10), "a".repeat(60), "_".repeat(10), base + "_"]) {
      expect(labReadable(tk("stt.sarvam-saaras-v3", u)), u).toBe(true);
      expect(bindRefusal(tk("stt.sarvam-saaras-v3", u), crow(u)), u).toBeNull();
    }
  });
  it("end to end: a uid with - is a layer error and a bad_clip_key, never a read or a signature", async () => {
    const u = "ab12-cd34-ef56-gh78";
    setCatalog([crow(u)]);
    store.set(tk("stt.sarvam-saaras-v3", u), { body: JSON.stringify(stt()), etag: null });
    reads.length = 0;
    const o = await run({ action: "get", consult_uid: u });
    expect((o.layers as Record<string, Row>).transcript).toMatchObject({ status: "error", error: "key_not_readable" });
    expect(reads.filter((r) => r !== ENCOUNTER_CATALOG_KEY)).toEqual([]);
    expect(await run({ action: "clip_audio_url", consult_uid: u })).toEqual({ ok: false, error: "bad_clip_key" });
    expect(H.signCalls).toEqual([]);
  });
});

describe("CATALOG-2 C4: parts clamp, clock mismatch, one manifest read", () => {
  const partsRow = () => crow(UID, { layers: { stt: layer("stt.sarvam-saaras-v3"), translate: null, role: null, parts: layer("parts.clef-jev") } });
  const ptrack = (segments: Row[]): Row => ({ layer: "parts", status: "ok", config: { clef_mode: "clef+jev" }, extras: {}, segments });
  const lay = async () => (await run({ action: "get", consult_uid: UID })).layers as Record<string, Row>;
  it("C4a: parts are clamped to [0, duration] after the conversion and report n_clamped beside data (refuter case [t0-100, t0+9000] at 5,000 ms -> [0, 5000])", async () => {
    setCatalog([partsRow()]);
    setManifest({ audio: { duration_ms: 5000 } });
    setTrack(tk("parts.clef-jev"), ptrack([{ part: "history", t0_ms: E(-100), t1_ms: E(9000), source: "jev" }, { part: "exam", t0_ms: E(1000), t1_ms: E(2000), source: "jev" }, { part: "order", t0_ms: E(2000), t1_ms: E(3000), source: "jev" }]));
    const p = (await lay()).parts!;
    expect(p.status).toBe("ok");
    expect((p.data as Row[]).map((x) => [x.t0_ms, x.t1_ms])).toEqual([[0, 5000], [1000, 2000], [2000, 3000]]);
    expect(p.n_clamped).toBe(2);
    expect(Array.isArray(p.data)).toBe(true);
  });
  it("C4b: relative 0-4000 times under an epoch manifest are clock_mismatch (transcript and parts), data null, never ok", async () => {
    setCatalog([crow(UID, { layers: { stt: layer("stt.sarvam-saaras-v3"), translate: null, role: null, parts: layer("parts.clef-jev") } })]);
    setManifest();
    setTrack(tk("stt.sarvam-saaras-v3"), stt({ segments: [{ t0_ms: 0, t1_ms: 2000, speaker: "0", lang: "en", text: "A" }, { t0_ms: 2000, t1_ms: 4000, speaker: "1", lang: "en", text: "B" }] }));
    setTrack(tk("parts.clef-jev"), ptrack([{ part: "history", t0_ms: 0, t1_ms: 2000 }, { part: "exam", t0_ms: 2000, t1_ms: 4000 }]));
    const l = await lay();
    expect(l.transcript).toMatchObject({ status: "error", error: "clock_mismatch", data: null });
    expect(l.parts).toMatchObject({ status: "error", error: "clock_mismatch", data: null });
  });
  it("C4b: a normal epoch track with one pre-roll clamp stays ok; exactly half clamped stays ok, over half is a mismatch", async () => {
    setCatalog([partsRow()]);
    setManifest();
    setTrack(tk("parts.clef-jev"), ptrack([{ part: "a", t0_ms: E(-60_000), t1_ms: E(500) }, { part: "b", t0_ms: E(500), t1_ms: E(900) }, { part: "c", t0_ms: E(900), t1_ms: E(2000) }]));
    expect((await lay()).parts).toMatchObject({ status: "ok", n_clamped: 1 });
    setTrack(tk("parts.clef-jev"), ptrack([{ part: "a", t0_ms: E(-5), t1_ms: E(-1) }, { part: "b", t0_ms: E(10), t1_ms: E(20) }])); // 2 of 4 = half
    expect((await lay()).parts).toMatchObject({ status: "ok", n_clamped: 2 });
    setTrack(tk("parts.clef-jev"), ptrack([{ part: "a", t0_ms: E(-5), t1_ms: E(-1) }, { part: "b", t0_ms: E(-3), t1_ms: E(20) }])); // 3 of 4
    expect((await lay()).parts).toMatchObject({ status: "error", error: "clock_mismatch" });
  });
  it("C4c: one get reads the manifest once, whatever layers use it", async () => {
    setCatalog([crow(UID, { layers: { stt: layer("stt.sarvam-saaras-v3"), translate: layer("translate.sarvam-saaras-v3"), role: layer("role.llm-roles"), parts: layer("parts.clef-jev") } })]);
    seedLayers();
    setTrack(tk("parts.clef-jev"), ptrack([{ part: "a", t0_ms: E(0), t1_ms: E(500) }]));
    reads.length = 0;
    const l = await lay();
    expect(l.transcript!.status).toBe("ok");
    expect(l.parts!.status).toBe("ok");
    expect(reads.filter((k) => k === mkey())).toHaveLength(1);
  });
});

describe("CATALOG-2 C5: reb-consult readers accept _ uids and still refuse the rest", () => {
  const U = "ab12_cd34_ef56_gh78_ij90_k"; // 26
  const rk = (kind: string, u = U) => `reb/2026-10-05/room_a/_consults/${u}/tracks/${kind}__v1__ab12cd34.json`;
  it("UID_RE: _ accepted; - . / .. space and lengths 9 and 61 refused", async () => {
    const { UID_RE } = await import("@/lib/room-access/readers/reb-consult");
    expect(UID_RE.test(U)).toBe(true);
    for (const ok of ["a".repeat(10), "a".repeat(60), "_".repeat(10)]) expect(UID_RE.test(ok), ok).toBe(true);
    for (const bad of [`${U}-x`, `${U}.x`, `${U}/x`, `${U}..`, `${U} x`, "a".repeat(9), "a".repeat(61), "", "../../x"]) expect(UID_RE.test(bad), bad).toBe(false);
  });
  const idxCalls = () => H.sqlCalls.filter((c) => /FROM reb_track_index/.test(c.text)).length;
  const span = (uid: string) => ({ consult_uid: uid, room_id: "room_a", ist_date: "2026-10-05", t_open_ms: E(0), t_close_ms: E(6000), windows: [] }) as never;
  const entries: Array<[string, (u: string) => Promise<unknown>]> = [
    ["readRebConsult", async (u) => (await import("@/lib/room-access/readers/reb-consult")).readRebConsult(span(u))],
    ["findRebTrack", async (u) => (await import("@/lib/room-access/readers/reb-consult")).findRebTrack(u, "room_a", "2026-10-05")],
    ["findSarvamTracks", async (u) => (await import("@/lib/room-access/readers/reb-consult")).findSarvamTracks(u, "room_a", "opd-a", "cut1", () => null)],
    ["loadRoleDoc (via readRebRoleFlags)", async (u) => (await import("@/lib/room-access/readers/reb-consult")).readRebRoleFlags(u, "room_a", "opd-a")],
  ];
  it("each of the four readers gets past its uid door for a 26-char _ uid (it asks the index) and stays shut for - . / .. space and lengths 9 and 61 (it asks nothing)", async () => {
    process.env.ETA_REB_ROLE_LLM = "1";
    try {
      for (const [name, call] of entries) {
        H.sqlCalls = [];
        await call(U);
        expect(idxCalls(), `${name} _ uid`).toBeGreaterThan(0);
        for (const bad of ["ab12-cd34-ef56-gh78", `${U}.x`, `${U}/x`, `${U}..`, `${U} x`, "a".repeat(9), "a".repeat(61)]) {
          H.sqlCalls = [];
          await call(bad);
          expect(idxCalls(), `${name} ${bad}`).toBe(0);
        }
      }
    } finally {
      delete process.env.ETA_REB_ROLE_LLM;
    }
  });
  it("the key's uid still binds to the requested uid: an index row naming ANOTHER uid's track is skipped, the right one is returned", async () => {
    const { findRebTrack } = await import("@/lib/room-access/readers/reb-consult");
    const { createHash } = await import("node:crypto");
    const body = JSON.stringify(translate());
    const sha = createHash("sha256").update(body, "utf8").digest("hex");
    const other = "zz99_yy88_xx77_ww66_vv55_u";
    store.set(rk("translate.sarvam-saaras-v3", other), { body, etag: null });
    store.set(rk("translate.sarvam-saaras-v3"), { body, etag: null });
    H.indexRows = [{ layer: "translate", engine: "sarvam-saaras-v3", config_hash: "ab12cd34", r2_key: rk("translate.sarvam-saaras-v3", other), sha256: sha }];
    expect((await findRebTrack(U, "room_a", "2026-10-05")).found).toBeNull();
    H.indexRows = [{ layer: "translate", engine: "sarvam-saaras-v3", config_hash: "ab12cd34", r2_key: rk("translate.sarvam-saaras-v3"), sha256: sha }];
    expect((await findRebTrack(U, "room_a", "2026-10-05")).found).toMatchObject({ layer: "translate", n_segments: 3 });
  });
});

describe("CATALOG-4 W1/W2: a mis-clocked translate or role track is dropped loudly, not silently", () => {
  beforeEach(() => {
    setCatalog([crow(UID)]);
    seedLayers();
  });
  const tr = async () => ((await run({ action: "get", consult_uid: UID, include_text: true })).layers as Record<string, Row>).transcript!;
  const rel = (segments: Row[]) => segments.map((g) => ({ ...g, t0_ms: (g.t0_ms as number) - T0, t1_ms: (g.t1_ms as number) - T0 }));
  it("stt good + translate on the relative clock: transcript ok, text_en null (stt is hi), degraded has translate:clock_mismatch, n_clamped counts only the tracks used", async () => {
    setTrack(tk("translate.sarvam-saaras-v3"), translate({ segments: rel(translate().segments as Row[]) }));
    const t = await tr();
    expect(t.status).toBe("ok");
    const d = t.data as Row;
    expect(d.degraded).toEqual(["translate:clock_mismatch"]);
    expect((d.segments as Row[]).map((x) => x.text_en)).toEqual([null, "ENGLISH1", null]); // only the en-IN stt segment keeps an English text
    expect(d.n_clamped).toBe(2); // stt overrun + role overrun; the dropped translate adds nothing
  });
  it("stt good + role on the relative clock: ok, roles unknown (as with an absent role track), degraded has role:clock_mismatch", async () => {
    setTrack(tk("role.llm-roles"), roles({ segments: rel(roles().segments as Row[]) }));
    const d = (await tr()).data as Row;
    expect(d.degraded).toEqual(["role:clock_mismatch"]);
    expect((d.segments as Row[]).every((x) => x.role === "unknown")).toBe(true);
  });
  it("a good translate track has no degraded entry; both bad gives both entries", async () => {
    expect(((await tr()).data as Row).degraded).toBeUndefined();
    setTrack(tk("translate.sarvam-saaras-v3"), translate({ segments: rel(translate().segments as Row[]) }));
    setTrack(tk("role.llm-roles"), roles({ segments: rel(roles().segments as Row[]) }));
    expect(((await tr()).data as Row).degraded).toEqual(["translate:clock_mismatch", "role:clock_mismatch"]);
  });
  it("stt mis-clocked still fails the whole layer with clock_mismatch", async () => {
    setTrack(tk("stt.sarvam-saaras-v3"), stt({ segments: rel(stt().segments as Row[]) }));
    expect(await tr()).toMatchObject({ status: "error", error: "clock_mismatch", data: null });
  });
});

// --- the door ---------------------------------------------------------------------------------------------------------------------------------
describe("the door", () => {
  const { handleMcpRpc } = { handleMcpRpc: (...a: Parameters<typeof import("@/lib/mcp/handler").handleMcpRpc>) => import("@/lib/mcp/handler").then((m) => m.handleMcpRpc(...a)) };
  const rpc = async (args: Row, principal: { rooms?: Set<string>; scopes?: Set<McpScope>; token?: string } = {}) => {
    const req = new NextRequest("https://x/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "scribe_catalog", arguments: args } }) });
    const res = await handleMcpRpc(req, { token_id: principal.token ?? "reader", scopes: principal.scopes ?? new Set<McpScope>(["read"]), ...(principal.rooms ? { rooms: principal.rooms } : {}) } as never);
    return (await res.json()) as { result?: { structuredContent: Row }; error?: { code: number; message: string; data?: Row } };
  };
  const auditRows = () => H.sqlCalls.filter((c) => /^INSERT INTO audit_log/.test(c.text));

  it("is not on the room-restricted allowlist, and a room-restricted token is refused before the handler (no read happens)", async () => {
    expect(ROOM_RESTRICTED_ALLOWED_TOOLS.has("scribe_catalog")).toBe(false);
    setCatalog([crow(UID)]);
    const b = await rpc({ action: "search" }, { rooms: new Set(["room_a"]), scopes: new Set<McpScope>(["read", "invoke", "write"]) });
    expect(b.error).toMatchObject({ code: -32001 });
    expect(b.result).toBeUndefined();
    expect(reads).toEqual([]);
  });
  it("a read token is allowed", async () => {
    setCatalog([crow(UID)]);
    const b = await rpc({ action: "search" });
    expect(b.error).toBeUndefined();
    expect(b.result!.structuredContent).toMatchObject({ ok: true, total_matched: 1 });
  });
  it("the presigned URL is in the answer and nowhere else: not in any audit insert, not in any console line", async () => {
    setCatalog([crow(UID)]);
    const b = await rpc({ action: "clip_audio_url", consult_uid: UID });
    expect(b.result!.structuredContent.url).toContain("SECRETSIG");
    expect(auditRows().length).toBeGreaterThan(0);
    const everything = JSON.stringify(H.sqlCalls) + logs.join("\n");
    for (const needle of ["SECRETSIG", "signed.example", "X-Amz", "consult-clips/"]) expect(everything, needle).not.toContain(needle);
    // the audit row carries the tool name and allow-listed args only
    expect(JSON.stringify(auditRows())).toContain("scribe_catalog");
    // CATALOG-3: the consult uid IS audited now (an id, allow-listed), the URL never is
  });
  /** the metadata_json.args of the door's audit row for the last scribe_catalog call */
  const lastAudit = (): Row => {
    const rows = auditRows().filter((c) => c.values.includes("scribe_catalog"));
    const json = rows[rows.length - 1]!.values.find((v) => typeof v === "string" && v.startsWith("{")) as string;
    return JSON.parse(json) as Row;
  };
  it("CATALOG-3 Z2: the audit row of a get holds action and consult_uid (and include_text), not the transcript", async () => {
    setCatalog([crow(UID)]);
    seedLayers();
    await rpc({ action: "get", consult_uid: UID, include_text: true });
    expect(lastAudit().args).toEqual({ action: "get", consult_uid: UID, include_text: true });
  });
  it("CATALOG-3 Z2: the audit row of clip_audio_url holds action and consult_uid and no URL, signature or X-Amz text anywhere", async () => {
    setCatalog([crow(UID)]);
    await rpc({ action: "clip_audio_url", consult_uid: UID });
    const row = lastAudit();
    expect(row.args).toEqual({ action: "clip_audio_url", consult_uid: UID });
    const text = JSON.stringify(auditRows());
    for (const needle of ["https://", "SECRETSIG", "signature", "signature_sha256", "X-Amz", "signed.example", "s".repeat(64)]) expect(text, needle).not.toContain(needle);
  });
  it("CATALOG-3 Z2: the audit row of a search holds action (and the allow-listed room/limit), not the other filters", async () => {
    setCatalog([crow(UID)]);
    await rpc({ action: "search", limit: 5, room: "opd-a", doctor_uid: "docA", cursor: "abc", from: "2026-10-01" });
    expect(lastAudit().args).toEqual({ action: "search", limit: 5, room: "opd-a" });
  });
  it("CATALOG-3 Z2: an unknown key (url, signature, text) is still dropped; so is a non-string/number/boolean action or consult_uid; strings are cut at 128", async () => {
    setCatalog([crow(UID)]);
    await rpc({ action: "get", consult_uid: UID, url: "https://x/y?X-Amz-Signature=abc", signature: "sig", text: "patient said", signature_sha256: "h" });
    const a = lastAudit().args as Row;
    for (const k of ["url", "signature", "text", "signature_sha256"]) expect(a, k).not.toHaveProperty(k);
    const { safeArgs } = await import("@/lib/mcp/audit");
    expect(safeArgs({ action: { x: 1 }, consult_uid: ["a"] })).toEqual({});
    expect((safeArgs({ consult_uid: "u".repeat(300) }).consult_uid as string).length).toBe(128);
  });
  it("include_text transcript text never reaches an audit row or a log", async () => {
    setCatalog([crow(UID)]);
    seedLayers();
    const b = await rpc({ action: "get", consult_uid: UID, include_text: true });
    expect(JSON.stringify(b.result)).toContain("NATIVE0");
    const everything = JSON.stringify(H.sqlCalls) + logs.join("\n");
    expect(everything).not.toMatch(/NATIVE|ENGLISH1|TR[012]/);
  });
  it("unknown action is a code", async () => {
    expect(await run({ action: "delete" })).toMatchObject({ ok: false, error: "unknown_action" });
    expect(await run({})).toMatchObject({ ok: false, error: "unknown_action" });
  });

  // --- CATALOG-5 -----------------------------------------------------------------------------------------------------------------------------------
describe("CATALOG-5: identity and prescription from encounter_catalog", () => {
  const NAME_D = "Synthetic Alpha Doc";
  const NAME_P = "Synthetic Patient";
  const IND = "IND-0001";
  const RX = "RX-0001";
  const idrow = (uid: string, o: Row = {}): Row => ({ consult_uid: uid, doctor_name: NAME_D, patient_name: NAME_P, individual_uid: IND, prescription_uid: RX, presc_state: "signed", prescription: { meds: ["PARACETAMOL"] }, ...o });
  const layersOf = async (args: Row = {}) => (await runA({ action: "get", consult_uid: UID, ...args })).layers as Record<string, Row>;
  beforeEach(() => setCatalog([crow(UID)]));

  it("get WITHOUT include_identity: identity data is {present}, rx has only flags; no name, id, URL or prescription anywhere in the JSON", async () => {
    H.identity = [idrow(UID)];
    const o = await runA({ action: "get", consult_uid: UID, include_text: true });
    const l = o.layers as Record<string, Row>;
    expect(l.identity).toEqual({ status: "ok", source: ["encounter_catalog"], data: { present: true } });
    expect(l.rx).toEqual({ status: "ok", source: ["encounter_catalog"], data: { prescription_uid: null, presc_state: "signed", has_prescription: true, pulse_url: null } });
    const whole = JSON.stringify(o);
    for (const needle of [NAME_D, NAME_P, IND, RX, "pulse.even.in", "PARACETAMOL"]) expect(whole, needle).not.toContain(needle);
    expect(H.identityQueries.at(-1)).toMatchObject({ withRx: false }); // the jsonb is not even selected
  });
  it("get WITH include_identity: names, ids, state and pulse_url; rx carries the ids and the link; prescription still withheld without include_text", async () => {
    H.identity = [idrow(UID)];
    const l = await layersOf({ include_identity: true });
    expect(l.identity!.data).toEqual({ doctor_name: NAME_D, patient_name: NAME_P, individual_uid: IND, prescription_uid: RX, presc_state: "signed", pulse_url: `https://pulse.even.in/prescription?prescription_uid=${RX}&individual_uid=${IND}` });
    expect(l.rx!.data).toEqual({ prescription_uid: RX, presc_state: "signed", has_prescription: true, pulse_url: `https://pulse.even.in/prescription?prescription_uid=${RX}&individual_uid=${IND}` });
    expect(JSON.stringify(l)).not.toContain("PARACETAMOL");
  });
  it("the stored prescription jsonb only with BOTH include_identity and include_text", async () => {
    H.identity = [idrow(UID)];
    for (const [a, b] of [[true, false], [false, true], [false, false]] as const) {
      const l = await layersOf({ include_identity: a, include_text: b });
      expect(JSON.stringify(l), `${a}/${b}`).not.toContain("PARACETAMOL");
    }
    const l = await layersOf({ include_identity: true, include_text: true });
    expect((l.rx!.data as Row).prescription).toEqual({ meds: ["PARACETAMOL"] });
    expect(H.identityQueries.at(-1)).toMatchObject({ withRx: true });
  });
  it("pulse_url is built with encoded ids and refused (null) when either id fails the id class", async () => {
    const { pulseUrl } = await import("@/lib/room-access/readers/catalog-identity");
    expect(pulseUrl("a:b@c.d_e-f", "g@h")).toBe("https://pulse.even.in/prescription?prescription_uid=a%3Ab%40c.d_e-f&individual_uid=g%40h");
    for (const bad of ["", "a b", "a/b", "a&b=c", "a".repeat(129), "é"]) {
      expect(pulseUrl(bad, IND), bad).toBeNull();
      expect(pulseUrl(RX, bad), bad).toBeNull();
    }
    expect(pulseUrl(null, IND)).toBeNull();
    expect(pulseUrl(RX, null)).toBeNull();
    // a stored id outside the class (not possible under the 0168 check, but the link must not carry it)
    H.identity = [idrow(UID, { prescription_uid: "bad id&x=1" })];
    expect(((await layersOf({ include_identity: true })).identity!.data as Row).pulse_url).toBeNull();
  });
  it("rx: ok when prescription_uid or prescription is present, else absent; identity absent when no row or every identity column is null; empty table is absent, not an error", async () => {
    expect((await layersOf()).identity).toMatchObject({ status: "absent", data: { present: false } });
    expect((await layersOf()).rx).toMatchObject({ status: "absent", data: null });
    H.identity = [idrow(UID, { doctor_name: null, patient_name: null, individual_uid: null, prescription_uid: null, presc_state: null, prescription: null })];
    expect((await layersOf({ include_identity: true })).identity).toMatchObject({ status: "absent", data: null });
    expect((await layersOf()).rx!.status).toBe("absent");
    H.identity = [idrow(UID, { prescription_uid: null, prescription: { x: 1 } })];
    expect((await layersOf()).rx).toMatchObject({ status: "ok", data: { has_prescription: true, prescription_uid: null } });
    H.identity = [idrow(UID, { prescription: null })];
    expect((await layersOf()).rx).toMatchObject({ status: "ok", data: { has_prescription: true } }); // a prescription_uid alone is enough (C3 never fills the jsonb)
    H.identity = [idrow(UID, { prescription_uid: null, prescription: null, presc_state: null, doctor_name: NAME_D })];
    expect((await layersOf()).rx!.status).toBe("absent");
  });
  it("a failing encounter_catalog read is an error on identity and rx only; the rest of get answers; cdmss stays not_available", async () => {
    seedLayers();
    H.identityThrows = "42P01";
    const o = await runA({ action: "get", consult_uid: UID });
    const l = o.layers as Record<string, Row>;
    expect(o.ok).toBe(true);
    expect(l.identity).toMatchObject({ status: "error", error: "db_error:42P01", data: null });
    expect(l.rx).toMatchObject({ status: "error", error: "db_error:42P01", data: null });
    expect(l.transcript!.status).toBe("ok");
    expect(l.cdmss).toEqual({ status: "not_available", source: ["consult-audit S5 (pending)"], data: null });
  });

  // --- search ---
  const trio = () => {
    setCatalog([crow("CONSULT_AAA1", { t_open: 300 }), crow("CONSULT_BBB2", { t_open: 200 }), crow("CONSULT_CCC3", { t_open: 100 })]);
    H.identity = [
      idrow("CONSULT_AAA1", { prescription_uid: "RX-A", individual_uid: "IND-A" }),
      idrow("CONSULT_BBB2", { prescription_uid: null, individual_uid: "IND-A", prescription: null }),
      idrow("CONSULT_CCC3", { prescription_uid: "RX-C", individual_uid: "IND-C", prescription: { m: 1 } }),
    ];
  };
  const uidsOf = (o: Row) => (o.rows as Row[]).map((r) => r.consult_uid);
  it("search without filters: rows carry has_prescription (boolean, or null with no joined row) and identity_rows; no identity block, no names", async () => {
    setCatalog([crow("CONSULT_AAA1", { t_open: 300 }), crow("CONSULT_ZZZ9", { t_open: 100 })]);
    H.identity = [idrow("CONSULT_AAA1")];
    const o = await runA({ action: "search" });
    expect((o.rows as Row[]).map((r) => r.has_prescription)).toEqual([true, null]);
    expect(o.identity_rows).toBe(1);
    expect(JSON.stringify(o)).not.toMatch(/Synthetic|IND-0001|RX-0001/);
    expect((o.rows as Row[])[0]).not.toHaveProperty("identity");
  });
  it("include_identity adds identity {names, ids, state, pulse_url} per row (null with no joined row)", async () => {
    setCatalog([crow("CONSULT_AAA1", { t_open: 300 }), crow("CONSULT_ZZZ9", { t_open: 100 })]);
    H.identity = [idrow("CONSULT_AAA1")];
    const r = (await runA({ action: "search", include_identity: true })).rows as Row[];
    expect(r[0]!.identity).toEqual({ doctor_name: NAME_D, patient_name: NAME_P, individual_uid: IND, prescription_uid: RX, presc_state: "signed", pulse_url: `https://pulse.even.in/prescription?prescription_uid=${RX}&individual_uid=${IND}` });
    expect(r[1]!.identity).toBeNull();
  });
  it("filters: has_prescription true/false, prescription_uid, individual_uid, combined; has_rx is an alias; total_matched reflects the filter", async () => {
    trio();
    expect(uidsOf(await runA({ action: "search", has_prescription: true }))).toEqual(["CONSULT_AAA1", "CONSULT_CCC3"]);
    expect(uidsOf(await runA({ action: "search", has_prescription: false }))).toEqual(["CONSULT_BBB2"]);
    expect(uidsOf(await runA({ action: "search", has_rx: true }))).toEqual(["CONSULT_AAA1", "CONSULT_CCC3"]);
    expect(uidsOf(await runA({ action: "search", has_rx: false }))).toEqual(["CONSULT_BBB2"]);
    expect(uidsOf(await runA({ action: "search", prescription_uid: "RX-C" }))).toEqual(["CONSULT_CCC3"]);
    expect(uidsOf(await runA({ action: "search", individual_uid: "IND-A" }))).toEqual(["CONSULT_AAA1", "CONSULT_BBB2"]);
    expect(uidsOf(await runA({ action: "search", individual_uid: "IND-A", has_prescription: true }))).toEqual(["CONSULT_AAA1"]);
    const o = await runA({ action: "search", has_prescription: true, limit: 1 });
    expect(o).toMatchObject({ total_matched: 2, identity_rows: 3 });
    expect(typeof o.next_cursor).toBe("string");
    expect(uidsOf(await runA({ action: "search", prescription_uid: "NOPE" }))).toEqual([]);
  });
  it("filter args are validated: ids must match the 0168 id class; has_prescription must be a boolean", async () => {
    trio();
    for (const k of ["prescription_uid", "individual_uid"]) for (const bad of ["a b", "x/y", "q&r", "a".repeat(129), 5, {}]) expect(await runA({ action: "search", [k]: bad }), `${k} ${String(bad)}`).toMatchObject({ ok: false, error: "bad_args" });
    for (const bad of ["maybe", 3, {}]) expect(await runA({ action: "search", has_prescription: bad })).toMatchObject({ ok: false, error: "bad_args" });
    expect(H.identityQueries).toEqual([]);
  });
  it("the join comes AFTER the date/room/doctor filters and is chunked at 500 uids per query", async () => {
    const many = Array.from({ length: 1203 }, (_, i) => crow(`CHUNKROW_${String(i).padStart(5, "0")}`, { t_open: 10_000 - i, doctor_uid: i % 2 === 0 ? "docEven" : "docOdd" }));
    setCatalog(many);
    H.identity = many.map((r) => idrow(r.consult_uid as string));
    const o = await runA({ action: "search", has_prescription: true, doctor_uid: "docEven", limit: 200 });
    expect(o.total_matched).toBe(602);
    expect(H.identityQueries.map((q) => q.uids.length)).toEqual([500, 102]); // only the 602 doctor matches were joined, 500 + 102
    expect(H.identityQueries.every((q) => q.uids.length <= 500)).toBe(true);
    // a plain search joins only the returned page (<= 200, one query)
    H.identityQueries = [];
    await runA({ action: "search", limit: 200 });
    expect(H.identityQueries.map((q) => q.uids.length)).toEqual([200]);
  });
  it("an empty table: filters return rows [] with identity_rows 0 (not 'no prescription'); a plain search says identity_rows 0 and has_prescription null", async () => {
    trio();
    H.identity = [];
    for (const f of [{ has_prescription: false }, { has_prescription: true }, { prescription_uid: "RX-A" }, { individual_uid: "IND-A" }]) {
      expect(await runA({ action: "search", ...f }), JSON.stringify(f)).toMatchObject({ ok: true, rows: [], total_matched: 0, identity_rows: 0 });
    }
    const o = await runA({ action: "search" });
    expect(o.identity_rows).toBe(0);
    expect((o.rows as Row[]).every((r) => r.has_prescription === null)).toBe(true);
  });
  it("a SQL error: filters and include_identity answer identity_unavailable; a plain search degrades (has_prescription null, identity_rows null, identity_error)", async () => {
    trio();
    H.identityThrows = "42P01";
    expect(await runA({ action: "search", has_prescription: true })).toEqual({ ok: false, error: "identity_unavailable" });
    expect(await runA({ action: "search", include_identity: true })).toEqual({ ok: false, error: "identity_unavailable" });
    const o = await runA({ action: "search" });
    expect(o).toMatchObject({ ok: true, identity_rows: null, identity_error: true });
    expect((o.rows as Row[]).every((r) => r.has_prescription === null)).toBe(true);
  });
  it("identityFor: >500 uids is an error code (the caller chunks), [] is ok and queries nothing, a missing table is an error not a throw", async () => {
    const { identityFor } = await import("@/lib/room-access/readers/catalog-identity");
    expect(await identityFor(Array.from({ length: 501 }, (_, i) => `u${i}`))).toEqual({ status: "error", code: "too_many_uids" });
    expect(await identityFor([])).toMatchObject({ status: "ok" });
    expect(H.identityQueries).toEqual([]);
    H.identityThrows = "42P01";
    expect(await identityFor(["a"])).toEqual({ status: "error", code: "db_error:42P01" });
  });
  it("V4 audit: a search with individual_uid / prescription_uid / has_prescription holds has_prescription (boolean) and neither uid nor any name; a string has_prescription is dropped", async () => {
    trio();
    await rpc({ action: "search", individual_uid: "IND-A", prescription_uid: "RX-A", has_prescription: true, include_identity: true }, { token: "admin:tester", scopes: new Set<McpScope>(["read", "admin"]) });
    let a = lastAudit().args as Row;
    expect(a).toEqual({ action: "search", has_prescription: true, include_identity: true, by_individual_uid: true, by_prescription_uid: true, identity_filter: true });
    const text = JSON.stringify(auditRows()) + logs.join("\n");
    for (const needle of ["IND-A", "RX-A", NAME_D, NAME_P, "Synthetic"]) expect(text, needle).not.toContain(needle);
    await rpc({ action: "search", has_prescription: "Synthetic Patient" }, { token: "admin:tester", scopes: new Set<McpScope>(["read", "admin"]) });
    a = lastAudit().args as Row;
    expect(a).not.toHaveProperty("has_prescription");
  });
  it("a room-restricted token is still refused; no PHI reaches the console on get or search with include_identity", async () => {
    trio();
    const b = await rpc({ action: "get", consult_uid: UID, include_identity: true }, { rooms: new Set(["room_a"]), scopes: new Set<McpScope>(["read", "invoke", "write"]) });
    expect(b.error).toMatchObject({ code: -32001 });
    expect(H.identityQueries).toEqual([]);
    await rpc({ action: "get", consult_uid: "CONSULT_AAA1", include_identity: true, include_text: true }, { token: "admin:tester", scopes: new Set<McpScope>(["read", "admin"]) });
    await rpc({ action: "search", include_identity: true }, { token: "admin:tester", scopes: new Set<McpScope>(["read", "admin"]) });
    expect(logs.join("\n")).not.toMatch(/Synthetic|IND-|RX-|PARACETAMOL/);
  });

  // --- CATALOG-6 ---
  const ADM_P = { token: "admin:tester", scopes: new Set<McpScope>(["read", "admin"]) };
  it("C1: a search by individual_uid audits by_individual_uid and identity_filter and the value appears nowhere; the same for prescription_uid; a search without them has none of the keys", async () => {
    trio();
    await rpc({ action: "search", individual_uid: "IND-A" }, ADM_P);
    expect(lastAudit().args).toEqual({ action: "search", by_individual_uid: true, identity_filter: true });
    let text = JSON.stringify(auditRows()) + logs.join("\n");
    expect(text).not.toContain("IND-A");
    await rpc({ action: "search", prescription_uid: "RX-C" }, ADM_P);
    expect(lastAudit().args).toEqual({ action: "search", by_prescription_uid: true, identity_filter: true });
    text = JSON.stringify(auditRows()) + logs.join("\n");
    expect(text).not.toContain("RX-C");
    await rpc({ action: "search", limit: 3 });
    const a = lastAudit().args as Row;
    for (const k of ["by_individual_uid", "by_prescription_uid", "identity_filter"]) expect(a, k).not.toHaveProperty(k);
    const { safeArgs } = await import("@/lib/mcp/audit");
    expect(safeArgs({ individual_uid: "", prescription_uid: 5, action: "search" })).toEqual({ action: "search" });
    expect(Object.keys(safeArgs({ individual_uid: "x", prescription_uid: "y" })).sort()).toEqual(["by_individual_uid", "by_prescription_uid", "identity_filter"]);
  });
  it("C2: a read token with include_identity, a prescription_uid or an individual_uid is refused -32001 and no SQL touches encounter_catalog; an admin: actor without the admin scope is refused too", async () => {
    trio();
    for (const args of [{ action: "get", consult_uid: UID, include_identity: true }, { action: "search", include_identity: true }, { action: "search", prescription_uid: "RX-A" }, { action: "search", individual_uid: "IND-A" }, { action: "get", consult_uid: UID, include_identity: "true" }]) {
      const b = await rpc(args);
      expect(b.error, JSON.stringify(args)).toMatchObject({ code: -32001 });
      expect(b.error!.data).toMatchObject({ needed: "admin" });
    }
    expect((await rpc({ action: "search", individual_uid: "IND-A" }, { token: "admin:tester", scopes: new Set<McpScope>(["read"]) })).error).toMatchObject({ code: -32001 });
    expect((await rpc({ action: "search", individual_uid: "IND-A" }, { token: "someone", scopes: new Set<McpScope>(["read", "admin"]) })).error).toMatchObject({ code: -32001 }); // admin scope but no admin: actor
    expect(H.sqlCalls.filter((c) => /encounter_catalog/.test(c.text))).toEqual([]);
    expect(H.identityQueries).toEqual([]);
    expect(H.matchQueries).toEqual([]);
  });
  it("C2: an admin token is allowed; a read token without those args still works (identity {present}, has_prescription)", async () => {
    trio();
    H.identity = [idrow(UID)];
    setCatalog([crow(UID), ...[]]);
    const ok = await rpc({ action: "get", consult_uid: UID, include_identity: true }, ADM_P);
    expect(ok.error).toBeUndefined();
    expect(((ok.result!.structuredContent.layers as Row).identity as Row).data).toMatchObject({ doctor_name: NAME_D });
    const rd = await rpc({ action: "get", consult_uid: UID });
    expect(rd.error).toBeUndefined();
    expect(((rd.result!.structuredContent.layers as Row).identity as Row).data).toEqual({ present: true });
    const s2 = await rpc({ action: "search", has_prescription: true });
    expect(s2.error).toBeUndefined();
    expect((s2.result!.structuredContent.rows as Row[])[0]).toMatchObject({ has_prescription: true });
    expect(JSON.stringify(rd.result) + JSON.stringify(s2.result)).not.toMatch(/Synthetic|IND-0001|RX-0001/);
  });
  it("C5: the id filters use the SQL path (windowed, capped at 2000+1), not a chunked join over all candidates", async () => {
    trio();
    expect(uidsOf(await runA({ action: "search", individual_uid: "IND-A" }))).toEqual(["CONSULT_AAA1", "CONSULT_BBB2"]);
    expect(H.matchQueries).toHaveLength(1);
    expect(H.matchQueries[0]).toMatchObject({ individual: "IND-A", prescription: null, cap: 2001 });
    expect(H.matchQueries[0]!.from < H.matchQueries[0]!.to).toBe(true);
    // the identity join then covers the returned page only
    expect(H.identityQueries.map((q) => q.uids)).toEqual([["CONSULT_AAA1", "CONSULT_BBB2"]]);
    H.matchQueries = [];
    expect(uidsOf(await runA({ action: "search", prescription_uid: "RX-C" }))).toEqual(["CONSULT_CCC3"]);
    expect(H.matchQueries[0]).toMatchObject({ individual: null, prescription: "RX-C" });
    expect(uidsOf(await runA({ action: "search", prescription_uid: "RX-A", individual_uid: "IND-A" }))).toEqual(["CONSULT_AAA1"]);
    expect(uidsOf(await runA({ action: "search", prescription_uid: "RX-A", individual_uid: "IND-C" }))).toEqual([]);
    expect(uidsOf(await runA({ action: "search", individual_uid: "IND-A", has_prescription: true }))).toEqual(["CONSULT_AAA1"]);
  });
  it("C5: uid filters are bounded by the window (from/to) and intersected with the R2 candidates", async () => {
    trio();
    H.identity.push(idrow("ONLY_IN_TABLE", { individual_uid: "IND-A" })); // not in the R2 catalog: never returned
    H.identity.push(idrow("OLD_ROW_AAA", { individual_uid: "IND-A", ist_date: "2026-09-12" }));
    expect(uidsOf(await runA({ action: "search", individual_uid: "IND-A" }))).toEqual(["CONSULT_AAA1", "CONSULT_BBB2"]);
    expect(H.matchQueries.at(-1)).toMatchObject({ from: "2026-09-15", to: "2026-10-14" }); // the 30-day default window
    setCatalog([crow("OLD_ROW_AAA", { ist_date: "2026-09-12" }), crow("CONSULT_AAA1", { t_open: 300 })]);
    resetCatalogCacheForTests();
    expect(uidsOf(await runA({ action: "search", individual_uid: "IND-A", from: "2026-09-10", to: "2026-09-20" }))).toEqual(["OLD_ROW_AAA"]);
  });
  it("C5: more than 2000 matches is too_many_matches; exactly 2000 passes; a SQL error is identity_unavailable", async () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => crow(`BULKROW_${String(i).padStart(5, "0")}`, { t_open: 50_000 - i }));
    setCatalog(mk(2001));
    H.identity = mk(2001).map((r) => idrow(r.consult_uid as string, { individual_uid: "IND-BULK" }));
    expect(await runA({ action: "search", individual_uid: "IND-BULK" })).toEqual({ ok: false, error: "too_many_matches" });
    H.identity = H.identity.slice(0, 2000);
    expect(await runA({ action: "search", individual_uid: "IND-BULK" })).toMatchObject({ ok: true, total_matched: 2000 });
    H.identityThrows = "42P01";
    expect(await runA({ action: "search", individual_uid: "IND-BULK" })).toEqual({ ok: false, error: "identity_unavailable" });
  });
  it("C5: has_prescription refuses a window over 31 days; the 30-day default and a 31-day window pass; uid filters have no such limit", async () => {
    trio();
    expect(await runA({ action: "search", has_prescription: true, from: "2026-09-10", to: "2026-10-14" })).toEqual({ ok: false, error: "bad_args", detail: "has_prescription spans at most 31 days" });
    expect(await runA({ action: "search", has_prescription: true, from: "2026-09-09" })).toMatchObject({ ok: false, error: "bad_args" }); // from alone: a 92-day partner, clamped at today: 36 days
    expect(await runA({ action: "search", has_prescription: true, from: "2026-09-14", to: "2026-10-14" })).toMatchObject({ ok: true }); // 31 days inclusive
    expect(await runA({ action: "search", has_prescription: true })).toMatchObject({ ok: true, default_window: true });
    expect(await runA({ action: "search", has_rx: false, from: "2026-09-09" })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await runA({ action: "search", individual_uid: "IND-A", from: "2026-09-09", to: "2026-10-14" })).toMatchObject({ ok: true });
  });
  it("C5: the new path returns what the old chunked path returned on the same fixture (ids equal, order equal)", async () => {
    trio();
    const viaSql = uidsOf(await runA({ action: "search", individual_uid: "IND-A" }));
    const viaJoin = (await runA({ action: "search", include_identity: true, limit: 200 })).rows as Row[];
    const oldPath = viaJoin.filter((r) => (r.identity as Row | null)?.individual_uid === "IND-A").map((r) => r.consult_uid);
    expect(viaSql).toEqual(oldPath);
  });
  it("CATALOG-6 FIX1: has_prescription = (prescription IS NOT NULL OR prescription_uid IS NOT NULL): uid-only is true / rx ok / matches =true and not =false; both null is false; jsonb-only is true", async () => {
    setCatalog([crow("UID_ONLY_AAA", { t_open: 300 }), crow("BOTH_NULL_BBB", { t_open: 200 }), crow("JSONB_ONLY_CC", { t_open: 100 })]);
    H.identity = [
      idrow("UID_ONLY_AAA", { prescription_uid: "RX-U", prescription: null }),
      idrow("BOTH_NULL_BBB", { prescription_uid: null, prescription: null }),
      idrow("JSONB_ONLY_CC", { prescription_uid: null, prescription: { m: 1 } }),
    ];
    const rows = (await runA({ action: "search" })).rows as Row[];
    expect(rows.map((r) => [r.consult_uid, r.has_prescription])).toEqual([["UID_ONLY_AAA", true], ["BOTH_NULL_BBB", false], ["JSONB_ONLY_CC", true]]);
    expect(uidsOf(await runA({ action: "search", has_prescription: true }))).toEqual(["UID_ONLY_AAA", "JSONB_ONLY_CC"]);
    expect(uidsOf(await runA({ action: "search", has_prescription: false }))).toEqual(["BOTH_NULL_BBB"]);
    const rx = async (uid: string) => ((await runA({ action: "get", consult_uid: uid })).layers as Record<string, Row>).rx!;
    expect(await rx("UID_ONLY_AAA")).toMatchObject({ status: "ok", data: { has_prescription: true } });
    expect((await rx("BOTH_NULL_BBB")).status).toBe("absent");
    expect(await rx("JSONB_ONLY_CC")).toMatchObject({ status: "ok", data: { has_prescription: true } });
  });

  // --- CATALOG-7: clip_audio_chunk ---
  describe("CATALOG-7 clip_audio_chunk", () => {
    const CLIPKEY = `consult-clips/2026-10-05/opd-a/${UID}/consult.flac`;
    const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256);
    const chunk = async (args: Row = {}) => run({ action: "clip_audio_chunk", consult_uid: UID, ...args });
    const dec = (o: Row) => Buffer.from(o.base64 as string, "base64");
    beforeEach(() => {
      setCatalog([crow(UID)]);
      H.clip = bytes(2500);
    });
    it("first chunk: offset 0, the exact Range, base64 of the stored bytes, done false; the shape", async () => {
      const o = await chunk({ offset: 0, length: 1000 });
      expect(o).toEqual({ ok: true, consult_uid: UID, offset: 0, length: 1000, total_bytes: 2500, content_type: "audio/flac", base64: Buffer.from(bytes(2500).slice(0, 1000)).toString("base64"), done: false, signature_sha256: "s".repeat(64) });
      expect(H.rangeCalls).toEqual([{ key: CLIPKEY, start: 0, end: 999 }]);
    });
    it("a middle chunk and the last partial chunk (done:true); the bytes reassemble to the whole clip", async () => {
      const a = await chunk({ offset: 0, length: 1000 });
      const b = await chunk({ offset: 1000, length: 1000 });
      expect(b).toMatchObject({ offset: 1000, length: 1000, done: false });
      expect(H.rangeCalls.at(-1)).toEqual({ key: CLIPKEY, start: 1000, end: 1999 });
      const c = await chunk({ offset: 2000, length: 1000 });
      expect(c).toMatchObject({ offset: 2000, length: 500, total_bytes: 2500, done: true });
      expect(H.rangeCalls.at(-1)).toEqual({ key: CLIPKEY, start: 2000, end: 2999 }); // exactly bytes=offset-(offset+length-1), as asked
      expect(Buffer.concat([dec(a), dec(b), dec(c)]).equals(Buffer.from(bytes(2500)))).toBe(true);
    });
    it("the default length is 1,048,576 and offset 0; a clip shorter than that is one chunk with done:true", async () => {
      const o = await chunk();
      expect(H.rangeCalls).toEqual([{ key: CLIPKEY, start: 0, end: 1_048_575 }]);
      expect(o).toMatchObject({ ok: true, offset: 0, length: 2500, done: true });
      H.clip = bytes(1_048_576 + 10);
      const big = await chunk();
      expect(big).toMatchObject({ length: 1_048_576, done: false, total_bytes: 1_048_586 });
    });
    it("exactly reaching the end is done:true; length over the cap, 0, fractional or negative length is bad_args", async () => {
      expect(await chunk({ offset: 1500, length: 1000 })).toMatchObject({ length: 1000, done: true });
      for (const length of [1_048_577, 0, -1, 1.5, "x", 1e12]) expect(await chunk({ length }), String(length)).toMatchObject({ ok: false, error: "bad_args" });
      expect(H.rangeCalls.length).toBe(1);
    });
    it("a negative or fractional offset is bad_args; nothing is read", async () => {
      H.rangeCalls = [];
      for (const offset of [-1, 0.5, "1.5", "-3", "abc", Number.NaN]) expect(await chunk({ offset }), String(offset)).toMatchObject({ ok: false, error: "bad_args" });
      expect(H.rangeCalls).toEqual([]);
    });
    it("an offset at or past the end is bad_range with total_bytes (also when the Content-Range header is absent: total from a HEAD)", async () => {
      expect(await chunk({ offset: 2500 })).toEqual({ ok: false, error: "bad_range", total_bytes: 2500 });
      expect(await chunk({ offset: 99_999 })).toEqual({ ok: false, error: "bad_range", total_bytes: 2500 });
      H.clipRangeHeader = false;
      H.headCalls = [];
      expect(await chunk({ offset: 1000, length: 500 })).toMatchObject({ ok: true, total_bytes: 2500, done: false });
      expect(H.headCalls).toEqual([CLIPKEY]);
    });
    it("a clip key that does not bind to the row is never read (bad_clip_key); blind, not_found and bad uid are refused before any read", async () => {
      setCatalog([crow(UID, { clip: { r2_key: `consult-clips/2026-10-04/opd-a/${UID}/consult.flac`, bytes: 1, minutes: 1 } }), crow("BLINDROW1", { ist_date: "2026-10-01", room_id: "room_blind" })]);
      H.rangeCalls = [];
      expect(await chunk()).toEqual({ ok: false, error: "bad_clip_key" });
      expect(await run({ action: "clip_audio_chunk", consult_uid: "BLINDROW1" })).toEqual({ ok: false, error: "blind_room_day" });
      expect(await run({ action: "clip_audio_chunk", consult_uid: "NOSUCHUID1" })).toEqual({ ok: false, error: "not_found" });
      expect(await run({ action: "clip_audio_chunk", consult_uid: "x" })).toMatchObject({ error: "bad_args" });
      expect(H.rangeCalls).toEqual([]);
    });
    it("F1: a Range-ignoring 200 (the whole body, no Content-Range) is read_failed with no base64; a short body without the header is read_failed; an over-long body with the header is read_failed", async () => {
      H.clip = bytes(3000);
      H.clipIgnoreRange = true;
      const o = await chunk({ offset: 1000, length: 1000 });
      expect(o).toEqual({ ok: false, error: "read_failed" });
      expect(JSON.stringify(o)).not.toContain("base64");
      // the default length on a clip longer than the cap: the whole body would exceed length
      H.clip = bytes(1_048_576 + 50);
      expect(await chunk()).toEqual({ ok: false, error: "read_failed" });
      // the same clip honouring Range is fine (the slice exactly matches min(length, total - offset))
      H.clipIgnoreRange = false;
      H.clipRangeHeader = false;
      H.clip = bytes(3000);
      expect(await chunk({ offset: 2500, length: 1000 })).toMatchObject({ ok: true, length: 500, done: true });
      expect(await chunk({ offset: 0, length: 1000 })).toMatchObject({ ok: true, length: 1000, done: false });
    });
    it("a missing object and a failing read are codes, not throws", async () => {
      H.clip = null;
      expect(await chunk()).toEqual({ ok: false, error: "clip_not_found" });
      H.clip = bytes(10);
      H.clipReadThrows = true;
      expect(await chunk()).toEqual({ ok: false, error: "read_failed" });
    });
    it("door: a read token is allowed; a room-restricted token is refused before any read", async () => {
      const ok = await rpc({ action: "clip_audio_chunk", consult_uid: UID, length: 100 });
      expect(ok.error).toBeUndefined();
      expect(ok.result!.structuredContent).toMatchObject({ ok: true, length: 100 });
      H.rangeCalls = [];
      const refused = await rpc({ action: "clip_audio_chunk", consult_uid: UID }, { rooms: new Set(["room_a"]), scopes: new Set<McpScope>(["read", "invoke", "write"]) });
      expect(refused.error).toMatchObject({ code: -32001 });
      expect(H.rangeCalls).toEqual([]);
    });
    it("A3: the audit row holds action, consult_uid, offset and length as numbers; no base64, key or bytes in any audit insert or console line; string offsets/lengths are dropped", async () => {
      H.clip = bytes(3000);
      const o = await rpc({ action: "clip_audio_chunk", consult_uid: UID, offset: 100, length: 200 });
      const b64 = o.result!.structuredContent.base64 as string;
      expect(b64.length).toBeGreaterThan(100);
      expect(lastAudit().args).toEqual({ action: "clip_audio_chunk", consult_uid: UID, offset: 100, length: 200 });
      const everything = JSON.stringify(auditRows()) + logs.join("\n");
      expect(everything).not.toContain(b64);
      expect(everything).not.toContain(b64.slice(0, 40));
      for (const needle of ["consult-clips/", "base64", "audio/flac"]) expect(everything, needle).not.toContain(needle);
      const { safeArgs } = await import("@/lib/mcp/audit");
      expect(safeArgs({ offset: "5", length: "7" })).toEqual({});
      expect(safeArgs({ offset: 5, length: 7 })).toEqual({ offset: 5, length: 7 });
    });
  });
});
});

describe("CATALOG-8: layers.audio_features", () => {
  const fk = (engine: string, ver = "v1", uid = UID, room = "room_a", day = "2026-10-05", cfg = "ab12cd34") => `reb/${day}/${room}/_consults/${uid}/tracks/features.${engine}__${ver}__${cfg}.json`;
  const ftrack = (features: unknown, o: Row = {}): Row => ({ layer: "features", engine: "x", version: "v1", status: "ok", config: {}, segments: [], extras: { features }, ...o });
  const GOOD = { speaker: "spk0", role: "doctor", role_source: "llm", feature: "f0_mean", stat: "median", value: 1.5, iqr: 0.2, n_turns: 4, seconds: 12.5, overlap_excluded_s: 0, reliability: 0.9, model_id: "m1", model_rev: "r1" };
  const withAf = (af: unknown, uid = UID, o: Row = {}) => (resetCatalogCacheForTests(), setCatalog([crow(uid, { layers: { stt: null, translate: null, role: null, parts: null, audio_features: af }, ...o })]));
  const af = async (): Promise<Row> => (((await run({ action: "get", consult_uid: UID })).layers as Record<string, Row>).audio_features)!;

  it("a row without audio_features is absent, and a get with every key absent is still ok", async () => {
    setCatalog([crow(UID)]);
    seedLayers();
    expect(await af()).toEqual({ status: "absent", source: [], data: null });
    withAf({ r2_key: fk("timbre-e2v") });
    const o = await run({ action: "get", consult_uid: UID });
    expect(o.ok).toBe(true);
    expect((o.layers as Record<string, Row>).audio_features).toEqual({ status: "absent", source: [fk("timbre-e2v")], data: null });
  });

  it("shapes a, b and c each read", async () => {
    setTrack(fk("timbre-e2v"), ftrack([GOOD]));
    setTrack(fk("talktime", "v2"), ftrack([{ ...GOOD, feature: "talk_share" }]));
    const a = { r2_key: fk("timbre-e2v"), status: "ok" };
    const b2 = { r2_key: fk("talktime", "v2") };
    for (const [shape, v, n] of [["a", a, 1], ["b", [a, b2], 2], ["c", { "timbre-e2v": a, talktime: b2 }, 2]] as const) {
      withAf(v);
      resetCatalogCacheForTests();
      const l = await af();
      expect(l.status, shape).toBe("ok");
      const d = l.data as { tracks: Row[]; n_skipped: number };
      expect(d.tracks.length, shape).toBe(n);
      expect(d.n_skipped).toBe(0);
      expect(d.tracks[0]).toEqual({ engine: "timbre-e2v", version: "v1", rows: [GOOD], n_rows_dropped: 0 });
    }
  });

  it("CATALOG-10: a flags track in shape c is read; a near-miss engine is still skipped", async () => {
    setTrack(fk("flags"), ftrack([{ ...GOOD, feature: "overlap_flag" }]));
    withAf({ flags: { r2_key: fk("flags"), status: "ok" }, flagz: { r2_key: fk("flagz") } });
    const l = await af();
    expect(l.status).toBe("ok");
    const d = l.data as { tracks: Row[]; n_skipped: number };
    expect(d.tracks).toEqual([{ engine: "flags", version: "v1", rows: [{ ...GOOD, feature: "overlap_flag" }], n_rows_dropped: 0 }]);
    expect(d.n_skipped).toBe(1);
    expect(reads.filter((r) => r.includes("flagz"))).toEqual([]);
  });

  it("an unknown engine is skipped and counted, never read", async () => {
    setTrack(fk("clef"), ftrack([GOOD]));
    withAf([{ r2_key: fk("clef") }, { r2_key: fk("mystery") }, { r2_key: fk("clef", "v1").replace("features.", "other.") }]);
    const l = await af();
    expect((l.data as Row).n_skipped).toBe(2);
    expect(((l.data as Row).tracks as Row[]).length).toBe(1);
    expect(reads.filter((r) => r.includes("mystery") || r.includes("other."))).toEqual([]);
  });

  it("a key bound to another consult is key_not_readable; a non-string key too", async () => {
    withAf({ r2_key: fk("clef", "v1", "OTHERUID0001") });
    expect(await af()).toMatchObject({ status: "error", error: "key_not_readable" });
    withAf({ r2_key: 42 });
    expect(await af()).toMatchObject({ status: "error", error: "key_not_readable" });
    expect(reads.filter((r) => r.includes("OTHERUID0001"))).toEqual([]);
  });

  it("a blind room-day key is refused", async () => {
    const k = fk("clef", "v1", UID, "room_blind", "2026-10-01");
    const row = crow(UID, { ist_date: "2026-10-01", room_id: "room_blind", layers: { audio_features: { r2_key: k } } });
    setTrack(k, ftrack([GOOD]));
    expect(await readAudioFeaturesLayer(row)).toMatchObject({ status: "error", error: "blind_room_day" });
    expect(reads).not.toContain(k);
  });

  it("a track whose status is not ok is absent; bad_json and read_failed are counted, not fatal", async () => {
    setTrack(fk("clef"), ftrack([GOOD], { status: "failed" }));
    withAf({ r2_key: fk("clef") });
    expect(await af()).toMatchObject({ status: "absent" });
    setTrack(fk("clef"), ftrack([GOOD]));
    store.set(fk("talktime"), { body: "{nope", etag: null });
    failKey = fk("timbre-e2v");
    withAf([{ r2_key: fk("clef") }, { r2_key: fk("talktime") }, { r2_key: fk("timbre-e2v") }]);
    const l = await af();
    expect(l.status).toBe("ok");
    expect((l.data as Row).errors).toEqual({ bad_json: 1, read_failed: 1 });
    // every key erroring: the layer errors with the first code
    store.delete(fk("clef"));
    store.set(fk("clef"), { body: "{nope", etag: null });
    withAf([{ r2_key: fk("clef") }, { r2_key: fk("talktime") }]);
    expect(await af()).toMatchObject({ status: "error", error: "bad_json", data: null });
  });

  it("rows keep the whitelist only; strings need the pattern, numbers must be finite", async () => {
    const big = "x".repeat(81);
    setTrack(fk("talktime"), ftrack([
      { ...GOOD, transcript: "ZZTEXT", name: "N", extra: 1 },
      { ...GOOD, speaker: "has space", role: big, stat: "ok/1:2", value: "1", iqr: Number.POSITIVE_INFINITY, reliability: null },
      { speaker: "spk1", value: 1 },
      "junk",
      { ...GOOD, feature: "bad feature" },
    ]));
    withAf({ r2_key: fk("talktime") });
    const d = (await af()).data as { tracks: Array<{ rows: Row[]; n_rows_dropped: number }> };
    expect(d.tracks[0].n_rows_dropped).toBe(3);
    expect(d.tracks[0].rows[0]).toEqual(GOOD);
    expect(d.tracks[0].rows[1]).toMatchObject({ speaker: null, role: null, stat: "ok/1:2", value: null, iqr: null, reliability: null, feature: "f0_mean" });
    expect(JSON.stringify(d)).not.toContain("ZZTEXT");
  });

  it("501 rows give 500 plus 1 dropped; 9 keys give too_many_tracks", async () => {
    setTrack(fk("clef"), ftrack(Array.from({ length: 501 }, () => GOOD)));
    withAf({ r2_key: fk("clef") });
    const d = (await af()).data as { tracks: Array<{ rows: Row[]; n_rows_dropped: number }> };
    expect([d.tracks[0].rows.length, d.tracks[0].n_rows_dropped]).toEqual([500, 1]);
    withAf(Array.from({ length: 9 }, () => ({ r2_key: fk("clef") })));
    expect(await af()).toMatchObject({ status: "error", error: "too_many_tracks" });
    withAf(Array.from({ length: 8 }, () => ({ r2_key: fk("clef") })));
    expect((await af()).status).toBe("ok");
  });

  it("search never shows an r2_key for shapes a, b and c", async () => {
    for (const v of [{ r2_key: fk("clef") }, [{ r2_key: fk("clef") }], { clef: { r2_key: fk("clef") } }, [fk("clef")], [[{ r2_key: fk("clef") }]]]) {
      withAf(v);
      resetCatalogCacheForTests();
      const o = await run({ action: "search", from: "2026-10-05", to: "2026-10-05" });
      expect(JSON.stringify(o)).not.toContain("features.clef");
      expect(((o.rows as Row[])[0].layers_present as string[])).toContain("audio_features");
    }
  });
});

describe("CATALOG-9: search scrubs storage keys at any depth", () => {
  const K = `reb/2026-10-05/room_a/_consults/${UID}/tracks/x__v1__ab12cd34.json`;
  const search = async (layers: Row, o: Row = {}): Promise<Row> => {
    resetCatalogCacheForTests();
    setCatalog([crow(UID, { layers, ...o })]);
    return ((await run({ action: "search", from: "2026-10-05", to: "2026-10-05" })).rows as Row[])[0]!;
  };
  const L = async (v: unknown): Promise<unknown> => ((await search({ lay: v })).layers as Row).lay;

  it("the three INFO-1 shapes show no key", async () => {
    expect(await L({ status: "ok", x: K })).toEqual({ status: "ok", x: null });
    expect(await L({ status: "ok", by: { x: { r2_key: K } } })).toEqual({ status: "ok", by: { x: {} } });
    expect(await L({ status: "ok", x: { key: K, engine: "e1" } })).toEqual({ status: "ok", x: { engine: "e1" } });
  });
  it("field names are dropped case-insensitively; url-like and store-like strings become null; plain strings stay", async () => {
    const out = (await L({ URL: "a", Signed_Url: "b", keys: [1], r2_keys: [2], a: "https://h.example/p", b: "consult-clips/d/s/u/consult.flac", c: "palimpsest/ledger/x", d: "plain text", e: 3, f: true, g: null, version: "v1", n_turns: 4 })) as Row;
    expect(out).toEqual({ a: null, b: null, c: null, d: "plain text", e: 3, f: true, g: null, version: "v1", n_turns: 4 });
  });
  it("depth 7 becomes null; a leaf at depth 7 and any container below it are null; depth 6 survives", async () => {
    const nest = (n: number): unknown => (n === 0 ? "leaf" : { n: nest(n - 1) });
    // layer value is depth 0; its sixth nested object holds "leaf" at depth 6
    expect(JSON.stringify(await L(nest(6)))).toBe('{"n":{"n":{"n":{"n":{"n":{"n":"leaf"}}}}}}');
    expect(JSON.stringify(await L(nest(7)))).toBe('{"n":{"n":{"n":{"n":{"n":{"n":{"n":null}}}}}}}');
    const deepObj = JSON.stringify(await L(nest(8)));
    expect(deepObj).toBe('{"n":{"n":{"n":{"n":{"n":{"n":{"n":null}}}}}}}');
  });
  it("a 65-entry array keeps 64", async () => {
    expect(((await L(Array.from({ length: 65 }, (_, i) => i))) as unknown[]).length).toBe(64);
  });
  it("clip in search has no key but keeps its other fields", async () => {
    const r = await search({});
    expect(r.clip).toMatchObject({ r2_status: "mirrored", bytes: 1234, minutes: 0.1 });
    expect(r.clip as Row).not.toHaveProperty("r2_key");
    expect(JSON.stringify(r)).not.toContain("consult-clips/");
  });
  it("a whole search answer over keys in every layer shape holds no reb/, consult-clips/, palimpsest/ or r2_key", async () => {
    setCatalog([crow(UID, { layers: { stt: layer("stt.sarvam-saaras-v3"), a: { r2_key: K }, b: [{ r2_key: K }, K, [{ r2_key: K }]], c: { e: { r2_key: K } }, d: { by: { x: { r2_key: K } } }, e: { x: { key: K } }, f: { x: K }, g: { u: "https://h.example/" + K, p: "palimpsest/" + K } } })]);
    const out = JSON.stringify(await run({ action: "search", from: "2026-10-05", to: "2026-10-05" }));
    for (const bad of ["reb/", "consult-clips/", "palimpsest/", "r2_key", "://"]) expect(out, bad).not.toContain(bad);
    expect(out).toContain("layers_present");
  });
});

describe("CATALOG-9 FIX1: prefixes anywhere, more key field names, the whole row", () => {
  const K = `reb/2026-10-05/room_a/_consults/${UID}/tracks/x__v1__ab12cd34.json`;
  const searchRow = async (o: Row): Promise<Row> => {
    resetCatalogCacheForTests();
    setCatalog([crow(UID, o)]);
    return ((await run({ action: "search", from: "2026-10-05", to: "2026-10-05" })).rows as Row[])[0]!;
  };
  it("prefixed, embedded and map-key forms show no key", async () => {
    const r = await searchRow({ layers: { l: { a: " " + K, b: "/" + K, c: "eta-lab-results/" + K, d: "see " + K, e: "r2:" + K, [K]: { status: "ok" }, ok: "debrief/notes", n: "web-reb" } } });
    const out = JSON.stringify(r);
    for (const bad of ["reb/", "consult-clips/", "palimpsest/", "r2_key"]) expect(out, bad).not.toContain(bad);
    expect((r.layers as Row).l).toEqual({ a: null, b: null, c: null, d: null, e: null, ok: "debrief/notes", n: "web-reb" });
  });
  it("more key-like field names are dropped, case-insensitive", async () => {
    const r = await searchRow({ layers: { l: { r2Key: "x", Object_Key: "x", s3_key: "x", clip_key: "x", presigned_url: "x", HREF: "x", uri: "x", path: "x", status: "ok" } } });
    expect((r.layers as Row).l).toEqual({ status: "ok" });
  });
  it("the whole row is scrubbed: a top-level key string and manifest:{r2_key} do not show; ids and dates do", async () => {
    const r = await searchRow({ stray: K, manifest: { r2_key: K, state: "ok" }, nested: { by: [K] } });
    expect(JSON.stringify(r)).not.toContain("reb/");
    expect(r).toMatchObject({ consult_uid: UID, ist_date: "2026-10-05", room_id: "room_a", stray: null, manifest: { state: "ok" }, nested: { by: [null] } });
  });
});

describe("CATALOG-9 FIX2: key-named layers, whole-row caps", () => {
  const K = `reb/2026-10-05/room_a/_consults/${UID}/tracks/x__v1__ab12cd34.json`;
  const searchRow = async (o: Row): Promise<Row> => {
    resetCatalogCacheForTests();
    setCatalog([crow(UID, o)]);
    return ((await run({ action: "search", from: "2026-10-05", to: "2026-10-05" })).rows as Row[])[0]!;
  };
  it("a layer named like a key or a store path is in neither layers nor layers_present", async () => {
    const r = await searchRow({ layers: { stt: layer("stt.sarvam-saaras-v3"), [K]: { status: "ok" }, r2_key: { status: "ok" }, url: [1] } });
    expect(JSON.stringify(r)).not.toContain("reb/");
    expect(Object.keys(r.layers as Row)).toEqual(["stt"]);
    expect(r.layers_present).toEqual(["stt"]);
  });
  it("top-level fields keep arrays past 64 and objects 8 deep; clip too; key rules still apply at depth", async () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: "leaf", k: K } } } } } } } };
    const r = await searchRow({ many: Array.from({ length: 70 }, (_, i) => i), deep, clip: { bytes: 5, list: Array.from({ length: 70 }, (_, i) => i) } });
    expect((r.many as unknown[]).length).toBe(70);
    expect(JSON.stringify(r.deep)).toBe('{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":"leaf","k":null}}}}}}}}');
    expect(((r.clip as Row).list as unknown[]).length).toBe(70);
    // layer values keep the tight caps
    const l = await searchRow({ layers: { lay: Array.from({ length: 70 }, (_, i) => i) } });
    expect(((l.layers as Row).lay as unknown[]).length).toBe(64);
  });
});
