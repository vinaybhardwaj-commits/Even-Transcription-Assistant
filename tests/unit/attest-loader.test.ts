/**
 * tests/unit/attest-loader.test.ts — the attestation loader: parse, REFUSE, dry-run.
 *
 * A wrong attestation enrols one doctor's voice onto another doctor's print and poisons the matcher with
 * nothing downstream able to catch it, so each refusal below has its own test, and each says in one clause
 * what would have to break for it to fail. People come from tests/support/fake-identity.ts only.
 * The last block runs the reader and the CLI against a REAL postgres:16 whose tables carry the columns
 * checked against the live database, and asserts the dry run issues nothing but SELECTs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { makeFakeClinician } from "../support/fake-identity";
import { parseSheet, istMidnightMs, IST_OFFSET_MS } from "@/lib/attest/sheet";
import { validateAttestations, normalizeName, type Reference } from "@/lib/attest/validate";
import { loadReference, workloadFrom } from "@/lib/attest/reference";
import { runLoader, WRITE_REFUSED } from "@/lib/attest/cli";

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
const D = "2026-08-24";
const at = (hhmm: string, date = D) => istMidnightMs(date)! + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) * 60_000;
const c1 = makeFakeClinician(1);
const c2 = makeFakeClinician(2);
const cGone = makeFakeClinician(3);
const cOff = makeFakeClinician(4);
const clin = (c: ReturnType<typeof makeFakeClinician>, over: Partial<{ status: string; deleted: boolean }> = {}) =>
  ({ id: c.id, full_name: c.full_name, email: c.email, status: over.status ?? "active", deleted: over.deleted ?? false });

const ROOM_A = { id: "room_fx0a", name: "Fixture Room – A", slug: "fixture-room-a" };
const ROOM_B = { id: "room_fx0b", name: "Fixture Room B", slug: "fixture-room-b" };
const win = (id: string, room: string, from: string, to: string, over: Partial<{ day: string | null; diarized: boolean }> = {}) =>
  ({ id, room_id: room, room_day_id: over.day === undefined ? `rd_${room}` : over.day, start_ms: at(from), end_ms: at(to), diarized: over.diarized ?? true });

function ref(over: Partial<Reference> = {}): Reference {
  return {
    rooms: [ROOM_A, ROOM_B],
    clinicians: [clin(c1), clin(c2), clin(cGone, { deleted: true }), clin(cOff, { status: "disabled" })],
    windows: [win("w_a1", ROOM_A.id, "09:00", "09:15"), win("w_a2", ROOM_A.id, "09:15", "09:30"), win("w_a3", ROOM_A.id, "10:00", "10:15"),
              win("w_b1", ROOM_B.id, "09:00", "09:15"), win("w_b2", ROOM_B.id, "09:15", "09:30")],
    roomDays: [{ id: `rd_${ROOM_A.id}`, room_id: ROOM_A.id, ist_date: D, scratch: false }, { id: `rd_${ROOM_B.id}`, room_id: ROOM_B.id, ist_date: D, scratch: false }],
    existing: [],
    diarizedRoomDayIds: new Set([`rd_${ROOM_A.id}`, `rd_${ROOM_B.id}`]),
    ...over,
  };
}
const sheet = (...lines: string[]) => ["room,date,start,end,clinician", ...lines].join("\n");
const rowOf = (room: string, start: string, end: string, who: string, date = D) => `${room},${date},${start},${end},${who}`;
const run = (text: string, r: Reference = ref()) => { const p = parseSheet(text); return validateAttestations(p.rows, r, p.refusals); };
const reasons = (res: ReturnType<typeof run>) => res.refusals.map((x) => `${x.row}:${x.reason}`);

// ── 1. the sheet ────────────────────────────────────────────────────────────────────────────────
describe("parseSheet — the shape a coordinator fills in", () => {
  it("reads five columns in any order, comma or tab, with a BOM and quotes; row numbers are spreadsheet rows", () => {
    const p = parseSheet("﻿clinician\tRoom\tdate\tstart\tend\n\"a, b\"\tFixture Room B\t2026-08-24\t09:00\t09:30\n\n\"x\"\tFixture Room B\t2026-08-24\t10:00\t10:30");
    expect(p.delimiter).toBe("\t");
    expect(p.refusals).toEqual([]);
    expect(p.rows.map((r) => [r.row, r.room, r.clinician])).toEqual([[2, "Fixture Room B", "a, b"], [4, "Fixture Room B", "x"]]);
    // breaks if: the header is order-sensitive, BOM/quotes are mishandled, or a blank line shifts the row numbers a coordinator sees.
  });
  it("refuses a wrong header (missing, extra or duplicated column) without echoing what the columns were called", () => {
    for (const h of ["room,date,start,end", "room,date,start,end,clinician,notes", "room,date,start,end,room"]) {
      const p = parseSheet(`${h}\nx`);
      expect(p.refusals.map((r) => [r.row, r.reason])).toEqual([[null, "bad_header"]]);
    }
    // breaks if: a sheet with an unexpected shape is read leniently and a column is guessed.
  });
  it("refuses an empty sheet and a header with no rows", () => {
    expect(parseSheet("  \n\n").refusals[0]).toMatchObject({ row: null, reason: "empty_sheet" });
    expect(parseSheet("room,date,start,end,clinician\n").refusals[0]).toMatchObject({ row: null, reason: "no_data_rows" });
    // breaks if: an empty file reads as a clean load of zero rows.
  });
  it("refuses each row-level syntax error by row: missing cell, bad date, bad time, end not after start, cell count, open quote", () => {
    const p = parseSheet(sheet(
      "Fixture Room B,2026-08-24,09:00,09:30,",       // row 2 missing clinician
      "Fixture Room B,2026-02-30,09:00,09:30,x",      // row 3 not a real date
      "Fixture Room B,24/08/2026,09:00,09:30,x",      // row 4 not ISO
      "Fixture Room B,2026-08-24,9am,09:30,x",        // row 5 bad start
      "Fixture Room B,2026-08-24,09:00,25:00,x",      // row 6 bad end
      "Fixture Room B,2026-08-24,24:00,24:00,x",      // row 7 24:00 is an end only
      "Fixture Room B,2026-08-24,09:30,09:00,x",      // row 8 reversed
      "Fixture Room B,2026-08-24,09:00,09:00,x",      // row 9 zero length
      "Fixture Room B,2026-08-24,09:00,x",            // row 10 too few cells
      "\"Fixture Room B,2026-08-24,09:00,09:30,x",    // row 11 open quote
    ));
    expect(p.rows).toEqual([]);
    expect(p.refusals.map((r) => `${r.row}:${r.reason}`)).toEqual([
      "2:missing_cell", "3:bad_date", "4:bad_date", "5:bad_time", "6:bad_time", "7:bad_time", "8:end_not_after_start", "9:end_not_after_start", "10:wrong_cell_count", "11:unterminated_quote",
    ]);
    expect(p.refusals[0]!.detail).toBe("clinician");
    // breaks if: any of these is repaired, guessed or dropped instead of refused, or the row number is not the sheet's.
  });
  it("times are INDIA time: 09:00 IST is 03:30 UTC, and 24:00 is accepted as an end", () => {
    expect(istMidnightMs("2026-08-24")! + 9 * 3_600_000).toBe(Date.UTC(2026, 7, 24, 3, 30));
    expect(IST_OFFSET_MS).toBe(19_800_000);
    expect(parseSheet(sheet("Fixture Room B,2026-08-24,23:00,24:00,x")).rows).toHaveLength(1);
    // breaks if: times are read as UTC or local time: every block would sit 5.5 h from the audio it names.
  });
});

// ── 2. the refusals ─────────────────────────────────────────────────────────────────────────────
describe("validateAttestations — every one of these is a REFUSAL naming the row", () => {
  it("happy path: clean rows are accepted as basis=attested, with counts", () => {
    const r = run(sheet(rowOf("Fixture Room B", "09:00", "09:30", c1.full_name), rowOf("fixture room - a", "09:00", "10:15", c2.email)));
    expect(r.ok).toBe(true);
    expect(r.records.map((x) => [x.source_row, x.basis, x.clinician_id, x.windows_under_block])).toEqual([[2, "attested", c1.id, 2], [3, "attested", c2.id, 3]]);
    expect(r.counts).toMatchObject({ rows_clean: 2, rooms: 2, room_days: 2, windows_under_blocks: 5, diarized_room_days_covered: 2, diarized_room_days_total: 2 });
    // breaks if: a valid sheet is refused, the basis is not the literal 'attested', or a name/email/dash-variant fails to resolve.
  });
  it("unknown room", () => { expect(reasons(run(sheet(rowOf("No Such Room", "09:00", "09:30", c1.full_name))))).toEqual(["2:unknown_room"]); /* breaks if: an unmatched room is guessed or skipped */ });
  it("ambiguous room: two rooms with the same name", () => {
    const r = run(sheet(rowOf("Fixture Room B", "09:00", "09:30", c1.full_name)), ref({ rooms: [ROOM_B, { ...ROOM_B, id: "room_fx0c", slug: "other" }] }));
    expect(reasons(r)).toEqual(["2:ambiguous_room"]);
    // breaks if: the first of two matching rooms is silently chosen.
  });
  it("unknown clinician", () => { expect(reasons(run(sheet(rowOf("Fixture Room B", "09:00", "09:30", "Nobody Known")))).join()).toBe("2:unknown_clinician"); /* breaks if: an unmatched clinician is guessed */ });
  it("ambiguous clinician: two live clinicians share a name", () => {
    const r = run(sheet(rowOf("Fixture Room B", "09:00", "09:30", c1.full_name)), ref({ clinicians: [clin(c1), { ...clin(c2), full_name: c1.full_name }] }));
    expect(reasons(r)).toEqual(["2:ambiguous_clinician"]);
    // breaks if: a name collision picks one, which is exactly how one doctor's voice lands on another's print.
  });
  it("a deleted clinician and a non-active clinician", () => {
    expect(reasons(run(sheet(rowOf("Fixture Room B", "09:00", "09:30", cGone.full_name), rowOf("Fixture Room B", "10:00", "10:30", cOff.full_name))))).toEqual(["2:clinician_deleted", "3:clinician_not_active"]);
    // breaks if: attestation is allowed for someone who no longer exists or is disabled.
  });
  it("a block with no window under it, including a block that touches a window only at its edge", () => {
    expect(reasons(run(sheet(rowOf("Fixture Room B", "11:00", "11:30", c1.full_name), rowOf("Fixture Room B", "09:30", "10:00", c1.full_name))))).toEqual(["2:no_window_under_block", "3:no_window_under_block"]);
    // breaks if: overlap uses <= (edge-touching counts) or a block over silence is accepted.
  });
  it("windows that exist only on a scratch room-day do not count", () => {
    const r = run(sheet(rowOf("Fixture Room B", "09:00", "09:30", c1.full_name)), ref({ roomDays: [{ id: `rd_${ROOM_B.id}`, room_id: ROOM_B.id, ist_date: D, scratch: true }] }));
    expect(reasons(r)).toEqual(["2:no_window_under_block"]);
    // breaks if: test/replay data is attested as if it were a clinic day.
  });
  it("windows exist but the room-day row does not", () => {
    expect(reasons(run(sheet(rowOf("Fixture Room B", "09:00", "09:30", c1.full_name)), ref({ roomDays: [], windows: [win("w_x", ROOM_B.id, "09:00", "09:15", { day: null })] })))).toEqual(["2:no_room_day"]);
    // breaks if: a block is attested with nothing to attach it to.
  });
  it("an exact duplicate: only the LATER copy is refused, and it is not also reported as an overlap", () => {
    expect(reasons(run(sheet(rowOf("Fixture Room B", "09:00", "09:30", c1.full_name), rowOf("Fixture Room B", "09:00", "09:30", c1.full_name))))).toEqual(["3:duplicate_row"]);
    // breaks if: a copy-paste slip passes, or is double-reported.
  });
  it("overlapping blocks in one room: BOTH rows named, even for different clinicians", () => {
    const r = run(sheet(rowOf("Fixture Room B", "09:00", "09:20", c1.full_name), rowOf("Fixture Room B", "09:10", "09:30", c2.full_name)));
    expect(r.refusals.map((x) => [x.row, x.reason, x.detail])).toEqual([[2, "overlap_same_room", "with row 3"], [3, "overlap_same_room", "with row 2"]]);
    // breaks if: two people are attested in one room at once, or only one side is named.
  });
  it("adjacent blocks in one room are NOT an overlap", () => {
    expect(run(sheet(rowOf("Fixture Room B", "09:00", "09:15", c1.full_name), rowOf("Fixture Room B", "09:15", "09:30", c2.full_name))).ok).toBe(true);
    // breaks if: a changeover at a boundary is refused (the check has become <= instead of <).
  });
  it("one clinician in two rooms at once: BOTH rows named; back-to-back in two rooms is fine", () => {
    const bad = run(sheet(rowOf("Fixture Room B", "09:00", "09:30", c1.full_name), rowOf("Fixture Room – A", "09:15", "09:30", c1.full_name)));
    expect(bad.refusals.map((x) => `${x.row}:${x.reason}`)).toEqual(["2:clinician_in_two_rooms", "3:clinician_in_two_rooms"]);
    expect(run(sheet(rowOf("Fixture Room B", "09:00", "09:15", c1.full_name), rowOf("Fixture Room – A", "09:15", "09:30", c1.full_name))).ok).toBe(true);
    // breaks if: the same person is attested in two rooms at once, or a walk between rooms is refused.
  });
  it("a block that contradicts an attestation a human already made (visit span or operator_pin instant)", () => {
    const visit = { kind: "visit" as const, clinician_id: c2.id, room_id: ROOM_B.id, start_ms: at("09:00"), end_ms: at("09:20") };
    const pin = { kind: "operator_pin" as const, clinician_id: c2.id, room_id: ROOM_B.id, start_ms: at("09:20"), end_ms: at("09:20") };
    expect(reasons(run(sheet(rowOf("Fixture Room B", "09:00", "09:30", c1.full_name)), ref({ existing: [visit] })))).toEqual(["2:conflicts_with_existing_attestation"]);
    expect(reasons(run(sheet(rowOf("Fixture Room B", "09:00", "09:30", c1.full_name)), ref({ existing: [pin] })))).toEqual(["2:conflicts_with_existing_attestation"]);
    expect(reasons(run(sheet(rowOf("Fixture Room – A", "09:00", "09:30", c2.full_name)), ref({ existing: [visit] })))).toEqual(["2:conflicts_with_existing_attestation"]); // same clinician, other room
    // breaks if: the sheet can overwrite or contradict a human's earlier attestation.
  });
  it("agreeing with an existing attestation (same clinician, same room) is fine", () => {
    const visit = { kind: "visit" as const, clinician_id: c1.id, room_id: ROOM_B.id, start_ms: at("09:00"), end_ms: at("09:20") };
    expect(run(sheet(rowOf("Fixture Room B", "09:00", "09:30", c1.full_name)), ref({ existing: [visit] })).ok).toBe(true);
    // breaks if: re-attesting what is already attested is refused.
  });
  it("ALL-OR-NOTHING: one refusal anywhere makes the whole load not ok, and it names only the offending row", () => {
    const r = run(sheet(rowOf("Fixture Room B", "09:00", "09:30", c1.full_name), rowOf("No Such Room", "09:00", "09:30", c2.full_name)));
    expect(r.ok).toBe(false);
    expect(reasons(r)).toEqual(["3:unknown_room"]);
    expect(r.counts).toMatchObject({ rows_read: 2, rows_clean: 1, refusals: 1 });
    // breaks if: a partly-bad sheet is treated as ok (the caller writes only when ok).
  });
  it("names match through dash variants, case and spacing, on both sides", () => {
    expect(normalizeName("  Fixture   Room — A ")).toBe(normalizeName("fixture room - a"));
    // breaks if: a coordinator's typography makes a real room 'unknown', or a match is looser than these three.
  });
});

// ── 3. the reader and the CLI, on a REAL postgres ───────────────────────────────────────────────
const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-attest-loader");

describe("REQUIRED PROOF — the reader and the dry run against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/attest-loader.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const statements: string[] = [];
const recording = async (s: TemplateStringsArray, ...v: unknown[]) => { statements.push(s.join("?").trim()); return pg.sql(s, ...v); };

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  // Columns and types copied from the LIVE database's information_schema (19 Sep 2026), only those the loader reads.
  pg.exec(`
    CREATE TABLE room (id text PRIMARY KEY, name text NOT NULL, slug text NOT NULL);
    CREATE TABLE clinician (id text PRIMARY KEY, full_name text NOT NULL, email text NOT NULL, status text NOT NULL, deleted_at timestamptz);
    CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL);
    CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL, room_day_id text, start_ms bigint NOT NULL, end_ms bigint NOT NULL);
    CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL, scratch boolean NOT NULL, UNIQUE (room_id, ist_date));
    CREATE TABLE room_diarize_window (window_id text NOT NULL, room_day_id text, state text NOT NULL);
    CREATE TABLE visit (clinician_id text, clinician_source text, session_id text, tape_start_ms bigint, tape_end_ms bigint);
    CREATE TABLE cue (type text NOT NULL, room_day_id text NOT NULL, at timestamptz NOT NULL, payload jsonb);
    INSERT INTO room VALUES ('${ROOM_A.id}', '${ROOM_A.name}', '${ROOM_A.slug}'), ('${ROOM_B.id}', '${ROOM_B.name}', '${ROOM_B.slug}');
    INSERT INTO clinician VALUES ('${c1.id}', '${c1.full_name}', '${c1.email}', 'active', NULL), ('${c2.id}', '${c2.full_name}', '${c2.email}', 'active', NULL);
    INSERT INTO bench_session VALUES ('bs_fx0a', '${ROOM_A.id}'), ('bs_fx0b', '${ROOM_B.id}');
    INSERT INTO room_day VALUES ('rd_a', '${ROOM_A.id}', '${D}', false), ('rd_b', '${ROOM_B.id}', '${D}', false);
    INSERT INTO bench_window VALUES ('w_1', 'bs_fx0a', 'rd_a', ${at("09:00")}, ${at("09:15")}), ('w_2', 'bs_fx0a', 'rd_a', ${at("09:15")}, ${at("09:30")}), ('w_3', 'bs_fx0b', 'rd_b', ${at("09:00")}, ${at("09:15")});
    INSERT INTO room_diarize_window VALUES ('w_1', 'rd_a', 'ok'), ('w_2', 'rd_a', 'failed'), ('w_3', 'rd_b', 'ok');
    INSERT INTO visit VALUES ('${c2.id}', 'operator', 'bs_fx0b', ${at("09:00")}, ${at("09:10")}), (NULL, NULL, 'bs_fx0b', NULL, NULL);
    INSERT INTO cue VALUES ('operator_pin', 'rd_b', to_timestamp(${at("09:12") / 1000}), '{"clinician_id":"${c2.id}","phase":"in_chair"}'), ('stt_turn', 'rd_b', now(), '{"text":"x"}');
  `);
}, 240_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

const cli = async (argv: string[], input = "") => {
  statements.length = 0;
  const lines: string[] = [];
  const code = await runLoader({ argv, sql: recording, readInput: () => input, out: (l) => lines.push(l), now: () => new Date("2026-09-19T00:00:00Z") });
  return { code, lines, text: lines.join("\n") };
};

describe.runIf(HAVE_DOCKER)("loadReference and the CLI — real postgres", () => {
  it("loadReference returns typed data: bigints as numbers, status as text, dates as strings, diarized only when state is ok", async () => {
    const r = await loadReference(pg.sql, { fromMs: at("00:00"), toMs: at("23:59") });
    expect(r.windows.map((w) => [w.id, w.start_ms, w.diarized]).sort()).toEqual([["w_1", at("09:00"), true], ["w_2", at("09:15"), false], ["w_3", at("09:00"), true]]);
    expect(r.roomDays.find((d) => d.id === "rd_a")).toMatchObject({ ist_date: D, scratch: false });
    expect(r.clinicians.find((c) => c.id === c1.id)).toMatchObject({ status: "active", deleted: false });
    expect([...r.diarizedRoomDayIds].sort()).toEqual(["rd_a", "rd_b"]);
    expect(r.existing.map((e) => [e.kind, e.clinician_id, e.start_ms === e.end_ms]).sort()).toEqual([["operator_pin", c2.id, true], ["visit", c2.id, false]]);
    // breaks if: a column name drifts from the live schema, a bigint is left a string, or a visit with no span is treated as placeable.
  });
  it("dry run of a clean sheet: exit 0, ONLY SELECTs issued, counts printed, no name or email in the output", async () => {
    const r = await cli(["--file", "x", "--attested-by", "fixture-coordinator", "--dry-run"], sheet(rowOf("Fixture Room – A", "09:00", "09:30", c1.full_name)));
    expect(r.code).toBe(0);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.every((s) => /^(SELECT|WITH)\b/i.test(s))).toBe(true);
    // and no statement touches voiceprint data: the repo's voiceprint-reader sweep must not need to know this loader exists.
    expect(statements.some((s) => /voice_print|voice_sample|embedding/i.test(s))).toBe(false);
    expect(r.text).toContain("would write: 1 attestation records");
    expect(r.text).toContain("diarized room-days covered: 1 of 2");
    expect(r.text).not.toContain(c1.full_name);
    expect(r.text).not.toContain(c1.email);
    // breaks if: the dry run issues any INSERT/UPDATE/DELETE, or prints a person.
  });
  it("dry run of a bad sheet: exit 2, the offending rows named by number and reason only, and 'would write: 0'", async () => {
    const r = await cli(["--file", "x", "--attested-by", "fixture-coordinator"], sheet(rowOf("Fixture Room B", "09:00", "09:15", c1.full_name), rowOf("Fixture Room B", "09:05", "09:15", c2.full_name), rowOf("Nope", "09:00", "09:15", "Nobody")));
    expect(r.code).toBe(2);
    expect(r.text).toContain("row 2  overlap_same_room (with row 3)");
    expect(r.text).toContain("row 3  overlap_same_room (with row 2)");
    expect(r.text).toContain("row 4  unknown_room");
    expect(r.text).toContain("would write: 0 attestation records");
    expect(r.text).not.toContain(c1.full_name);
    // breaks if: refusals are warnings (exit 0), a row is unnamed, or a refused load still reports something to write.
  });
  it("a block over the existing operator visit by a different clinician is refused against the REAL visit and cue rows", async () => {
    const r = await cli(["--file", "x", "--attested-by", "fixture-coordinator"], sheet(rowOf("Fixture Room B", "09:00", "09:15", c1.full_name)));
    expect(r.code).toBe(2);
    expect(r.text).toContain("conflicts_with_existing_attestation");
    // breaks if: the existing-attestation read stops finding visits or operator_pin cues.
  });
  it("--write is REFUSED with the reason, exit 3, and issues no statement at all", async () => {
    const r = await cli(["--write", "--file", "x", "--attested-by", "fixture-coordinator"], sheet(rowOf("Fixture Room B", "09:00", "09:15", c1.full_name)));
    expect(r.code).toBe(3);
    expect(r.text).toBe(WRITE_REFUSED);
    expect(statements).toEqual([]);
    // breaks if: a write path is quietly added, or --write reads the database first.
  });
  it("usage errors: missing --attested-by, an unknown flag, and no --file", async () => {
    expect((await cli(["--file", "x"], "")).code).toBe(1);
    expect((await cli(["--frobnicate"])).code).toBe(1);
    expect((await cli(["--attested-by", "someone"])).code).toBe(1);
    // breaks if: an attestation can be loaded with no attestor, or a typo'd flag is ignored.
  });
  it("--workload sizes the human task from the data: diarized room-days, rooms, dates, and none narrowed", async () => {
    const r = await cli(["--workload"]);
    expect(r.code).toBe(0);
    expect(r.text).toContain("diarized room-days to attest: 2 | across 2 rooms and 1 dates | 2 diarized windows");
    expect(r.text).toContain("already attested over diarized audio: 1 of 2");
    const w = workloadFrom(await loadReference(pg.sql, { fromMs: 0, toMs: 4_102_444_800_000 }));
    expect(w.diarized_room_days).toBe(2);
    // breaks if: the workload counts a non-diarized day, or claims an attested day that no diarized audio sits under.
  });
});
