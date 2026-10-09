/**
 * encounter-anchors.test.ts — Pulse anchors (epic #23 g): the derived close_kind / end_clicked split, the next Start,
 * weak starts, doctor precedence, and that the resolver's own vocabulary is untouched. All ids are fake; times are
 * written as IST wall clock and converted by hand-checked Date.parse.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { effectiveCheckValues } from "../support/sql-check";
import { CLOSE_KIND, istDayRange, loadAnchors, toAnchors } from "@/lib/encounter-clock/anchors";
import type { EncounterWindowRead } from "@/lib/encounter-windows";

const IST = (hhmm: string, date = "2026-10-08") => `${date}T${hhmm}:00+05:30`;
const EP = (hhmm: string, date?: string) => Date.parse(IST(hhmm, date));

const row = (o: Partial<EncounterWindowRead>): EncounterWindowRead => ({
  consult_key: "c1@m1", consult_uid: "c1", prescription_ref: null, machine: "m1", room_id: "room_a", room_slug: "opd-x",
  doctor_uid: null, display_name: null, attribution: "none", t_open: new Date(EP("10:00")).toISOString(), t_close: null,
  close_reason: "open", quality: "clean", reopen_count: 0, source_event_ids: [], resolver_version: "v",
  warehouse_doctor_uid: null, warehouse_doctor_name: null, warehouse_checked_at: null, warehouse_prescription_uid: null,
  consulting_doctor_uid: null, consulting_doctor_name: null, attribution_source: null, doctor_mismatch: false,
  ...o,
});
const at = (hhmm: string) => new Date(EP(hhmm)).toISOString();

describe("close_kind", () => {
  it("maps every close_reason the database admits, exactly once", () => {
    const eff = effectiveCheckValues("db/migrations", "eta_encounter_windows_close_reason_chk", "close_reason");
    expect(new Set(Object.keys(CLOSE_KIND))).toEqual(eff.values);
    expect(Object.keys(CLOSE_KIND)).toHaveLength(7);
  });
  it("only a real endConsult is a clicked end; url_clear is weak", () => {
    expect(CLOSE_KIND).toEqual({
      endConsult: "clicked_end", url_clear: "url_clear", next_open: "next_open", logout: "logout",
      idle_timeout: "idle", cap_90m: "cap", open: "open",
    });
  });
  it("the resolver and the cutter still count url_clear as explicit — this ticket changes neither", () => {
    const compute = readFileSync("lib/encounter-windows/compute.ts", "utf8");
    expect(compute).toContain('const EXPLICIT_CLOSE: ReadonlySet<CloseReason> = new Set(["endConsult", "url_clear"]);');
    const cutter = readFileSync("tools/eta-consult-cutter/cutter/config.py", "utf8");
    expect(cutter).toMatch(/EXPLICIT = \{"url_clear", "endConsult"\}/);
  });
});

describe("toAnchors", () => {
  it("a clicked end, a weak end, and an open consult, with next Starts in order", () => {
    const rows = [
      row({ consult_key: "c3@m1", t_open: at("10:40"), close_reason: "open", t_close: null }),
      row({ consult_key: "c1@m1", t_open: at("10:00"), close_reason: "endConsult", t_close: at("10:12") }),
      row({ consult_key: "c2@m1", t_open: at("10:15"), close_reason: "url_clear", t_close: at("10:31") }),
    ];
    const { anchors, skipped } = toAnchors(rows);
    expect(skipped).toBe(0);
    expect(anchors.map((a) => a.consult_key)).toEqual(["c1@m1", "c2@m1", "c3@m1"]);
    expect(anchors[0]).toMatchObject({
      start_ms: EP("10:00"), close_kind: "clicked_end", end_clicked: true, end_click_ms: EP("10:12"),
      end_weak_ms: null, end_weak_kind: null, next_start_ms: EP("10:15"),
    });
    expect(anchors[1]).toMatchObject({
      close_kind: "url_clear", end_clicked: false, end_click_ms: null, end_weak_ms: EP("10:31"), end_weak_kind: "url_clear",
      next_start_ms: EP("10:40"),
    });
    expect(anchors[2]).toMatchObject({ close_kind: "open", end_clicked: false, end_click_ms: null, end_weak_ms: null, end_weak_kind: null, next_start_ms: null });
  });

  it("the look-ahead row gives the last anchor its next Start, only in the same room", () => {
    const rows = [row({ t_open: at("21:00"), close_reason: "cap_90m", t_close: at("22:30") })];
    expect(toAnchors(rows, row({ consult_key: "n@m1", t_open: "2026-10-09T03:00:00.000Z" })).anchors[0]!.next_start_ms).toBe(Date.parse("2026-10-09T03:00:00.000Z"));
    expect(toAnchors(rows, row({ consult_key: "n@m2", room_id: "room_b", t_open: "2026-10-09T03:00:00.000Z" })).anchors[0]!.next_start_ms).toBeNull();
    expect(toAnchors(rows).anchors[0]).toMatchObject({ close_kind: "cap", end_weak_kind: "cap", end_weak_ms: EP("22:30") });
  });

  it("weak_start for multi_doctor and ambiguous only", () => {
    const q = (quality: EncounterWindowRead["quality"]) => toAnchors([row({ quality })]).anchors[0]!.weak_start;
    expect([q("multi_doctor"), q("ambiguous"), q("clean"), q("unclosed"), q("unattributed")]).toEqual([true, true, false, false, false]);
  });

  it("doctor: the warehouse's first, else the extension's, else none — both uids kept", () => {
    const a = (o: Partial<EncounterWindowRead>) => toAnchors([row(o)]).anchors[0]!;
    expect(a({ warehouse_doctor_uid: "doc_w", doctor_uid: "doc_e" })).toMatchObject({ doctor_source: "warehouse", doctor_uid_warehouse: "doc_w", doctor_uid_ext: "doc_e" });
    expect(a({ doctor_uid: "doc_e" })).toMatchObject({ doctor_source: "extension", doctor_uid_warehouse: null, doctor_uid_ext: "doc_e" });
    expect(a({})).toMatchObject({ doctor_source: "none" });
  });

  it("rows with no room or an unreadable start are skipped and counted, never guessed", () => {
    const { anchors, skipped } = toAnchors([row({ room_id: null }), row({ t_open: "not a time" }), row({ consult_key: "ok@m1" })]);
    expect(anchors.map((x) => x.consult_key)).toEqual(["ok@m1"]);
    expect(skipped).toBe(2);
  });

  it("ties on start are ordered by consult_key, so the result is stable", () => {
    const rows = [row({ consult_key: "b@m1" }), row({ consult_key: "a@m1" })];
    const { anchors } = toAnchors(rows);
    expect(anchors.map((x) => x.consult_key)).toEqual(["a@m1", "b@m1"]);
    expect(anchors[0]!.next_start_ms).toBe(EP("10:00"));
  });
});

describe("istDayRange and loadAnchors", () => {
  it("an IST day is 18:30Z the evening before to 18:30Z that evening", () => {
    expect(istDayRange("2026-10-08")).toEqual({ from: "2026-10-07T18:30:00.000Z", to: "2026-10-08T18:30:00.000Z" });
    expect(() => istDayRange("8 Oct")).toThrow();
  });

  it("reads the day, then one look-ahead row, through queryWindows — and writes nothing", async () => {
    const calls: string[] = [];
    const answers: unknown[][] = [
      [{ ...row({ t_open: at("10:00"), close_reason: "endConsult", t_close: at("10:10") }) }],
      [{ ...row({ consult_key: "n@m1", t_open: "2026-10-09T03:00:00.000Z" }) }],
    ];
    const db = vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => {
      calls.push(strings.join("?").replace(/\s+/g, " "));
      void vals;
      return Promise.resolve(answers.shift() ?? []);
    });
    const out = await loadAnchors(db as never, "room_a", "2026-10-08");
    if ("refused" in out) throw new Error("room_a is not a blind room-day");
    const { anchors } = out;
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c).toMatch(/^ ?SELECT /);
      expect(c).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    }
    const [first, second] = db.mock.calls;
    expect(first!.slice(1)).toEqual(expect.arrayContaining(["room_a", "2026-10-07T18:30:00.000Z", "2026-10-08T18:30:00.000Z", 5000]));
    expect(second!.slice(1)).toEqual(expect.arrayContaining(["room_a", "2026-10-08T18:30:00.000Z", 1]));
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ end_clicked: true, next_start_ms: Date.parse("2026-10-09T03:00:00.000Z") });
  });
});
