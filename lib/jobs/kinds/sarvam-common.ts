/**
 * lib/jobs/kinds/sarvam-common.ts — S8A: what sarvam_transcribe and sarvam_translate share. The R2 result object, the daily audio cap,
 * the paid-call audit row, and the argument parsers. No Sarvam call is made here.
 *
 * TEXT NEVER TOUCHES `progress` OR `result`: the transcript lives only in R2 (mcp-sarvam/<job_id>.json); the job row carries counts,
 * duration, speaker count, language and the key.
 */
import { sql } from "@/lib/db";
import { getObjectBytes, putObjectBytes } from "@/lib/r2";
import { isNonEnglish } from "@/lib/sarvam";

export const SARVAM_ENGINE = "sarvam-gw";
export const SARVAM_DAILY_CAP_MINUTES = 240;
export const RESULT_PREFIX = "mcp-sarvam/";
export const resultKey = (jobId: string): string => `${RESULT_PREFIX}${jobId}.json`;
/** A Sarvam batch gets this long, wall clock from its start, before the job gives up. */
export const SARVAM_WALL_MS = 30 * 60_000;

/** Where the audio came from: a doctor-recorded encounter, or a clip cut by the CONSULT cutter. Never room tape, never a whole window. */
export type SarvamScope = "encounter" | "consult_clip" | "room_segment" | "window" | "synthetic" | "other";
export type SarvamUse = "production" | "mcp" | "research";
export const SCOPE_CONSULT_ONLY = "scope_consult_only";

export type ResultEntry = {
  speaker_id: string; start_s: number; end_s: number; text: string;
  /** S8A4: the script this entry's own text is written in (Latin, Devanagari, Kannada, ...), and Sarvam's per-entry language if the response carried one */
  script?: string; language_code?: string | null;
  english?: string; /** G54: the English the translate pass DID give for an entry whose other part it refused; kept only to be restored (as english_status partial) if mayura cannot cover the entry */ partial_english?: string; /** where `english` came from: the translate pass (speech -> English), mayura on the entry's text, or the entry itself (Latin script, no partner) */ english_source?: "translate_pass" | "mayura" | "mayura_fallback" | "native_latin" | "native_unverified";
  /** S8A4-R3: ok | mayura_fallback | unverified | untranslated | empty — whether the English can be taken as English; mixed_language: some Indic words inside an otherwise English entry; mayura_lang: the source language mayura was given */
  english_status?: "ok" | "mayura_fallback" | "unverified" | "untranslated" | "partial" | "empty"; mixed_language?: boolean; mayura_lang?: string | null;
  /** partial English per 900-char chunk, until the entry is complete */ parts?: string[];
};
/** S8A4: one entry of the English track. native_idx = the native entry it was aligned to by time overlap, or null (kept, never dropped). */
export type EnglishEntry = { speaker_id: string; start_s: number; end_s: number; text: string; source: "translate_pass" | "mayura" | "mayura_fallback" | "native_latin" | "native_unverified"; native_idx: number | null; status?: "ok" | "unverified" | "partial"; mixed_language?: boolean };
export type ResultDoc = {
  /** O5: set to "sarvam_mcp_research" on any result built from ROOM audio; never present on production text */
  source_label?: string;
  language_code: string | null;
  duration_s: number;
  speakers: string[];
  entries: ResultEntry[];
  transcript: string;
  english?: string;
  /** S8A4 */
  english_entries?: EnglishEntry[];
  drug_candidates?: Array<{ entry_idx: number; heard: string; suggested: string; score: number; source: string }>;
  sarvam_job_ids?: { native: string | null; english: string | null };
  minutes?: { native: number; english: number };
  english_pass?: "pending" | "done" | "suspect" | "skipped_cap" | "failed" | "not_requested";
  /** G43: translate-pass entries that were NOT English (Indic script or romanised Indic) and were refused; their native partners went to mayura */
  pass_rejected?: number;
  /** G49: the translate pass' transcript when it returned no diarized entries; a reference for a reader, never part of the English track */
  english_pass_reference?: string;
  /** the English-track `drug_candidates[].entry_idx` indexes `english_entries` */
};

export async function readJson<T>(key: string): Promise<T | null> {
  const bytes = await getObjectBytes(key);
  if (!bytes) return null;
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
  } catch {
    return null;
  }
}
export async function writeJson(key: string, doc: unknown): Promise<void> {
  await putObjectBytes(key, Buffer.from(JSON.stringify(doc), "utf8"), "application/json");
}

/** The IST calendar day's start as an ISO instant (IST has no DST). */
export function istDayStartIso(nowMs: number = Date.now()): string {
  const day = new Date(nowMs + 19_800_000).toISOString().slice(0, 10);
  return new Date(Date.parse(`${day}T00:00:00+05:30`)).toISOString();
}

/** Audio minutes already sent through the gateway today (IST), from the paid-call audit rows. */
export async function sarvamMinutesToday(nowMs: number = Date.now()): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM((metadata_json->>'audio_minutes')::numeric), 0)::float8 AS minutes
      FROM audit_log
     WHERE action = 'stt.paid_call' AND target_type = 'stt_engine' AND target_id = ${SARVAM_ENGINE}
       AND created_at >= ${istDayStartIso(nowMs)}::timestamptz
  `) as Array<{ minutes: number | string | null }>;
  const n = Number(rows[0]?.minutes ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** The refusal object when today's cap is spent, else null. */
export async function dailyCapRefusal(nowMs: number = Date.now()): Promise<{ error: "sarvam_daily_cap"; minutes_today: number; cap_minutes: number } | null> {
  const minutes = await sarvamMinutesToday(nowMs);
  return minutes >= SARVAM_DAILY_CAP_MINUTES ? { error: "sarvam_daily_cap", minutes_today: Math.round(minutes * 100) / 100, cap_minutes: SARVAM_DAILY_CAP_MINUTES } : null;
}

/** The stt_engine rate for sarvam-gw if such a row exists, else for the existing `sarvam` engine; null when neither is priced. */
export async function sarvamRatePerMin(): Promise<{ rate: number | null; source: string | null }> {
  const rows = (await sql`
    SELECT id, cost_per_min_usd FROM stt_engine WHERE id = ANY(${[SARVAM_ENGINE, "sarvam"]}::text[])
  `) as Array<{ id: string; cost_per_min_usd: number | string | null }>;
  for (const id of [SARVAM_ENGINE, "sarvam"]) {
    const r = rows.find((x) => x.id === id);
    const n = r && r.cost_per_min_usd !== null ? Number(r.cost_per_min_usd) : NaN;
    if (Number.isFinite(n)) return { rate: n, source: id };
  }
  return { rate: null, source: null };
}

/**
 * Minutes already promised to EARLIER jobs that have not yet been audited (still in prepare / init / upload / start). Each counts its measured
 * duration if it has one, else the 30-minute maximum. Only jobs created BEFORE this one count, so two jobs racing never refuse each other.
 */
// G55 (documented, no code change): the 2x reservation of an English-track job is held ONLY while the job is in prepare..start (the SQL below). During the native poll / finish
// steps the second pass's minutes are NOT reserved. Nothing is overspent: en_init asks the cap AGAIN (capRefusalForJob) and, if the day filled up meanwhile, skips the second pass
// with english_pass skipped_cap, and the mayura fallback covers the entries. The cap is therefore enforced, at the cost of an occasional skipped English pass.
export async function reservedMinutesEarlier(job: { id: string; created_at: string }): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(COALESCE((progress->>'duration_ms')::numeric / 60000, ${SARVAM_MAX_JOB_MINUTES})
                          * (CASE WHEN args->>'english' = 'true' AND COALESCE(step, 'prepare') IN ('prepare', 'init', 'upload', 'start') THEN 2 ELSE 1 END)), 0)::float8 AS minutes
      FROM scribe_job
     WHERE kind = 'sarvam_transcribe' AND status IN ('queued', 'running') AND id <> ${job.id}::text
       AND (created_at < ${job.created_at}::timestamptz OR (created_at = ${job.created_at}::timestamptz AND id < ${job.id}::text))
       AND COALESCE(step, 'prepare') IN ('prepare', 'init', 'upload', 'start', 'en_init', 'en_upload', 'en_start')
  `) as Array<{ minutes: number | string | null }>;
  // G22/G26: a job Sarvam was STARTED for (progress.sarvam_started_ms) whose paid-call row has not landed holds its minutes, WHATEVER ITS STATUS (running in poll with
  // audit_pending, done, failed, cancelled: Sarvam bills it either way), for a day. Jobs still in prepare..start are counted above, not twice.
  const failed = (await sql`
    SELECT COALESCE(SUM((j.progress->>'duration_ms')::numeric / 60000), 0)::float8 AS minutes
      FROM scribe_job j
     WHERE j.kind = 'sarvam_transcribe' AND j.id <> ${job.id}::text
       AND j.progress ? 'sarvam_job_id' AND (j.progress->>'sarvam_started_ms') IS NOT NULL AND (j.progress->>'duration_ms') IS NOT NULL
       AND NOT (j.status IN ('queued', 'running') AND COALESCE(j.step, 'prepare') IN ('prepare', 'init', 'upload', 'start'))
       AND j.updated_at > now() - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'stt.paid_call' AND a.target_type = 'stt_engine' AND a.target_id = ${SARVAM_ENGINE} AND a.metadata_json->>'job_id' = j.id)
  `) as Array<{ minutes: number | string | null }>;
  // S8A4: the English pass is a second paid batch over the same audio: started (en_started_ms) and not yet audited under `<job id>:en` holds its minutes too
  const english = (await sql`
    SELECT COALESCE(SUM((j.progress->>'duration_ms')::numeric / 60000), 0)::float8 AS minutes
      FROM scribe_job j
     WHERE j.kind = 'sarvam_transcribe' AND j.id <> ${job.id}::text
       AND j.progress ? 'en_sarvam_job_id' AND (j.progress->>'en_started_ms') IS NOT NULL AND (j.progress->>'duration_ms') IS NOT NULL
       AND j.updated_at > now() - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'stt.paid_call' AND a.target_type = 'stt_engine' AND a.target_id = ${SARVAM_ENGINE} AND a.metadata_json->>'job_id' = j.id || ':en')
  `) as Array<{ minutes: number | string | null }>;
  const n = Number(rows[0]?.minutes ?? 0) + Number(failed[0]?.minutes ?? 0) + Number(english[0]?.minutes ?? 0);
  return Number.isFinite(n) ? n : 0;
}
export const SARVAM_MAX_JOB_MINUTES = 30;

/** At submit time: today's audited minutes + earlier jobs' reserved minutes + this job's MEASURED minutes must fit under the cap. */
export async function capRefusalForJob(job: { id: string; created_at: string }, ownMinutes: number, nowMs: number = Date.now()): Promise<{ today: number; reserved: number; own: number } | null> {
  const [today, reserved] = await Promise.all([sarvamMinutesToday(nowMs), reservedMinutesEarlier(job)]);
  return today + reserved + ownMinutes > SARVAM_DAILY_CAP_MINUTES ? { today: Math.round(today * 100) / 100, reserved: Math.round(reserved * 100) / 100, own: Math.round(ownMinutes * 100) / 100 } : null;
}

/** Back-off between the attempts at the paid-call audit write (ms). Mutable so a test need not wait. */
export const auditRetry = { delaysMs: [100, 300, 900] };

/**
 * One audit_log stt.paid_call per Sarvam batch (engine 'sarvam-gw'), IDEMPOTENT on the job id: a replayed step writes no second row.
 * actor_type 'system' — the value mcp/audit.ts writes; lib/stt/paid-engines recordPaidCall writes 'mcp', which the actor_type enum of migration 0001
 * does not list (reported, not changed here).
 *
 * S3: THE ROW IS WHAT THE DAILY CAP COUNTS, so a write that fails is retried (auditRetry.delaysMs) and, if it still fails, THROWS (audit_write_failed). The
 * caller (sarvam-transcribe settleAudit) catches that and keeps the job going with progress.audit_pending, retrying the write on every poll claim; the minutes stay
 * reserved meanwhile. The row is never silently skipped, and an audit fault never fails a job Sarvam is running.
 */
export async function recordSarvamCall(opts: { actor: string | null; jobId: string; sarvamJobId: string; durationMs: number; scope: SarvamScope; use?: SarvamUse }): Promise<void> {
  // usage contract v1.2: the row carries use + scope; a production caller can only write consult_clip / encounter (a row without use reads as production)
  const use: SarvamUse = opts.use === "mcp" || opts.use === "research" ? opts.use : "production";
  if (use === "production" && (opts.scope === "window" || opts.scope === "room_segment")) throw new Error("scope_requires_mcp");
  const minutes = Math.round((opts.durationMs / 60_000) * 1000) / 1000;
  let lastErr = "error";
  for (let attempt = 0; attempt <= auditRetry.delaysMs.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, auditRetry.delaysMs[attempt - 1]));
    try {
      const have = (await sql`
        SELECT 1 AS one FROM audit_log WHERE action = 'stt.paid_call' AND target_type = 'stt_engine' AND target_id = ${SARVAM_ENGINE} AND metadata_json->>'job_id' = ${opts.jobId}::text LIMIT 1
      `) as unknown[];
      if (have.length > 0) return;
      let rate: { rate: number | null; source: string | null } = { rate: null, source: null };
      try {
        rate = await sarvamRatePerMin();
      } catch {
        /* no stt_engine table or row: the estimate stays null */
      }
      const est = rate.rate === null ? null : Math.round(rate.rate * minutes * 100000) / 100000;
      await sql`
        INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
        VALUES ('system', ${opts.actor ?? "mcp"}, 'stt.paid_call', 'stt_engine', ${SARVAM_ENGINE}, ${JSON.stringify({
          engine: SARVAM_ENGINE,
          job_id: opts.jobId,
          sarvam_job_id: opts.sarvamJobId,
          scope: opts.scope,
          use,
          duration_ms: Math.round(opts.durationMs),
          audio_minutes: minutes,
          cost_per_min_usd: rate.rate,
          estimated_cost_usd: est,
          rate_source: rate.source,
        })}::jsonb)
      `;
      return;
    } catch (e) {
      lastErr = String((e as Error)?.message ?? e).slice(0, 120);
      console.error("[sarvam] paid-call audit write failed", JSON.stringify({ job_id: opts.jobId, attempt: attempt + 1, err: lastErr }));
    }
  }
  throw new Error(`audit_write_failed: ${lastErr}`);
}

/**
 * Does this text need translating? A language code that says English decides "no". With NO code (null / "unknown") nothing is assumed:
 * romanised Hindi is plain ASCII, so the text is sent for translation with source "auto" (lib/sarvam.ts:312 has always sent "auto" to mayura:v1).
 */
export function looksNonEnglish(text: string, languageCode: string | null | undefined): boolean {
  if (!text.trim()) return false;
  if (languageCode && languageCode.toLowerCase() !== "unknown") return isNonEnglish(languageCode);
  return true;
}

/** "2026-10-08T09:30:00Z" / "...+05:30" (explicit offset) or IST wall clock "YYYY-MM-DD HH:MM[:SS]" -> epoch ms, else null. */
export function parseWhen(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const s = v.trim();
  // IST wall clock needs the SPACE form; a "T" stamp without an offset is ambiguous and is refused (as scribe_room_levels does)
  const ist = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2})?$/.exec(s);
  if (ist) {
    const t = Date.parse(`${ist[1]}T${ist[2]}${ist[3] ?? ":00"}+05:30`);
    return Number.isFinite(t) ? t : null;
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
