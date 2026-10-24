/**
 * lib/spine/transcript-final.ts — SPINE S7a pure half: the `transcript_final` stage for a CONFIRMED encounter. No clock (pass `now`), no randomness, no I/O.
 *
 * What it decides: from the bench windows that cover [t_open, t_close] of an encounter's room-day (the reader has already dropped blind windows), is the final transcript READY (every covering
 * window has a terminal outcome: transcribed, silent or refused), must the job WAIT (some window is still pending: offer it to the EXISTING drain), or must it FAIL (waited past MAX_WAIT_MS)?
 * It then assembles the final transcript from the windows' stored ROUTE runs (order by window start; native + English when the run has both) and builds the event feed-orch reads.
 *
 * O4 / O5: room audio NEVER goes to Sarvam for production callers. Nothing here transcribes: the only engine is the route run the auto-drain already stores. An assembly that is handed a run of any other engine throws.
 * TEXT: the assembled text is never stored or logged here. The record is a REF (run ids + sha256 + char counts), as spine_artefact requires.
 */
import { createHash } from "node:crypto";
import { isSarvamEngine } from "@/lib/stt/o4-scope";
import { CLOSE_GRACE_MS, cutVersion, inputKey, TRANSCRIPT_FINAL_STAGE } from "./enqueue";

export const FINAL_ENGINE = "route";
export const FINAL_VERSION = "v1";
export const EVENT_KIND = "transcript_final_event";
export const SHADOW_KIND = "transcript_final_shadow";
export const PASS_KIND = "transcript_final";
/** A job still waiting this long after t_close + grace fails `windows_not_ready`. The auto-drain's own look-back is 6 h; the drain moves one window per room per 5 min tick, so 6 h clears a day's backlog of a few windows. */
export const MAX_WAIT_MS = 6 * 3_600_000;
/** Windows offered to the drain per executor pass (the drain is paced: one per tick per room). Never more than this, whatever is pending. */
export const MAX_OFFERS_PER_PASS = 2;
/** Jobs claimed per pass. */
export const CLAIM_LIMIT = 3;

export type WindowState = "open" | "closed" | "transcribing" | "transcribed" | "failed" | "silent" | string;
/** One covering window as the room reader returns it. Times are epoch ms (or null). */
export type CoveringWindow = {
  id: string; start_ms: number; end_ms: number; source_mic: string; state: WindowState;
  /** the stored ROUTE run for this window (engine = 'route', no error), if any */
  run_id: string | null; run_at_ms: number | null;
  closed_at_ms: number | null; refused_at_ms: number | null; refused_reason: string | null;
  /** a room_window job is queued or running for it */
  job_open: boolean;
};
export type Outcome = "transcribed" | "silent" | "refused" | "pending";

/** Reasons the drain gives that are a fact about the window itself and cannot change (mirrors lib/stt/auto-drain-backfill PERMANENT_STEPS). */
const PERMANENT_REASONS = new Set(["too_long", "no_room_day", "not_found"]);
const reasonBase = (r: string | null): string => (r ?? "").replace(/#\d{1,3}$/, "");

/** PURE — a window's outcome. `transcribed` needs the state AND a stored route run (a state without a run is pending: "we never looked" is not "we looked and found nothing"). */
export function outcomeOf(w: CoveringWindow): Outcome {
  if (w.state === "silent") return "silent";
  if (w.state === "failed") return "refused";
  if (w.state === "transcribed") return w.run_id ? "transcribed" : "pending";
  if (PERMANENT_REASONS.has(reasonBase(w.refused_reason))) return "refused";
  return "pending";
}

/** PURE — when two mics cut the same span, one window stands for it: `primary` if present, else the first mic by name. Output is ordered by window start. */
export function pickWindows(ws: readonly CoveringWindow[]): CoveringWindow[] {
  const by = new Map<string, CoveringWindow>();
  for (const w of ws) {
    const k = `${w.start_ms}|${w.end_ms}`;
    const held = by.get(k);
    const better = !held || (w.source_mic === "primary" && held.source_mic !== "primary") || (held.source_mic !== "primary" && w.source_mic !== "primary" && w.source_mic < held.source_mic);
    if (better) by.set(k, w);
  }
  return [...by.values()].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || (a.id < b.id ? -1 : 1));
}

export type Counts = { covering: number; transcribed: number; silent: number; refused: number; pending: number; blind_excluded: number };
export type Decision =
  | { kind: "ready"; counts: Counts; windows_ready_at: number; window_ids: string[]; run_ids: string[] }
  | { kind: "wait"; counts: Counts; offers: string[] }
  | { kind: "fail"; counts: Counts; reason: "windows_not_ready" | "no_covering_windows" };

/** PURE — the instant the executor may start: t_close + the close grace (the same D6 grace the enqueuer uses). */
export const eligibleAt = (tCloseMs: number): number => tCloseMs + CLOSE_GRACE_MS;

export function decide(a: {
  windows: readonly CoveringWindow[]; blindExcluded: number; now: number; tCloseMs: number;
  /** may the existing drain be asked (ROOM_AUTO_DRAIN_ENABLED on)? false => no offers, the job just waits */
  drainOn: boolean; cooldownMs: number; maxWaitMs?: number; offerCap?: number;
}): Decision {
  const picked = pickWindows(a.windows);
  const out = picked.map((w) => ({ w, o: outcomeOf(w) }));
  const n = (o: Outcome): number => out.filter((x) => x.o === o).length;
  const counts: Counts = { covering: picked.length, transcribed: n("transcribed"), silent: n("silent"), refused: n("refused"), pending: n("pending"), blind_excluded: a.blindExcluded };
  const deadline = eligibleAt(a.tCloseMs) + (a.maxWaitMs ?? MAX_WAIT_MS);
  if (picked.length === 0) return a.now >= deadline ? { kind: "fail", counts, reason: "no_covering_windows" } : { kind: "wait", counts, offers: [] };
  if (counts.pending === 0) {
    const ready = Math.min(a.now, Math.max(...out.map(({ w }) => w.run_at_ms ?? w.refused_at_ms ?? w.closed_at_ms ?? 0)));
    return { kind: "ready", counts, windows_ready_at: ready, window_ids: picked.map((w) => w.id), run_ids: out.filter((x) => x.o === "transcribed").map((x) => x.w.run_id as string) };
  }
  if (a.now >= deadline) return { kind: "fail", counts, reason: "windows_not_ready" };
  const offers = !a.drainOn ? [] : out
    .filter(({ w, o }) => o === "pending" && w.state === "closed" && !w.job_open && !(w.refused_at_ms !== null && a.now - w.refused_at_ms < a.cooldownMs))
    .slice(0, a.offerCap ?? MAX_OFFERS_PER_PASS).map(({ w }) => w.id);
  return { kind: "wait", counts, offers };
}

export type RunText = { run_id: string; window_id: string; engine: string; original: string | null; english: string | null };
export type Assembled = { native_chars: number; english_chars: number; sha256: string; run_ids: string[]; has_english: boolean };

/**
 * PURE — the final transcript's identity from the runs, in WINDOW order (`order` = the picked windows' run ids by start). The text itself is returned only as lengths and a sha256 over the canonical
 * [run_id, original, english] list, so a differing text is a differing sha. A run of a Sarvam (or any non-route) engine throws: O4.
 */
export function assemble(order: readonly string[], runs: readonly RunText[]): Assembled & { native: string; english: string | null } {
  const by = new Map(runs.map((r) => [r.run_id, r]));
  const parts: RunText[] = [];
  for (const id of order) {
    const r = by.get(id);
    if (!r) throw new Error("run_text_missing");
    if (r.engine !== FINAL_ENGINE || isSarvamEngine(r.engine)) throw new Error("o4_non_route_run");
    parts.push(r);
  }
  const native = parts.map((p) => (p.original ?? "").trim()).filter(Boolean).join("\n");
  const eng = parts.map((p) => (p.english ?? "").trim()).filter(Boolean);
  const english = eng.length ? eng.join("\n") : null;
  const sha256 = createHash("sha256").update(JSON.stringify(parts.map((p) => [p.run_id, p.original ?? "", p.english ?? ""]))).digest("hex");
  return { native, english, native_chars: native.length, english_chars: english?.length ?? 0, sha256, run_ids: parts.map((p) => p.run_id), has_english: english !== null };
}

const iso = (ms: number): string => new Date(ms).toISOString();

export type FinalEvent = {
  event: "encounter.transcript_final"; v: 1; mode: "shadow" | "live";
  encounter_id: string; cut_version: string; room_id: string | null; ist_date: string; engine: typeof FINAL_ENGINE;
  stamps: { t_close: string; enqueued_at: string; windows_ready_at: string; final_at: string };
  windows: Counts; window_ids: string[]; run_ids: string[];
  text: { native_chars: number; english_chars: number; sha256: string; ref: string };
};

/** The artefact ref: the text lives in the window runs; this names them. */
export const artefactRef = (runIds: readonly string[]): string => `transcription_run:${runIds.join(",")}`;

/** PURE — the event feed-orch reads. Ids, counts, stamps, a sha: no text. */
export function buildEvent(a: {
  mode: "shadow" | "live"; encounter_id: string; boundary_rev: number; room_id: string | null; ist_date: string;
  tCloseMs: number; enqueuedAtMs: number; now: number; ready: Extract<Decision, { kind: "ready" }>; text: Assembled;
}): FinalEvent {
  return {
    event: "encounter.transcript_final", v: 1, mode: a.mode, encounter_id: a.encounter_id, cut_version: cutVersion(a.boundary_rev), room_id: a.room_id, ist_date: a.ist_date, engine: FINAL_ENGINE,
    stamps: { t_close: iso(a.tCloseMs), enqueued_at: iso(a.enqueuedAtMs), windows_ready_at: iso(a.ready.windows_ready_at), final_at: iso(a.now) },
    windows: a.ready.counts, window_ids: a.ready.window_ids, run_ids: a.text.run_ids,
    text: { native_chars: a.text.native_chars, english_chars: a.text.english_chars, sha256: a.text.sha256, ref: artefactRef(a.text.run_ids) },
  };
}

/** The artefact row's identity: the stage config hash is the job's input_key, so a re-keyed stage is a new artefact. */
export const FINAL_CFG8 = (): string => inputKey(TRANSCRIPT_FINAL_STAGE);
