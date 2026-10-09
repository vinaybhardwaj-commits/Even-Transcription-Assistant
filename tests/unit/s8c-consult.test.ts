/**
 * S8C — consult clips in scribe_sarvam through CONSULT's index mirror. sql, R2, the job queue, the lab store and fetch are all fakes; no gateway, no Sarvam, no production.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

type Row = Record<string, unknown>;
const statements: Array<{ text: string; values: unknown[] }> = [];
let answer: (text: string, values: unknown[]) => unknown = () => [];
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => { const text = strings.join("?"); statements.push({ text, values }); return Promise.resolve(answer(text, values)); };
  sql.transaction = async () => [];
  return { sql, db: {} };
});
const clipBytes = new Map<string, Uint8Array>();
const heads: string[] = [];
let headSize: number | null = 1000;
vi.mock("@/lib/r2", async (orig) => ({ ...((await orig()) as object), headObject: vi.fn(async (k: string) => { heads.push(k); return { size: headSize, content_type: "audio/flac" }; }), getObjectBytes: vi.fn(async (k: string) => clipBytes.get(k) ?? null) }));
const submitted: Row[] = [];
vi.mock("@/lib/jobs/submit", async (orig) => ({ ...((await orig()) as object), submitJob: vi.fn(async (i: { kind: string; args: Row }) => { submitted.push(i); return { id: "job_c1", kind: i.kind, status: "queued" }; }) }));
vi.mock("@/lib/jobs/kinds/sarvam-common", async (orig) => ({ ...((await orig()) as object), dailyCapRefusal: vi.fn(async () => null) }));
vi.mock("@/lib/sarvam-gateway", async (orig) => ({ ...((await orig()) as object), gatewayConfigured: () => true }));

const L = await import("@/lib/sarvam-lab");
const S = await import("@/lib/mcp/surface");
const CI = await import("@/lib/consult-index");
const { BLIND_ROOM_DAYS } = await import("@/lib/rubrics/blind-room-days");
const T = await import("@/lib/jobs/kinds/sarvam-transcribe");
const [BD, BR] = BLIND_ROOM_DAYS[0]!;

const sha = (b: string) => createHash("sha256").update(b, "utf8").digest("hex");
const UID = "CUidAaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const row = (uid: string, o: Row = {}): Row => ({ consult_uid: uid, window_id: `consult-${uid}`, ist_date: "2026-10-08", room_id: "r1", room_slug: "opd-1", span_start: "2026-10-08T10:00:00Z", span_end: "2026-10-08T10:10:00Z", span_end_epoch: 1, t_open: "x", t_close: "y",
  minutes: 10, bytes: 123, quality: "clean", flags: [], coverage: 0.9, voice_isolated: false, doctor_uid: "DOCTORUID123", doctor_identified: true, cut_at: "z", code_commit: "abc", signature: "SIGSECRET", r2: { bucket: "eta-audio", prefix: "consult-clips/p", files: ["consult.flac"], at: "t" }, ...o });
const mem = new Map<string, string>();
const gets: string[] = [];
function setIndex(rows: Row[], o: { badSha?: boolean; noManifest?: boolean } = {}) {
  const latest = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  mem.set("consult/index/latest.jsonl", latest);
  mem.delete("consult/index/manifest.json");
  if (!o.noManifest) mem.set("consult/index/manifest.json", JSON.stringify({ generated_at: "2026-10-09T00:00:00Z", rows: rows.length, sha256: o.badSha ? "0".repeat(64) : sha(latest), code_commit: "abc" }));
}
const track = (layer: string, n = 3) => JSON.stringify({ layer, status: "ok", segments: Array.from({ length: n }, (_, i) => ({ t0_ms: i * 1000, t1_ms: i * 1000 + 900, speaker: "0", lang: "en-IN", text: `line ${i}`, extras: {} })) });
function setRebTrack(uid = UID, layer = "translate") {
  const body = track(layer);
  const key = `reb/2026-10-08/r1/_consults/${uid}/tracks/${layer}.sarvam-saaras-v3__saaras-v3__abcd1234.json`;
  mem.set(key, body);
  answer = (t) => (/FROM reb_track_index/.test(t) ? [{ layer, engine: "e", config_hash: "abcd1234", r2_key: key, sha256: sha(body) }] : /FROM eta_encounter_windows/.test(t) ? [] : []);
}
const ctx = { origin: "https://x", actor: "mcp:t", scopes: new Set(["read", "invoke"]) } as never;
const call = async (args: Row) => (await S.CALLABLE_TOOLS.get("scribe_sarvam")!.handler(args, ctx)) as Row;
const fetchSpy = vi.fn();

beforeEach(() => {
  statements.length = 0; submitted.length = 0; heads.length = 0; mem.clear(); gets.length = 0; headSize = 1000; answer = () => [];
  fetchSpy.mockReset(); vi.stubGlobal("fetch", fetchSpy);
  L.setLabStoreForTests({ get: async (k) => { gets.push(k); return mem.has(k) ? { body: mem.get(k)!, etag: "e" } : null; }, put: async () => "ok", list: async () => [] });
});
afterEach(() => { vi.unstubAllGlobals(); L.setLabStoreForTests(null); });

describe("the lab allowlist: the two mirror objects, GET only", () => {
  it("GET of latest.jsonl and manifest.json works; PUT, list, any other consult/ key and a path trick are refused; nothing under consult/ is writable", async () => {
    mem.set("consult/index/latest.jsonl", "x");
    const store = L.labStore()!;
    await expect(store.get("consult/index/latest.jsonl")).resolves.toMatchObject({ body: "x" });
    await expect(store.get("consult/index/manifest.json")).resolves.toBeNull();
    await expect(store.put("consult/index/latest.jsonl", "evil", {})).rejects.toThrow(/not_writable/);
    for (const bad of ["consult/index/other.json", "consult/index/", "consult/index/latest.jsonl/../x", "consult/x", "consult/index/latest.jsonl.bak"]) await expect(store.get(bad), bad).rejects.toThrow(/lab_key_not_readable/);
    await expect(store.list("consult/index/")).rejects.toThrow(/lab_key_not_readable/);
    expect(L.labWritable("consult/index/latest.jsonl")).toBe(false);
    expect(L.labReadable("consult/index/latest.jsonl")).toBe(true);
  });
});

describe("the mirror and its integrity", () => {
  it("a sha256 that does not match the manifest = consult_index_integrity and NO rows, in the library, in transcribe and in consult_clips; nothing is submitted", async () => {
    setIndex([row(UID)], { badSha: true });
    expect(await CI.readConsultIndex()).toEqual({ ok: false, error: "consult_index_integrity" });
    expect(await call({ action: "transcribe", consult_uid: UID })).toMatchObject({ ok: false, error: "consult_index_integrity" });
    expect(await call({ action: "consult_clips", ist_date: "2026-10-08" })).toEqual({ ok: false, error: "consult_index_integrity" });
    expect(submitted).toEqual([]);
    setIndex([row(UID)], { noManifest: true });
    expect(await CI.readConsultIndex()).toEqual({ ok: false, error: "consult_index_unavailable" });
  });
  it("doctor fields never leave: consult_clips rows carry no doctor_uid, doctor_identified or signature, whatever the mirror holds", async () => {
    setIndex([row(UID)]);
    const out = await call({ action: "consult_clips", ist_date: "2026-10-08" });
    const s = JSON.stringify(out);
    expect(out).toMatchObject({ ok: true, count: 1, sendable: 1, voice_isolated: 0 });
    for (const bad of ["doctor_uid", "doctor_identified", "DOCTORUID123", "signature", "SIGSECRET"]) expect(s, bad).not.toContain(bad);
    expect(CI.publicRow(row(UID) as never)).not.toHaveProperty("doctor_uid");
    expect(Object.keys(CI.publicRow(row(UID) as never))).toEqual(expect.arrayContaining(["consult_uid", "ist_date", "room_id", "voice_isolated", "minutes"]));
  });
  it("consult_clips: held-out and unplaced rows are excluded and counted, the room and status filters work, the held-out (date, room) is refused before the mirror is read", async () => {
    setIndex([row(UID), row("CUidBbbbbbbbbbbbbbbbbbbbbbbbbbbbb2", { room_id: "r2", room_slug: "opd-2", voice_isolated: true }), row("CUidCcccccccccccccccccccccccccccc3", { room_id: BR, ist_date: BD }), row("CUidDddddddddddddddddddddddddddd4", { room_id: "", ist_date: "2026-10-08" })]);
    const day = await call({ action: "consult_clips", ist_date: "2026-10-08" });
    expect(day).toMatchObject({ ok: true, count: 2, voice_isolated: 1, sendable: 1, n_unplaced_excluded: 1, n_blind_excluded: 0 });
    expect(await call({ action: "consult_clips", ist_date: "2026-10-08", room_slug: "opd-2" })).toMatchObject({ count: 1 });
    expect(await call({ action: "consult_clips", ist_date: "2026-10-08", status: "failed" })).toMatchObject({ ok: true, count: 0 });
    expect(await call({ action: "consult_clips", ist_date: BD })).toMatchObject({ ok: true, count: 0, n_blind_excluded: 1 }); // the held-out row is excluded and counted, never returned
    gets.length = 0;
    expect(await call({ action: "consult_clips", ist_date: BD, room_slug: BR })).toEqual({ ok: false, error: "blind_room_day" });
    expect(gets).toEqual([]);
    expect(await call({ action: "consult_clips", ist_date: "nope" })).toMatchObject({ ok: false, error: "invalid_ist_date" });
  });
});

describe("transcribe {consult_uid}", () => {
  it("a held-out consult is refused BEFORE the mirror, any track or the audio is read", async () => {
    answer = (t) => (/FROM eta_encounter_windows/.test(t) ? [{ room_id: BR, ist_date: BD }] : []);
    setIndex([row(UID, { room_id: BR, ist_date: BD })]);
    expect(await call({ action: "transcribe", consult_uid: UID })).toEqual({ ok: false, error: "blind_room_day" });
    expect(gets).toEqual([]);
    expect(heads).toEqual([]);
    expect(statements.every((s) => /FROM eta_encounter_windows/.test(s.text))).toBe(true);
    expect(submitted).toEqual([]);
    // status / result are guarded the same way
    for (const action of ["status", "result"]) expect(await call({ action, consult_uid: UID }), action).toEqual({ ok: false, error: "blind_room_day" });
    expect(gets).toEqual([]);
  });
  it("a voice_isolated row is refused consult_voice_isolated: not sent, not probed", async () => {
    setIndex([row(UID, { voice_isolated: true })]);
    expect(await call({ action: "transcribe", consult_uid: UID })).toEqual({ ok: false, error: "consult_voice_isolated" });
    expect(submitted).toEqual([]);
    expect(heads).toEqual([]);
  });
  it("a consult with a palimpsest track is already_transcribed with the track reference: ZERO Sarvam calls, nothing submitted", async () => {
    setIndex([row(UID)]);
    setRebTrack();
    expect(await call({ action: "transcribe", consult_uid: UID })).toEqual({ ok: false, error: "already_transcribed", track: { source: "palimpsest", layer: "translate", config_hash: "abcd1234", n_segments: 3 } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(submitted).toEqual([]);
    expect(heads).toEqual([]);
  });
  it("a clip not in the mirror is consult_not_in_index; an unreadable eta-audio object is audio_unreadable (nothing submitted)", async () => {
    setIndex([row(UID)]);
    expect(await call({ action: "transcribe", consult_uid: "CUidZzzzzzzzzzzzzzzzzzzzzzzzzzzzz9" })).toEqual({ ok: false, error: "consult_not_in_index" });
    headSize = null;
    expect(await call({ action: "transcribe", consult_uid: UID })).toEqual({ ok: false, error: "audio_unreadable" });
    expect(heads).toEqual([`consult-clips/2026-10-08/opd-1/${UID}/consult.flac`]);
    expect(submitted).toEqual([]);
  });
  it("the happy path submits the existing sarvam_transcribe job for the consult (consult audio only), and the job's prepare step resolves the eta-audio key from the mirror", async () => {
    setIndex([row(UID)]);
    expect(await call({ action: "transcribe", consult_uid: UID })).toMatchObject({ ok: true, job_id: "job_c1", kind: "sarvam_transcribe" });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.args).toEqual({ consult_uid: UID });
    const out = await T.sarvamTranscribeKind.run({ job: { id: "j", created_at: new Date().toISOString() }, step: "prepare", args: { source: "consult", consult_uid: UID, mode: "transcribe", english: true }, progress: {}, runner: "r" } as never);
    expect(out).toEqual({ kind: "next", step: "init", progress: { clip_key: `consult-clips/2026-10-08/opd-1/${UID}/consult.flac`, content_type: "audio/flac", scope: "consult_clip", ref: UID, source_kind: "consult", mirror_minutes: 10 } });
    // the job refuses the same things (a job queued before the rule, or a direct insert)
    setIndex([row(UID, { voice_isolated: true })]);
    expect(await T.sarvamTranscribeKind.run({ job: { id: "j", created_at: new Date().toISOString() }, step: "prepare", args: { source: "consult", consult_uid: UID, mode: "transcribe", english: true }, progress: {}, runner: "r" } as never)).toEqual({ kind: "fail", error: "consult_voice_isolated" });
  });
  it("a row whose fields are not clean ids has no clip key (nothing is concatenated from an unvalidated value)", () => {
    expect(CI.clipKeyOf(row(UID) as never)).toBe(`consult-clips/2026-10-08/opd-1/${UID}/consult.flac`);
    for (const bad of [{ room_slug: "../x" }, { room_slug: "a/b" }, { room_slug: null }, { ist_date: "2026-10-08/.." }, { consult_uid: "a b" }]) expect(CI.clipKeyOf(row(UID, bad) as never), JSON.stringify(bad)).toBeNull();
  });
});

describe("status / result {consult_uid}: the palimpsest track, no Sarvam call", () => {
  it("status gives layer, config_hash and the segment count; result without include_text gives the same; with include_text the segments (text) come too", async () => {
    setIndex([row(UID)]);
    setRebTrack();
    const st = await call({ action: "status", consult_uid: UID });
    expect(st).toMatchObject({ ok: true, source: "palimpsest", track: { layer: "translate", config_hash: "abcd1234", n_segments: 3 } });
    expect(JSON.stringify(st)).not.toContain("line 0");
    expect(JSON.stringify(await call({ action: "result", consult_uid: UID }))).not.toContain("line 0");
    const withText = await call({ action: "result", consult_uid: UID, include_text: true }) as { track: { segments: Array<{ text: string }> } };
    expect(withText.track.segments.map((x) => x.text)).toEqual(["line 0", "line 1", "line 2"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(submitted).toEqual([]);
  });
  it("no track yet = track null (not an error); an altered track (sha256) is skipped and counted", async () => {
    setIndex([row(UID)]);
    expect(await call({ action: "status", consult_uid: UID })).toMatchObject({ ok: true, track: null, source: null });
    setRebTrack();
    mem.set(`reb/2026-10-08/r1/_consults/${UID}/tracks/translate.sarvam-saaras-v3__saaras-v3__abcd1234.json`, track("translate", 9));
    expect(await call({ action: "status", consult_uid: UID })).toMatchObject({ ok: true, track: null, n_integrity_skipped: 1 });
  });
  it("the job_id paths are unchanged: an unknown job id is unknown_job, no consult_uid needed", async () => {
    expect(await call({ action: "status", job_id: "job_nope" })).toMatchObject({ ok: false, error: "unknown_job" });
  });
});

describe("S8C-1: consult_uid is NOT unique (one row per machine): ANY held-out row refuses, in either row order", () => {
  const rowsIn = (order: "clean-first" | "blind-first"): Row[] => {
    const clean = { room_id: "r1", ist_date: "2026-10-08" }, blind = { room_id: BR, ist_date: BD };
    return order === "clean-first" ? [clean, blind] : [blind, clean];
  };
  for (const order of ["clean-first", "blind-first"] as const) {
    it(`${order}: transcribe, status and result include_text are all blind_room_day, with no mirror, track or audio read`, async () => {
      setIndex([row(UID)]); // the mirror row sits on the CLEAN pair
      setRebTrack();
      const base = answer;
      answer = (t, v) => (/FROM eta_encounter_windows WHERE consult_uid/.test(t) ? rowsIn(order) : base(t, v));
      gets.length = 0; heads.length = 0;
      expect(await call({ action: "transcribe", consult_uid: UID })).toEqual({ ok: false, error: "blind_room_day" });
      expect(await call({ action: "status", consult_uid: UID })).toEqual({ ok: false, error: "blind_room_day" });
      expect(await call({ action: "result", consult_uid: UID, include_text: true })).toEqual({ ok: false, error: "blind_room_day" });
      expect(gets).toEqual([]);
      expect(heads).toEqual([]);
      expect(submitted).toEqual([]);
    });
  }
  it("a uid whose rows are all clean is served (the same query, no held-out row)", async () => {
    setIndex([row(UID)]);
    setRebTrack();
    const base = answer;
    answer = (t, v) => (/FROM eta_encounter_windows WHERE consult_uid/.test(t) ? [{ room_id: "r1", ist_date: "2026-10-08" }, { room_id: "r2", ist_date: "2026-10-08" }] : base(t, v));
    expect(await call({ action: "result", consult_uid: UID, include_text: true })).toMatchObject({ ok: true, source: "palimpsest" });
  });
});

describe("S8C-3: consult_clips returns whitelisted SCALAR fields only", () => {
  it("nested objects in flags, quality, coverage, span_*, r2.files never reach the output, whatever they hold (a nested doctor_uid included)", async () => {
    setIndex([row(UID, { flags: ["clean", { doctor_uid: "NESTEDDOC1" }, "doctor_identified", "overlap:low"], quality: { doctor_uid: "NESTEDDOC2" }, coverage: { x: { doctor_uid: "NESTEDDOC3" } }, span_start: { doctor_uid: "NESTEDDOC4" },
      r2: { bucket: "eta-audio", prefix: "consult-clips/p", files: [{ name: "consult.flac", doctor_uid: "NESTEDDOC5" }, "consult.flac"], at: "t", signature: "SIGX" } })]);
    const out = await call({ action: "consult_clips", ist_date: "2026-10-08" }) as { rows: Array<Record<string, any>> };
    const s = JSON.stringify(out);
    for (const bad of ["NESTEDDOC", "doctor", "signature", "SIGX"]) expect(s, bad).not.toContain(bad);
    expect(out.rows[0]).toMatchObject({ flags: ["clean", "overlap:low"], quality: null, coverage: null, span_start: null, r2: { bucket: "eta-audio", prefix: "consult-clips/p", n_files: 2, at: "t" } });
    for (const [k, v] of Object.entries(out.rows[0]!)) { if (k === "r2") { for (const x of Object.values(v as object)) expect(typeof x === "object" && x !== null, `r2.${k}`).toBe(false); } else if (Array.isArray(v)) { for (const x of v) expect(typeof x, k).toBe("string"); } else expect(typeof v === "object" && v !== null, k).toBe(false); } // no nested object at all
  });
});

describe("S8C-4: a room given as a SLUG is mapped to its room_id through the mirror", () => {
  it("a held-out room asked for by slug is blind_room_day (no rows returned); an ordinary slug lists", async () => {
    setIndex([row(UID), row("CUidBlindSlugAaaaaaaaaaaaaaaaaaaaaa1", { room_id: BR, room_slug: "slug-of-held-out", ist_date: BD })]);
    expect(await call({ action: "consult_clips", ist_date: BD, room_slug: "slug-of-held-out" })).toEqual({ ok: false, error: "blind_room_day" });
    expect(await call({ action: "consult_clips", ist_date: "2026-10-08", room_slug: "opd-1" })).toMatchObject({ ok: true, count: 1 });
  });
});

describe("S8C-2 in the job: the duration is never shorter than the mirror row says, and a real-shaped clip passes", () => {
  const flac60s = (): Uint8Array => { const b = new Uint8Array(42); b.set([0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22]); const rate = 16_000, total = rate * 60; b[18] = (rate >> 12) & 0xff; b[19] = (rate >> 4) & 0xff; b[20] = ((rate & 0x0f) << 4) | (0 << 1) | 0; b[21] = (15 << 4) | 0; b[22] = (total >>> 24) & 0xff; b[23] = (total >>> 16) & 0xff; b[24] = (total >>> 8) & 0xff; b[25] = total & 0xff; return b; };
  it("a clip whose container says 60 s but whose mirror row says 60 minutes is window_too_long (the cap and the 30-minute limit see the longer figure)", async () => {
    const key = `consult-clips/2026-10-08/opd-1/${UID}/consult.flac`;
    clipBytes.set(key, flac60s());
    const run = (mirror?: number) => T.sarvamTranscribeKind.run({ job: { id: "j", created_at: new Date().toISOString() }, step: "init", args: { source: "consult", consult_uid: UID, mode: "transcribe", english: true }, progress: { clip_key: key, content_type: "audio/flac", scope: "consult_clip", ref: UID, source_kind: "consult", ...(mirror === undefined ? {} : { mirror_minutes: mirror }) }, runner: "r" } as never);
    expect(await run(60)).toEqual({ kind: "fail", error: "window_too_long" });
  });
  it("the crafted 15 MB case (header claims one sample) still reads at least the mirror minutes: 31 minutes = window_too_long; and a real-shaped 4 MB 10-minute 16 kHz mono clip is NOT refused", async () => {
    const key = `consult-clips/2026-10-08/opd-1/${UID}/consult.flac`;
    const withHeader = (total: number, size: number): Uint8Array => { const b = new Uint8Array(size); b.set(flac60s().subarray(0, 42)); const rate = 16_000; b[22] = (total >>> 24) & 0xff; b[23] = (total >>> 16) & 0xff; b[24] = (total >>> 8) & 0xff; b[25] = total & 0xff; void rate; return b; };
    const run = () => T.sarvamTranscribeKind.run({ job: { id: "j", created_at: new Date().toISOString() }, step: "init", args: { source: "consult", consult_uid: UID, mode: "transcribe", english: true }, progress: { clip_key: key, content_type: "audio/flac", scope: "consult_clip", ref: UID, source_kind: "consult", mirror_minutes: 31 }, runner: "r" } as never);
    clipBytes.set(key, withHeader(1, 15_000_000));
    expect(await run()).toEqual({ kind: "fail", error: "window_too_long" });
    const real = withHeader(16_000 * 600, 4_000_000);
    clipBytes.set(key, real);
    const ok = await T.sarvamTranscribeKind.run({ job: { id: "j", created_at: new Date().toISOString() }, step: "init", args: { source: "consult", consult_uid: UID, mode: "transcribe", english: true }, progress: { clip_key: key, content_type: "audio/flac", scope: "consult_clip", ref: UID, source_kind: "consult", mirror_minutes: 10 }, runner: "r" } as never);
    expect(JSON.stringify(ok)).not.toContain("window_too_long");
  });
});

