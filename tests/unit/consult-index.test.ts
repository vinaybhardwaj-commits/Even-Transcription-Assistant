/**
 * consult-index.test.ts — PURE checks for the consult index (lib/consult-index/*, migration 0146): the mirror's integrity rule, the row mapping (IST wall clock vs the UTC epoch, the clip key, the cut version,
 * the sealed flag), what is skipped and counted, that no name is ever read, the absolute-time view of a stored result, the batch/consult argument parsers, and the cron route's auth. All ids are fake.
 */
import { createHash } from "node:crypto";
import { makeFakeClinician } from "../support/fake-identity";

const DOC = makeFakeClinician(2);
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock("@/lib/consult-index/sync", () => ({ syncConsultIndex: S.sync }));
vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => null }));
vi.mock("@/lib/db", () => ({ sql: () => { throw new Error("no sql in a pure test"); } }));

import { istWallToMs, normalizeRow, parseIndex, sha256Hex, spanOf } from "@/lib/consult-index/parse";
import { consultResultView } from "@/lib/consult-index/result-view";
import { BATCH_MAX_UIDS, parseBatchArgs } from "@/lib/jobs/kinds/sarvam-consult-batch";
import { parseSarvamTranscribeArgs } from "@/lib/jobs/kinds/sarvam-transcribe";
import { GET, POST } from "@/app/api/cron/consult-index-sync/route";

const UID = "73jf39ondtahkp3mf728infj0o";
/** A row as the cutter writes it (field names measured on the box); the values are invented. */
const row = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  consult_uid: UID, ist_date: "2026-10-06", room_slug: "opd-7-y74w", room_id: "room_qyzghzaf", doctor_uid: "DOCTORUID1", doctor_name: DOC.full_name, window_id: 123,
  t_open: "2026-10-06 10:34:24.848", t_close: "2026-10-06 10:34:52.081", quality: "unattributed", status: "cut", code_commit: "ec8fa64", signature: { doctor: "SIGSECRET" },
  flags: [], doctor_identified: false, span_start: "2026-10-06 10:33:24.848", span_end: "2026-10-06 10:34:53.662", span_end_epoch: 1791263093.662, minutes: 1.48, coverage: 1.0,
  bytes: { "consult.flac": 100, "timeline.json": 5 }, bytes_total: 105, voice_isolated: false, cut_at: "2026-10-09T02:14:48+0530",
  r2: { status: "mirrored", bucket: "eta-audio", prefix: `consult-clips/2026-10-06/opd-7-y74w/${UID}`, files: 4, at: "2026-10-09T02:14:50+0530" }, ...o,
});
const manifestFor = (latest: string, o: Record<string, unknown> = {}) => JSON.stringify({ generated_at: "2026-10-10T00:00:00Z", rows: 1, sha256: sha256Hex(latest), code_commit: "abc", ...o });
const lines = (...rs: Array<Record<string, unknown>>) => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("time: the cutter writes IST wall-clock strings and a UTC epoch", () => {
  it("a zone-less string is IST (+05:30); a string with a zone is taken as written", () => {
    expect(istWallToMs("2026-10-06 10:34:53.662")).toBe(Date.parse("2026-10-06T05:04:53.662Z"));
    expect(istWallToMs("2026-10-06T10:34:53Z")).toBe(Date.parse("2026-10-06T10:34:53Z"));
    expect(istWallToMs("2026-10-09T02:14:48+0530")).toBe(Date.parse("2026-10-08T20:44:48Z"));
    for (const bad of ["", "soon", 5, null, "2026-10-06 25:00:00"]) expect(istWallToMs(bad), String(bad)).toBeNull();
  });
  it("t1 is span_end_epoch (UTC seconds) when present, t0 = t1 minus the span's own length", () => {
    const s = spanOf(row())!;
    expect(s.t1).toBe(1791263093662);
    expect(s.t1 - s.t0).toBe(88_814);
    expect(s.t1).toBe(istWallToMs("2026-10-06 10:34:53.662")); // the epoch and the IST string agree for this row
  });
  it("without an epoch the IST string decides; a bad epoch is ignored; end before start is refused", () => {
    const { span_end_epoch: _e, ...noEpoch } = row();
    expect(spanOf(noEpoch)!.t1).toBe(Date.parse("2026-10-06T05:04:53.662Z"));
    expect(spanOf(row({ span_end_epoch: 12 }))!.t1).toBe(Date.parse("2026-10-06T05:04:53.662Z"));
    expect(spanOf(row({ span_end: "2026-10-06 10:33:00.000" }))).toBeNull();
  });
});

describe("normalizeRow", () => {
  it("maps a cut, mirrored row: absolute span, clip key from validated parts, cut version = cut_at, sealed false, doctor_uid as recorded, no name", () => {
    const n = normalizeRow(row());
    if (!("row" in n)) throw new Error("skipped");
    expect(n.row).toMatchObject({
      consult_uid: UID, room_id: "room_qyzghzaf", room_slug: "opd-7-y74w", ist_date: "2026-10-06", clip_r2_key: `consult-clips/2026-10-06/opd-7-y74w/${UID}/consult.flac`, t1_ms: 1791263093662,
      cut_version: "2026-10-09T02:14:48+0530", code_commit: "ec8fa64", sealed: false, doctor_uid: "DOCTORUID1", doctor_identified: false, voice_isolated: false, minutes: 1.48, bytes: 105, quality: "unattributed", coverage: 1,
    });
    const json = JSON.stringify(n.row);
    expect(json).not.toContain(DOC.full_name);
    expect(json).not.toContain("SIGSECRET");
    expect(Object.keys(n.row)).not.toContain("doctor_name");
    expect(Object.keys(n.row)).not.toContain("signature");
  });
  it("reads cut_version, sealed and session_id when the upstream row carries them", () => {
    const n = normalizeRow(row({ cut_version: "v7", sealed: true, session_id: "bs_abc" }));
    expect("row" in n && n.row).toMatchObject({ cut_version: "v7", sealed: true, session_id: "bs_abc" });
    expect("row" in normalizeRow(row({ sealed: "yes" })) && (normalizeRow(row({ sealed: "yes" })) as { row: { sealed: boolean } }).row.sealed).toBe(false); // only a real true seals
  });
  it.each([
    ["not cut", { status: "skipped" }, "not_cut"],
    ["deferred", { status: "deferred_long" }, "not_cut"],
    ["not mirrored", { r2: { status: "pending", prefix: "x" } }, "not_mirrored"],
    ["no r2", { r2: undefined }, "not_mirrored"],
    ["a bad uid", { consult_uid: "../x" }, "no_uid"],
    ["a bad slug", { room_slug: "opd 7/../x" }, "bad_place"],
    ["a bad date", { ist_date: "06-10-2026" }, "bad_place"],
    ["a bad span", { span_start: "nope" }, "bad_span"],
    ["a prefix that is not this consult's", { r2: { status: "mirrored", prefix: "consult-clips/2026-10-06/other/ZZZ" } }, "bad_prefix"],
    ["no cut version", { cut_at: undefined }, "no_cut_version"],
  ])("skips a row that is %s", (_n, over, why) => {
    expect(normalizeRow(row(over))).toEqual({ skip: why });
  });
  it("an unsafe doctor_uid is dropped, not stored", () => {
    const n = normalizeRow(row({ doctor_uid: "x'; DROP TABLE y;--" }));
    expect("row" in n && n.row.doctor_uid).toBeNull();
  });
});

describe("parseIndex: the mirror's integrity rule", () => {
  it("accepts a file whose sha256 equals the manifest's, and takes the LATEST line per consult_uid", () => {
    const latest = lines(row({ cut_at: "2026-10-08T10:00:00+0530" }), row({ cut_at: "2026-10-09T10:00:00+0530" }));
    const r = parseIndex(latest, manifestFor(latest));
    if (!r.ok) throw new Error("integrity");
    expect(r.parsed.read).toBe(2);
    expect(r.parsed.rows).toHaveLength(1);
    expect(r.parsed.rows[0]!.cut_version).toBe("2026-10-09T10:00:00+0530");
    expect(r.manifest).toMatchObject({ sha256: sha256Hex(latest), rows: 1 });
  });
  it("a sha256 mismatch, a missing or malformed manifest, or a changed byte yields NO rows", () => {
    const latest = lines(row());
    expect(parseIndex(latest, manifestFor(latest, { sha256: "0".repeat(64) }))).toEqual({ ok: false, error: "consult_index_integrity" });
    expect(parseIndex(latest, manifestFor(latest, { sha256: undefined }))).toEqual({ ok: false, error: "consult_index_integrity" });
    expect(parseIndex(latest, "not json")).toEqual({ ok: false, error: "consult_index_integrity" });
    expect(parseIndex(latest, manifestFor(latest, { sha256: "short" }))).toEqual({ ok: false, error: "consult_index_integrity" });
    expect(parseIndex(latest + " ", manifestFor(latest))).toEqual({ ok: false, error: "consult_index_integrity" });
    expect(parseIndex(latest, manifestFor(latest, { sha256: sha256Hex(latest).toUpperCase() })).ok).toBe(true); // hex case does not matter
  });
  it("every skipped line is counted under its reason; nothing disappears silently", () => {
    const latest = lines(row(), row({ consult_uid: "U2abcdefghij", status: "skipped" }), row({ consult_uid: "U3abcdefghij", r2: { status: "pending" } })) + "not json\n[1]\n";
    const r = parseIndex(latest, manifestFor(latest));
    if (!r.ok) throw new Error("integrity");
    expect(r.parsed.rows).toHaveLength(1);
    expect(r.parsed.read).toBe(5);
    expect(r.parsed.skipped).toEqual({ not_cut: 1, not_mirrored: 1, not_json: 2 });
  });
  it("blank lines are ignored, not counted", () => {
    const latest = "\n\n" + lines(row()) + "\n";
    const r = parseIndex(latest, manifestFor(latest));
    expect(r.ok && r.parsed.read).toBe(1);
  });
});

describe("consultResultView: segments with ABSOLUTE UTC times", () => {
  it("adds the clip's t0 to each entry's offset, for the native and the English track", () => {
    const t0 = 1_791_263_000_000;
    const v = consultResultView({
      language_code: "hi-IN", duration_s: 12.5, speakers: ["0", "1"], transcript: "namaste", english: "hello",
      entries: [{ speaker_id: "0", start_s: 0, end_s: 3.25, text: "namaste", english: "hello", language_code: "hi-IN" }, { speaker_id: "1", start_s: 3.5, end_s: 12.5, text: "ji" }],
      english_entries: [{ speaker_id: "0", start_s: 0, end_s: 3.25, text: "hello", source: "translate_pass", native_idx: 0 }],
    }, t0);
    expect(v.segments).toEqual([
      { speaker_id: "0", t0_ms: t0, t1_ms: t0 + 3250, text: "namaste", english: "hello", language_code: "hi-IN" },
      { speaker_id: "1", t0_ms: t0 + 3500, t1_ms: t0 + 12_500, text: "ji" },
    ]);
    expect(v.english_segments).toEqual([{ speaker_id: "0", t0_ms: t0, t1_ms: t0 + 3250, text: "hello", source: "translate_pass" }]);
    expect([v.transcript, v.english, v.language_code, v.duration_s]).toEqual(["namaste", "hello", "hi-IN", 12.5]);
  });
  it("tolerates a doc with no English and a non-finite time", () => {
    const v = consultResultView({ language_code: null, duration_s: 1, speakers: [], transcript: "", entries: [{ speaker_id: "0", start_s: Number.NaN, end_s: 1, text: "x" }] }, 1000);
    expect(v.segments[0]).toMatchObject({ t0_ms: 1000, t1_ms: 2000 });
    expect([v.english, v.english_segments]).toEqual([null, []]);
  });
});

describe("argument parsers", () => {
  it("a batch: 1..25 plain ids, de-duplicated, options defaulted; a room or session argument is scope_consult_only", () => {
    expect(parseBatchArgs({ consult_uids: [UID, UID, "U2abcdefghij"] })).toEqual({ consult_uids: [UID, "U2abcdefghij"], mode: "transcribe", english: true });
    expect(parseBatchArgs({ consult_uids: [UID], mode: "codemix", english: false, num_speakers: 3 })).toMatchObject({ mode: "codemix", english: false, num_speakers: 3 });
    expect(() => parseBatchArgs({ consult_uids: [] })).toThrow(/bad args/);
    expect(() => parseBatchArgs({ consult_uids: Array.from({ length: BATCH_MAX_UIDS + 1 }, (_, i) => `U${i}abcdefghij`) })).toThrow(/bad args/);
    expect(() => parseBatchArgs({ consult_uids: ["../etc"] })).toThrow(/plain ids/);
    expect(() => parseBatchArgs({ consult_uids: [UID], url: "x" })).toThrow(/bad args/);
    for (const bad of [{ room: "opd-1" }, { from: "1" }, { to: "2" }, { session_id: "bs_1" }, { from_ms: 1 }, { to_ms: 2 }, { bench_window_id: "bw_1" }]) {
      expect(() => parseBatchArgs({ consult_uids: [UID], ...bad }), JSON.stringify(bad)).toThrow(/^scope_consult_only/);
    }
  });
  it("a single consult ask still refuses every room / session / window argument (scope_consult_only), alone or beside a valid source", () => {
    for (const bad of [{ room: "opd-1" }, { from: "1" }, { to: "2" }, { session_id: "bs_1" }, { from_ms: 1 }, { to_ms: 2 }, { bench_window_id: "bw_1" }]) {
      expect(() => parseSarvamTranscribeArgs(bad)).toThrow(/^scope_consult_only/);
      expect(() => parseSarvamTranscribeArgs({ consult_uid: UID, ...bad }), JSON.stringify(bad)).toThrow(/^scope_consult_only/);
    }
  });
});

describe("/api/cron/consult-index-sync auth", () => {
  const ENV = ["CRON_SECRET", "MIGRATION_SECRET"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.CRON_SECRET = "cron-fake";
    process.env.MIGRATION_SECRET = "mig-fake";
    S.sync.mockReset();
  });
  const req = (method: string, auth?: string, headers: Record<string, string> = {}) => new NextRequest("https://x.test/api/cron/consult-index-sync", { method, headers: { ...(auth ? { authorization: auth } : {}), ...headers } });

  it("GET needs the cron or migration bearer; the bare x-vercel-cron header, a wrong or empty bearer are refused and nothing syncs", async () => {
    for (const r of [req("GET"), req("GET", undefined, { "x-vercel-cron": "1" }), req("GET", "Bearer wrong"), req("GET", "Bearer "), req("GET", "cron-fake")]) {
      expect((await GET(r)).status).toBe(401);
    }
    delete process.env.CRON_SECRET;
    delete process.env.MIGRATION_SECRET;
    expect((await GET(req("GET", "Bearer undefined"))).status).toBe(401);
    expect(S.sync).not.toHaveBeenCalled();
  });
  it("GET with the cron secret syncs and returns counts only", async () => {
    S.sync.mockResolvedValue({ ok: true, sync_id: 3, manifest_rows: 4, rows_read: 5, rows_written: 4, inserted: 4, changed: 0, rows_skipped: 1, skipped: { not_cut: 1 } });
    const r = await GET(req("GET", "Bearer cron-fake"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain('"inserted":4');
    expect(S.sync).toHaveBeenCalledOnce();
  });
  it("a failed sync is NOT a 200: '0 rows' must never mean 'could not look'", async () => {
    S.sync.mockResolvedValue({ ok: false, sync_id: 9, error: "consult_index_integrity" });
    const r = await GET(req("GET", "Bearer mig-fake"));
    expect(r.status).toBeGreaterThanOrEqual(500);
    S.sync.mockRejectedValue(new Error("neon: postgres://secret"));
    const r2 = await GET(req("GET", "Bearer mig-fake"));
    expect(r2.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(await r2.json())).not.toContain("secret");
  });
  it("POST needs the migration bearer or an admin cookie", async () => {
    expect((await POST(req("POST", "Bearer cron-fake"))).status).toBe(401);
    expect((await POST(req("POST"))).status).toBe(401);
    S.sync.mockResolvedValue({ ok: true, sync_id: 1, manifest_rows: 0, rows_read: 0, rows_written: 0, inserted: 0, changed: 0, rows_skipped: 0, skipped: {} });
    expect((await POST(req("POST", "Bearer mig-fake"))).status).toBe(200);
  });
});

describe("sha256Hex", () => {
  it("is the manifest's hash", () => {
    expect(sha256Hex("a\n")).toBe(createHash("sha256").update("a\n", "utf8").digest("hex"));
  });
});
