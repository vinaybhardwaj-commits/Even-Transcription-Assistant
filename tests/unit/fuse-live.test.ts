/**
 * tests/unit/fuse-live.test.ts — K2 acceptance U1–U9, plus the flag that keeps Monday safe.
 *
 * The unit half of K2. Everything here is either a property of the PURE function (so it needs
 * no database at all) or a property of the flag parser (so it needs no network). The live half
 * — L1..L7 — is exercised against production separately; these are the assertions that must
 * hold before anything is deployed at all.
 *
 * The single most important test in this file is not any of the numbered ones: it is
 * "the flag enables nothing by default", because that is the property Monday depends on.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  runRulesArm,
  END_REASONS,
  ALL_END_REASONS,
  LAST_MARK_WINDOW_MS,
  type TapeSession,
} from "@/lib/brain/fuse/rules";
import { K2_DERIVABLE_CLINICIAN_SOURCES, type FuseCue } from "@/lib/brain/fuse/types";
import { parseFuseLiveFlag, isFuseLiveEnabled, FUSE_LIVE_ENV } from "@/lib/brain/fuse/live-flag";
import { istDayRolloverAt } from "@/lib/brain/fuse/live";
import { encodeCueCursor, decodeCueCursor } from "@/lib/brain/state";

// --- fixtures ---------------------------------------------------------------------------
const DAY = "2026-08-19";
const T = (hhmm: string): string => `${DAY}T${hhmm}:00.000Z`;
const ROLLOVER = istDayRolloverAt(DAY);

let n = 0;
const cue = (type: string, at: string, payload: Record<string, unknown> | null, sourceRef: string | null = null): FuseCue => ({
  id: `cue_${type}_${++n}`,
  type,
  at,
  payload,
  source: "replay",
  source_ref: sourceRef,
});
const wh = (type: string, at: string, ref: string, payload: Record<string, unknown>): FuseCue => cue(type, at, payload, ref);
const mark = (at: string, payload: Record<string, unknown> = { source: "kiosk" }): FuseCue => cue("consult_mark", at, payload, null);

// =========================================================================================
// U1 — a pulse_note closure emits ended_at equal to that cue's `at`
// =========================================================================================
describe("U1 — the closer's own instant is recorded, not the arm's clock", () => {
  it("a pulse_note closure sets ended_at to that cue's `at`, exactly", () => {
    const noteAt = T("06:00");
    const { visits } = runRulesArm(
      [
        wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),
        wh("pulse_note", noteAt, "pn_1", { individual_uid: "ind_1", attribution: "direct" }),
      ],
      { rolloverAt: ROLLOVER },
    );
    expect(visits).toHaveLength(1);
    expect(visits[0]!.end_reason).toBe(END_REASONS.PULSE_NOTE);
    expect(visits[0]!.ended_at).toBe(noteAt);
  });

  it("a visit that is NOT ended carries no ended_at — the two fields travel together", () => {
    // Every closer fires on a fused day, so the way to observe this pairing is the invariant
    // itself: no visit anywhere has one without the other.
    const { visits } = runRulesArm(
      [
        wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),
        mark(T("09:00")),
      ],
      { rolloverAt: ROLLOVER },
    );
    for (const v of visits) {
      if (v.state !== "ended") expect(v.ended_at).toBeNull();
      else expect(v.end_reason).not.toBeNull();
    }
  });
});

// =========================================================================================
// U2 — a mark-only visit NOW CLOSES, by all three routes
// =========================================================================================
describe("U2 — the mark-only visit closes; before K2 it was closed by nothing, ever", () => {
  it("route 1 — next_opener: the next visit opening ends it, at that instant", () => {
    const { visits } = runRulesArm([mark(T("04:00")), wh("pstart", T("10:39"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" })], {
      rolloverAt: ROLLOVER,
    });
    const orphan = visits.find((v) => v.opened_by_kind === "mark")!;
    expect(orphan.state).toBe("ended");
    expect(orphan.end_reason).toBe(END_REASONS.NEXT_OPENER);
    expect(orphan.ended_at).toBe(T("10:39"));
    // and it is STILL the unrecorded-care row: no identity was invented to close it
    expect(orphan.individual_uid).toBeNull();
  });

  it("route 2 — mark_window_elapsed: no next opener, so its own 45-minute window ends it", () => {
    const { visits } = runRulesArm([mark(T("10:00"))], { rolloverAt: ROLLOVER });
    expect(visits).toHaveLength(1);
    expect(visits[0]!.state).toBe("ended");
    expect(visits[0]!.end_reason).toBe(END_REASONS.MARK_WINDOW_ELAPSED);
  });

  it("route 3 — day_rollover_unknown: the window runs past the boundary, so the day ends it", () => {
    // A mark pressed inside the last 45 minutes of the day. Its window never elapsed, so
    // claiming mark_window_elapsed would assert an interval that did not finish.
    const lateMark = new Date(Date.parse(ROLLOVER) - 10 * 60 * 1000).toISOString();
    const { visits } = runRulesArm([mark(lateMark)], { rolloverAt: ROLLOVER });
    expect(visits[0]!.state).toBe("ended");
    expect(visits[0]!.end_reason).toBe(END_REASONS.DAY_ROLLOVER_UNKNOWN);
    expect(visits[0]!.ended_at).toBe(ROLLOVER);
  });

  it("all three tokens are in the closed set, and none of them is `day_rollover`", () => {
    for (const r of [END_REASONS.NEXT_OPENER, END_REASONS.MARK_WINDOW_ELAPSED, END_REASONS.DAY_ROLLOVER_UNKNOWN]) {
      expect(ALL_END_REASONS).toContain(r);
      expect(r).not.toBe(END_REASONS.DAY_ROLLOVER);
    }
    // B4: they are END reasons, and the ambiguity vocabulary is untouched by them
    const rules = readFileSync("lib/brain/fuse/rules.ts", "utf8");
    const reasonsBlock = rules.slice(rules.indexOf("export const RULES_REASONS"), rules.indexOf("export const ALL_RULES_REASONS"));
    for (const r of ["next_opener", "mark_window_elapsed", "day_rollover_unknown"]) {
      expect(reasonsBlock).not.toContain(r);
    }
  });
});

// =========================================================================================
// U3 — mark_window_elapsed lands exactly 45 minutes on
// =========================================================================================
describe("U3 — the mark window is exactly LAST_MARK_WINDOW_MS, to the millisecond", () => {
  it("ended_at is mark time + 45 minutes, and 45 minutes is what the constant says", () => {
    const at = T("10:00");
    const { visits } = runRulesArm([mark(at)], { rolloverAt: ROLLOVER });
    expect(visits[0]!.end_reason).toBe(END_REASONS.MARK_WINDOW_ELAPSED);
    expect(Date.parse(visits[0]!.ended_at!) - Date.parse(at)).toBe(LAST_MARK_WINDOW_MS);
    expect(LAST_MARK_WINDOW_MS).toBe(45 * 60 * 1000);
  });
});

// =========================================================================================
// U4 — B5 precedence when two closers are eligible
// =========================================================================================
describe("U4 — B5 precedence: the FIRST eligible closer wins and the rest are not consulted", () => {
  it("pulse_note beats next_opener", () => {
    // ind_1 opens at 03:00, its note lands 04:00, and a NEXT visit opens at 05:00. Both closers
    // are eligible; the note is earlier in the chain.
    const { visits } = runRulesArm(
      [
        wh("pstart", T("03:00"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),
        wh("pulse_note", T("04:00"), "pn_1", { individual_uid: "ind_1", attribution: "direct" }),
        wh("pstart", T("05:00"), "svc_2", { individual_uid: "ind_2", calendar_uid: "cal_2", attribution: "direct" }),
      ],
      { rolloverAt: ROLLOVER },
    );
    const first = visits.find((v) => v.opened_by === "svc_1")!;
    expect(first.end_reason).toBe(END_REASONS.PULSE_NOTE);
    expect(first.ended_at).toBe(T("04:00"));
  });

  it("next_opener beats mark_window_elapsed — precedence, not chronology", () => {
    // A mark at 10:00 whose window is EMPTY (the pstart at 11:00 falls outside [10:00, 10:45),
    // so the mark mints its own visit) and whose window would have ended at 10:45. Both closers
    // are eligible and mark_window_elapsed is the EARLIER instant — B1 still wins, because the
    // chain is ordered by precedence and not by which clock reads lower.
    const { visits } = runRulesArm(
      [mark(T("10:00")), wh("pstart", T("11:00"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" })],
      { rolloverAt: ROLLOVER },
    );
    const orphan = visits.find((v) => v.opened_by_kind === "mark")!;
    expect(orphan.end_reason).toBe(END_REASONS.NEXT_OPENER);
    expect(orphan.ended_at).toBe(T("11:00"));
    expect(Date.parse(orphan.ended_at!)).toBeGreaterThan(Date.parse(T("10:00")) + LAST_MARK_WINDOW_MS);
  });

  it("mark_window_elapsed beats day_rollover_unknown", () => {
    const { visits } = runRulesArm([mark(T("10:00"))], { rolloverAt: ROLLOVER });
    expect(visits[0]!.end_reason).toBe(END_REASONS.MARK_WINDOW_ELAPSED);
    expect(visits[0]!.end_reason).not.toBe(END_REASONS.DAY_ROLLOVER_UNKNOWN);
  });

  it("next_opener beats the boundary for a warehouse visit too", () => {
    const { visits } = runRulesArm(
      [
        wh("pstart", T("03:00"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),
        wh("pstart", T("05:00"), "svc_2", { individual_uid: "ind_2", calendar_uid: "cal_2", attribution: "direct" }),
      ],
      { rolloverAt: ROLLOVER },
    );
    expect(visits.find((v) => v.opened_by === "svc_1")!.end_reason).toBe(END_REASONS.NEXT_OPENER);
    // only the LAST visit reaches the boundary
    expect(visits.find((v) => v.opened_by === "svc_2")!.end_reason).toBe(END_REASONS.DAY_ROLLOVER);
  });
});

// =========================================================================================
// U5 / U6 — the two tape findings, neither of them an error
// =========================================================================================
describe("U5 — a visit with no tape coverage is still emitted, with a NULL binding", () => {
  it("no sessions at all → null session_id and null bounds, and the visit survives", () => {
    const { visits } = runRulesArm([wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" })], {
      rolloverAt: ROLLOVER,
    });
    expect(visits).toHaveLength(1);
    expect(visits[0]!.session_id).toBeNull();
    expect(visits[0]!.tape_start_ms).toBeNull();
    expect(visits[0]!.tape_end_ms).toBeNull();
    expect(visits[0]!.individual_uid).toBe("ind_1"); // warehouse truth is kept
  });

  it("a session that does NOT cover the visit is not forced onto it", () => {
    const sessions: TapeSession[] = [{ id: "bs_x", started_at: T("14:00"), ended_at: T("16:00") }];
    const { visits } = runRulesArm([wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" })], {
      rolloverAt: ROLLOVER,
      sessions,
    });
    expect(visits[0]!.session_id).toBeNull();
  });

  it("a covering session binds, and the bounds are the OVERLAP in epoch ms", () => {
    const sessions: TapeSession[] = [{ id: "bs_x", started_at: T("03:00"), ended_at: T("04:00") }];
    const { visits } = runRulesArm(
      [
        wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),
        wh("pulse_note", T("05:00"), "pn_1", { individual_uid: "ind_1", attribution: "direct" }),
      ],
      { rolloverAt: ROLLOVER, sessions },
    );
    const v = visits[0]!;
    expect(v.session_id).toBe("bs_x");
    // visit [03:35, 05:00) ∩ tape [03:00, 04:00) = [03:35, 04:00)
    expect(v.tape_start_ms).toBe(Date.parse(T("03:35")));
    expect(v.tape_end_ms).toBe(Date.parse(T("04:00")));
    expect(v.tape_end_ms!).toBeGreaterThan(v.tape_start_ms!); // 0056's CHECK
  });

  it("a still-running tape and a still-open visit give a start with a NULL end, which 0056 allows", () => {
    const sessions: TapeSession[] = [{ id: "bs_live", started_at: T("03:00"), ended_at: null }];
    // No rolloverAt supplied → the boundary close has no instant, so ended_at stays null.
    const { visits } = runRulesArm([wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" })], {
      sessions,
    });
    const v = visits[0]!;
    expect(v.session_id).toBe("bs_live");
    expect(v.tape_start_ms).toBe(Date.parse(T("03:35")));
    expect(v.tape_end_ms).toBeNull();
  });
});

describe("U6 — a tape window with no warehouse evidence still yields a visit, with no identity", () => {
  it("the mark-only visit binds to the tape and keeps a null individual_uid", () => {
    const sessions: TapeSession[] = [{ id: "bs_x", started_at: T("09:00"), ended_at: T("12:00") }];
    const { visits } = runRulesArm([mark(T("10:00"))], { rolloverAt: ROLLOVER, sessions });
    expect(visits).toHaveLength(1);
    const v = visits[0]!;
    expect(v.individual_uid).toBeNull();
    expect(v.session_id).toBe("bs_x");
    expect(v.tape_start_ms).toBe(Date.parse(T("10:00")));
    // it closes at 10:45, inside the tape, so the overlap ends there rather than at 12:00
    expect(v.tape_end_ms).toBe(Date.parse(T("10:00")) + LAST_MARK_WINDOW_MS);
  });
});

// =========================================================================================
// U7 — purity
// =========================================================================================
describe("U7 — runRulesArm is still a pure function", () => {
  const cues: FuseCue[] = [
    wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" }),
    wh("dx_event", T("05:10"), "svc_dx", { individual_uid: "ind_1", attribution: "direct" }),
    mark(T("10:00"), { source: "kiosk", clinician_id: "doc_abc" }),
    wh("pulse_note", T("06:00"), "pn_1", { individual_uid: "ind_1", attribution: "direct" }),
  ];
  const sessions: TapeSession[] = [{ id: "bs_x", started_at: T("03:00"), ended_at: T("12:00") }];

  it("same input, same output, twice — with the new options in play", () => {
    const a = runRulesArm(cues, { rolloverAt: ROLLOVER, sessions });
    const b = runRulesArm(cues, { rolloverAt: ROLLOVER, sessions });
    expect(a).toEqual(b);
  });

  it("input order does not change the answer", () => {
    const a = runRulesArm(cues, { rolloverAt: ROLLOVER, sessions });
    const b = runRulesArm([...cues].reverse(), { rolloverAt: ROLLOVER, sessions });
    expect(b).toEqual(a);
  });

  it("it does not mutate its arguments", () => {
    const cuesCopy = JSON.parse(JSON.stringify(cues));
    const sessCopy = JSON.parse(JSON.stringify(sessions));
    runRulesArm(cues, { rolloverAt: ROLLOVER, sessions });
    expect(cues).toEqual(cuesCopy);
    expect(sessions).toEqual(sessCopy);
  });

  it("no I/O, no clock, no randomness, no id generation anywhere in the file", () => {
    const src = readFileSync("lib/brain/fuse/rules.ts", "utf8");
    expect(src).not.toMatch(/\bDate\.now\(\)/);
    expect(src).not.toMatch(/\bMath\.random\b/);
    expect(src).not.toMatch(/\bnew Date\(\s*\)/); // argless now()
    expect(src).not.toMatch(/\bfetch\(|\bquery\(|\bsql`|require\(/);
    expect(src).not.toMatch(/newVisitId|nanoid|randomUUID|crypto\./);
  });
});

// =========================================================================================
// U8 — clinician_source is derived, and 'roster'/'voice' are unreachable in K2
// =========================================================================================
describe("U8 — the clinician is DERIVED, and only 'mark' | 'operator' | 'unknown' can appear", () => {
  it("nothing said → 'unknown' with a null id, which is a terminal answer and not an error", () => {
    const { visits } = runRulesArm([wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct" })], {
      rolloverAt: ROLLOVER,
    });
    expect(visits[0]!.clinician_source).toBe("unknown");
    expect(visits[0]!.clinician_id).toBeNull();
    expect(visits[0]!.clinician_confidence).toBeNull();
  });

  it("a consult_mark carrying clinician_id derives source 'mark'", () => {
    const { visits } = runRulesArm([mark(T("10:00"), { source: "kiosk", clinician_id: "doc_abc" })], { rolloverAt: ROLLOVER });
    expect(visits[0]!.clinician_id).toBe("doc_abc");
    expect(visits[0]!.clinician_source).toBe("mark");
    expect(visits[0]!.clinician_confidence).toBeGreaterThan(0);
  });

  it("an operator_pin carrying clinician_id derives 'operator', and outranks a mark", () => {
    const { visits } = runRulesArm(
      [
        mark(T("10:00"), { source: "kiosk", clinician_id: "doc_from_mark" }),
        cue("operator_pin", T("10:05"), { source: "mcp", clinician_id: "doc_from_operator" }),
      ],
      { rolloverAt: ROLLOVER },
    );
    const v = visits.find((x) => x.opened_by_kind === "mark")!;
    expect(v.clinician_source).toBe("operator");
    expect(v.clinician_id).toBe("doc_from_operator");
  });

  it("a payload that TYPES clinician_source is ignored — the field is never read", () => {
    const { visits } = runRulesArm(
      [mark(T("10:00"), { source: "kiosk", clinician_id: "doc_abc", clinician_source: "roster", clinician_confidence: 0.99 })],
      { rolloverAt: ROLLOVER },
    );
    // the cue TYPE decided the label, not the payload's claim about itself
    expect(visits[0]!.clinician_source).toBe("mark");
    expect(visits[0]!.clinician_source).not.toBe("roster");
    // and the file never reads those keys at all
    const src = readFileSync("lib/brain/fuse/rules.ts", "utf8");
    expect(src).not.toMatch(/"clinician_source"|'clinician_source'/);
    expect(src).not.toMatch(/"clinician_confidence"|'clinician_confidence'/);
  });

  it("'roster' and 'voice' cannot be produced by any cue shape in this build", () => {
    const { visits } = runRulesArm(
      [
        wh("pstart", T("03:35"), "svc_1", { individual_uid: "ind_1", calendar_uid: "cal_1", attribution: "direct", clinician_source: "roster", clinician_id: "doc_r" }),
        cue("speaker_match", T("04:00"), { clinician_id: "doc_v", clinician_source: "voice" }),
        mark(T("10:00"), { source: "kiosk", clinician_id: "doc_m" }),
        cue("operator_pin", T("11:00"), { source: "mcp", clinician_id: "doc_o" }),
      ],
      { rolloverAt: ROLLOVER },
    );
    for (const v of visits) {
      expect(v.clinician_source).not.toBe("roster");
      expect(v.clinician_source).not.toBe("voice");
      expect(K2_DERIVABLE_CLINICIAN_SOURCES).toContain(v.clinician_source!);
    }
  });

  it("room_day.doctor_id is neither read nor written anywhere in the fuse", () => {
    for (const f of ["lib/brain/fuse/rules.ts", "lib/brain/fuse/live.ts", "lib/brain/fuse/visit-update.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/doctor_id/);
    }
  });
});

// =========================================================================================
// U9 — rules.ts still holds exactly ONE invented constant
// =========================================================================================
describe("U9 — LAST_MARK_WINDOW_MS is still the only invented constant, and still 45 minutes", () => {
  it("its value is unchanged", () => {
    expect(LAST_MARK_WINDOW_MS).toBe(45 * 60 * 1000);
  });

  it("no SECOND time-shaped constant was added to rules.ts", () => {
    const src = readFileSync("lib/brain/fuse/rules.ts", "utf8");
    // Every `N * 60 * 1000`-shaped literal in the file, whatever it is called.
    const timeConstants = [...src.matchAll(/^\s*(?:export\s+)?const\s+([A-Z0-9_]+)\s*=\s*[^;]*60\s*\*\s*1000/gm)].map((m) => m[1]);
    expect(timeConstants).toEqual(["LAST_MARK_WINDOW_MS"]);
  });

  it("the debounce constant lives OUTSIDE rules.ts, where scheduling parameters belong", () => {
    expect(readFileSync("lib/brain/fuse/rules.ts", "utf8")).not.toContain("DEBOUNCE");
    expect(readFileSync("lib/brain/fuse/live.ts", "utf8")).toContain("FUSE_DEBOUNCE_MS");
  });

  it("no silence-gap closer, and no silence derived from turn timing", () => {
    const src = readFileSync("lib/brain/fuse/rules.ts", "utf8");
    // stt_turn / stt_silence timing must play no part in deciding when a visit ends
    expect(src).not.toMatch(/stt_turn|stt_silence/);
    expect(src).not.toMatch(/silence_gap|gap_ms|GAP_MS|SILENCE_/);
    for (const word of ["thin", "degenerate", "loop"]) {
      expect(src.toLowerCase()).not.toMatch(new RegExp(`\\b${word}\\b\\s*(turn|segment)`));
    }
  });

  it("arms B and C are neither revived nor re-run by anything K2 added", () => {
    for (const f of ["lib/brain/fuse/live.ts", "lib/brain/fuse/visit-update.ts", "lib/brain/fuse/live-flag.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/gemini-arms|runFlashArm|runHybridArm/);
    }
  });
});

// =========================================================================================
// THE FLAG — the property Monday depends on
// =========================================================================================
describe("FUSE_LIVE_ENABLED — off by default, per-room, and never global", () => {
  it("unset enables nothing", () => {
    const s = parseFuseLiveFlag(undefined);
    expect(s.set).toBe(false);
    expect(s.rooms).toEqual([]);
  });

  it("empty and whitespace enable nothing", () => {
    for (const v of ["", "   ", "\n"]) expect(parseFuseLiveFlag(v).rooms).toEqual([]);
  });

  it("a boolean-shaped value enables NOTHING and is reported as a misconfiguration", () => {
    // This is the mistake a person actually makes. It must not turn the fuse on anywhere.
    for (const v of ["1", "true", "on", "yes", "*", "all"]) {
      const s = parseFuseLiveFlag(v);
      expect(s.rooms).toEqual([]);
      expect(s.misconfigured).toBe(true);
      expect(s.refused).toContain(v);
      expect(isFuseLiveEnabledWith(v, "room_qyzghzaf")).toBe(false);
      expect(isFuseLiveEnabledWith(v, "room_2qe955hy")).toBe(false);
    }
  });

  it("naming ONE room enables that room and no other", () => {
    const v = "room_2qe955hy";
    expect(isFuseLiveEnabledWith(v, "room_2qe955hy")).toBe(true);
    // the two clinic rooms of the 24 August OPD day
    expect(isFuseLiveEnabledWith(v, "room_qyzghzaf")).toBe(false);
    expect(isFuseLiveEnabledWith(v, "room_bh6jtq4t")).toBe(false);
  });

  it("a list is parsed, and a refused token in a list does not enable the others' neighbours", () => {
    const s = parseFuseLiveFlag("room_a, room_b  room_c");
    expect(s.rooms).toEqual(["room_a", "room_b", "room_c"]);
    const mixed = parseFuseLiveFlag("room_a,*");
    expect(mixed.rooms).toEqual(["room_a"]);
    expect(mixed.refused).toEqual(["*"]);
    expect(isFuseLiveEnabledWith("room_a,*", "room_zzz")).toBe(false);
  });

  it("an empty room id is never enabled", () => {
    expect(isFuseLiveEnabledWith("room_a", "")).toBe(false);
  });

  it("the flag is read at the point of use, never cached at module scope", () => {
    const src = readFileSync("lib/brain/fuse/live-flag.ts", "utf8");
    // no top-level `const X = process.env...`
    expect(src).not.toMatch(/^\s*(?:export\s+)?const\s+\w+\s*=\s*process\.env/m);
    expect(src).toMatch(/return parseFuseLiveFlag\(process\.env\[FUSE_LIVE_ENV\]\)/);
    // and it really does change answer when the env changes, within one process
    const prev = process.env[FUSE_LIVE_ENV];
    try {
      process.env[FUSE_LIVE_ENV] = "room_live_1";
      expect(isFuseLiveEnabled("room_live_1")).toBe(true);
      process.env[FUSE_LIVE_ENV] = "";
      expect(isFuseLiveEnabled("room_live_1")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env[FUSE_LIVE_ENV];
      else process.env[FUSE_LIVE_ENV] = prev;
    }
  });

  it("D1's hazard comment names EVERY call site — verified by grep, not by reading it", () => {
    const sites = execFileSync("git", ["grep", "-n", "isFuseLiveEnabled(", "--", "*.ts", ":!tests"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      // drop the definition itself and any prose mention
      .filter((l) => !l.includes("export function isFuseLiveEnabled"))
      .filter((l) => !/^\S+:\d+:\s*\*/.test(l));
    // Exactly three: the cue route, scheduleLiveFuse, runLiveFuse.
    expect(sites).toHaveLength(3);
    expect(sites.filter((l) => l.startsWith("app/api/brain/cues/route.ts"))).toHaveLength(1);
    expect(sites.filter((l) => l.startsWith("lib/brain/fuse/live.ts"))).toHaveLength(2);
    // and the comment says three
    expect(readFileSync("lib/brain/fuse/live-flag.ts", "utf8")).toContain("THREE call sites");
  });

  it("the cue route reaches the fuse from exactly ONE place, inside the flag check", () => {
    const src = readFileSync("app/api/brain/cues/route.ts", "utf8");
    expect(src.match(/scheduleLiveFuse\(/g) ?? []).toHaveLength(1);
    // the call sits inside the `if`, and the scratch guard is untouched
    expect(src).toMatch(/if \(isFuseLiveEnabled\(roomId\)\) \{\s*\n\s*const fused = await scheduleLiveFuse\(/);
    expect(src).toContain('if (day.scratch !== true) throw new HttpError(409, "not_a_scratch_day");');
  });
});

// =========================================================================================
// Part E — the cursor
// =========================================================================================
describe("E1 — the cue cursor is the ORDER BY key, so paging cannot skip or repeat", () => {
  it("round-trips", () => {
    const c = encodeCueCursor("2026-08-19T10:00:00.000Z", "cue_abc");
    expect(decodeCueCursor(c)).toEqual({ at: "2026-08-19T10:00:00.000Z", id: "cue_abc" });
  });

  it("rejects junk rather than silently meaning page one", () => {
    for (const bad of ["", "nonsense", "|cue_a", "2026-08-19T10:00:00.000Z|", "notadate|cue_a"]) {
      expect(decodeCueCursor(bad)).toBeNull();
    }
    expect(decodeCueCursor(null)).toBeNull();
  });

  it("the SQL compares the whole (at, id) tuple, not `at` alone", () => {
    const src = readFileSync("lib/brain/state.ts", "utf8");
    expect(src).toContain("(at, id) < ($6::timestamptz, $7::text)");
    expect(src).toContain("at < $5::timestamptz");
    // the cap is unchanged
    expect(src).toMatch(/export const CUES_MAX_LIMIT = 200;/);
  });
});

/** Drive the real reader through the real env, then put it back. */
function isFuseLiveEnabledWith(envValue: string, roomId: string): boolean {
  const prev = process.env[FUSE_LIVE_ENV];
  try {
    process.env[FUSE_LIVE_ENV] = envValue;
    return isFuseLiveEnabled(roomId);
  } finally {
    if (prev === undefined) delete process.env[FUSE_LIVE_ENV];
    else process.env[FUSE_LIVE_ENV] = prev;
  }
}
