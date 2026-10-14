/**
 * src/lib/audit-ruling.ts — a governance ruling on a routed thread (Round 2 / F3).
 *
 * Order of work, and why:
 *
 *   1. Read the thread from CDMSS (label, doctor). Unknown reference -> 404, nothing written.
 *   2. Record ONE gov_interventions row, keyed by `${reference}|${action}|${thread version}` (unique
 *      index). The version is the thread's event count plus the time of its last event, so it moves
 *      whenever the thread does: a retry, a double click and a network replay of the SAME decision on
 *      the SAME thread state find that row and reuse its id (never a second row), while a thread that
 *      CDMSS later reopened gets a fresh row and can be ruled again. If the row is still unconfirmed
 *      when another attempt arrives, the row takes that attempt's actor and note, so EPI and CDMSS
 *      always hold the same attribution. This is EPI's system of record for the decision.
 *   3. POST /signal-action with gov_intervention_ref = that row's id, actor and note taken FROM the row.
 *      CDMSS treats a repeat of (ref, action, intervention id) as a 200 no-op, so step 3 is safe to
 *      repeat as often as step 2 is.
 *
 * An unconfirmed ruling is finished before a new one is started (N1). If CDMSS applied a ruling but the
 * reply was lost, the row is still pending; pressing again must not create a second ruling. So before
 * writing anything: (a) any pending row for the same thread + action is reused with ITS key, whatever the
 * thread's version is now; (b) the audit-signal read we already made is searched for that row's id, and if
 * CDMSS's event log has it, the row is marked synced and the press reports success without a second call
 * (if later events show the thread has moved on since, a fresh ruling follows as usual).
 *
 * Outcomes:
 *   200 (fresh or replayed)  success; the row is marked synced.
 *   409                      the thread moved or the transition is illegal. The row for this attempt is
 *                            removed (it never took effect), and the caller is told the CURRENT status
 *                            so the screen can refresh instead of showing a stale button.
 *   400 / 404                refused upstream; same clean-up, a plain message.
 *   anything else            CDMSS unreachable or erroring. The row STAYS pending, so pressing the
 *                            button again is a retry of the same decision, not a second one. The
 *                            nightly cron retries it too (retryPendingRulings), and until CDMSS
 *                            confirms it, screens show it as "Pending sync", never as a done ruling.
 *
 * Who may rule: super admin anywhere; a Site Medical Head only for a physician engaged at a hospital
 * they head (and never for a doctor not yet linked to a physician profile).
 *
 * The note is required: a ruling without a reason is not a ruling.
 */

import { sql } from "@/lib/db";
import { actionLabel, isSignalAction, toFindingRow, type FindingRow, type SignalAction } from "@/lib/audit-findings";
import { fetchAuditSignal, isAuditReference, postSignalAction, upstreamError } from "@/lib/cdmss-governance";
import { loadDoctorLookup } from "@/lib/audit-findings-server";
import { RETRY_BUDGET_MS, RETRY_CALL_TIMEOUT_MS } from "@/lib/response-sync";
import { canActOnPhysician, type StaffScope } from "@/lib/staff-live";

export const NOTE_MIN = 3;
export const NOTE_MAX = 2000;

export type RulingBody =
  | { ok: true; action: SignalAction; note: string }
  | { ok: false; message: string };

/** PURE. The request body of a ruling, or why it is refused. Extra keys are refused, not ignored. */
export function parseRulingBody(raw: unknown): RulingBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "body must be a JSON object" };
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "action" && k !== "note")) return { ok: false, message: "unexpected field in body" };
  if (!isSignalAction(o.action)) {
    return { ok: false, message: "action must be acknowledged_by_governance, privilege_action, dismissed or closed" };
  }
  const note = typeof o.note === "string" ? o.note.trim() : "";
  if (note.length < NOTE_MIN) return { ok: false, message: "A note is required: say why you are making this ruling." };
  return { ok: true, action: o.action, note: note.slice(0, NOTE_MAX) };
}

/**
 * PURE. A token that changes whenever the thread does: the number of events in its log and the time of
 * the last one. CDMSS only ever appends events (a re-route of a settled thread appends one), so a
 * thread that was ruled and then reopened has a different version from the one the first ruling saw.
 */
export function threadVersion(events: unknown, signal?: { routed_at?: unknown } | null): string {
  if (Array.isArray(events) && events.length > 0) {
    let last = 0;
    for (const e of events) {
      const at = (e as { at?: unknown } | null)?.at;
      const t = typeof at === "string" ? Date.parse(at) : NaN;
      if (Number.isFinite(t) && t > last) last = t;
    }
    return `${events.length}.${last}`;
  }
  const routed = typeof signal?.routed_at === "string" ? Date.parse(signal.routed_at) : NaN;
  return Number.isFinite(routed) ? `0.${routed}` : "0.0";
}

/** The idempotency key: one decision per thread + action + thread state. */
export function rulingKey(reference: string, action: string, version: string): string {
  return `${reference}|${action}|${version}`;
}

export interface RulingActor {
  profileId: string;
  email: string;
}

export type RulingResult =
  | { ok: true; replayed: boolean; status: string | null; intervention_id: string; row: FindingRow | null }
  | {
      ok: false;
      http: 400 | 403 | 404 | 409 | 502;
      error: "not_found" | "invalid" | "conflict" | "unavailable" | "out_of_scope";
      message: string;
      current_status?: string | null;
    };

interface InterventionRow {
  id: string;
  cdmss_sync_state: string | null;
  actor_email: string | null;
  ruling_note: string | null;
}

interface PendingLookup {
  id: string;
  idempotency_key: string | null;
}

/**
 * PURE. Where in the event log the ruling with this intervention id sits (-1 when it is not there).
 * CDMSS writes a 'ruled' or 'closed' event whose payload carries the action and gov_intervention_ref.
 */
export function appliedRulingIndex(events: unknown, action: string, interventionId: string): number {
  if (!Array.isArray(events)) return -1;
  return events.findIndex((e) => {
    const o = e as { event?: unknown; payload?: { action?: unknown; gov_intervention_ref?: unknown } | null } | null;
    return (
      (o?.event === "ruled" || o?.event === "closed") &&
      o?.payload?.action === action &&
      o?.payload?.gov_intervention_ref === interventionId
    );
  });
}

async function audit(
  actor: RulingActor,
  action: string,
  reference: string,
  after: Record<string, unknown>,
): Promise<void> {
  try {
    await sql`INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (${actor.profileId}::uuid, ${action}, 'audit_thread', ${reference}, ${JSON.stringify(after)}::jsonb)`;
  } catch {
    // The decision is already recorded in gov_interventions; a missing log row costs nothing else.
  }
}

async function currentStatusOf(reference: string): Promise<string | null> {
  const o = await fetchAuditSignal(reference);
  if (o.kind !== "http" || o.status !== 200) return null;
  const sig = (o.body as { signal?: { status?: unknown } } | null)?.signal;
  return typeof sig?.status === "string" ? sig.status : null;
}

export async function recordRuling(input: {
  reference: string;
  action: SignalAction;
  note: string;
  actor: RulingActor;
  /** Where the caller may act (from requireStaff). */
  scope: StaffScope;
}): Promise<RulingResult> {
  const { reference, action, note, actor, scope } = input;
  if (!isAuditReference(reference)) {
    return { ok: false, http: 400, error: "invalid", message: "That is not a thread reference." };
  }

  // 1. The thread, from CDMSS.
  const thread = await fetchAuditSignal(reference);
  if (thread.kind === "http" && thread.status === 404) {
    return { ok: false, http: 404, error: "not_found", message: "CDMSS does not know this thread." };
  }
  if (thread.kind !== "http" || thread.status !== 200) {
    return { ok: false, http: 502, error: "unavailable", message: "CDMSS did not answer. Nothing was recorded; try again." };
  }
  const lookup = await loadDoctorLookup();
  const before = toFindingRow((thread.body as { signal?: unknown } | null)?.signal, lookup);
  if (!before) {
    return { ok: false, http: 502, error: "unavailable", message: "CDMSS sent a thread this screen cannot read. Nothing was recorded." };
  }

  // Site scope: a Site Medical Head rules only for physicians at their own hospital(s).
  if (!(await canActOnPhysician(scope, before.physician_id))) {
    return {
      ok: false,
      http: 403,
      error: "out_of_scope",
      message: before.physician_id
        ? "This doctor is not engaged at a hospital you head, so you cannot rule on this thread."
        : "This doctor is not linked to a physician profile yet, so only a super admin can rule on this thread.",
    };
  }

  // 2. One decision row per thread + action. First, finish any unconfirmed ruling for this thread + action.
  const events = (thread.body as { events?: unknown } | null)?.events;
  let version = threadVersion(events, (thread.body as { signal?: { routed_at?: unknown } } | null)?.signal);
  let key = rulingKey(reference, action, version);
  const kindNote = `${actionLabel(action)}: ${note}`;
  try {
    const pending = (await sql`
      SELECT id::text AS id, idempotency_key
      FROM gov_interventions
      WHERE signal_key = ${reference} AND action = ${action} AND cdmss_sync_state = 'pending'
      ORDER BY created_at DESC LIMIT 1`) as unknown as PendingLookup[];
    const p = Array.isArray(pending) ? pending[0] : undefined;
    if (p?.idempotency_key) {
      const at = appliedRulingIndex(events, action, p.id);
      if (at >= 0) {
        // CDMSS applied it; only the answer was lost. Confirm the row.
        await sql`UPDATE gov_interventions SET cdmss_sync_state = 'synced', cdmss_sync_error = NULL, cdmss_sync_at = now() WHERE id = ${p.id}::uuid`;
        await audit(actor, "audit_ruling", reference, { action, intervention_id: p.id, recovered: true });
        if (at === (events as unknown[]).length - 1) {
          // Nothing happened to the thread since: this press IS that ruling. Report it, send nothing.
          return { ok: true, replayed: true, status: before.status, intervention_id: p.id, row: before };
        }
        // The thread moved on after that ruling (for example it was reopened): this press is a new one.
      } else {
        // Not applied (or not visible): retry the SAME decision under its own key.
        key = p.idempotency_key;
        version = "reused";
      }
    }
  } catch {
    // Could not look; fall through to the version-scoped key.
  }
  let row: InterventionRow | null = null;
  try {
    const inserted = (await sql`
      INSERT INTO gov_interventions
        (signal_key, signal_label, kind, note, physician_id, actor_email, action, idempotency_key,
         cdmss_sync_state, ruling_note, thread_version)
      VALUES
        (${reference}, ${before.finding_type}, 'other', ${kindNote}, ${before.physician_id}::uuid,
         ${actor.email}, ${action}, ${key}, 'pending', ${note}, ${version})
      ON CONFLICT (idempotency_key) DO UPDATE
        SET note = EXCLUDED.note, actor_email = EXCLUDED.actor_email, ruling_note = EXCLUDED.ruling_note,
            cdmss_sync_state = 'pending', cdmss_sync_error = NULL
        WHERE gov_interventions.cdmss_sync_state IS DISTINCT FROM 'synced'
      RETURNING id::text AS id, cdmss_sync_state, actor_email, ruling_note`) as unknown as InterventionRow[];
    row = inserted[0] ?? null;
    if (!row) {
      // Already confirmed by CDMSS for this very thread state: reuse it as it stands.
      const found = (await sql`
        SELECT id::text AS id, cdmss_sync_state, actor_email, ruling_note
        FROM gov_interventions WHERE idempotency_key = ${key} LIMIT 1`) as unknown as InterventionRow[];
      row = found[0] ?? null;
    }
  } catch {
    return { ok: false, http: 502, error: "unavailable", message: "The decision could not be recorded. Nothing was sent to CDMSS; try again." };
  }
  if (!row) {
    return { ok: false, http: 502, error: "unavailable", message: "The decision could not be recorded. Nothing was sent to CDMSS; try again." };
  }
  const interventionId = row.id;

  // 3. The CDMSS ruling: actor and note come from the row, so both systems hold the same attribution.
  const out = await postSignalAction({
    reference,
    action,
    note: row.ruling_note ?? note,
    actor: `gov:${row.actor_email ?? actor.email}`.slice(0, 64),
    govInterventionRef: interventionId,
  });

  if (out.kind === "http" && out.status === 200 && (out.body as { ok?: boolean } | null)?.ok !== false) {
    const body = (out.body ?? {}) as { replayed?: unknown; status?: unknown; signal?: unknown };
    const replayed = body.replayed === true;
    try {
      await sql`UPDATE gov_interventions SET cdmss_sync_state = 'synced', cdmss_sync_error = NULL WHERE id = ${interventionId}::uuid`;
    } catch {
      // The ruling is applied upstream; the next identical press re-marks it.
    }
    if (!replayed) await audit(actor, "audit_ruling", reference, { action, intervention_id: interventionId });
    return {
      ok: true,
      replayed,
      status: typeof body.status === "string" ? body.status : null,
      intervention_id: interventionId,
      row: toFindingRow(body.signal, lookup),
    };
  }

  if (out.kind === "http" && (out.status === 409 || out.status === 400 || out.status === 404)) {
    const text = upstreamError(out.body);
    // The attempt never took effect: remove its row (never a row CDMSS already confirmed).
    try {
      await sql`DELETE FROM gov_interventions WHERE id = ${interventionId}::uuid AND cdmss_sync_state IS DISTINCT FROM 'synced'`;
    } catch {
      // Left pending; the next press reuses it.
    }
    if (out.status === 409) {
      const current = await currentStatusOf(reference);
      await audit(actor, "audit_ruling_refused", reference, { action, status: 409, current_status: current, error: text });
      return {
        ok: false,
        http: 409,
        error: "conflict",
        message: "This thread has changed since you opened it, so the ruling was not applied. The current status is shown.",
        current_status: current,
      };
    }
    return {
      ok: false,
      http: out.status === 404 ? 404 : 400,
      error: out.status === 404 ? "not_found" : "invalid",
      message: text || "CDMSS refused the ruling.",
    };
  }

  // Transport failure, 401 (key), 5xx: unknown outcome. The row stays pending so a retry is the same decision.
  try {
    const why = out.kind === "http" ? `status ${out.status} ${upstreamError(out.body)}`.trim() : "transport";
    await sql`UPDATE gov_interventions SET cdmss_sync_error = ${why.slice(0, 300)} WHERE id = ${interventionId}::uuid`;
  } catch {
    // Best effort.
  }
  return {
    ok: false,
    http: 502,
    error: "unavailable",
    message: "The decision is saved here but CDMSS did not confirm it. Press the button again to retry; it will not be recorded twice.",
  };
}

// ───────────────────── rulings CDMSS has not confirmed ─────────────────────

export const MAX_RULING_ATTEMPTS = 8;
export const RULING_RETRY_BATCH = 20;

export interface PendingRuling {
  id: string;
  reference: string;
  action: string;
  actor_email: string | null;
  ruling_note: string | null;
  attempts: number;
  created_at: string | null;
  error: string | null;
}

/**
 * Rulings saved in EPI that CDMSS has not confirmed (cdmss_sync_state = 'pending'). Best effort: before
 * migrations 037/040 the columns do not exist and this returns an empty list.
 */
export async function loadPendingRulings(limit = 100): Promise<PendingRuling[]> {
  try {
    const rows = (await sql`
      SELECT id::text AS id, signal_key AS reference, action, actor_email, ruling_note,
             coalesce(cdmss_sync_attempts, 0)::int AS attempts, created_at::text AS created_at,
             cdmss_sync_error AS error
      FROM gov_interventions
      WHERE action IS NOT NULL AND cdmss_sync_state = 'pending'
      ORDER BY created_at ASC
      LIMIT ${limit}`) as unknown as PendingRuling[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** PURE. What a signal-action answer means for a ruling being retried. */
export function classifyRulingRetry(o: { kind: "transport" } | { kind: "http"; status: number; body: unknown }): "synced" | "refused" | "retry" {
  if (o.kind !== "http") return "retry";
  if (o.status === 200) return (o.body as { ok?: boolean } | null)?.ok === false ? "retry" : "synced";
  if (o.status === 409 || o.status === 400 || o.status === 404) return "refused";
  return "retry";
}

export interface RulingRetrySummary {
  attempted: number;
  synced: number;
  refused: number;
  failed: number;
  exhausted: number;
  stopped_reason?: "time_budget" | "query_failed";
}

/**
 * Nightly retry of rulings CDMSS did not confirm. The call is idempotent upstream (same intervention
 * id), so a ruling CDMSS had actually applied before the answer was lost comes back as a replay. A ruling
 * CDMSS now refuses (the thread moved on) is marked 'refused': kept for the record, hidden from lists.
 * Stops when the time budget is spent; a call never outlives what is left of it.
 */
export async function retryPendingRulings(
  opts: { limit?: number; deadline?: number; now?: () => number } = {},
): Promise<RulingRetrySummary> {
  const now = opts.now ?? Date.now;
  const deadline = opts.deadline ?? now() + RETRY_BUDGET_MS;
  const summary: RulingRetrySummary = { attempted: 0, synced: 0, refused: 0, failed: 0, exhausted: 0 };
  let pending: PendingRuling[];
  try {
    pending = await loadPendingRulings(opts.limit ?? RULING_RETRY_BATCH);
  } catch {
    return { ...summary, stopped_reason: "query_failed" };
  }
  for (const r of pending) {
    if (r.attempts >= MAX_RULING_ATTEMPTS || !r.ruling_note || !isSignalAction(r.action)) {
      summary.exhausted += 1;
      continue;
    }
    const left = deadline - now();
    if (left <= 0) {
      summary.stopped_reason = "time_budget";
      break;
    }
    summary.attempted += 1;
    const out = await postSignalAction({
      reference: r.reference,
      action: r.action,
      note: r.ruling_note,
      actor: `gov:${r.actor_email ?? "unknown"}`.slice(0, 64),
      govInterventionRef: r.id,
      timeoutMs: Math.min(RETRY_CALL_TIMEOUT_MS, left),
    });
    const verdict = classifyRulingRetry(out);
    try {
      if (verdict === "synced") {
        await sql`UPDATE gov_interventions
                  SET cdmss_sync_state = 'synced', cdmss_sync_error = NULL, cdmss_sync_at = now(),
                      cdmss_sync_attempts = coalesce(cdmss_sync_attempts, 0) + 1
                  WHERE id = ${r.id}::uuid`;
        summary.synced += 1;
      } else {
        const why = out.kind === "http" ? `status ${out.status} ${upstreamError(out.body)}`.trim() : "transport";
        await sql`UPDATE gov_interventions
                  SET cdmss_sync_state = ${verdict === "refused" ? "refused" : "pending"},
                      cdmss_sync_error = ${why.slice(0, 300)}, cdmss_sync_at = now(),
                      cdmss_sync_attempts = coalesce(cdmss_sync_attempts, 0) + 1
                  WHERE id = ${r.id}::uuid`;
        if (verdict === "refused") summary.refused += 1;
        else summary.failed += 1;
      }
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}
