/**
 * lib/diarize-nemotron/store.ts — the ONLY writer of diarize_nemotron_window, diarize_nemotron_claim and
 * diarize_nemotron_worker (migration 0140). Epic #23, ticket (b).
 *
 * Neon HTTP: every call is one statement, tagged template, every value bound — and CAST where it lands in a
 * select list, because Neon sends parameters untyped and Postgres cannot infer a type there. Concurrency is settled
 * INSIDE single statements, never by a read followed by a write:
 *
 *   CLAIM   one INSERT … ON CONFLICT DO UPDATE … WHERE the old lease has expired. Two workers racing for
 *           the same window: the second one's conflict finds a live lease, its WHERE fails, and the window
 *           is not returned to it. No row lock on bench_window is needed, so the STT path is never blocked.
 *   INGEST  INSERT … ON CONFLICT ON CONSTRAINT diarize_nemotron_window_once DO NOTHING. An identical
 *           re-post inserts nothing and is answered as a duplicate; a DIFFERENT payload for the same key is
 *           refused (409) and the stored row is never overwritten.
 *
 * ELIGIBILITY mirrors lib/stt/diarize-job.ts (closed or transcribed, grid-aligned, a room_day, a joined
 * clip). It does NOT wait for STT, and it never touches room_diarize_window: production diarization is
 * untouched by anything here.
 */
import { sql } from "@/lib/db";
import { teacherLabelsEnabled } from "@/lib/diarize-engine";
import { writeWindowLabel } from "@/lib/room-access/diarize-labels";
import { BLIND_ROOM_DAYS, isBlindRoomDay } from "@/lib/rubrics/blind-room-days";
import { MAX_ATTEMPTS, TERMINAL_ERROR_CODES, type Derived, type IngestBody } from "@/lib/diarize-nemotron/validate";

/** How long a claim is the worker's alone. PROVISIONAL (PRD §6.1); a dead worker's window is free again after it. */
export const LEASE_MINUTES = 15;
/** A signed clip URL outlives the lease, so a worker that claimed it can always still fetch it. */
export const CLIP_URL_SECONDS = 1800;

export type ClaimedWindow = {
  window_id: string;
  room_day_id: string;
  start_ms: number;
  end_ms: number;
  clip_r2_key: string;
  attempts: number;
};

/** The held-out set as the two parallel arrays the claim query unnests: [IST date], [room_id]. */
const BLIND_DAYS = BLIND_ROOM_DAYS.map(([d]) => d);
const BLIND_ROOMS = BLIND_ROOM_DAYS.map(([, r]) => r);

/**
 * Claim up to `limit` windows for `workerId`, NEWEST first (start_ms is epoch ms), so today's
 * audio never waits behind the backlog (Orchestrator ruling, 9 Oct 2026). A window is offered when it has no Nemotron
 * row at all (any revision), and either no claim, or an expired, unfinished claim with attempts left.
 */
export async function claimPending(workerId: string, limit: number): Promise<ClaimedWindow[]> {
  const rows = (await sql`
    WITH cand AS (
      SELECT w.id, w.room_day_id, w.start_ms, w.end_ms, w.clip_r2_key
        FROM bench_window w
        JOIN room_day rd ON rd.id = w.room_day_id
        LEFT JOIN diarize_nemotron_claim c ON c.window_id = w.id
       WHERE w.state IN ('closed', 'transcribed')
         AND w.grid_aligned = TRUE
         AND w.room_day_id IS NOT NULL
         AND w.clip_r2_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM diarize_nemotron_window n WHERE n.window_id = w.id)
         -- N1: a BLIND (held-out) room-day's windows are never offered (lib/rubrics/blind-room-days.ts)
         AND NOT EXISTS (SELECT 1 FROM unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b(d, r) WHERE b.d = rd.ist_date AND b.r = rd.room_id)
         AND (c.window_id IS NULL OR (c.done_at IS NULL AND c.lease_until < now() AND c.attempts < ${MAX_ATTEMPTS}))
       ORDER BY w.start_ms DESC
       LIMIT ${limit}
    ), claimed AS (
      INSERT INTO diarize_nemotron_claim AS c (window_id, worker_id, claimed_at, lease_until, attempts)
      SELECT id, ${workerId}::text, now(), now() + make_interval(mins => ${LEASE_MINUTES}::int), 1 FROM cand
      ON CONFLICT (window_id) DO UPDATE
         SET worker_id = EXCLUDED.worker_id, claimed_at = now(), lease_until = EXCLUDED.lease_until,
             attempts = c.attempts + 1
       WHERE c.done_at IS NULL AND c.lease_until < now() AND c.attempts < ${MAX_ATTEMPTS}
      RETURNING c.window_id, c.attempts
    )
    SELECT cand.id AS window_id, cand.room_day_id, cand.start_ms, cand.end_ms, cand.clip_r2_key, claimed.attempts
      FROM cand JOIN claimed ON claimed.window_id = cand.id
     ORDER BY cand.start_ms DESC
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    window_id: String(r.window_id),
    room_day_id: String(r.room_day_id),
    start_ms: Number(r.start_ms),
    end_ms: Number(r.end_ms),
    clip_r2_key: String(r.clip_r2_key),
    attempts: Number(r.attempts),
  }));
}

/**
 * LAB LANE GUARD: would claimPending offer ANY window right now? The same eligibility as claimPending's candidate query (kept beside it so the two
 * cannot drift; tests/unit/nemotron-lab-pg.test.ts seeds both and compares). The lab claim route answers "production_pending" while this is true.
 */
export async function productionPendingExists(): Promise<boolean> {
  const rows = (await sql`
    SELECT EXISTS (
      SELECT 1
        FROM bench_window w
        JOIN room_day rd ON rd.id = w.room_day_id
        LEFT JOIN diarize_nemotron_claim c ON c.window_id = w.id
       WHERE w.state IN ('closed', 'transcribed')
         AND w.grid_aligned = TRUE
         AND w.room_day_id IS NOT NULL
         AND w.clip_r2_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM diarize_nemotron_window n WHERE n.window_id = w.id)
         AND NOT EXISTS (SELECT 1 FROM unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b(d, r) WHERE b.d = rd.ist_date AND b.r = rd.room_id)
         AND (c.window_id IS NULL OR (c.done_at IS NULL AND c.lease_until < now() AND c.attempts < ${MAX_ATTEMPTS}))
    ) AS pending
  `) as Array<{ pending: boolean }>;
  return rows[0]?.pending === true;
}

/**
 * Give back a claim this worker took but was never handed (the clip URL could not be signed): the attempt is
 * refunded and the lease released. A first claim is deleted (attempts cannot go below 1); a later one steps back.
 * Only a live, unfinished lease held by `workerId` is touched.
 */
export async function releaseClaim(workerId: string, windowId: string): Promise<void> {
  await sql`
    DELETE FROM diarize_nemotron_claim
     WHERE window_id = ${windowId} AND worker_id = ${workerId} AND done_at IS NULL AND lease_until > now() AND attempts = 1
  `;
  await sql`
    UPDATE diarize_nemotron_claim SET attempts = attempts - 1, lease_until = now()
     WHERE window_id = ${windowId} AND worker_id = ${workerId} AND done_at IS NULL AND lease_until > now() AND attempts > 1
  `;
}

/** Windows whose claims used every attempt without a stored row. Reported on every /pending answer so a stuck window is never silent. */
export async function countExhausted(): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS n FROM diarize_nemotron_claim c
     WHERE c.done_at IS NULL AND c.attempts >= ${MAX_ATTEMPTS} AND c.lease_until < now()
       AND NOT EXISTS (SELECT 1 FROM diarize_nemotron_window n WHERE n.window_id = c.window_id)
  `) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

export type IngestOutcome =
  | { result: "stored"; id: number; label: "written" | "skipped" | "failed" }
  | { result: "duplicate" }
  | { result: "conflict" }
  | { result: "unknown_window" }
  | { result: "room_day_mismatch" }
  | { result: "failure_recorded"; attempts: number }
  | { result: "no_live_claim" }
  | { result: "blind_room_day" };

/** N1: is this window's OWN room-day (not the posted room_day_id) in the held-out set? */
async function windowIsBlind(windowId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT rd.ist_date::text AS ist_date, rd.room_id FROM bench_window w JOIN room_day rd ON rd.id = w.room_day_id
     WHERE w.id = ${windowId} LIMIT 1
  `) as Array<{ ist_date: string; room_id: string }>;
  return rows[0] ? isBlindRoomDay(rows[0].ist_date, rows[0].room_id) : false;
}

/** INSERT the row for a validated body. Returns the new id, or null when the key already had a row. */
async function insertRow(b: IngestBody, d: Derived, payloadSha: string): Promise<number | null> {
  const rows = (await sql`
    INSERT INTO diarize_nemotron_window
      (window_id, room_day_id, engine, model, model_rev, config, config_hash, worker_id, machine, audio_ms,
       clip_sha256, turns_json, speaker_count, turn_count, speech_ms, overlap_ms, payload_sha256, status, error_code, probs_r2_key)
    SELECT w.id, w.room_day_id, ${b.engine}::text, ${b.model}::text, ${b.model_rev}::text, ${JSON.stringify(b.config)}::jsonb,
           ${b.config_hash}::text, ${b.worker_id}::text, ${b.machine}::text, ${b.audio_ms}::int, ${b.clip_sha256}::text,
           ${JSON.stringify(b.turns)}::jsonb, ${d.speaker_count}::int, ${d.turn_count}::int, ${d.speech_ms}::int, ${d.overlap_ms}::int,
           ${payloadSha}::text, ${b.status}::text, ${b.error_code}::text, ${b.probs_r2_key ?? null}::text
      FROM bench_window w
     WHERE w.id = ${b.window_id} AND w.room_day_id = ${b.room_day_id}
    ON CONFLICT ON CONSTRAINT diarize_nemotron_window_once DO NOTHING
    RETURNING id
  `) as Array<{ id: number | string }>;
  return rows[0] ? Number(rows[0].id) : null;
}

/** Why an insert returned nothing: an existing row (same or different payload), or no such window. */
async function explainNoInsert(b: IngestBody, payloadSha: string): Promise<IngestOutcome> {
  const existing = (await sql`
    SELECT payload_sha256 FROM diarize_nemotron_window
     WHERE window_id = ${b.window_id} AND engine = ${b.engine} AND model_rev = ${b.model_rev} AND config_hash = ${b.config_hash}
     LIMIT 1
  `) as Array<{ payload_sha256: string }>;
  if (existing[0]) return existing[0].payload_sha256 === payloadSha ? { result: "duplicate" } : { result: "conflict" };
  const w = (await sql`SELECT room_day_id FROM bench_window WHERE id = ${b.window_id} LIMIT 1`) as Array<{ room_day_id: string | null }>;
  return w[0] ? { result: "room_day_mismatch" } : { result: "unknown_window" };
}

/** Set the probability pointer on the row this body's key names, only where it is still NULL. */
async function attachProbsKey(b: IngestBody): Promise<void> {
  await sql`
    UPDATE diarize_nemotron_window SET probs_r2_key = ${b.probs_r2_key ?? null}::text
     WHERE window_id = ${b.window_id} AND engine = ${b.engine} AND model_rev = ${b.model_rev} AND config_hash = ${b.config_hash} AND probs_r2_key IS NULL
  `;
}

/** Close the claim once a row is stored. Harmless when there is no claim (a parity backfill posts unclaimed). */
async function finishClaim(windowId: string): Promise<void> {
  await sql`
    UPDATE diarize_nemotron_claim SET done_at = now(), lease_until = now()
     WHERE window_id = ${windowId} AND done_at IS NULL
  `;
}

/**
 * A teacher label for a stored `ok` row, when DIARIZE_TEACHER_LABELS is on. Never fails the ingest
 * (lib/diarize-labels.ts: labelling failing must never fail a window). run_id is the (revision, config)
 * pair, so a re-post can never double-count.
 */
async function maybeLabel(b: IngestBody): Promise<"written" | "skipped" | "failed"> {
  if (b.status !== "ok") return "skipped";
  let on: boolean;
  try {
    on = teacherLabelsEnabled();
  } catch {
    return "failed";
  }
  if (!on) return "skipped";
  try {
    await writeWindowLabel({
      windowId: b.window_id,
      roomDayId: b.room_day_id,
      engine: "nemotron",
      model: b.model,
      providerJobId: null,
      runId: `${b.model_rev}:${b.config_hash}`,
      segments: b.turns.map(([s, e, l]) => ({ start_ms: s, end_ms: e, speaker_idx: Number(l.slice(3)) })),
      speakerCount: new Set(b.turns.map((t) => t[2])).size,
      audioSeconds: b.audio_ms / 1000,
    });
    return "written";
  } catch (e) {
    console.warn("[nemotron] teacher label write failed:", e instanceof Error ? e.name : "error");
    return "failed";
  }
}

/** Store a result row (ok, empty, or a TERMINAL failure) and close the claim. */
async function storeRow(b: IngestBody, d: Derived, payloadSha: string): Promise<IngestOutcome> {
  const id = await insertRow(b, d, payloadSha);
  if (id === null) {
    const why = await explainNoInsert(b, payloadSha);
    // a row already holds the key (same or different payload): the window is done, never re-offered
    if (why.result === "duplicate" || why.result === "conflict") await finishClaim(b.window_id);
    // a re-post that now carries the probability pointer the first post lacked (an upload that failed once) adds it; it never replaces one
    if (why.result === "duplicate" && b.probs_r2_key) await attachProbsKey(b);
    return why;
  }
  await finishClaim(b.window_id);
  return { result: "stored", id, label: await maybeLabel(b) };
}

/**
 * The ingest decision for a validated body.
 *
 *   ok / empty                 → stored (idempotent on the key; 409 on a different payload).
 *   failed, terminal code      → stored as the window's `failed` row; no further attempts.
 *   failed, attempts left      → recorded on the claim (failure_history) and the lease released, so the
 *                                window is offered again; no window row, so a later success can still land.
 *   failed, last attempt       → stored as the window's `failed` row.
 *   failed, no live claim held by this worker → nothing changes (a replayed failure is not a second attempt).
 *   any status, the window's room-day is BLIND → blind_room_day, nothing written.
 */
export async function recordIngest(b: IngestBody, d: Derived, payloadSha: string): Promise<IngestOutcome> {
  // N1: a blind room-day's window is refused before anything is written, whatever the status
  if (await windowIsBlind(b.window_id)) return { result: "blind_room_day" };
  if (b.status !== "failed") return storeRow(b, d, payloadSha);

  const code = b.error_code!;
  // A final failure (terminal code, or the last attempt) keeps the lease until storeRow decides: if that insert is
  // refused (a room-day mismatch), the claim is not left released-but-unfinished for another worker to burn an attempt on.
  const terminal = TERMINAL_ERROR_CODES.has(code);
  const claim = (await sql`
    UPDATE diarize_nemotron_claim
       SET lease_until = CASE WHEN ${terminal}::boolean OR attempts >= ${MAX_ATTEMPTS}::int THEN lease_until ELSE now() END,
           last_error_code = ${code},
           failure_history = failure_history || jsonb_build_array(jsonb_build_object('at', now(), 'worker_id', ${b.worker_id}::text, 'error_code', ${code}::text))
     WHERE window_id = ${b.window_id} AND worker_id = ${b.worker_id} AND done_at IS NULL AND lease_until > now()
    RETURNING attempts
  `) as Array<{ attempts: number }>;
  if (!claim[0]) return { result: "no_live_claim" };
  const attempts = Number(claim[0].attempts);
  if (terminal || attempts >= MAX_ATTEMPTS) return storeRow(b, d, payloadSha);
  return { result: "failure_recorded", attempts };
}

/** Upsert the worker's last heartbeat. */
export async function recordHeartbeat(workerId: string, payload: Record<string, unknown>): Promise<void> {
  await sql`
    INSERT INTO diarize_nemotron_worker (worker_id, last_seen_at, payload)
    VALUES (${workerId}, now(), ${JSON.stringify(payload)}::jsonb)
    ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = now(), payload = EXCLUDED.payload
  `;
}

export type NemotronResult = {
  window_id: string;
  room_day_id: string;
  status: "ok" | "empty";
  model: string;
  model_rev: string;
  config_hash: string;
  machine: string;
  audio_ms: number;
  turns: Array<[number, number, string]>;
};

/**
 * The window's newest stored Nemotron answer that has something to say (`ok` or `empty`; a `failed` row is
 * not an answer). The diarize_window job reads this; it is the only thing the job needs from the shadow store.
 */
export async function loadNemotronResult(windowId: string): Promise<NemotronResult | null> {
  const rows = (await sql`
    SELECT window_id, room_day_id, status, model, model_rev, config_hash, machine, audio_ms, turns_json
      FROM diarize_nemotron_window
     WHERE window_id = ${windowId}::text AND status IN ('ok', 'empty')
     ORDER BY received_at DESC, id DESC
     LIMIT 1
  `) as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  const turns = Array.isArray(r.turns_json) ? (r.turns_json as Array<[number, number, string]>) : [];
  return {
    window_id: String(r.window_id),
    room_day_id: String(r.room_day_id),
    status: r.status === "empty" ? "empty" : "ok",
    model: String(r.model),
    model_rev: String(r.model_rev),
    config_hash: String(r.config_hash),
    machine: String(r.machine),
    audio_ms: Number(r.audio_ms),
    turns,
  };
}

/** The room diarize row's state, and which engine wrote it (timing_json.engine.name; null for a row that predates provenance), or null when there is no row. */
export async function roomDiarizeRow(windowId: string): Promise<{ state: string; engine: string | null } | null> {
  const rows = (await sql`
    SELECT state, timing_json->'engine'->>'name' AS engine FROM room_diarize_window WHERE window_id = ${windowId}::text LIMIT 1
  `) as Array<{ state: string; engine: string | null }>;
  return rows[0] ? { state: rows[0].state, engine: rows[0].engine } : null;
}

/**
 * Does this window still need its diarize job? Yes when Nemotron has answered (`ok` / `empty`) and the room
 * diarize row is absent or `failed` (recordDiarizeWindow replaces a failed row). An `ok` / `no_speakers` row —
 * a row written by another engine (pyannote era) or by this one — means NO: nothing queues it again (D4).
 */
export async function windowNeedsDiarizeJob(windowId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT EXISTS (SELECT 1 FROM diarize_nemotron_window n WHERE n.window_id = ${windowId}::text AND n.status IN ('ok', 'empty')) AS answered,
           (SELECT d.state FROM room_diarize_window d WHERE d.window_id = ${windowId}::text) AS state
  `) as Array<{ answered: boolean; state: string | null }>;
  const r = rows[0];
  return !!r && r.answered === true && (r.state === null || r.state === "failed");
}

/** The most failed `diarize_window` jobs one window may have had before the sweeper stops re-driving it. */
export const SWEEP_MAX_FAILED_JOBS = 3;
/** Windows the sweeper submits per tick. */
export const SWEEP_LIMIT = 20;

/**
 * R2-2 / R3 — the windows the sweeper should re-drive: Nemotron has answered (`ok` / `empty`), the room diarize row is absent
 * or `failed`, the window is not held out, no `diarize_window` job is queued or running for it, and fewer than SWEEP_MAX_FAILED_JOBS
 * of its jobs have FAILED (the job's own failure count, not room_diarize_window.attempts: a window whose job dies before it writes a
 * row has no attempts to count). Oldest window first.
 *
 * COST (R3). The candidates are MATERIALISED first; scribe_job is then read ONCE, grouped by window, over only the rows that can matter
 * (status failed / queued / running — scribe_job_status_created_idx) and LEFT JOINed. The first version ran a correlated count(*) over
 * scribe_job per candidate window: ~350 s per tick at 30k windows / 600k jobs. No migration.
 */
export async function windowsToSweep(limit: number, blind: string[]): Promise<string[]> {
  const rows = (await sql`
    WITH cand AS MATERIALIZED (
      SELECT w.id, w.start_ms
        FROM bench_window w
       WHERE EXISTS (SELECT 1 FROM diarize_nemotron_window n WHERE n.window_id = w.id AND n.status IN ('ok', 'empty'))
         AND NOT EXISTS (SELECT 1 FROM room_diarize_window d WHERE d.window_id = w.id AND d.state <> 'failed')
         AND w.id <> ALL(${blind}::text[])
    ), jobs AS (
      SELECT j.args->>'window_id' AS window_id,
             count(*) FILTER (WHERE j.status = 'failed') AS failed,
             bool_or(j.status IN ('queued', 'running')) AS open
        FROM scribe_job j
       WHERE j.kind = 'diarize_window' AND j.status IN ('failed', 'queued', 'running')
       GROUP BY 1
    )
    SELECT c.id AS window_id
      FROM cand c LEFT JOIN jobs j ON j.window_id = c.id
     WHERE COALESCE(j.open, false) = false AND COALESCE(j.failed, 0) < ${SWEEP_MAX_FAILED_JOBS}::int
     ORDER BY c.start_ms ASC
     LIMIT ${limit}::int
  `) as Array<{ window_id: string }>;
  return rows.map((r) => r.window_id);
}

/** Windows the sweeper has given up on: answered, no ok row, not held out, and SWEEP_MAX_FAILED_JOBS failed jobs. Counted on every tick so a stuck window is never silent. Same shape as windowsToSweep. */
export async function countSweepExhausted(blind: string[]): Promise<number> {
  const rows = (await sql`
    WITH cand AS MATERIALIZED (
      SELECT w.id
        FROM bench_window w
       WHERE EXISTS (SELECT 1 FROM diarize_nemotron_window n WHERE n.window_id = w.id AND n.status IN ('ok', 'empty'))
         AND NOT EXISTS (SELECT 1 FROM room_diarize_window d WHERE d.window_id = w.id AND d.state <> 'failed')
         AND w.id <> ALL(${blind}::text[])
    ), jobs AS (
      SELECT j.args->>'window_id' AS window_id, count(*) AS failed
        FROM scribe_job j
       WHERE j.kind = 'diarize_window' AND j.status = 'failed'
       GROUP BY 1
    )
    SELECT count(*)::int AS n
      FROM cand c JOIN jobs j ON j.window_id = c.id
     WHERE j.failed >= ${SWEEP_MAX_FAILED_JOBS}::int
  `) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}
