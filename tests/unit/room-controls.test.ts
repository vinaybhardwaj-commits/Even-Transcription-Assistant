/**
 * Room processing controls — the card, the switches, and the one button that stops everything.
 *
 * The screen this covers is held by an operator walking between clinic rooms on a live recording
 * day. Four rules matter more than the rest, and each is here because getting it wrong is worse
 * than not building the screen at all:
 *
 *   R4  THE INTERFACE NEVER SAYS DRAIN, FUSE, WINDOW OR SUBJECT. Those are our words.
 *   R6  GREEN MEANS WORKING. A lane switched on with nothing to do is GREY and says so — "on"
 *       glowing green over a room where nothing is happening is the display that let a
 *       nine-hour fault sit unnoticed on Friday night.
 *   R7  FRICTION ON THE DANGEROUS DIRECTION ONLY. Turning Visits on asks. Turning anything off
 *       never asks. Stopping must never take two taps in a clinic.
 *   R9  STOP ALL PROCESSING TOUCHES NO RECORDING, and its own copy says so.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { tapeLane, transcriptLane, visitsLane } from "@/lib/admin/rooms-live";
import { attentionItems } from "@/components/admin/BenchRoomsLive";

/**
 * Source with every comment removed.
 *
 * These rules are about what a person READS ON THE SCREEN, not about what the source explains to
 * the next engineer. A comment that says «never write "enables the live fuse"» must not fail the
 * test that forbids that copy — otherwise the only way to pass is to delete the reasoning, which
 * is exactly backwards.
 */
function rendered(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const NONE = { done: 0, waiting: 0, in_progress: 0, failed: 0, words_ms: 0 };
const NOW = Date.parse("2026-08-24T05:00:00.000Z");

describe("R6 — green means working", () => {
  it("on with nothing to do is GREY and says so", () => {
    expect(transcriptLane(true, NONE)).toEqual({ level: "off", state: "On, nothing to do", enabled: true });
    expect(visitsLane(true, { built: 0, open: 0 })).toEqual({ level: "off", state: "On, nothing to do", enabled: true });
  });

  it("off is grey and says Off", () => {
    expect(transcriptLane(false, NONE).state).toBe("Off");
    expect(visitsLane(false, { built: 0, open: 0 }).state).toBe("Off");
  });

  it("green only when the queue is empty and nothing failed", () => {
    const green = transcriptLane(true, { ...NONE, done: 11, in_progress: 1 });
    expect(green.level).toBe("ok");
    expect(green.state).toContain("up to date");
  });

  it("anything waiting or failed is amber, and never says up to date", () => {
    const waiting = transcriptLane(true, { ...NONE, done: 4, waiting: 6 });
    expect(waiting.level).toBe("amber");
    expect(waiting.state).not.toContain("up to date");
    const failed = transcriptLane(true, { ...NONE, done: 4, failed: 2 });
    expect(failed.level).toBe("amber");
    expect(failed.state).toContain("2 failed");
  });

  it("visits reports what it built, not that it is on", () => {
    expect(visitsLane(true, { built: 7, open: 1 })).toEqual({ level: "ok", state: "7 today · 1 open", enabled: true });
  });
});

describe("the Tape lane — R5, and the only red that means walk to the room", () => {
  const base = { recording: true, paused_session: false, stalled: false, stalled_age_ms: null, session_started_at: new Date(NOW - 3 * 3600_000).toISOString(), primary_chunks: 38, nowMs: NOW };

  it("recording shows duration and pieces, and carries NO switch", () => {
    const t = tapeLane(base);
    expect(t.level).toBe("ok");
    expect(t.state).toMatch(/^Recording · 3h 00m · 38 pieces$/);
    expect(t.enabled).toBeNull(); // R5 — no switch on Tape, ever
  });

  it("stalled is red and says the tape is silent", () => {
    const t = tapeLane({ ...base, stalled: true, stalled_age_ms: 18 * 60_000 });
    expect(t.level).toBe("red");
    expect(t.state).toContain("Says recording, silent");
  });

  it("paused outranks recording — consent was withdrawn", () => {
    expect(tapeLane({ ...base, paused_session: true }).level).toBe("amber");
  });

  it("not recording is grey", () => {
    expect(tapeLane({ ...base, recording: false }).state).toBe("Not recording");
  });
});

describe("R10 — the two emergencies read differently", () => {
  const room = (over: Record<string, unknown>) => ({
    room: { id: "room_a", slug: "s", name: "Cardiology OPD" },
    recording: true, paused_session: false, session_id: "bs_1", session_started_at: null,
    last_primary_at: null, last_backup_at: null, last_piece_at: null, mic_level: "ok",
    backup_chunks_today: 1, backup_reads_no_chunks: false, stalled: false, stalled_age_ms: null,
    transcript_enabled: true, visits_enabled: false,
    transcript_counts: NONE, visit_counts: { built: 0, open: 0 },
    lanes: { tape: tapeLane({ recording: true, paused_session: false, stalled: false, stalled_age_ms: null, session_started_at: null, primary_chunks: 0, nowMs: NOW }), transcript: transcriptLane(true, NONE), visits: visitsLane(false, { built: 0, open: 0 }) },
    ended_disagrees: false, ended_disagrees_session_id: null, ended_disagrees_ended_at: null,
    ended_disagrees_last_piece_at: null, ended_disagrees_chunks: 0,
    last_warehouse_at: null, doctor_clock_silent_ms: null, doctor_clock_level: "unknown",
    marks_today: 0, last_mark_at: null, marks_not_sent: 0,
    last_window_asked_at: null, last_window_complete: null, degraded: [],
    ...over,
  }) as never;

  it("processing behind says THE AUDIO IS SAFE, first", () => {
    const items = attentionItems([room({ transcript_counts: { ...NONE, done: 4, waiting: 6, failed: 2 } })], new Map(), true, NOW);
    const row = items.find((i) => i.title.includes("transcript behind"))!;
    expect(row).toBeTruthy();
    expect(row.severity).toBe("amber");
    expect(row.title).toContain("the audio is safe");
    expect(row.detail).toContain("Nothing is lost");
    // and it must NOT tell somebody to go and stand in the room
    expect(row.detail).not.toMatch(/go to the room/i);
  });

  it("the tape gone quiet says audio is BEING LOST and sends somebody there", () => {
    const items = attentionItems([room({ stalled: true, stalled_age_ms: 18 * 60_000 })], new Map(), true, NOW);
    const row = items.find((i) => i.title.includes("no audio arriving"))!;
    expect(row).toBeTruthy();
    expect(row.severity).toBe("red");
    expect(row.title).toContain("audio is being lost");
    expect(row.detail).toMatch(/go to the room/i);
  });

  it("a room with Transcript OFF and a backlog raises nothing — it was told to stop", () => {
    const items = attentionItems([room({ transcript_enabled: false, transcript_counts: { ...NONE, waiting: 6 } })], new Map(), true, NOW);
    expect(items.some((i) => i.title.includes("transcript behind"))).toBe(false);
  });
});

describe("R4 — the interface never uses our words", () => {
  const visible = rendered("components/admin/BenchRoomsLive.tsx");

  it.each(["drain", "fuse", "subject", "bench_window", "stt_window"])("never renders the word %s", (word) => {
    // allow it inside route paths and identifiers, forbid it as a rendered word
    const asCopy = new RegExp(`>[^<]*\\b${word}\\b|"[A-Z][^"]*\\b${word}\\b`, "i");
    expect(visible).not.toMatch(asCopy);
  });

  it("the three lane names are exactly Tape, Transcript, Visits", () => {
    expect(visible).toMatch(/name="Tape"/);
    expect(visible).toMatch(/name="Transcript"/);
    expect(visible).toMatch(/name="Visits"/);
  });
});

describe("R7 — friction on the dangerous direction only", () => {
  const ui = readFileSync("components/admin/BenchRoomsLive.tsx", "utf8");

  it("turning Visits ON opens the confirmation; turning it OFF calls setLane directly", () => {
    const toggle = /onToggle=\{\(\) => \{\s*const now = pending\[[\s\S]*?\}\}/.exec(ui)?.[0] ?? "";
    expect(toggle).toBeTruthy();
    expect(toggle).toMatch(/if \(now\) void setLane\(r\.room\.id, "visits", false\);/);
    expect(toggle).toMatch(/else setConfirmVisits/);
  });

  it("Transcript has no confirmation in either direction", () => {
    const t = /name="Transcript"[\s\S]*?name="Visits"/.exec(ui)?.[0] ?? "";
    expect(t).toBeTruthy();
    expect(t).toMatch(/void setLane\(r\.room\.id, "transcript"/);
    expect(t).not.toMatch(/setConfirm/);
  });

  it("the confirmation copy says what is kept, in plain words", () => {
    const copy = rendered("components/admin/BenchRoomsLive.tsx");
    expect(copy).toContain("build its own record of who was seen and when, and that record is kept");
    expect(copy).toContain("Anything already written stays");
    expect(copy).not.toMatch(/enables the live fuse/i);
  });
});

describe("R9 / S3 — stop all processing, and what its copy promises", () => {
  const ui = readFileSync("components/admin/BenchRoomsLive.tsx", "utf8");
  const route = readFileSync("app/api/admin/bench/processing/route.ts", "utf8");

  it("the button's own card states that recording continues and no audio is lost", () => {
    expect(ui).toContain("Recording carries on and no audio is lost");
  });

  it("the route's stop-all statement names no recording table and no room kill switch", () => {
    const stmt = /UPDATE room\s+SET transcript_enabled = FALSE, visits_enabled = FALSE[\s\S]*?RETURNING[^`]*/.exec(route)?.[0] ?? "";
    expect(stmt).toBeTruthy();
    expect(stmt).not.toMatch(/bench_session|bench_chunk|disabled_at|bench_command/);
    // one statement => one transaction (S1)
    expect(route.match(/UPDATE room\s+SET transcript_enabled = FALSE/g) ?? []).toHaveLength(1);
  });

  it("no STATEMENT in the route touches recording", () => {
    expect(rendered("app/api/admin/bench/processing/route.ts")).not.toMatch(/bench_session|bench_chunk|bench_command|disabled_at/);
  });
});

describe("R11 — no money figure anywhere on this screen", () => {
  const ui = readFileSync("components/admin/BenchRoomsLive.tsx", "utf8");
  const agg = readFileSync("lib/admin/rooms-live.ts", "utf8");

  it("the day summary carries minutes, and no currency is rendered", () => {
    expect(ui).toMatch(/fmtMinutes\(rollup\.day\.audio_recorded_ms\)/);
    expect(rendered("components/admin/BenchRoomsLive.tsx")).not.toMatch(/₹|\brupee|\busd\b|cost_usd|cost_inr/i);
  });

  it("the DaySummary type has no field that could carry one", () => {
    const t = /export type DaySummary = \{[\s\S]*?\};/.exec(agg)?.[0] ?? "";
    expect(t).toBeTruthy();
    expect(t).not.toMatch(/cost|price|usd|inr|rupee|spend/i);
  });
});

describe("U3 — the switch is a 44-point target", () => {
  const ui = readFileSync("components/admin/BenchRoomsLive.tsx", "utf8");
  it("the visual is the mockup's 52x30 inside a 44-tall tap target", () => {
    const sw = /function LaneSwitch\([\s\S]*?\n\}/.exec(ui)?.[0] ?? "";
    expect(sw).toBeTruthy();
    expect(sw).toMatch(/h-11/);        // 44pt tall
    expect(sw).toMatch(/min-w-11/);    // 44pt wide minimum
    expect(sw).toMatch(/w-\[52px\] h-\[30px\]/); // the drawn switch, per the approved mockup
    expect(sw).toMatch(/role="switch"/);
    expect(sw).toMatch(/aria-checked=\{on\}/);
  });
});

describe("every colour class this screen asks for actually exists", () => {
  /**
   * TAILWIND DROPS UNKNOWN CLASSES SILENTLY, which is why a missing shade looks like a design
   * choice rather than a bug. This screen has been bitten twice now: `border-warning-200
   * bg-warning-50` generated nothing for the room card's whole worst-condition signal, and then
   * `bg-danger-600` generated nothing for the STOP ALL PROCESSING button — white text on a pink
   * card, the most important control on the page nearly invisible, caught only by looking at a
   * screenshot. A comment in tailwind.config.ts warns about exactly this; the warning was not
   * enough, so here is the check.
   */
  const cfg = readFileSync("tailwind.config.ts", "utf8");
  const avail: Record<string, Set<string>> = {};
  for (const m of cfg.matchAll(/(\w[\w-]*):\s*\{([^}]*)\}/g)) {
    const shades = [...m[2]!.matchAll(/(\d+):/g)].map((x) => x[1]!);
    if (shades.length) (avail[m[1]!] ??= new Set()).add(...([] as string[])), shades.forEach((sh) => avail[m[1]!]!.add(sh));
  }
  for (const nested of ["blue", "ink", "navy", "pink"]) if (avail[nested]) avail[`even-${nested}`] = avail[nested]!;

  it.each([
    "components/admin/BenchRoomsLive.tsx",
    "components/room/RoomRecorderClient.tsx",
  ])("%s uses no shade the palette does not define", (file) => {
    const bad: string[] = [];
    for (const m of readFileSync(file, "utf8").matchAll(/\b(?:bg|text|border|ring|from|to)-([a-z]+(?:-[a-z]+)*)-(\d{2,3})\b/g)) {
      const pal = m[1]!, shade = m[2]!;
      if (avail[pal] && !avail[pal]!.has(shade)) bad.push(`${pal}-${shade}`);
    }
    expect([...new Set(bad)]).toEqual([]);
  });
});
