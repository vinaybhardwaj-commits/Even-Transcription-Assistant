/**
 * consult-index-pg.test.ts — the Scribe consult index on postgres:16 with EVERY migration (0150 included), through the real job runner and the real MCP tool. R2 (clips, results), the lab store (the name-free
 * index mirror, the Sarvam ledger) and the Sarvam gateway are fakes: no real call is made, no key is read. All ids are fake. DOCKER: CI host only.
 *
 *   1. migration 0150: twice, registers once, constraints hold;
 *   2. the hourly sync: the first run is the BACKFILL; a re-run changes nothing; a re-cut updates; `sealed` is sticky; a sha256 mismatch writes nothing; a missing mirror is consult_index_unavailable;
 *   3. scribe_sarvam / sarvam_transcribe on a consult_uid resolve through the index and send only that cut clip; the result is stored with model + revision under (consult_uid, cut_version);
 *   4. IDEMPOTENCY: the same cut asked again is answered from the stored result: no job, no gateway call, billed:false; a re-cut is a new ask;
 *   5. consult_sealed, consult_not_indexed, consult_voice_isolated, mirror_minutes_missing, scope_consult_only;
 *   6. the batch form: one job id, a child per consult that needs one, the rest answered with their reason; progress through the job row;
 *   7. consult_result: model + revision, and segments with ABSOLUTE UTC times.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { makeFakeClinician } from "../support/fake-identity";

const DOC = makeFakeClinician(1);

type Row = Record<string, any>;
const H = vi.hoisted(() => ({
  sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>,
  r2: new Map<string, Uint8Array>(),
  heads: [] as string[],
  gw: { init: vi.fn(), upload: vi.fn(), startJob: vi.fn(), status: vi.fn(), result: vi.fn(), translate: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.mock("@/lib/r2", async (orig) => ({
  ...((await orig()) as object),
  getObjectBytes: vi.fn(async (k: string) => H.r2.get(k) ?? null),
  putObjectBytes: vi.fn(async (k: string, b: Uint8Array) => { H.r2.set(k, b); }),
  headObject: vi.fn(async (k: string) => { H.heads.push(k); const b = H.r2.get(k); return b ? { size: b.length, content_type: "audio/flac" } : { size: null, content_type: null }; }),
}));
vi.mock("@/lib/sarvam-gateway", async (orig) => ({ ...((await orig()) as object), gatewayConfigured: () => true }));
vi.mock("@/lib/sarvam-gw", async (orig) => ({
  ...((await orig()) as object),
  gwBatchInit: (...a: unknown[]) => H.gw.init(...a),
  gwBatchUpload: (...a: unknown[]) => H.gw.upload(...a),
  gwBatchStartJob: (...a: unknown[]) => H.gw.startJob(...a),
  gwBatchStatus: (...a: unknown[]) => H.gw.status(...a),
  gwBatchResult: (...a: unknown[]) => H.gw.result(...a),
  gwTranslateChunk: (...a: unknown[]) => H.gw.translate(...a),
}));
vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-consult-index");
const q = async <T = Row>(strings: TemplateStringsArray, ...v: unknown[]) => (await pg.sql(strings, ...v)) as T[];
const fails = (text: string) => { try { pg.exec(text); return ""; } catch (e) { return String((e as { stderr?: unknown }).stderr ?? e); } };

const P = await import("@/lib/consult-index/parse");
const Sync = await import("@/lib/consult-index/sync");
const St = await import("@/lib/room-access/consult-index-store");
const T = await import("@/lib/jobs/kinds/sarvam-transcribe");
const B = await import("@/lib/jobs/kinds/sarvam-consult-batch");
const C = await import("@/lib/sarvam-lab");
const Sv = await import("@/lib/mcp/surface");
const SC = await import("@/lib/jobs/kinds/sarvam-common");

// ---- fixtures -------------------------------------------------------------------------------------------------------------------------------
const DAY = "2026-10-06";
const SLUG = "ci-opd-1";
const ROOM = "room_ci1";
const uidOf = (n: string) => `CIuid${n}abcdefghijklmnopq`;
const UA = uidOf("A"), UB = uidOf("B"), UC = uidOf("C"), UD = uidOf("D"), UE = uidOf("E"), UNKNOWN = uidOf("Z");
const T1 = Date.parse(`${DAY}T04:32:00Z`); // the clip ends here; it is 120 s long
let cutSeq = 0;
function indexRow(uid: string, o: Row = {}): Row {
  const k = Object.keys({ [UA]: 1, [UB]: 1, [UC]: 1, [UD]: 1, [UE]: 1 }).indexOf(uid);
  const end = T1 + Math.max(k, 0) * 600_000;
  const wall = (ms: number) => new Date(ms + 19_800_000).toISOString().replace("T", " ").replace("Z", "");
  return {
    consult_uid: uid, ist_date: DAY, room_slug: SLUG, room_id: ROOM, doctor_uid: "DOCTORUID1", doctor_name: DOC.full_name, window_id: 1, status: "cut", quality: "clean", code_commit: "abc1234",
    span_start: wall(end - 120_000), span_end: wall(end), span_end_epoch: end / 1000, minutes: 2, coverage: 1, bytes: { "consult.flac": 4000, "timeline.json": 1000 }, bytes_total: 5000, voice_isolated: false, doctor_identified: true,
    cut_at: `2026-10-09T0${(cutSeq += 1) % 10}:00:00+0530`, r2: { status: "mirrored", bucket: "eta-audio", prefix: `consult-clips/${DAY}/${SLUG}/${uid}`, files: 4, at: "x" }, ...o,
  };
}
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const lab = new Map<string, { body: string; etag: string }>();
let labDown = false;
const labStore: import("@/lib/sarvam-lab").LabStore = {
  async get(k) { if (labDown) throw new Error("down"); const o = lab.get(k); return o ? { body: o.body, etag: o.etag } : null; },
  async put(k, body, cond) {
    const cur = lab.get(k);
    if (cond.ifNoneMatch && cur) return "precondition_failed";
    if (cond.ifMatch && cur?.etag !== cond.ifMatch) return "precondition_failed";
    lab.set(k, { body, etag: `"e${lab.size}-${body.length}"` });
    return "ok";
  },
  async list(prefix) { return [...lab.keys()].filter((k) => k.startsWith(prefix)); },
};
function publishIndex(rows: Row[], o: { badSha?: boolean; noManifest?: boolean } = {}) {
  const latest = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  lab.set("consult/index/latest.jsonl", { body: latest, etag: "e1" });
  if (o.noManifest) lab.delete("consult/index/manifest.json");
  else lab.set("consult/index/manifest.json", { body: JSON.stringify({ generated_at: "2026-10-10T00:00:00Z", rows: rows.length, sha256: o.badSha ? "0".repeat(64) : sha(latest), code_commit: "abc" }), etag: "e2" });
}
/** A FLAC header carrying `seconds` of 16 kHz mono 16-bit (STREAMINFO only; no audio). */
function flac(seconds: number): Uint8Array {
  const b = new Uint8Array(42);
  b.set([0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22]);
  const rate = 16_000, samples = rate * seconds;
  b[18] = (rate >> 12) & 0xff; b[19] = (rate >> 4) & 0xff; b[20] = ((rate & 0x0f) << 4) | (0 << 1) | 0; b[21] = (15 << 4) | (Math.floor(samples / 2 ** 32) & 0x0f);
  const lo = samples >>> 0;
  b[22] = (lo >>> 24) & 0xff; b[23] = (lo >>> 16) & 0xff; b[24] = (lo >>> 8) & 0xff; b[25] = lo & 0xff;
  return b;
}
const clipKey = (uid: string) => `consult-clips/${DAY}/${SLUG}/${uid}/consult.flac`;
const putClips = (...uids: string[]) => { for (const u of uids) H.r2.set(clipKey(u), flac(120)); };

const FIVE = () => [indexRow(UA), indexRow(UB, { voice_isolated: true }), indexRow(UC, { sealed: true }), indexRow(UD, { minutes: null }), indexRow(UE)];
async function backfill(rows: Row[] = FIVE()) {
  publishIndex(rows);
  const r = await Sync.syncConsultIndex();
  if (!r.ok) throw new Error(`sync failed: ${r.error}`);
  return r;
}
const wipe = () => pg.exec(`DELETE FROM reb_track_index; DELETE FROM consult_sarvam_result; DELETE FROM consult_index; DELETE FROM consult_index_sync; DELETE FROM scribe_job; DELETE FROM audit_log WHERE action = 'stt.paid_call';`);

// ---- the Sarvam gateway fake: counts every call so "never billed twice" is a number --------------------------------------------------------
const gwCalls = () => H.gw.init.mock.calls.length + H.gw.upload.mock.calls.length + H.gw.startJob.mock.calls.length + H.gw.status.mock.calls.length + H.gw.result.mock.calls.length + H.gw.translate.mock.calls.length;
function fakeGateway() {
  let n = 0;
  const started = new Set<string>();
  H.gw.init.mockImplementation(async () => ({ ok: true, jobId: `sv_${(n += 1)}` }));
  H.gw.upload.mockResolvedValue({ ok: true });
  H.gw.startJob.mockImplementation(async (id: string) => { started.add(id); return { ok: true }; });
  H.gw.status.mockImplementation(async (id: string) => (started.has(id) ? { ok: true, state: "Completed", outputs: ["out.json"] } : { ok: true, state: "Pending", outputs: [] }));
  H.gw.result.mockResolvedValue({
    ok: true, languageCode: "hi-IN", transcript: "namaste doctor sahab",
    entries: [{ speakerId: "0", start: 0, end: 3.5, transcript: "namaste doctor", languageCode: "hi-IN" }, { speakerId: "1", start: 4, end: 9.25, transcript: "ji bataiye", languageCode: "hi-IN" }],
  });
}

// ---- the runner -----------------------------------------------------------------------------------------------------------------------------
const runner = async () => ({ ...(await import("@/lib/jobs/store")), ...(await import("@/lib/jobs/runner")), ...(await import("@/lib/jobs/submit")) });
/** Run every runnable job, one step at a time, until none is left (bounded). */
async function drain(max = 200): Promise<void> {
  const { claimJobs, runOneStep } = await runner();
  for (let i = 0; i < max; i++) {
    const id = `r_${Math.random()}`;
    const got = await claimJobs(1, 240_000, id);
    if (!got.length) {
      // nothing is claimable: a batch parent may be HELD BACK between looks (delay_s). If one is, let its hold lapse and go round again; otherwise we are done.
      const held = (await q<{ n: number }>`SELECT count(*)::int AS n FROM scribe_job WHERE status = 'running' AND lease_until > now()`)[0]!.n;
      if (held === 0) return;
      pg.exec(`UPDATE scribe_job SET lease_until = now() - interval '1 second' WHERE status = 'running' AND lease_until > now();`);
      continue;
    }
    await runOneStep(got[0]!, id);
  }
  throw new Error("drain did not finish");
}
const submit = async (kind: string, args: Row) => (await runner()).submitJob({ kind, args, actor: "mcp:test", scopes: new Set(["read", "invoke"] as const) });
const job = async (id: string) => (await q<Row>`SELECT id, kind, status, step, error, result, progress FROM scribe_job WHERE id = ${id}`)[0]!;
const jobsOfKind = async (kind: string) => q<Row>`SELECT id, status, result, error, args FROM scribe_job WHERE kind = ${kind} ORDER BY created_at`;
const tool = async (args: Row) => (await Sv.CALLABLE_TOOLS.get("scribe_sarvam")!.handler(args, { origin: "https://x", actor: "mcp:test", scopes: new Set(["read", "invoke"]) } as never)) as Row;
const results = () => q<Row>`SELECT consult_uid, cut_version, mode, english, job_id, model_stt, model_translate, model_rev, pipeline_rev, speaker_count, transcript_chars, t0_ms::float8 AS t0_ms FROM consult_sarvam_result ORDER BY id`;

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
  pg.exec(`
    INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) VALUES ('${ROOM}', '${SLUG}', 'CI Room', 'x', TRUE);
    INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_ci1', '${ROOM}', '${DAY}');
    INSERT INTO bench_session (id, room_id, started_at, ended_at, status) VALUES ('bs_ci1', '${ROOM}', '${DAY}T04:00:00Z', '${DAY}T20:00:00Z', 'ended');
  `);
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); });
beforeEach(() => {
  if (!HAVE) return;
  wipe();
  lab.clear(); labDown = false; H.r2.clear(); H.heads.length = 0;
  Object.values(H.gw).forEach((f) => f.mockReset());
  fakeGateway();
  C.setLabStoreForTests(labStore);
  T.sarvamTiming.pollStepMs = 0; T.sarvamTiming.pollIntervalMs = 0; T.sarvamTiming.translateStepMs = 60_000;
  SC.auditRetry.delaysMs = [0, 0, 0];
});
afterEach(() => { C.setLabStoreForTests(null); });

describe.skipIf(!HAVE)("migration 0150", () => {
  it("applies twice, registers once, and its constraints hold", async () => {
    const text = readFileSync("db/migrations/0150_consult_index.sql", "utf8");
    pg.exec(text);
    pg.exec(text);
    expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM schema_migrations WHERE version = 150`)[0]!.n).toBe(1);
    const ins = (cols: string) => fails(`INSERT INTO consult_index (consult_uid, room_id, room_slug, ist_date, t0_ms, t1_ms, clip_r2_key, cut_version, source_sha256) VALUES (${cols});`);
    expect(ins(`'m1', 'r', 's', '${DAY}', 5, 5, 'consult-clips/a/b', 'v', 'h'`)).toMatch(/span_chk/);
    expect(ins(`'m2', 'r', 's', '${DAY}', 1, 5, 'bench/a/b', 'v', 'h'`)).toMatch(/key_chk/);
    expect(ins(`'m3', 'r', 's', '${DAY}', 1, 5, 'consult-clips/../b', 'v', 'h'`)).toMatch(/key_chk/);
    pg.exec(`INSERT INTO consult_sarvam_result (consult_uid, cut_version, mode, english, job_id, result_r2_key, model_stt, model_translate, model_rev, pipeline_rev, t0_ms) VALUES ('m9', 'v', 'transcribe', true, 'j', 'mcp-sarvam/j.json', 'a', 'b', 'c', 'd', 1);`);
    expect(fails(`INSERT INTO consult_sarvam_result (consult_uid, cut_version, mode, english, job_id, result_r2_key, model_stt, model_translate, model_rev, pipeline_rev, t0_ms) VALUES ('m9', 'v', 'transcribe', true, 'j2', 'mcp-sarvam/j2.json', 'a', 'b', 'c', 'd', 1);`)).toMatch(/once/);
    expect(fails(`INSERT INTO consult_sarvam_result (consult_uid, cut_version, mode, english, job_id, result_r2_key, model_stt, model_translate, model_rev, pipeline_rev, t0_ms) VALUES ('m8', 'v', 'bogus', true, 'j', 'mcp-sarvam/j.json', 'a', 'b', 'c', 'd', 1);`)).toMatch(/mode_chk/);
    expect(fails(`INSERT INTO consult_sarvam_result (consult_uid, cut_version, mode, english, job_id, result_r2_key, model_stt, model_translate, model_rev, pipeline_rev, t0_ms) VALUES ('m7', 'v', 'codemix', true, 'j', 'lab/x.json', 'a', 'b', 'c', 'd', 1);`)).toMatch(/key_chk/);
    pg.exec(`DELETE FROM consult_sarvam_result;`);
  });
});

describe.skipIf(!HAVE)("the sync (the first run is the backfill)", () => {
  it("writes every cut, mirrored consult: absolute span, clip key, doctor_uid as recorded, the covering bench session; skipped lines are counted", async () => {
    publishIndex([...FIVE(), indexRow(uidOf("S"), { status: "skipped" }), indexRow(uidOf("P"), { r2: { status: "pending" } })]);
    const r = await Sync.syncConsultIndex();
    expect(r).toMatchObject({ ok: true, rows_read: 7, rows_written: 5, inserted: 5, changed: 0, rows_skipped: 2, skipped: { not_cut: 1, not_mirrored: 1 } });
    const rows = await q<Row>`SELECT consult_uid, room_id, room_slug, ist_date::text AS ist_date, session_id, t0_ms::float8 AS t0_ms, t1_ms::float8 AS t1_ms, clip_r2_key, doctor_uid, doctor_identified, cut_version, sealed, voice_isolated, minutes::float8 AS minutes FROM consult_index ORDER BY consult_uid`;
    expect(rows).toHaveLength(5);
    const a = rows.find((x) => x.consult_uid === UA)!;
    expect(a).toMatchObject({ room_id: ROOM, room_slug: SLUG, ist_date: DAY, session_id: "bs_ci1", t1_ms: T1, t0_ms: T1 - 120_000, clip_r2_key: clipKey(UA), doctor_uid: "DOCTORUID1", doctor_identified: true, sealed: false, voice_isolated: false, minutes: 2 });
    expect(rows.find((x) => x.consult_uid === UC)!.sealed).toBe(true);
    expect(rows.find((x) => x.consult_uid === UB)!.voice_isolated).toBe(true);
    // no name anywhere in the table
    expect(JSON.stringify(rows)).not.toContain(DOC.full_name);
    const log = (await q<Row>`SELECT status, rows_read, rows_written, rows_skipped, skipped, manifest_rows FROM consult_index_sync ORDER BY id DESC LIMIT 1`)[0]!;
    expect(log).toMatchObject({ status: "ok", rows_read: 7, rows_written: 5, rows_skipped: 2, manifest_rows: 7 });
  });
  it("a re-run changes nothing; a re-cut updates the row; a changed field is picked up", async () => {
    const rows = FIVE();
    await backfill(rows);
    const before = await q<Row>`SELECT consult_uid, synced_at::text AS synced_at FROM consult_index ORDER BY consult_uid`;
    const again = await backfill(rows);
    expect(again).toMatchObject({ inserted: 0, changed: 0, rows_written: 5 });
    expect(await q<Row>`SELECT consult_uid, synced_at::text AS synced_at FROM consult_index ORDER BY consult_uid`).toEqual(before); // an unchanged row is not even rewritten
    const recut = await backfill([indexRow(UA, { cut_at: "2026-10-10T09:00:00+0530", minutes: 2.5 }), ...rows.slice(1)]);
    expect(recut).toMatchObject({ inserted: 0, changed: 1 });
    expect((await St.getIndexRow(UA))).toMatchObject({ cut_version: "2026-10-10T09:00:00+0530", minutes: 2.5 });
  });
  it("sealed is STICKY: a later sync cannot clear it", async () => {
    await backfill([indexRow(UA, { sealed: true })]);
    expect((await St.getIndexRow(UA))!.sealed).toBe(true);
    await backfill([indexRow(UA, { sealed: false, cut_at: "2026-10-11T09:00:00+0530" })]);
    const r = (await St.getIndexRow(UA))!;
    expect([r.sealed, r.cut_version]).toEqual([true, "2026-10-11T09:00:00+0530"]);
    await backfill([indexRow(UE)]);
    await backfill([indexRow(UE, { sealed: true })]);
    expect((await St.getIndexRow(UE))!.sealed).toBe(true); // raised by a later sync
  });
  it("a sha256 mismatch writes NOTHING and records a failed sync; a missing manifest or store is consult_index_unavailable", async () => {
    await backfill([indexRow(UA)]);
    publishIndex([indexRow(UA, { cut_at: "TAMPERED" }), indexRow(UE)], { badSha: true });
    expect(await Sync.syncConsultIndex()).toMatchObject({ ok: false, error: "consult_index_integrity" });
    expect((await St.getIndexRow(UA))!.cut_version).not.toBe("TAMPERED");
    expect(await St.getIndexRow(UE)).toBeNull();
    expect((await St.latestSync())).toMatchObject({ status: "failed", error_code: "consult_index_integrity" });
    publishIndex([indexRow(UA)], { noManifest: true });
    expect(await Sync.syncConsultIndex()).toMatchObject({ ok: false, error: "consult_index_unavailable" });
    labDown = true;
    expect(await Sync.syncConsultIndex()).toMatchObject({ ok: false, error: "consult_index_unavailable" });
    labDown = false;
    C.setLabStoreForTests(null);
    delete process.env.SCRIBE_LAB_R2_ACCESS_KEY_ID;
    expect(await Sync.syncConsultIndex()).toMatchObject({ ok: false, error: "consult_index_unavailable" });
    // an error is cleared only by the success of the next run
    C.setLabStoreForTests(labStore);
    await backfill([indexRow(UA)]);
    expect((await St.latestSync())).toMatchObject({ status: "ok", error_code: null });
  });
});

describe.skipIf(!HAVE)("the sync of the PUBLISHED shape (the writer drops status and r2.status)", () => {
  /** what tools/index_mirror.py publishes: ALLOW keys only, r2 = bucket/prefix/files/at */
  const ALLOW = ["consult_uid", "window_id", "ist_date", "room_id", "room_slug", "span_start", "span_end", "span_end_epoch", "t_open", "t_close", "minutes", "bytes", "quality", "flags", "coverage", "voice_isolated", "doctor_uid", "doctor_identified", "cut_at", "code_commit", "signature", "r2"];
  const publish = (r: Row): Row => ({ ...Object.fromEntries(ALLOW.filter((k) => k in r && k !== "r2").map((k) => [k, r[k]])), r2: Object.fromEntries(["bucket", "prefix", "files", "at"].filter((k) => k in r.r2).map((k) => [k, r.r2[k]])) });
  it("indexes every published row (the first production sync read 429 and wrote 0) and can then be sent", async () => {
    const pub = FIVE().map(publish);
    expect(pub.every((r) => !("status" in r) && !("status" in r.r2))).toBe(true);
    publishIndex(pub);
    const r = await Sync.syncConsultIndex();
    expect(r).toMatchObject({ ok: true, rows_read: 5, rows_written: 5, inserted: 5, rows_skipped: 0, skipped: {} });
    expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM consult_index`)[0]!.n).toBe(5);
    expect((await St.getIndexRow(UA))).toMatchObject({ clip_r2_key: clipKey(UA), bytes: 5000 });
    putClips(UA);
    const out = await tool({ action: "transcribe", consult_uid: UA, english: false });
    expect(out).toMatchObject({ ok: true, status: "queued" });
  });
});

describe.skipIf(!HAVE)("PALIMPSEST REUSE: the track the palimpsest already made for THIS cut is returned, Sarvam is not called", () => {
  /** the cutter's signature for a consult (what palimpsest stamps on its tracks as config.clip_signature); synthetic values */
  const sig = (uid: string, o: Row = {}): Row => ({ start: 1791296881.32, end: 1791297441.34, rule: "explicit_close+15s", mode: "fixed", doctor: "DOCTORUID1", print: true, cov: 1, room: SLUG, day: DAY, uidmark: uid.length, ...o });
  const withSig = (uid: string, o: Row = {}) => indexRow(uid, { signature: sig(uid), ...o });
  const segs = (n: number, textOf: (i: number) => string) => Array.from({ length: n }, (_, i) => ({ t0_ms: T1 - 120_000 + i * 4000, t1_ms: T1 - 120_000 + i * 4000 + 3500, speaker: `SPEAKER_0${i % 2}`, lang: "hi-IN", text: textOf(i) }));
  /** write a palimpsest track into the (fake) lab bucket and index it in reb_track_index, as palimpsest does */
  function putTrack(uid: string, layer: "stt" | "translate", o: { dropObject?: boolean; clipSig?: Row; engine?: string; indexEngine?: string; status?: string; shadow?: boolean; shaWrong?: boolean; n?: number; hash?: string } = {}) {
    const doc = { config: { clip_signature: o.clipSig ?? sig(uid), gateway: "x", job_parameters: {} }, config_hash: o.hash ?? "ab12cd34", engine: o.engine ?? "sarvam-saaras-v3", extras: {}, layer, machine: "m", model: "saaras:v3", reason: null, schema: "reb.track.v1",
      segments: segs(o.n ?? 3, (i) => (layer === "stt" ? `namaste ${i}` : `hello ${i}`)), status: o.status ?? "ok", version: "saaras-v3", window_id: `consult-${uid}` };
    const key = `reb/${DAY}/${ROOM}/_consults/${uid}/tracks/${layer}.${doc.engine}__saaras-v3__${doc.config_hash}.json`;
    const body = JSON.stringify(doc);
    if (!o.dropObject) lab.set(key, { body, etag: "t" });
    pg.exec(`INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, shadow, status, r2_key, sha256) VALUES ('consult-${uid}', '${DAY}', '${ROOM}', '${layer}', '${o.indexEngine ?? doc.engine}', 'saaras-v3', '${doc.config_hash}', ${o.shadow ? "true" : "false"}, 'ok', '${key}', '${o.shaWrong ? "0".repeat(64) : sha(body)}');`);
  }
  const noJobsNoGateway = async (calls: number, kind = "sarvam_transcribe") => { expect(gwCalls()).toBe(calls); expect(await jobsOfKind(kind)).toHaveLength(0); expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'stt.paid_call'`)[0]!.n).toBe(0); };

  it("scribe_sarvam returns the palimpsest's stt+translate for the same cut, labelled source palimpsest, and calls Sarvam NOT at all", async () => {
    await backfill([withSig(UA)]);
    putClips(UA);
    putTrack(UA, "stt"); putTrack(UA, "translate");
    const calls = gwCalls();
    const out = await tool({ action: "transcribe", consult_uid: UA });
    expect(out).toMatchObject({ ok: true, existing: true, source: "palimpsest", billed: false, consult_uid: UA, job_id: null, source_job_id: null, model_stt: "saaras:v3", model_translate: "saaras:v3", model_rev: "saaras-v3",
      language_code: "hi-IN", duration_s: 120, speakers: 2, transcript_chars: "namaste 0 namaste 1 namaste 2".length, english_chars: "hello 0 hello 1 hello 2".length, english_pass: "done" });
    await noJobsNoGateway(calls);
    expect(H.heads).toEqual([]); // not even the clip was probed
    expect(JSON.stringify(out)).not.toMatch(/namaste|hello/);
  });

  it("the same through the JOB (scribe_job_submit): done, existing, source palimpsest, no gateway call, no paid-call row", async () => {
    await backfill([withSig(UA)]);
    putClips(UA);
    putTrack(UA, "stt");
    const calls = gwCalls();
    const j = await submit("sarvam_transcribe", { consult_uid: UA });
    await drain();
    const r = await job(j.id);
    expect([r.status, r.error]).toEqual(["done", null]);
    expect(r.result).toMatchObject({ existing: true, source: "palimpsest", consult_uid: UA, speakers: 2, english_chars: 0, english_pass: "not_requested" });
    expect(gwCalls()).toBe(calls);
    expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'stt.paid_call'`)[0]!.n).toBe(0);
  });

  it("consult_result reads the palimpsest's track when we hold none, in the NORMAL result shape: english = the translated TEXT, segments {speaker_id, language_code}, absolute times only with include_text", async () => {
    await backfill([withSig(UA)]);
    putTrack(UA, "stt"); putTrack(UA, "translate");
    const head = await tool({ action: "consult_result", consult_uid: UA });
    expect(head).toMatchObject({ ok: true, source: "palimpsest", model_stt: "saaras:v3", model_translate: "saaras:v3", model_rev: "saaras-v3", speakers: 2, english: true, english_pass: "done", stale: false, billed: false, job_id: null });
    expect(JSON.stringify(head)).not.toMatch(/namaste|hello|reb\//);
    const full = await tool({ action: "consult_result", consult_uid: UA, include_text: true });
    expect(full.transcript).toBe("namaste 0 namaste 1 namaste 2");
    expect(full.english).toBe("hello 0 hello 1 hello 2"); // the English TEXT, not a status word
    expect(full.language_code).toBe("hi-IN");
    expect((full.segments as Row[])[1]).toEqual({ speaker_id: "SPEAKER_01", t0_ms: T1 - 120_000 + 4000, t1_ms: T1 - 120_000 + 7500, text: "namaste 1", language_code: "hi-IN" });
    expect((full.english_segments as Row[])[1]).toEqual({ speaker_id: "SPEAKER_01", t0_ms: T1 - 120_000 + 4000, t1_ms: T1 - 120_000 + 7500, text: "hello 1", source: "translate_pass" });
    expect(full).not.toHaveProperty("english_text");
    expect(full).not.toHaveProperty("stt_segments");
  });

  it("SHAPE PARITY: a reused palimpsest result has EXACTLY the fields of scribe_sarvam's own result, field by field (transcribe answer, job result, consult_result head, consult_result with text)", async () => {
    // one consult transcribed by US (the normal path), one answered from the palimpsest
    await backfill([withSig(UA), withSig(UE)]);
    putClips(UA, UE);
    putTrack(UE, "stt"); putTrack(UE, "translate");
    await tool({ action: "transcribe", consult_uid: UA, english: false });
    await drain();
    const keys = (o: Row) => Object.keys(o).sort();
    const kinds = (o: Row) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? "null" : Array.isArray(v) ? "array" : typeof v]));

    // 1. the transcribe answer for an already-answered consult
    const ownAns = await tool({ action: "transcribe", consult_uid: UA, english: false });
    const palAns = await tool({ action: "transcribe", consult_uid: UE });
    expect(ownAns).toMatchObject({ existing: true, source: "scribe_sarvam" });
    expect(palAns).toMatchObject({ existing: true, source: "palimpsest" });
    expect(keys(palAns)).toEqual(keys(ownAns));
    // 2. the job result
    const ownJob = await submit("sarvam_transcribe", { consult_uid: UA, english: false });
    const palJob = await submit("sarvam_transcribe", { consult_uid: UE });
    await drain();
    const ownR = (await job(ownJob.id)).result!, palR = (await job(palJob.id)).result!;
    expect(keys(palR)).toEqual(keys(ownR));
    // 3. the consult_result head
    const ownHead = await tool({ action: "consult_result", consult_uid: UA });
    const palHead = await tool({ action: "consult_result", consult_uid: UE });
    expect(keys(palHead).filter((k) => k !== "billed")).toEqual(keys(ownHead));
    for (const [k, t] of Object.entries(kinds(ownHead))) if (t !== "null" && kinds(palHead)[k] !== "null") expect(kinds(palHead)[k], k).toBe(t);
    // 4. consult_result with text: same top-level keys, same segment keys
    const ownFull = await tool({ action: "consult_result", consult_uid: UA, include_text: true });
    const palFull = await tool({ action: "consult_result", consult_uid: UE, include_text: true });
    expect(keys(palFull).filter((k) => k !== "billed")).toEqual(keys(ownFull));
    expect(typeof palFull.english).toBe("string"); // own with english:false is null; with English it is the same field holding the text
    expect(keys((palFull.segments as Row[])[0]!)).toEqual(keys((ownFull.segments as Row[])[0]!));
    // 5. the English segments: built by the SAME function from an own-shaped document
    const { consultResultView } = await import("@/lib/consult-index/result-view");
    const ownEng = consultResultView({ language_code: "hi-IN", duration_s: 1, speakers: [], transcript: "", english: "x", entries: [], english_entries: [{ speaker_id: "0", start_s: 0, end_s: 1, text: "x", source: "translate_pass", native_idx: 0 }] }, 0).english_segments[0]!;
    expect(keys((palFull.english_segments as Row[])[0]!)).toEqual(keys(ownEng as Row));
  });

  it("(a) RESULTS STORED UNDER THE OLD cut_at VERSION ARE STILL FOUND after the version became the signature's: carried over by the sync of the same cut, so nothing is billed twice; a RE-CUT is not carried", async () => {
    // the old release: rows carry no signature, so cut_version = cut_at
    await backfill([indexRow(UA, { cut_at: "2026-10-09T02:00:00+0530" }), indexRow(UE, { cut_at: "2026-10-09T03:00:00+0530" })]);
    putClips(UA, UE);
    await tool({ action: "transcribe", consult_uid: UA, english: false });
    await tool({ action: "transcribe", consult_uid: UE, english: false });
    await drain();
    expect((await results()).map((r) => r.cut_version).sort()).toEqual(["2026-10-09T02:00:00+0530", "2026-10-09T03:00:00+0530"]);
    const calls = gwCalls();
    // the new release's sync: the SAME cut of UA now has a signature; UE was RE-CUT meanwhile (a new cut_at)
    publishIndex([withSig(UA, { cut_at: "2026-10-09T02:00:00+0530" }), withSig(UE, { cut_at: "2026-10-12T09:00:00+0530" })]);
    const r = await Sync.syncConsultIndex();
    expect(r).toMatchObject({ ok: true, migrated_results: 1 });
    const rs = await results();
    expect(rs.find((x) => x.consult_uid === UA)!.cut_version).toMatch(/^sig:/);
    expect(rs.find((x) => x.consult_uid === UE)!.cut_version).toBe("2026-10-09T03:00:00+0530"); // the earlier cut's result is not claimed by the new cut
    // UA is answered from the stored result: no job, no gateway call
    expect(await tool({ action: "transcribe", consult_uid: UA, english: false })).toMatchObject({ ok: true, existing: true, source: "scribe_sarvam", billed: false });
    expect(gwCalls()).toBe(calls);
    // UE (re-cut) is a real new ask
    expect(await tool({ action: "transcribe", consult_uid: UE, english: false })).toMatchObject({ ok: true, status: "queued" });
    // idempotent: syncing again carries nothing and breaks nothing
    expect(await Sync.syncConsultIndex()).toMatchObject({ ok: true, migrated_results: 0 });
  });

  it("(a) a result already stored under the NEW form is never overwritten by the carry-over (the UNIQUE key holds)", async () => {
    await backfill([indexRow(UA, { cut_at: "2026-10-09T02:00:00+0530" })]);
    const old = (await St.getIndexRow(UA))!;
    await St.recordResult({ consult_uid: UA, cut_version: old.cut_version, mode: "transcribe", english: false, num_speakers: null, job_id: "j_old", result_r2_key: "mcp-sarvam/j_old.json", model_stt: "a", model_translate: "b", model_rev: "c", pipeline_rev: "d", language_code: null, duration_s: 1, speaker_count: 1, transcript_chars: 1, english_chars: 0, english_pass: null, t0_ms: old.t0_ms });
    const sigRow = withSig(UA, { cut_at: "2026-10-09T02:00:00+0530" });
    const { signatureVersion } = await import("@/lib/consult-index/parse");
    await St.recordResult({ consult_uid: UA, cut_version: signatureVersion(sigRow.signature)!, mode: "transcribe", english: false, num_speakers: null, job_id: "j_new", result_r2_key: "mcp-sarvam/j_new.json", model_stt: "a", model_translate: "b", model_rev: "c", pipeline_rev: "d", language_code: null, duration_s: 1, speaker_count: 1, transcript_chars: 1, english_chars: 0, english_pass: null, t0_ms: old.t0_ms });
    publishIndex([sigRow]);
    expect(await Sync.syncConsultIndex()).toMatchObject({ ok: true, migrated_results: 0 });
    expect((await results()).map((r) => r.job_id).sort()).toEqual(["j_new", "j_old"]);
  });

  it("(b) an index row that says ok whose R2 object is MISSING is track_missing: Sarvam is NOT billed silently; only force:true goes on (tool, job, batch, consult_result)", async () => {
    await backfill([withSig(UA), withSig(UE)]);
    putClips(UA, UE);
    putTrack(UA, "stt", { dropObject: true });
    const calls = gwCalls();
    expect(await tool({ action: "transcribe", consult_uid: UA, english: false })).toEqual({ ok: false, error: "track_missing" });
    expect(await tool({ action: "consult_result", consult_uid: UA })).toEqual({ ok: false, error: "track_missing" });
    const j = await submit("sarvam_transcribe", { consult_uid: UA, english: false });
    await drain();
    expect(String((await job(j.id)).error)).toContain("track_missing");
    const b = await tool({ action: "transcribe", consult_uids: [UA], english: false });
    await drain();
    expect((await job(String(b.job_id))).result).toMatchObject({ refused: 1, done: 0 });
    expect(((await job(String(b.job_id))).result!.items as Row[])[0]).toMatchObject({ state: "refused", code: "track_missing" });
    expect(gwCalls()).toBe(calls);
    expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'stt.paid_call'`)[0]!.n).toBe(0);
    // force:true: the caller says "I know, send it" -> Sarvam is called (tool, job, batch)
    expect(await tool({ action: "transcribe", consult_uid: UA, english: false, force: true })).toMatchObject({ ok: true, status: "queued" });
    await drain();
    expect(gwCalls()).toBeGreaterThan(calls);
    expect(await results()).toHaveLength(1);
    const calls2 = gwCalls();
    putTrack(UE, "stt", { dropObject: true });
    const jf = await submit("sarvam_transcribe", { consult_uid: UE, english: false, force: true });
    await drain();
    expect((await job(jf.id)).status).toBe("done");
    expect(gwCalls()).toBeGreaterThan(calls2);
  });

  it("(b) force never overrides a track that EXISTS (it is still reused, not re-billed); force is not accepted for anything but a boolean", async () => {
    await backfill([withSig(UA)]);
    putClips(UA);
    putTrack(UA, "stt");
    const calls = gwCalls();
    expect(await tool({ action: "transcribe", consult_uid: UA, force: true })).toMatchObject({ ok: true, source: "palimpsest", billed: false });
    expect(gwCalls()).toBe(calls);
    expect(await tool({ action: "transcribe", consult_uid: UA, force: "yes" })).toMatchObject({ ok: false, error: "bad_args" });
  });

  it("(b) a missing TRANSLATE object does not block: the stt is reused without English; a missing stt object with a good stt object elsewhere is not 'missing'", async () => {
    await backfill([withSig(UA)]);
    putClips(UA);
    putTrack(UA, "stt"); putTrack(UA, "translate", { dropObject: true });
    const calls = gwCalls();
    expect(await tool({ action: "transcribe", consult_uid: UA })).toMatchObject({ ok: true, source: "palimpsest", english_chars: 0, english_pass: "not_requested" });
    expect(gwCalls()).toBe(calls);
  });

  it("a track of ANOTHER CUT (the clip was re-cut after the track was made) is NOT reused: Sarvam is called", async () => {
    await backfill([withSig(UA)]);
    putClips(UA);
    putTrack(UA, "stt", { clipSig: sig(UA, { end: 1791297999.99, cov: 0.8 }) });
    const calls = gwCalls();
    const out = await tool({ action: "transcribe", consult_uid: UA, english: false });
    expect(out).toMatchObject({ ok: true, status: "queued" });
    expect(out.source).toBeUndefined();
    await drain();
    expect(gwCalls()).toBeGreaterThan(calls);
    expect(await results()).toHaveLength(1);
    // and consult_result does not present the old cut's track as this cut's
    await q`DELETE FROM consult_sarvam_result`;
    expect(await tool({ action: "consult_result", consult_uid: UA })).toMatchObject({ ok: true, result: null });
  });

  it("only a LIVE ok sarvam-saaras-v3 track counts: another engine, a failed or shadow track, a track whose sha256 is wrong are ignored (Sarvam is called)", async () => {
    await backfill([withSig(UA), withSig(UE)]);
    putClips(UA, UE);
    putTrack(UA, "stt", { engine: "medasr", hash: "m1" });
    putTrack(UA, "stt", { status: "failed", hash: "m2" });
    putTrack(UA, "stt", { shadow: true, hash: "m3" });
    putTrack(UA, "stt", { shaWrong: true, hash: "m4" });
    putTrack(UA, "stt", { indexEngine: "medasr", engine: "sarvam-saaras-v3", hash: "m5" }); // indexed as another engine: the index filter alone must refuse it
    putTrack(UA, "stt", { indexEngine: "sarvam-saaras-v3", engine: "medasr", hash: "m6" }); // indexed as sarvam but the track itself says another engine: the track is checked too
    const calls = gwCalls();
    expect(await tool({ action: "transcribe", consult_uid: UA, english: false })).toMatchObject({ ok: true, status: "queued" });
    await drain();
    expect(gwCalls()).toBeGreaterThan(calls);
    // the one good track is found among the bad ones
    putTrack(UE, "stt");
    const calls2 = gwCalls();
    expect(await tool({ action: "transcribe", consult_uid: UE, english: false })).toMatchObject({ ok: true, source: "palimpsest" });
    expect(gwCalls()).toBe(calls2);
  });

  it("a track belonging to another consult or another room's key is never used", async () => {
    await backfill([withSig(UA)]);
    putClips(UA);
    putTrack(UE, "stt", { clipSig: sig(UA) }); // UE's track, even carrying UA's signature
    pg.exec(`UPDATE reb_track_index SET window_id = 'consult-${UA}' WHERE window_id = 'consult-${UE}';`); // indexed under UA, but the KEY names UE
    const calls = gwCalls();
    expect(await tool({ action: "transcribe", consult_uid: UA, english: false })).toMatchObject({ ok: true, status: "queued" });
    await drain();
    expect(gwCalls()).toBeGreaterThan(calls);
  });

  it("FAIL CLOSED: if the lookup cannot be made the answer is reuse_lookup_unavailable, never 'none' (Sarvam is not called)", async () => {
    await backfill([withSig(UA)]);
    putClips(UA);
    putTrack(UA, "stt");
    const calls = gwCalls();
    C.setLabStoreForTests(null);
    delete process.env.SCRIBE_LAB_R2_ACCESS_KEY_ID;
    expect(await tool({ action: "transcribe", consult_uid: UA, english: false })).toEqual({ ok: false, error: "reuse_lookup_unavailable" });
    expect(await tool({ action: "consult_result", consult_uid: UA })).toEqual({ ok: false, error: "reuse_lookup_unavailable" });
    const j = await submit("sarvam_transcribe", { consult_uid: UA, english: false });
    await drain();
    expect(String((await job(j.id)).error)).toContain("reuse_lookup_unavailable");
    expect(gwCalls()).toBe(calls);
    C.setLabStoreForTests(labStore);
    labDown = true; // the lab bucket throws while reading the track
    expect(await tool({ action: "transcribe", consult_uid: UA, english: false })).toEqual({ ok: false, error: "reuse_lookup_unavailable" });
    expect(gwCalls()).toBe(calls);
  });

  it("order: sealed is still refused (a sealed consult is not reused); our own stored result comes first; a voice-isolated consult with a matching track is REUSED (nothing is sent), without one it is refused", async () => {
    await backfill([withSig(UA, { sealed: true }), withSig(UB, { voice_isolated: true }), withSig(UE, { voice_isolated: true })]);
    putClips(UA, UB, UE);
    putTrack(UA, "stt"); putTrack(UB, "stt");
    expect(await tool({ action: "transcribe", consult_uid: UA })).toEqual({ ok: false, error: "consult_sealed" });
    expect(await tool({ action: "transcribe", consult_uid: UB })).toMatchObject({ ok: true, source: "palimpsest" });
    expect(await tool({ action: "transcribe", consult_uid: UE })).toEqual({ ok: false, error: "consult_voice_isolated" });
    const row = (await St.getIndexRow(UB))!;
    await St.recordResult({ consult_uid: UB, cut_version: row.cut_version, mode: "transcribe", english: true, num_speakers: null, job_id: "j_own", result_r2_key: "mcp-sarvam/j_own.json", model_stt: "a", model_translate: "b", model_rev: "c", pipeline_rev: "d", language_code: null, duration_s: 1, speaker_count: 1, transcript_chars: 1, english_chars: 0, english_pass: null, t0_ms: row.t0_ms });
    expect(await tool({ action: "transcribe", consult_uid: UB })).toMatchObject({ ok: true, existing: true, job_id: "j_own" });
  });

  it("english asked but only an stt track exists: the stt is returned (english: not_in_palimpsest); Sarvam is NOT called for the English", async () => {
    await backfill([withSig(UA)]);
    putClips(UA);
    putTrack(UA, "stt");
    const calls = gwCalls();
    expect(await tool({ action: "transcribe", consult_uid: UA, english: true })).toMatchObject({ ok: true, source: "palimpsest", english_chars: 0, english_pass: "not_requested", speakers: 2 });
    expect(gwCalls()).toBe(calls);
  });

  it("a translate track alone is not a transcription: Sarvam is called", async () => {
    await backfill([withSig(UA)]);
    putClips(UA);
    putTrack(UA, "translate");
    expect(await tool({ action: "transcribe", consult_uid: UA, english: false })).toMatchObject({ ok: true, status: "queued" });
  });

  it("the batch: a reusable consult is 'existing' with source palimpsest and queues NO child; the others are processed as before", async () => {
    await backfill([withSig(UA), withSig(UE)]);
    putClips(UA, UE);
    putTrack(UA, "stt");
    const out = await tool({ action: "transcribe", consult_uids: [UA, UE], english: false });
    await drain();
    const j = await job(String(out.job_id));
    expect(j.result).toMatchObject({ total: 2, existing: 1, done: 1, refused: 0, failed: 0 });
    const items = Object.fromEntries((j.result!.items as Row[]).map((i) => [i.consult_uid, i]));
    expect(items[UA]).toMatchObject({ state: "existing", source: "palimpsest" });
    expect(items[UE]).toMatchObject({ state: "done" });
    expect((await jobsOfKind("sarvam_transcribe")).map((x) => x.args.consult_uid)).toEqual([UE]);
    expect(H.gw.upload).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!HAVE)("scribe_sarvam / sarvam_transcribe on a consult_uid", () => {
  it("resolves through the index, sends ONLY that cut clip, and stores the result with model + revision under the cut version", async () => {
    await backfill();
    putClips(UA, UB, UC, UD, UE);
    const out = await tool({ action: "transcribe", consult_uid: UA, english: false });
    expect(out).toMatchObject({ ok: true, kind: "sarvam_transcribe", status: "queued" });
    await drain();
    const j = await job(String(out.job_id));
    expect([j.status, j.error]).toEqual(["done", null]);
    expect(j.result).toMatchObject({ consult_uid: UA, speakers: 2, language_code: "hi-IN" });
    expect(H.gw.upload).toHaveBeenCalledTimes(1); // one clip, once
    expect(H.gw.upload.mock.calls[0]![1]).toEqual(H.r2.get(clipKey(UA))); // the bytes of THAT consult's clip and nothing else
    const stored = await results();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ consult_uid: UA, cut_version: (await St.getIndexRow(UA))!.cut_version, mode: "transcribe", job_id: out.job_id, model_stt: expect.stringMatching(/saaras/), model_translate: expect.stringMatching(/mayura/), speaker_count: 2, t0_ms: T1 - 120_000 });
    expect(stored[0]!.model_rev).toBeTruthy();
    expect(stored[0]!.pipeline_rev).toMatch(/^sarvam-consult-1:/);
    // the job row and the result row carry counts and ids, never text
    expect(JSON.stringify(j.result) + JSON.stringify(j.progress)).not.toMatch(/namaste|bataiye/);
    // the paid-call audit row names the consult scope
    expect((await q<Row>`SELECT metadata_json->>'scope' AS scope FROM audit_log WHERE action = 'stt.paid_call'`)[0]!.scope).toBe("consult_clip");
  });

  it("IDEMPOTENT: the same cut asked again is answered from the stored result: no job, no gateway call, billed:false", async () => {
    await backfill();
    putClips(UA);
    const first = await tool({ action: "transcribe", consult_uid: UA, english: false });
    await drain();
    const calls = gwCalls();
    const jobsBefore = (await jobsOfKind("sarvam_transcribe")).length;
    const second = await tool({ action: "transcribe", consult_uid: UA, english: false });
    expect(second).toMatchObject({ ok: true, existing: true, billed: false, job_id: first.job_id, consult_uid: UA });
    expect(gwCalls()).toBe(calls);
    expect((await jobsOfKind("sarvam_transcribe")).length).toBe(jobsBefore);
    // the same ask through scribe_job_submit's path (a job): it ends done+existing at prepare, again with no gateway call
    const viaJob = await submit("sarvam_transcribe", { consult_uid: UA, english: false });
    await drain();
    const jj = await job(viaJob.id);
    expect(jj.status).toBe("done");
    expect(jj.result).toMatchObject({ existing: true, consult_uid: UA, source_job_id: first.job_id });
    expect(gwCalls()).toBe(calls);
    expect(await results()).toHaveLength(1);
  });

  it("a different option set is a different ask (english true vs false, mode); a RE-CUT is a new ask", async () => {
    await backfill([indexRow(UA)]);
    putClips(UA);
    await tool({ action: "transcribe", consult_uid: UA, english: false });
    await drain();
    const calls = gwCalls();
    const other = await tool({ action: "transcribe", consult_uid: UA, english: false, mode: "codemix" });
    expect(other.existing).toBeUndefined();
    expect(other).toMatchObject({ ok: true, status: "queued" });
    await drain();
    expect(gwCalls()).toBeGreaterThan(calls);
    expect((await results()).map((r) => r.mode)).toEqual(["transcribe", "codemix"]);
    // re-cut: a new cut_version
    await backfill([indexRow(UA, { cut_at: "2026-10-12T09:00:00+0530" })]);
    const again = await tool({ action: "transcribe", consult_uid: UA, english: false });
    expect(again.existing).toBeUndefined();
    await drain();
    const rs = await results();
    expect(rs.filter((r) => r.mode === "transcribe").map((r) => r.cut_version)).toHaveLength(2);
    // and the old cut's result is still there, readable
    const view = await tool({ action: "consult_result", consult_uid: UA });
    expect(view).toMatchObject({ ok: true, stale: false, cut_version: "2026-10-12T09:00:00+0530" });
    expect(view.other_cuts).toBeTruthy();
  });

  it("two jobs racing for the same cut register ONE result (the UNIQUE key), whoever finishes first", async () => {
    await backfill([indexRow(UA)]);
    putClips(UA);
    const row = (await St.getIndexRow(UA))!;
    const rec = (jobId: string) => St.recordResult({ consult_uid: UA, cut_version: row.cut_version, mode: "transcribe", english: false, num_speakers: null, job_id: jobId, result_r2_key: `mcp-sarvam/${jobId}.json`, model_stt: "a", model_translate: "b", model_rev: "c", pipeline_rev: "d", language_code: null, duration_s: 1, speaker_count: 1, transcript_chars: 1, english_chars: 0, english_pass: null, t0_ms: row.t0_ms });
    expect([await rec("j_first"), await rec("j_second")]).toEqual([true, false]);
    expect((await results()).map((r) => r.job_id)).toEqual(["j_first"]);
  });

  it("refusals, each BEFORE any gateway call or audio read: consult_sealed, consult_not_indexed, consult_voice_isolated, mirror_minutes_missing, audio_unreadable", async () => {
    await backfill();
    putClips(UA, UB, UC, UD); // UE has no clip in R2
    const calls = gwCalls();
    H.heads.length = 0;
    expect(await tool({ action: "transcribe", consult_uid: UC })).toEqual({ ok: false, error: "consult_sealed" });
    expect(await tool({ action: "transcribe", consult_uid: UNKNOWN })).toEqual({ ok: false, error: "consult_not_indexed" });
    expect(await tool({ action: "transcribe", consult_uid: UB })).toEqual({ ok: false, error: "consult_voice_isolated" });
    expect(await tool({ action: "transcribe", consult_uid: UD })).toEqual({ ok: false, error: "mirror_minutes_missing" });
    expect(await tool({ action: "transcribe", consult_uid: UE })).toEqual({ ok: false, error: "audio_unreadable" });
    expect(gwCalls()).toBe(calls);
    expect(H.heads).toEqual([clipKey(UE)]); // only the one consult that passed every row check was probed
    expect(await jobsOfKind("sarvam_transcribe")).toHaveLength(0);
    // the same refusals through the job (a submit that bypasses the tool): the job fails by code and calls nothing
    for (const [uid, code] of [[UC, "consult_sealed"], [UNKNOWN, "consult_not_indexed"], [UB, "consult_voice_isolated"], [UD, "mirror_minutes_missing"], [UE, "audio_unreadable"]] as const) {
      const j = await submit("sarvam_transcribe", { consult_uid: uid });
      await drain();
      const r = await job(j.id);
      expect([r.status, String(r.error)], uid).toEqual(["failed", expect.stringContaining(code)]);
    }
    expect(gwCalls()).toBe(calls);
  });

  it("a sealed consult stays sealed even if its clip is already there and its result was stored earlier is NOT re-sent", async () => {
    await backfill([indexRow(UA)]);
    putClips(UA);
    await tool({ action: "transcribe", consult_uid: UA, english: false });
    await drain();
    await backfill([indexRow(UA, { sealed: true })]);
    const calls = gwCalls();
    expect(await tool({ action: "transcribe", consult_uid: UA, english: false })).toEqual({ ok: false, error: "consult_sealed" });
    expect(gwCalls()).toBe(calls);
  });

  it("room, session and window arguments stay scope_consult_only — exactly as before — and nothing is queued", async () => {
    await backfill([indexRow(UA)]);
    putClips(UA);
    const calls = gwCalls();
    for (const bad of [{ room: SLUG }, { from: "1" }, { to: "2" }, { session_id: "bs_ci1" }, { from_ms: 1 }, { to_ms: 2 }, { bench_window_id: "bw_1" }]) {
      expect(await tool({ action: "transcribe", consult_uid: UA, ...bad }), JSON.stringify(bad)).toMatchObject({ ok: false, error: "scope_consult_only" });
      expect(await tool({ action: "transcribe", consult_uids: [UA], ...bad }), JSON.stringify(bad)).toMatchObject({ ok: false, error: "scope_consult_only" });
    }
    expect(gwCalls()).toBe(calls);
    expect(await jobsOfKind("sarvam_transcribe")).toHaveLength(0);
    expect(await jobsOfKind("sarvam_consult_batch")).toHaveLength(0);
  });
});

describe.skipIf(!HAVE)("the batch form", () => {
  it("ONE job id for a list: refused consults carry their reason, an existing result is answered, the rest become child jobs; progress is on the job row", async () => {
    await backfill();
    putClips(UA, UB, UC, UD, UE);
    // UA already has its result
    await tool({ action: "transcribe", consult_uid: UA, english: false });
    await drain();
    const calls = gwCalls();
    const out = await tool({ action: "transcribe", consult_uids: [UA, UB, UC, UNKNOWN, UE], english: false });
    expect(out).toMatchObject({ ok: true, kind: "sarvam_consult_batch", status: "queued" });
    const id = String(out.job_id);
    await drain();
    const j = await job(id);
    expect([j.status, j.error]).toEqual(["done", null]);
    expect(j.result).toMatchObject({ total: 5, done: 1, existing: 1, refused: 3, failed: 0 });
    const items = Object.fromEntries((j.result!.items as Row[]).map((i) => [i.consult_uid, i]));
    expect(items[UA]).toMatchObject({ state: "existing" });
    expect(items[UB]).toMatchObject({ state: "refused", code: "consult_voice_isolated" });
    expect(items[UC]).toMatchObject({ state: "refused", code: "consult_sealed" });
    expect(items[UNKNOWN]).toMatchObject({ state: "refused", code: "consult_not_indexed" });
    expect(items[UE]).toMatchObject({ state: "done" });
    expect(H.gw.upload).toHaveBeenCalledTimes(2); // UA once before, UE once now: UA was NOT sent again
    expect(gwCalls()).toBeGreaterThan(calls);
    expect(JSON.stringify(j.result) + JSON.stringify(j.progress)).not.toMatch(/consult-clips|namaste|DOCTORUID|doctor/);
    expect((await results()).map((r) => r.consult_uid).sort()).toEqual([UA, UE].sort());
    // the same batch again: everything is existing or refused, nothing new is sent
    const calls2 = gwCalls();
    const again = await tool({ action: "transcribe", consult_uids: [UA, UE], english: false });
    await drain();
    expect((await job(String(again.job_id))).result).toMatchObject({ total: 2, existing: 2, done: 0 });
    expect(gwCalls()).toBe(calls2);
  });

  it("is visible in progress while the children run (the job row names every consult's state)", async () => {
    await backfill([indexRow(UA), indexRow(UE)]);
    putClips(UA, UE);
    const out = await tool({ action: "transcribe", consult_uids: [UA, UE], english: false });
    const { claimJobs, runOneStep } = await runner();
    const id = "r_prog";
    const got = await claimJobs(1, 240_000, id);
    expect(got[0]!.id).toBe(out.job_id);
    await runOneStep(got[0]!, id); // fan
    const mid = await job(String(out.job_id));
    expect(mid.step).toBe("wait");
    // the first look at the children (the wait step) holds the parent BACK (a future lease), so the younger children are claimed next, not starved by it
    const look = await claimJobs(1, 240_000, id);
    expect(look[0]!.id).toBe(out.job_id);
    await runOneStep(look[0]!, id);
    expect((await q<{ held: boolean }>`SELECT (lease_until > now()) AS held FROM scribe_job WHERE id = ${String(out.job_id)}`)[0]!.held).toBe(true);
    const next = await claimJobs(1, 240_000, "r_next");
    expect(next[0]!.kind).toBe("sarvam_transcribe");
    const kids = (mid.progress as Row).children as Row;
    expect(Object.keys(kids).sort()).toEqual([UA, UE].sort());
    expect(Object.values(kids).map((k: any) => k.state)).toEqual(["queued", "queued"]);
    expect(Object.values(kids).every((k: any) => typeof k.job_id === "string")).toBe(true);
    expect((await jobsOfKind("sarvam_transcribe")).map((x) => x.args.consult_uid).sort()).toEqual([UA, UE].sort());
  });

  it("a replayed fan step never queues a consult twice; the list is bounded; bad ids and room arguments never queue", async () => {
    await backfill([indexRow(UA)]);
    putClips(UA);
    const out = await tool({ action: "transcribe", consult_uids: [UA, UA], english: false });
    const { claimJobs, runOneStep } = await runner();
    const rid = "r_fan";
    const got = await claimJobs(1, 240_000, rid);
    await runOneStep(got[0]!, rid);
    const kidsBefore = (await jobsOfKind("sarvam_transcribe")).length;
    // replay the fan step against the saved progress: the child is already recorded, so nothing is queued again
    const mid = await job(String(out.job_id));
    const outcome = await B.sarvamConsultBatchKind.run({ job: { id: out.job_id, actor: "mcp:test", created_at: new Date().toISOString() } as never, step: "fan", args: { consult_uids: [UA], mode: "transcribe", english: false }, progress: mid.progress as Row });
    expect(outcome.kind).toBe("next");
    expect((await jobsOfKind("sarvam_transcribe")).length).toBe(kidsBefore);
    expect(kidsBefore).toBe(1);
    // a child already recorded as done stays done on a replay (it is not looked at, queued or re-labelled again)
    const replayDone = await B.sarvamConsultBatchKind.run({ job: { id: out.job_id, actor: "mcp:test", created_at: new Date().toISOString() } as never, step: "fan", args: { consult_uids: [UA], mode: "transcribe", english: false }, progress: { children: { [UA]: { state: "done", job_id: "j_old" } } } });
    expect(replayDone).toMatchObject({ kind: "next", progress: { children: { [UA]: { state: "done", job_id: "j_old" } } } });
    expect(await tool({ action: "transcribe", consult_uids: Array.from({ length: 26 }, (_, i) => `U${i}abcdefghijkl`) })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await tool({ action: "transcribe", consult_uids: ["../x"] })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await tool({ action: "transcribe", consult_uids: [UA], consult_uid: UA })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await tool({ action: "transcribe", consult_uids: [UA], encounter_id: "enc_1" })).toMatchObject({ ok: false, error: "bad_args" });
  });

  it("a child that fails is reported with its code; the batch still finishes", async () => {
    await backfill([indexRow(UA)]);
    putClips(UA);
    H.gw.init.mockResolvedValue({ ok: false, error: "init_400", status: 400, transient: false });
    const out = await tool({ action: "transcribe", consult_uids: [UA], english: false });
    await drain();
    const j = await job(String(out.job_id));
    expect(j.status).toBe("done");
    expect(j.result).toMatchObject({ total: 1, failed: 1, done: 0 });
    expect((j.result!.items as Row[])[0]).toMatchObject({ consult_uid: UA, state: "failed", code: "sarvam_submit_failed" });
    expect(await results()).toHaveLength(0); // a failed run registers nothing, so the next ask is a real ask
  });
});

describe.skipIf(!HAVE)("reading results and the index through the MCP", () => {
  it("consult_result: model + revision always; transcript, English and segments with ABSOLUTE UTC times only with include_text", async () => {
    await backfill([indexRow(UA)]);
    putClips(UA);
    await tool({ action: "transcribe", consult_uid: UA, english: false });
    await drain();
    const head = await tool({ action: "consult_result", consult_uid: UA });
    expect(head).toMatchObject({ ok: true, consult_uid: UA, stale: false, mode: "transcribe", english: false, model_stt: expect.stringMatching(/saaras/), model_translate: expect.stringMatching(/mayura/), speakers: 2, clip: { t0_ms: T1 - 120_000, t1_ms: T1 } });
    expect(head.model_rev).toBeTruthy();
    expect(head).not.toHaveProperty("segments");
    expect(JSON.stringify(head)).not.toMatch(/namaste|bataiye|mcp-sarvam|consult-clips/);
    const full = await tool({ action: "consult_result", consult_uid: UA, include_text: true });
    expect(full.transcript).toContain("namaste");
    expect(full.segments).toEqual([
      expect.objectContaining({ speaker_id: "0", t0_ms: T1 - 120_000, t1_ms: T1 - 120_000 + 3500, text: "namaste doctor" }),
      expect.objectContaining({ speaker_id: "1", t0_ms: T1 - 120_000 + 4000, t1_ms: T1 - 120_000 + 9250, text: "ji bataiye" }),
    ]);
  });
  it("consult_result for an unknown consult is consult_not_indexed; a consult with no result says so; a bad uid is refused", async () => {
    await backfill([indexRow(UA)]);
    expect(await tool({ action: "consult_result", consult_uid: UNKNOWN })).toEqual({ ok: false, error: "consult_not_indexed" });
    expect(await tool({ action: "consult_result", consult_uid: UA })).toMatchObject({ ok: true, result: null });
    expect(await tool({ action: "consult_result", consult_uid: "../x" })).toEqual({ ok: false, error: "consult_uid_invalid" });
  });
  it("consult_clips lists one IST day from the table (no names, doctor_uid labelled as a hint), with the last sync", async () => {
    await backfill();
    const out = await tool({ action: "consult_clips", ist_date: DAY, room_slug: SLUG });
    expect(out).toMatchObject({ ok: true, ist_date: DAY, count: 5, sealed: 1, voice_isolated: 1, truncated: false, index_sync: { status: "ok", rows_written: 5 } });
    const rows = out.rows as Row[];
    expect(rows.map((r) => r.t0_ms)).toEqual([...rows.map((r) => r.t0_ms)].sort((a, b) => a - b));
    expect(rows[0]).toMatchObject({ doctor_uid: "DOCTORUID1", doctor_uid_note: "cutter record; not identity", session_id: "bs_ci1" });
    expect(JSON.stringify(out)).not.toMatch(new RegExp(`${DOC.full_name}|consult-clips|signature`));
    expect(await tool({ action: "consult_clips", ist_date: DAY, room_slug: "another-room" })).toMatchObject({ ok: true, count: 0 });
    expect(await tool({ action: "consult_clips", ist_date: "2026-13-45" })).toEqual({ ok: false, error: "invalid_ist_date" });
    expect(await tool({ action: "consult_clips" })).toEqual({ ok: false, error: "invalid_ist_date" });
  });
});
