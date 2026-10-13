/**
 * lib/alerts/ops-alert.ts — queue a room alert for a person (gating/opd4-guard, S3).
 *
 * THE PATH. The app on Vercel cannot post to the ETA bus or ubus; there is no client for either in this repo and no safe inbound door to the Mini. The existing
 * path is the outbox: a row in room_alert_outbox is pulled by the Mini relay through scribe_room_alerts (lib/room-alerts.ts) and posted. This module writes
 * that row and nothing else, so it adds no vendor and no secret. WHICH buses and WHICH recipients (gating-lead, fleet, ubus) is the relay's configuration on
 * the Mini and is not visible from here.
 *
 * CONTENT: room id, room slug, problem code, minutes. Ids and counts only; no name, no transcript, no patient text.
 * DEDUPE: one row per (kind, room, dedupe key) per hour, decided by the database in the same statement as the insert (NOT EXISTS), so two cron runs or two
 * app instances cannot both send. A retire's key is its install id, so two different installs retired in one hour are two messages.
 * NEVER THROWS: a retire or a poll must not fail because its alert could not be queued. A failure is logged by name and returned as false.
 */
import { sql } from "@/lib/db";

export const OPS_ALERT_KINDS = ["install_retired", "recorder_off", "mic_denied", "no_machine", "room_disabled"] as const;
export type OpsAlertKind = (typeof OPS_ALERT_KINDS)[number];

/** One problem sends one message per hour. */
export const OPS_ALERT_DEDUPE_MINUTES = 60;

export type OpsAlert = {
  kind: OpsAlertKind;
  room_id: string;
  room_slug: string;
  /** minutes the problem has stood, or the last-seen age for a retire; null when it has no duration */
  minutes: number | null;
  /** the install a retire is about; also its dedupe key */
  install_id?: string | null;
  /** retire only: manual | handover | forced */
  reason?: string | null;
};

const SAFE = /[^A-Za-z0-9_.:-]/g;
const clean = (v: string): string => v.replace(SAFE, "").slice(0, 80);

/** PURE — the row's text. Ids only. */
export function composeOpsAlert(a: OpsAlert): { subject: string; body: string; dedupe_key: string } {
  const slug = clean(a.room_slug) || clean(a.room_id);
  const mins = a.minutes === null || !Number.isFinite(a.minutes) ? null : Math.max(0, Math.round(a.minutes));
  const dedupeKey = a.kind === "install_retired" ? clean(a.install_id ?? "") || "unknown_install" : a.kind;
  const parts = [`room=${slug}`, `room_id=${clean(a.room_id)}`, `problem=${a.kind}`];
  if (a.install_id) parts.push(`install_id=${clean(a.install_id)}`);
  if (a.reason) parts.push(`reason=${clean(a.reason)}`);
  if (mins !== null) parts.push(a.kind === "install_retired" ? `last_seen_min_ago=${mins}` : `minutes=${mins}`);
  return { subject: `[ops] ${a.kind} ${slug}`, body: parts.join(" "), dedupe_key: dedupeKey };
}

/** Queue one alert. Returns true when a row was inserted, false when it was deduped or could not be written. */
export async function queueOpsAlert(a: OpsAlert): Promise<boolean> {
  const m = composeOpsAlert(a);
  try {
    const rows = (await sql`
      INSERT INTO room_alert_outbox (kind, room_ids, room_name, status_from, status_to, subject, body)
      SELECT ${a.kind}::text, ARRAY[${a.room_id}::text], ${clean(a.room_slug) || null}::text, NULL, ${m.dedupe_key}::text, ${m.subject}::text, ${m.body}::text
       WHERE NOT EXISTS (
         SELECT 1 FROM room_alert_outbox o
          WHERE o.kind = ${a.kind}::text
            AND o.room_ids = ARRAY[${a.room_id}::text]
            AND o.status_to = ${m.dedupe_key}::text
            AND o.created_at > now() - (${OPS_ALERT_DEDUPE_MINUTES}::int * INTERVAL '1 minute')
       )
      RETURNING id
    `) as Array<{ id: unknown }>;
    return rows.length > 0;
  } catch (e) {
    console.warn("[ops-alert] could not queue", JSON.stringify({ kind: a.kind, room_id: a.room_id, err: String((e as Error)?.message ?? e).slice(0, 160) }));
    return false;
  }
}
