/**
 * lib/spine/transcript-final-store.ts — SPINE S7a executor for the `transcript_final` stage, run SERVER-SIDE by the spine cron (the box runner is never handed this stage: config.SERVER_STAGES).
 *
 * Gate: spine_config `jobs` + `mode.transcript_final` + kill_switch through config.readModes / enqueue.effectiveModes (missing, malformed or killed = off => { skipped: "off" }, nothing read or written).
 *  - live:   claim queued transcript_final jobs (the ordinary queue, lease and breaker), and per job: re-read the encounter (must still be `confirmed`, same cut, not frozen, not a blind room-day), read the covering
 *            windows through lib/room-access/readers/spine-transcript, ask the EXISTING drain for windows not yet transcribed (offer; ROOM_AUTO_DRAIN_ENABLED must be on), requeue (`release`, a short next_attempt)
 *            until every covering window is terminal, then assemble from the stored ROUTE runs and record: one spine_artefact row (ref only, source_table transcription_run) AND one event (spine_tick kind
 *            `transcript_final_event`) in ONE statement, then report the job done. Past MAX_WAIT_MS the job fails `windows_not_ready` / `no_covering_windows`.
 *  - shadow: NOTHING is offered, claimed, leased or emitted. Shadow jobs (status `shadow`) are evaluated read-only; a job that WOULD emit writes one `transcript_final_shadow` tick (the same event shape, mode shadow) once.
 *  - each live pass also: reaps this stage's exhausted leases (the box claim route's reaper never sees a server stage run by the cron), REVIVES a job that failed windows_not_ready / no_covering_windows once its windows are all terminal
 *            and covering (bounded: a revived job is claimed and finishes, a window transition is needed to revive again), and sweeps recent events for a REVISION (`encounter.transcript_final_revised`: the latest route run set
 *            for the (encounter, cut) differs from the latest event's; append-only, a new tick, the artefact stays create-only).
 * One `transcript_final` tick per pass carries the counts. No text, name or phone is ever written or logged: ids, counts, stamps, a sha256.
 * O4: no paid or Sarvam call exists in this path; the only transcription is the existing drain (drainRoomWindow -> room_window job -> the route engine).
 */
import { sql } from "@/lib/db";
import { isBlindRoomDay } from "@/lib/rubrics/blind-room-days";
import { readMode, readModes, SERVER_STAGES } from "./config";
import { effectiveModes, TRANSCRIPT_FINAL_STAGE } from "./enqueue";
import { HORIZON_MS } from "./merge";
import { claimJobs, openBreakers, opsAlertNotifier, reapExhausted, reportJob, stubNotifier, type SpineJob } from "./jobs";
import { LEASE_MS } from "./retry";
import {
  assemble, buildEvent, CLAIM_LIMIT, decide, EVENT_KIND, FINAL_CFG8, FINAL_ENGINE, FINAL_VERSION, istDateOf, newBudget, PASS_KIND, REVISED_EVENT, rotate, SHADOW_KIND, SWEEP_LIMIT, takeOffers,
  type CoveringWindow, type Decision, type FinalEvent, type OfferBudget, type RunText,
} from "./transcript-final";
import { blindWindowsAny, markWindowOffered, readCoveringWindows, readRunTexts } from "@/lib/room-access/readers/spine-transcript";

export const OWNER = "spine-cron:transcript_final";
const SHADOW_LIMIT = 20;

export type Deps = {
  readWindows: (a: { room_id: string; t_open_ms: number; t_close_ms: number }) => Promise<{ windows: CoveringWindow[]; blind_excluded: number }>;
  readRuns: (ids: readonly string[]) => Promise<RunText[]>;
  /** ask the EXISTING drain for one window (enqueueSubject + drainRoomWindow). Returns the drain's step name. */
  offer: (windowId: string) => Promise<string>;
  drainOn: () => boolean;
  cooldownMs: number;
  rng: () => number;
};

type EncRow = { encounter_id: string; status: string; boundary_rev: number; flags: string[]; room_id: string | null; ist_date: string; t_open: number; t_close: number | null; enqueued_at: number };

export type TfCounts =
  | { skipped: "off" }
  | {
    mode: "shadow" | "live"; claimed: number; done: number; waiting: number; failed: number; offered: number; would_offer: number; would_emit: number; errors: number; breaker_open: boolean;
    /** held-out windows left out of the reads of this pass: a count, never an id, and never in an event */
    blind_excluded: number; reaped: number; revived: number; revised: number;
  };

const ENC_SQL = (jobId: number) => sql`
  SELECT e.encounter_id, e.status, e.boundary_rev, e.flags::text AS flags, e.room_id, e.ist_date::text AS ist_date, e.t_open, e.t_close, j.created_at AS enqueued_at, j.cut_version
    FROM spine_job j JOIN spine_encounter e ON e.encounter_id = j.encounter_id WHERE j.job_id = ${jobId}::bigint`;

const toMs = (v: unknown): number => Date.parse(String(v));
function toEnc(r: Record<string, unknown>): EncRow & { cut_version: string } {
  return {
    encounter_id: String(r.encounter_id), status: String(r.status), boundary_rev: Number(r.boundary_rev),
    flags: Array.isArray(r.flags) ? (r.flags as unknown[]).map(String) : String(r.flags ?? "").replace(/[{}]/g, "").split(",").filter(Boolean),
    room_id: r.room_id == null ? null : String(r.room_id), ist_date: String(r.ist_date), t_open: toMs(r.t_open), t_close: r.t_close == null ? null : toMs(r.t_close),
    enqueued_at: toMs(r.enqueued_at), cut_version: String(r.cut_version),
  };
}

/** Why this encounter may not get a final transcript for this job's cut, or null. A permanent reason: the job fails with it, no event. */
export function ineligible(e: EncRow & { cut_version: string }): string | null {
  if (e.status !== "confirmed") return "not_confirmed";
  if (e.cut_version !== `r${e.boundary_rev}`) return "stale_cut";
  if (e.flags.includes("frozen")) return "frozen";
  if (e.t_close === null || e.room_id === null) return "not_closed";
  if (isBlindRoomDay(e.ist_date, e.room_id) || isBlindRoomDay(istDateOf(e.t_open), e.room_id) || isBlindRoomDay(istDateOf(e.t_close), e.room_id)) return "blind_room_day";
  return null;
}

type Evaluated =
  | { kind: "ineligible"; reason: string; blind: number }
  | { kind: "wait"; decision: Extract<Decision, { kind: "wait" }>; room_id: string | null; blind: number }
  | { kind: "fail"; decision: Extract<Decision, { kind: "fail" }>; blind: number }
  | { kind: "ready"; event: FinalEvent; run_ids: string[]; sha256: string; empty: boolean; blind: number };

/** Read-only: the encounter's windows and the decision on them. (No offer, no write, no text.) */
async function assess(e: EncRow & { cut_version: string }, now: number, d: Deps): Promise<{ decision: Decision; blind: number } | { ineligible: string }> {
  const why = ineligible(e);
  if (why) return { ineligible: why };
  const { windows, blind_excluded } = await d.readWindows({ room_id: e.room_id as string, t_open_ms: e.t_open, t_close_ms: e.t_close as number });
  return { decision: decide({ windows, now, tOpenMs: e.t_open, tCloseMs: e.t_close as number, drainOn: d.drainOn(), cooldownMs: d.cooldownMs }), blind: blind_excluded };
}

/** Read-only: where is this job? */
async function evaluate(job: { job_id: number }, mode: "shadow" | "live", now: number, d: Deps): Promise<Evaluated> {
  const encs = await ENC_SQL(job.job_id);
  if (!encs[0]) return { kind: "ineligible", reason: "no_encounter", blind: 0 };
  const e = toEnc(encs[0] as Record<string, unknown>);
  const a = await assess(e, now, d);
  if ("ineligible" in a) return { kind: "ineligible", reason: a.ineligible, blind: 0 };
  const { decision, blind } = a;
  if (decision.kind === "wait") return { kind: "wait", decision, room_id: e.room_id, blind };
  if (decision.kind === "fail") return { kind: "fail", decision, blind };
  const runs = await d.readRuns(decision.run_ids);
  const text = assemble(decision.run_ids, runs);
  const event = buildEvent({ mode, encounter_id: e.encounter_id, boundary_rev: e.boundary_rev, room_id: e.room_id, ist_date: e.ist_date, tCloseMs: e.t_close as number, enqueuedAtMs: e.enqueued_at, now, ready: decision, text });
  return { kind: "ready", event, run_ids: text.run_ids, sha256: text.sha256, empty: decision.counts.transcribed === 0, blind };
}

/**
 * The artefact (ref only) and the event, ONE statement: both land or neither does. Idempotent: an event for (encounter, cut_version) is written once; the artefact is create-only on its key
 * (a rerun with a different sha does not overwrite: a changed text is a new cut_version, never an edit).
 */
export async function recordFinal(ev: FinalEvent, x: { run_ids: string[]; sha256: string; empty: boolean }): Promise<{ event: boolean; artefact: boolean }> {
  const rows = (await sql`
    WITH ev AS (
      INSERT INTO spine_tick (kind, counts)
      SELECT ${EVENT_KIND}::text, ${JSON.stringify(ev)}::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM spine_tick t WHERE t.kind = ${EVENT_KIND}::text AND t.counts->>'encounter_id' = ${ev.encounter_id}::text AND t.counts->>'cut_version' = ${ev.cut_version}::text AND t.counts->>'event' = ${ev.event}::text)
      RETURNING id
    ), art AS (
      INSERT INTO spine_artefact (encounter_id, stage, engine, version, cfg8, cut_version, store, bucket, object_key, sha256, status, source_table)
      VALUES (${ev.encounter_id}, ${TRANSCRIPT_FINAL_STAGE}, ${FINAL_ENGINE}, ${FINAL_VERSION}, ${FINAL_CFG8()}, ${ev.cut_version}, 'neon', NULL, ${ev.text.ref}, ${x.sha256}, ${x.empty ? "empty" : "ok"}, 'transcription_run')
      ON CONFLICT ON CONSTRAINT spine_artefact_key_uq DO NOTHING
      RETURNING id
    )
    SELECT (SELECT count(*) FROM ev)::int AS ev, (SELECT count(*) FROM art)::int AS art`) as Array<{ ev: number; art: number }>;
  return { event: Number(rows[0]?.ev) > 0, artefact: Number(rows[0]?.art) > 0 };
}

async function recordShadow(ev: FinalEvent): Promise<boolean> {
  const rows = (await sql`
    INSERT INTO spine_tick (kind, counts)
    SELECT ${SHADOW_KIND}::text, ${JSON.stringify(ev)}::jsonb
     WHERE NOT EXISTS (SELECT 1 FROM spine_tick t WHERE t.kind = ${SHADOW_KIND}::text AND t.counts->>'encounter_id' = ${ev.encounter_id}::text AND t.counts->>'cut_version' = ${ev.cut_version}::text)
    RETURNING id`) as Array<unknown>;
  return rows.length > 0;
}

/**
 * A REVISION: appended only while the latest event of (encounter, cut_version) — original or revised — carries exactly the sha it revises AND the new sha differs. Append-only (a new tick); a rerun, or a
 * second pass that sees the same runs, adds 0 rows. The artefact row stays create-only: the event is the record of the current text.
 */
export async function recordRevision(ev: FinalEvent): Promise<boolean> {
  if (ev.revises_sha256 === undefined || ev.event !== REVISED_EVENT) throw new Error("not_a_revision");
  const rows = (await sql`
    INSERT INTO spine_tick (kind, counts)
    SELECT ${EVENT_KIND}::text, ${JSON.stringify(ev)}::jsonb
     WHERE ${ev.text.sha256}::text <> ${ev.revises_sha256}::text
       AND (SELECT t.counts->'text'->>'sha256' FROM spine_tick t WHERE t.kind = ${EVENT_KIND}::text AND t.counts->>'encounter_id' = ${ev.encounter_id}::text AND t.counts->>'cut_version' = ${ev.cut_version}::text ORDER BY t.id DESC LIMIT 1) = ${ev.revises_sha256}::text
    RETURNING id`) as Array<unknown>;
  return rows.length > 0;
}

/** The default deps: the real room reads and the real drain (imported lazily so a unit test of the pure parts loads neither). */
export async function realDeps(origin: string): Promise<Deps> {
  const { drainRoomWindow } = await import("@/lib/stt/room-drain");
  const { enqueueSubject } = await import("@/lib/stt/fanout");
  const { SYSTEM_ACTOR } = await import("@/lib/stt/receipt");
  const { ROOM_AUTO_DRAIN_ENABLED_ENV, AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES } = await import("@/lib/stt/auto-drain");
  const { parseFlag } = await import("@/lib/flags");
  return {
    readWindows: readCoveringWindows, readRuns: readRunTexts,
    drainOn: () => { try { return parseFlag(ROOM_AUTO_DRAIN_ENABLED_ENV); } catch { return false; } },   // a malformed flag is off, never a guess
    cooldownMs: AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES * 60_000,
    rng: Math.random,
    // The same three steps the auto-drain makes for a window it offers (lib/stt/auto-drain.ts): the legacy queue row first, the drain, then the refusal mark that paces the next offer.
    offer: async (windowId) => {
      await enqueueSubject("bench_window", windowId, "asr");
      const out = await drainRoomWindow(windowId, origin, { actor: SYSTEM_ACTOR, via: "cron" });
      await markWindowOffered(windowId, out.step);
      return out.step;
    },
  };
}

export const REVIVED_KIND = "transcript_final_revived";
const REVIVABLE = ["windows_not_ready", "no_covering_windows"];

/** Failed windows_not_ready / no_covering_windows jobs of a still-current confirmed encounter, newest first (bounded to the spine horizon). */
async function revivable(now: number, d: Deps): Promise<number> {
  const rows = (await sql`
    SELECT j.job_id, j.encounter_id, j.cut_version, j.last_error_code FROM spine_job j JOIN spine_encounter e ON e.encounter_id = j.encounter_id
     WHERE j.stage = ${TRANSCRIPT_FINAL_STAGE}::text AND j.status = 'failed' AND j.last_error_code = ANY(${REVIVABLE}::text[])
       AND e.status = 'confirmed' AND j.cut_version = 'r' || e.boundary_rev::text AND NOT (e.flags @> ARRAY['frozen']::text[])
       AND j.done_at >= ${new Date(now - HORIZON_MS).toISOString()}::timestamptz
     ORDER BY j.job_id DESC LIMIT 100`) as Array<{ job_id: unknown; encounter_id: unknown; cut_version: unknown; last_error_code: unknown }>;
  let revived = 0;
  for (const r of rotate(rows, SWEEP_LIMIT, now)) {
    const encs = await ENC_SQL(Number(r.job_id));
    if (!encs[0]) continue;
    const a = await assess(toEnc(encs[0] as Record<string, unknown>), now, d);
    if ("ineligible" in a || a.decision.kind !== "ready") continue;
    // every covering window is terminal and the union covers the span: a NEW attempt (the same key, attempts reset), claimed by this very pass. It ends in `done`, so it cannot be revived again.
    // The failure stays visible: the same statement appends a `transcript_final_revived` tick naming the job and the error it had (ids and a code, no text).
    const up = (await sql`
      WITH u AS (
        UPDATE spine_job SET status = 'queued', attempts = 0, next_attempt_at = NULL, lease_owner = NULL, lease_until = NULL, last_error_class = NULL, last_error_code = NULL, done_at = NULL
         WHERE job_id = ${Number(r.job_id)}::bigint AND status = 'failed' AND last_error_code = ANY(${REVIVABLE}::text[]) RETURNING job_id
      ), t AS (
        INSERT INTO spine_tick (kind, counts)
        SELECT ${REVIVED_KIND}::text, jsonb_build_object('job_id', u.job_id, 'encounter_id', ${String(r.encounter_id)}::text, 'cut_version', ${String(r.cut_version)}::text, 'prior_error_code', ${String(r.last_error_code)}::text) FROM u
      )
      SELECT job_id FROM u`) as Array<unknown>;
    revived += up.length;
  }
  return revived;
}

/** The newest event per (encounter, cut) that is still the current cut of a confirmed, unfrozen encounter: the candidates for a revision. */
async function revisionCandidates(now: number): Promise<Array<{ e: EncRow & { cut_version: string }; last: FinalEvent }>> {
  const rows = (await sql`
    SELECT x.counts, e.encounter_id, e.status, e.boundary_rev, e.flags::text AS flags, e.room_id, e.ist_date::text AS ist_date, e.t_open, e.t_close
      FROM (SELECT DISTINCT ON (t.counts->>'encounter_id', t.counts->>'cut_version') t.id, t.counts
              FROM spine_tick t WHERE t.kind = ${EVENT_KIND}::text AND t.ticked_at >= ${new Date(now - HORIZON_MS).toISOString()}::timestamptz
             ORDER BY t.counts->>'encounter_id', t.counts->>'cut_version', t.id DESC) x
      JOIN spine_encounter e ON e.encounter_id = x.counts->>'encounter_id'
     WHERE e.status = 'confirmed' AND x.counts->>'cut_version' = 'r' || e.boundary_rev::text AND NOT (e.flags @> ARRAY['frozen']::text[])
     ORDER BY x.id DESC LIMIT 100`) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const last = (typeof r.counts === "string" ? JSON.parse(r.counts) : r.counts) as FinalEvent;
    return { e: toEnc({ ...r, enqueued_at: last.stamps.enqueued_at, cut_version: last.cut_version }), last };
  });
}

/** A revision: the latest route run set of the (encounter, cut) is not the one the latest event names. Cheap check first (the run ids come with the window read); the texts are read only when the set differs. */
async function sweepRevisions(now: number, d: Deps): Promise<number> {
  let revised = 0;
  for (const { e, last } of rotate(await revisionCandidates(now), SWEEP_LIMIT, now)) {
    // I2: a window of the last event that is held out NOW hides that event from the feed; a revision of it would name a hidden sha. Skip: no revision follows a hold-out change.
    const hidden = await blindWindowsAny(last.window_ids);
    if (last.window_ids.some((id) => hidden.has(id))) continue;
    const a = await assess(e, now, d);
    if ("ineligible" in a || a.decision.kind !== "ready") continue;
    const dec = a.decision;
    if (dec.run_ids.length === last.run_ids.length && dec.run_ids.every((id, i) => id === last.run_ids[i])) continue;
    const text = assemble(dec.run_ids, await d.readRuns(dec.run_ids));
    if (text.sha256 === last.text.sha256) continue;
    const ev = buildEvent({ mode: "live", encounter_id: e.encounter_id, boundary_rev: e.boundary_rev, room_id: e.room_id, ist_date: e.ist_date, tCloseMs: e.t_close as number, enqueuedAtMs: e.enqueued_at, now, ready: dec, text, revises: last.text.sha256 });
    if (await recordRevision(ev)) revised += 1;
  }
  return revised;
}

export async function runTranscriptFinal(now: number, origin: string, deps?: Deps): Promise<TfCounts> {
  const m = await readModes([TRANSCRIPT_FINAL_STAGE]);
  const mode = effectiveModes(m.jobs, m.stages)[TRANSCRIPT_FINAL_STAGE];
  if (m.jobs === "off" || (mode !== "shadow" && mode !== "live")) return { skipped: "off" };
  const d = deps ?? (await realDeps(origin));
  const c = { mode, claimed: 0, done: 0, waiting: 0, failed: 0, offered: 0, would_offer: 0, would_emit: 0, errors: 0, breaker_open: false, blind_excluded: 0, reaped: 0, revived: 0, revised: 0 };
  const at = new Date(now);
  const budget: OfferBudget = newBudget();   // ONE budget for the whole pass, shared by every job (and one window per room)

  if (mode === "shadow") {
    const rows = (await sql`
      SELECT j.job_id FROM spine_job j JOIN spine_encounter e ON e.encounter_id = j.encounter_id
       WHERE j.stage = ${TRANSCRIPT_FINAL_STAGE}::text AND j.status = 'shadow' AND e.status = 'confirmed' AND j.cut_version = 'r' || e.boundary_rev::text
         AND j.created_at >= ${new Date(now - HORIZON_MS).toISOString()}::timestamptz
         AND NOT EXISTS (SELECT 1 FROM spine_tick t WHERE t.kind = ${SHADOW_KIND}::text AND t.counts->>'encounter_id' = j.encounter_id AND t.counts->>'cut_version' = j.cut_version)
       ORDER BY j.job_id DESC LIMIT ${SHADOW_LIMIT}::int`) as Array<{ job_id: unknown }>;
    for (const r of rows) {
      c.claimed += 1;
      try {
        const ev = await evaluate({ job_id: Number(r.job_id) }, "shadow", now, d);
        c.blind_excluded += ev.blind;
        if (ev.kind === "ready") { if (await recordShadow(ev.event)) c.would_emit += 1; }
        else if (ev.kind === "wait") { c.waiting += 1; c.would_offer += takeOffers(budget, ev.room_id, ev.decision.offers).length; }
        else c.failed += 1;
      } catch (e) { c.errors += 1; console.error("spine transcript_final shadow failed", (e as { code?: string }).code ?? "unknown"); }
    }
  } else {
    try {
      // This stage is run by the cron, so the box claim route's reaper never sees a lease of it that ran out on its last attempt: reap it here (only this stage's).
      const notifier = (await readMode("dead_alert")) === "live" ? opsAlertNotifier : stubNotifier;
      c.reaped = await reapExhausted(at, notifier, SERVER_STAGES);
    } catch (e) { c.errors += 1; console.error("spine transcript_final reap failed", (e as { code?: string }).code ?? "unknown"); }
    if ((await openBreakers([TRANSCRIPT_FINAL_STAGE], at)).length > 0) c.breaker_open = true;
    else {
      try { c.revived = await revivable(now, d); } catch (e) { c.errors += 1; console.error("spine transcript_final revive failed", (e as { code?: string }).code ?? "unknown"); }
      const jobs: SpineJob[] = await claimJobs(OWNER, [TRANSCRIPT_FINAL_STAGE], CLAIM_LIMIT, at, LEASE_MS);
      for (const j of jobs) {
        c.claimed += 1;
        const report = (outcome: "done" | "release" | "permanent" | "transient", code?: string, noTick = false) =>
          reportJob({ job_id: j.job_id, owner: OWNER, outcome, error_code: code ?? null, now: at, rng: d.rng, noBreakerTick: noTick });
        try {
          const ev = await evaluate(j, "live", now, d);
          c.blind_excluded += ev.blind;
          if (ev.kind === "ineligible") { c.failed += 1; await report("permanent", ev.reason, true); }   // I1: data-driven, not an engine failure: no breaker tick
          else if (ev.kind === "fail") { c.failed += 1; await report("permanent", ev.decision.reason, true); }
          else if (ev.kind === "wait") {
            c.waiting += 1;
            for (const id of takeOffers(budget, ev.room_id, ev.decision.offers)) { await d.offer(id); c.offered += 1; }
            await report("release");
          } else {
            await recordFinal(ev.event, ev);
            c.done += 1;
            await report("done");
          }
        } catch (e) {
          c.errors += 1;
          console.error("spine transcript_final failed", (e as { code?: string }).code ?? "unknown");
          await report("transient", "exec_error").catch(() => undefined);
        }
      }
    }
    try { c.revised = await sweepRevisions(now, d); } catch (e) { c.errors += 1; console.error("spine transcript_final revision sweep failed", (e as { code?: string }).code ?? "unknown"); }
  }
  await sql`INSERT INTO spine_tick (kind, counts) VALUES (${PASS_KIND}::text, ${JSON.stringify(c)}::jsonb)`;
  return c;
}
