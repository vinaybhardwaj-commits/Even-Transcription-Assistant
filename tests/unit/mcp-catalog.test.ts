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
import { resetCatalogCacheForTests, selectTrack, parseCatalog, type Track } from "@/lib/room-access/readers/catalog-consult";
import { ROOM_RESTRICTED_ALLOWED_TOOLS, type ToolContext } from "@/lib/mcp/registry";
import type { McpScope } from "@/lib/mcp/auth";

const CTX: ToolContext = { actor: "mcp:test", origin: "https://example.test", scopes: new Set<McpScope>(["read"]) };
const run = async (args: Row): Promise<Row> => (await catalogTool.handler(args, CTX)) as Row;

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

// 0.1 min = 6,000 ms clip. Sarvam overruns the end by <= 0.56 s: the last stt segment ends at 6,400.
const stt = (o: Row = {}): Row => ({
  layer: "stt", engine: "sarvam-saaras-v3", version: "v1", status: "ok", extras: {}, config: {},
  segments: [
    { t0_ms: 0, t1_ms: 2000, speaker: "0", lang: "hi-IN", text: "NATIVE0" },
    { t0_ms: 2000, t1_ms: 4000, speaker: "1", lang: "en-IN", text: "ENGLISH1" },
    { t0_ms: 4000, t1_ms: 6400, speaker: 2, lang: "hi-IN", text: "NATIVE2" },
  ], ...o,
});
const translate = (o: Row = {}): Row => ({
  layer: "translate", engine: "sarvam-saaras-v3", version: "v1", status: "ok", extras: {}, config: {},
  segments: [{ t0_ms: 0, t1_ms: 2000, speaker: "0", text: "TR0" }, { t0_ms: 2000, t1_ms: 4000, speaker: "1", text: "TR1" }, { t0_ms: 4000, t1_ms: 6400, speaker: "2", text: "TR2" }], ...o,
});
const roles = (o: Row = {}): Row => ({
  layer: "role", engine: "llm-roles", version: "v1", status: "ok", extras: { map: { "0": "doctor", "1": "patient", "2": "attender" } }, config: {},
  segments: [{ t0_ms: 0, t1_ms: 1900, speaker: "0", role: "doctor" }, { t0_ms: 1900, t1_ms: 4000, speaker: "1", role: "patient" }, { t0_ms: 4000, t1_ms: 6400, speaker: "2", role: "staff" }], ...o,
});
const seedLayers = () => {
  setTrack(tk("stt.sarvam-saaras-v3"), stt());
  setTrack(tk("translate.sarvam-saaras-v3"), translate());
  setTrack(tk("role.llm-roles"), roles());
};

let logs: string[];
beforeEach(() => {
  H.sqlCalls = [];
  H.rooms = [{ id: "room_a", slug: "opd-a", name: "OPD A", disabled_at: null }, { id: "room_b", slug: "opd-b", name: "OPD B", disabled_at: null }];
  H.freescriptRows = [];
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
  const uids = (o: Row) => (o.rows as Row[]).map((r) => r.consult_uid);

  it("reads the one exact key, sorts newest t_open first, and returns the documented envelope; the pre-2026-09-09 row never appears", async () => {
    setCatalog(many());
    const o = await run({ action: "search" });
    expect(o).toMatchObject({ ok: true, total_matched: 4, next_cursor: null, n_bad_lines: 0, n_blind_excluded: 0, catalog_generated_at: "2026-10-14T01:00:00Z" });
    expect(uids(o)).toEqual(["AAAAAA02", "AAAAAA03", "AAAAAA01", "AAAAAA04"]);
    expect(reads).toEqual([ENCOUNTER_CATALOG_KEY]);
  });
  it("filters: doctor_uid, room (slug, id and name resolve), source, from/to", async () => {
    setCatalog(many());
    expect(uids(await run({ action: "search", doctor_uid: "docA" }))).toEqual(["AAAAAA03", "AAAAAA01", "AAAAAA04"]);
    expect(uids(await run({ action: "search", room: "opd-b" }))).toEqual(["AAAAAA02"]);
    expect(uids(await run({ action: "search", room: "room_b" }))).toEqual(["AAAAAA02"]);
    expect(uids(await run({ action: "search", room: "opd b" }))).toEqual(["AAAAAA02"]);
    expect(uids(await run({ action: "search", source: "caa" }))).toEqual(["AAAAAA02"]);
    expect(uids(await run({ action: "search", from: "2026-10-02", to: "2026-10-03" }))).toEqual(["AAAAAA02", "AAAAAA03"]);
    expect(await run({ action: "search", room: "nowhere" })).toEqual({ ok: false, error: "unknown_room" });
    expect(await run({ action: "search", source: "other" })).toMatchObject({ ok: false, error: "bad_args" });
  });
  it("a span over 92 days is bad_args; exactly 92 days passes; from alone and to alone get a 92-day partner", async () => {
    setCatalog(many());
    expect(await run({ action: "search", from: "2026-09-09", to: "2026-12-10" })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await run({ action: "search", from: "2026-09-09", to: "2026-12-09" })).toMatchObject({ ok: true });
    expect(await run({ action: "search", from: "2026-13-40" })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await run({ action: "search", from: "2026-10-04", to: "2026-10-01" })).toMatchObject({ ok: false, error: "bad_args" });
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
    const p1 = await run({ action: "search", limit: 3 });
    expect(uids(p1)).toHaveLength(3);
    expect(typeof p1.next_cursor).toBe("string");
    const p2 = await run({ action: "search", limit: 3, cursor: p1.next_cursor });
    expect([...uids(p1), ...uids(p2)]).toEqual(["AAAAAA02", "AAAAAA03", "AAAAAA01", "AAAAAA04"]);
    expect(p2.next_cursor).toBeNull();
    expect(await run({ action: "search", cursor: "not a cursor!" })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await run({ action: "search", cursor: "AAAA" })).toMatchObject({ ok: false, error: "bad_args" });
    const big = Array.from({ length: 230 }, (_, i) => crow(`BIGROW${String(i).padStart(3, "0")}`, { t_open: i }));
    setCatalog(big);
    resetCatalogCacheForTests();
    expect(uids(await run({ action: "search", limit: 9999 }))).toHaveLength(200);
  });
  it("has_rx is refused in v1, whatever its value", async () => {
    setCatalog(many());
    for (const v of [true, false, "yes"]) expect(await run({ action: "search", has_rx: v })).toEqual({ ok: false, error: "bad_args", detail: "has_rx arrives with catalog C2" });
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
    expect(Object.keys(layers)).toEqual(["transcript", "parts", "freescript", "rubric", "jev", "cdmss", "rx"]);
    for (const l of Object.values(layers)) expect(Object.keys(l).filter((k) => k !== "error").sort()).toEqual(["data", "source", "status"]);
    expect(layers.cdmss).toEqual({ status: "not_available", source: ["consult-audit S5 (pending)"], data: null });
    expect(layers.rx).toEqual({ status: "not_available", source: ["catalog C2 (pending)"], data: null });
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
    expect(t.source).toEqual([tk("stt.sarvam-saaras-v3"), tk("translate.sarvam-saaras-v3"), tk("role.llm-roles")]);
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
    setTrack(tk("translate.sarvam-saaras-v3"), translate({ segments: [{ t0_ms: 1000, t1_ms: 3900, text: "ONE" }] }));
    const segs = ((await tr({ include_text: true })).data as Row).segments as Row[];
    expect(segs.map((s) => s.text_en)).toEqual(["ONE", "ONE", null]); // seg 2 (4000-6400) overlaps nothing; lang hi: no fallback
  });
  it("role: the role segment with the most overlap wins over the speaker map; then the map; else unknown", async () => {
    // seg 0 (0-2000) overlaps doctor (0-1900) by 1900 and patient (1900-4000) by 100: doctor. seg 2 overlaps "staff" though the map says attender: overlap wins.
    let segs = ((await tr()).data as Row).segments as Row[];
    expect(segs.map((s) => s.role)).toEqual(["doctor", "patient", "staff"]);
    // no overlapping role segment for seg 2: the track's speaker map answers
    setTrack(tk("role.llm-roles"), roles({ segments: [{ t0_ms: 0, t1_ms: 2000, speaker: "0", role: "doctor" }] }));
    segs = ((await tr()).data as Row).segments as Row[];
    expect(segs.map((s) => s.role)).toEqual(["doctor", "patient", "attender"]);
    // no map either: unknown
    setTrack(tk("role.llm-roles"), roles({ extras: {}, segments: [] }));
    segs = ((await tr()).data as Row).segments as Row[];
    expect(segs.map((s) => s.role)).toEqual(["unknown", "unknown", "unknown"]);
    // an invalid role string is unknown, never passed through
    setTrack(tk("role.llm-roles"), roles({ extras: {}, segments: [{ t0_ms: 0, t1_ms: 6400, speaker: "0", role: "wizard" }] }));
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
      expect(reads, k).toEqual([ENCOUNTER_CATALOG_KEY]);
    }
  });
  it("a non-string key is key_not_readable too", async () => {
    setCatalog([crow(UID, { layers: { stt: { r2_key: 42, status: "ok" }, translate: null, role: null, parts: null } })]);
    const l = (await run({ action: "get", consult_uid: UID })).layers as Record<string, Row>;
    expect(l.transcript).toMatchObject({ status: "error", error: "key_not_readable" });
  });
});

describe("get: parts", () => {
  const parts = (mode: string): Row => ({ layer: "parts", engine: "clef-jev", version: "v0", status: "ok", config: { clef_mode: mode }, extras: {}, segments: [{ part: "history", t0_ms: 0, t1_ms: 900, score: 0.8, confidence: 0.7, source: "jev" }] });
  it("clef+jev only: other modes are absent; the rows carry part, times, score, confidence, source", async () => {
    setCatalog([crow(UID, { layers: { stt: null, translate: null, role: null, parts: layer("parts.clef-jev") } })]);
    setTrack(tk("parts.clef-jev"), parts("clef+jev"));
    let p = ((await run({ action: "get", consult_uid: UID })).layers as Record<string, Row>).parts!;
    expect(p).toEqual({ status: "ok", source: [tk("parts.clef-jev")], data: [{ part: "history", t0_ms: 0, t1_ms: 900, score: 0.8, confidence: 0.7, source: "jev" }] });
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
    expect((r.data as Row[])[0]).toEqual({ rubric_id: "pitch_detect", version: "1.0.0", run_id: "rub_1", status: "ok", score: { n: 3, ok: true, verdict: "pass" }, verdict: "pass", created_at: "2026-10-06T00:00:00Z" });
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

// --- the door ---------------------------------------------------------------------------------------------------------------------------------
describe("the door", () => {
  const { handleMcpRpc } = { handleMcpRpc: (...a: Parameters<typeof import("@/lib/mcp/handler").handleMcpRpc>) => import("@/lib/mcp/handler").then((m) => m.handleMcpRpc(...a)) };
  const rpc = async (args: Row, principal: { rooms?: Set<string>; scopes?: Set<McpScope> } = {}) => {
    const req = new NextRequest("https://x/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "scribe_catalog", arguments: args } }) });
    const res = await handleMcpRpc(req, { token_id: "reader", scopes: principal.scopes ?? new Set<McpScope>(["read"]), ...(principal.rooms ? { rooms: principal.rooms } : {}) } as never);
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
    expect(JSON.stringify(auditRows())).not.toContain(UID);
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
});
