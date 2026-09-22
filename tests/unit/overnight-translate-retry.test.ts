/**
 * Overnight translate — THE CANARY RETRY, end to end (V's engineering ruling, 21 Sep 2026, RULINGS-21-SEP-1730).
 *
 * The REAL selector (makeStore) and the REAL driver (runOvernight) run over a small in-memory model of the two tables the retry reads:
 * which windows have a run with text and no English, and how many `done` translate jobs of this driver's actor each has. The fake `sql`
 * answers each statement the way the database would for the rule written in it, and the fake door "finishes" a job by adding one attempt.
 * So what is pinned is the wiring: the bound parameters, the attempt numbers, the order of the selection, and the stop.
 *
 * The scenario the ruling names: a check that keeps throwing stops a run after 5; the NEXT run re-picks those windows; a 4th unavailable
 * does not re-pick; and a parked window is counted, never called done.
 */
import { describe, it, expect } from "vitest";
import { runOvernight, CONSECUTIVE_FAILURE_LIMIT, ACTOR, type Deps } from "@/lib/overnight-translate/driver";
import { makeStore, RETRY_MAX_ATTEMPTS, type SqlTag } from "@/lib/overnight-translate/select";
import { IST_OFFSET_MS } from "@/lib/overnight-translate/hours";
import type { Door, StatusResult, SubmitResult } from "@/lib/overnight-translate/door";

const NIGHT = Date.UTC(2026, 8, 21, 22, 0, 0) - IST_OFFSET_MS;
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

type Win = { id: string; attempts: number; english: boolean; enteredAt: number };
type Model = { wins: Win[]; checkThrows: boolean; giveEnglish: boolean };

function world(n: number, over: Partial<Model> = {}): Model {
  return { wins: Array.from({ length: n }, (_, i) => ({ id: `W${i}`, attempts: 0, english: false, enteredAt: i })), checkThrows: false, giveEnglish: false, ...over };
}

/** The database, for the statements the selector sends. `undefined` = not mine. */
function sqlFor(m: Model): SqlTag {
  const row = (w: Win) => ({
    id: w.id, room_id: "room_1", room_day_id: "rd_a", start_ms: String(w.enteredAt * 1000), end_ms: String(w.enteredAt * 1000 + 900_000),
    transcript_enabled: true, run_id: `tr_${w.id}`, orig_len: 700, eng_len: w.english ? 700 : 0, metrics_json: null, hour_ist: 0, no_speakers: false, attempts: w.attempts,
  });
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = flat(strings.raw.join("?"));
    const skip = (values[values.length - 1] ?? []) as string[];
    if (text.includes("AS remaining")) return [{ remaining: 0, in_off_rooms: 0 }];
    if (text.includes("AS closed_hours")) return [{ closed_hours: 0, no_speakers: 0 }];
    if (text.includes("JOIN LATERAL") && !text.includes("LEFT JOIN LATERAL")) {
      // THE RETRY SCAN: has a run with text and no English, was run by this driver (attempts >= 1), not in this run's skip list, and
      // attempts < the bound unless the caller asked for parked ones too.
      expect(values).toContain(ACTOR);
      const includeParked = values.find((v) => typeof v === "boolean") as boolean;
      const bound = values.find((v) => typeof v === "number") as number;   // the attempts bound, as SENT (it precedes maxFailedJobs in the statement)
      return m.wins
        .filter((w) => w.attempts >= 1 && !w.english && !skip.includes(w.id) && (includeParked || w.attempts < bound))
        .map(row);
    }
    if (text.includes("LIMIT 1") && text.includes("NOT EXISTS (SELECT 1 FROM transcription_run t")) {
      // THE BACKLOG PICK: never transcribed = no attempt yet, and not tried this run.
      const w = m.wins.find((x) => x.attempts === 0 && !skip.includes(x.id));
      return w ? [{ id: w.id, room_id: "room_1", room_day_id: "rd_a", start_ms: "1", end_ms: "900001", transcript_enabled: true }] : [];
    }
    if (text.includes("ORDER BY created_at DESC LIMIT 1") && !text.includes("JOIN")) {
      // THE ENGLISH CHECK
      if (m.checkThrows) throw Object.assign(new Error("read failed postgres://user:pw@host/db"), { name: "NeonDbError" });
      const w = m.wins.find((x) => x.id === values[0]);
      return w ? [{ orig_len: 700, eng_len: w.english ? 700 : 0 }] : [];
    }
    return [];
  }) as SqlTag;
}

function night(m: Model, mode: "run" | "dry-run" = "run", limit = 0) {
  const clock = { t: NIGHT };
  const log: Array<Record<string, unknown>> = [];
  const submitted: Array<{ id: string; args: Record<string, unknown> }> = [];
  const jobWindow = new Map<string, string>();
  const finished = new Set<string>();
  const door: Door = {
    async submitRoomWindow(args): Promise<SubmitResult> {
      const job_id = `job_${submitted.length + 1}`;
      submitted.push({ id: args.window_id, args: args as unknown as Record<string, unknown> });
      jobWindow.set(job_id, args.window_id);
      return { ok: true, job_id };
    },
    async jobStatus(jobId): Promise<StatusResult> {
      // The job finishes: one more `done` attempt, and (only if the world says so) English appears.
      const w = m.wins.find((x) => x.id === jobWindow.get(jobId))!;
      if (!finished.has(jobId)) { finished.add(jobId); w.attempts += 1; if (m.giveEnglish) w.english = true; }
      return { ok: true, status: "done", step: "finish", error_code: null, attempts: 5, failures: 0, join_contended: false };
    },
  };
  const deps: Deps = {
    store: makeStore(sqlFor(m), { fixtureRoomDays: [], maxFailedJobs: 7, actor: ACTOR }),
    door, origin: "https://www.evenscribe.app",
    now: () => clock.t,
    sleep: async (ms, signal) => { if (!signal.aborted) clock.t += ms; },
    gate: () => ({ go: true, reason: "ok" }),
    log: (ev) => log.push(ev),
  };
  const run = () => runOvernight(deps, mode, limit, new AbortController().signal);
  return { run, log, submitted };
}
const ev = (log: Array<Record<string, unknown>>, name: string) => log.filter((e) => e.event === name);

describe("THE CANARY RETRY, end to end", () => {
  it("a check that keeps THROWING stops each run after 5; the NEXT run re-picks those windows; a 4th unavailable does not re-pick", async () => {
    const m = world(8, { checkThrows: true });
    const ids = (r: { submitted: Array<{ id: string }> }) => r.submitted.map((s) => s.id);
    const first5 = ["W0", "W1", "W2", "W3", "W4"];

    // Run 1: never-transcribed windows; every check throws; five unverified stop it.
    const r1 = night(m); const s1 = await r1.run();
    expect(s1).toMatchObject({ started: CONSECUTIVE_FAILURE_LIMIT, done: 0, unverified: CONSECUTIVE_FAILURE_LIMIT, fatal: "too_many_failures", stop: "fatal" });
    expect(ids(r1)).toEqual(first5);
    expect(ev(r1.log, "window_done"), "none was recorded done").toHaveLength(0);
    expect(ev(r1.log, "window_submitted").map((e) => [e.klass, e.attempt])).toEqual(first5.map(() => ["backlog", 1]));

    // Run 2: the same five come back FIRST, as retries, attempt 2 — not W5, W6, W7 — and it stops after 5 again.
    const r2 = night(m); const s2 = await r2.run();
    expect(ids(r2)).toEqual(first5);
    expect(ev(r2.log, "window_submitted").map((e) => [e.klass, e.attempt])).toEqual(first5.map(() => ["retry", 2]));
    expect(s2).toMatchObject({ started: 5, done: 0, unverified: 5, fatal: "too_many_failures" });
    expect(m.wins.slice(5).every((w) => w.attempts === 0), "W5-W7 untouched while retries were pending").toBe(true);

    // Run 3: attempt 3, the last one.
    const r3 = night(m); const s3 = await r3.run();
    expect(ids(r3)).toEqual(first5);
    expect(ev(r3.log, "window_submitted").map((e) => [e.klass, e.attempt])).toEqual(first5.map(() => ["retry", 3]));
    expect(s3).toMatchObject({ started: 5, done: 0, unverified: 5, fatal: "too_many_failures" });
    expect(m.wins.slice(0, 5).map((w) => w.attempts)).toEqual([3, 3, 3, 3, 3]);
    expect(RETRY_MAX_ATTEMPTS).toBe(3);

    // Run 4: they are PARKED. A dry run shows them counted (parked 5, nothing pending) and NOT in the plan.
    const dry = night(m, "dry-run", 20); await dry.run();
    expect(ev(dry.log, "night_start")[0]).toMatchObject({ parked: 5, retry_pending: 0 });
    expect(ev(dry.log, "plan").map((e) => e.window_id)).toEqual(["W5", "W6", "W7"]);
    expect(ev(dry.log, "plan").every((e) => e.klass === "backlog" && e.attempt === 1)).toBe(true);

    // ...and a real run with a working check does the rest, and never touches the parked five, and never calls them done.
    m.checkThrows = false; m.giveEnglish = true;
    const r4 = night(m); const s4 = await r4.run();
    expect(ids(r4)).toEqual(["W5", "W6", "W7"]);
    expect(s4).toMatchObject({ started: 3, done: 3, unverified: 0, fatal: null, stop: "backlog_empty" });
    expect(m.wins.slice(0, 5).map((w) => w.attempts), "no fourth attempt").toEqual([3, 3, 3, 3, 3]);
  });

  it("a window whose check merely failed to READ, but which DID get English, is not re-picked (the rule reads the run, not a memory of the failure)", async () => {
    const m = world(8, { checkThrows: true, giveEnglish: true });
    const r1 = night(m); await r1.run();
    expect(r1.submitted.map((s) => s.id)).toEqual(["W0", "W1", "W2", "W3", "W4"]);
    m.checkThrows = false;
    const r2 = night(m); const s2 = await r2.run();
    expect(r2.submitted.map((s) => s.id), "straight on to the never-transcribed windows").toEqual(["W5", "W6", "W7"]);
    expect(s2).toMatchObject({ done: 3, unverified: 0 });
  });

  it("a retried job is sent exactly like a first one: translate:true, the driver's actor, and no override for a Transcript-on room", async () => {
    const m = world(6, { checkThrows: true });
    await night(m).run();
    const r2 = night(m); await r2.run();
    expect(r2.submitted[0]!.args).toEqual({ window_id: "W0", origin: "https://www.evenscribe.app", actor: ACTOR, via: "mcp", translate: true });
  });

  it("the throwing arm never logs the error's message — only its name", async () => {
    const m = world(6, { checkThrows: true });
    const r = night(m); await r.run();
    expect(JSON.stringify(r.log)).not.toContain("postgres://");
    expect(ev(r.log, "english_check_unavailable")[0]).toMatchObject({ error_name: "NeonDbError", attempt: 1 });
  });
});
