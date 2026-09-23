/**
 * lib/diarize-pyannoteai.ts — hosted diarization: pyannote.ai precision-3.
 *
 * V listened to the five windows where the local diarizer and pyannote.ai disagreed most and chose
 * pyannote.ai on 5 of 5 (23 Sep 2026). This is the client for that switch. It does one thing:
 * submit a window's audio, wait for the answer, and hand back speaker spans in THE SHAPE THE LOCAL
 * SERVICE ALREADY RETURNS, so nothing downstream learns a second vocabulary.
 *
 * ─── THE API, AS MEASURED — NOT AS DOCUMENTED ──────────────────────────────────────────────────
 * Every line below was read off the live API on 23 Sep 2026 with the production key, not from a
 * doc page. Recorded here because the shape is load-bearing and a doc can drift:
 *
 *   POST /v1/diarize   {url, model}  -> {jobId, status, ...}
 *   GET  /v1/jobs/{id}               -> {jobId, status, createdAt, updatedAt, output}
 *                                       output.diarization = [{start, end, speaker}]
 *                                       start/end are SECONDS (floats). speaker is a label string.
 *   GET  /v2/jobs?limit=N            -> {items: [{id, status, type, source, model, quantity,
 *                                                 reason, createdAt, completedAt}], nextCursor}
 *   statuses seen: created | running | succeeded | failed | canceled
 *
 * TWO FACTS THAT SHAPE THIS FILE:
 *
 * 1. THE JOB DETAIL DOES NOT CARRY THE MODEL. `GET /v1/jobs/{id}` returns five keys and `model` is
 *    not among them; `model` lives only on the v2 job record. So the engine label is fetched from
 *    there (`fetchJobRecord`) rather than echoed back from what we asked for. Writing the constant
 *    we sent would make the stored row's provenance a restatement of our own intent — it would
 *    read as evidence and be none. When the record cannot be found the model is NULL. Never a
 *    plausible-looking default.
 *
 * 2. THERE IS NO MEDIA DELETE. `DELETE /v1/media/...` and `GET /v1/media` both 404, so audio
 *    uploaded to pyannote.ai's own storage stays there on their retention schedule and we cannot
 *    reclaim it. That is why this client does NOT upload: it hands over a SHORT-LIVED PRESIGNED R2
 *    URL for one object and lets pyannote.ai fetch it. The credential expires by itself, the audio
 *    never leaves our bucket, and nothing goes through the Mini tunnel. `route_transcribe` already
 *    hands an external service a presigned URL this way; this is that idiom, not a second one.
 *
 * ─── WHAT NEVER APPEARS IN A LOG, A ROW, OR AN ERROR ───────────────────────────────────────────
 * The API key (Authorization header only — never a query string, never argv, never an error), the
 * presigned URL (it is a bearer credential for patient audio for as long as it lives), and the
 * provider's own message bodies, which can describe the audio. Errors that leave this file are
 * CODES from `PyannoteErrorCode`. The provider's text is logged truncated, beside the job id, and
 * never stored.
 */

import type { DiarizeSegment } from "@/lib/stt/speaker-clusters";

/** Base URL. Overridable by env so a test points at a fake server; it is not a secret. */
export const PYANNOTEAI_BASE_ENV = "PYANNOTEAI_BASE_URL";
export const PYANNOTEAI_BASE_DEFAULT = "https://api.pyannote.ai";
/** The key. Read at call time, sent in the Authorization header, never anywhere else. */
export const PYANNOTEAI_API_KEY_ENV = "PYANNOTEAI_API_KEY";
/** The model we ask for. What we STORE is read back from the job record — see fetchJobRecord. */
export const PYANNOTEAI_MODEL_ENV = "PYANNOTEAI_MODEL";
export const PYANNOTEAI_MODEL_DEFAULT = "precision-3";

/**
 * How long the presigned URL lives: 15 minutes.
 *
 * Minutes, not hours, and deliberately far below `route_transcribe`'s floor, because the work is
 * far shorter — precision-3 answered every window of the 22 Sep bake-off in well under a minute.
 * The URL must outlive pyannote.ai's own queue, not our poll: they fetch the audio when the job
 * starts, which is why this is not five minutes. A URL that expires before the fetch fails the
 * job, and a failed job falls back to the local diarizer — so being tight costs a fallback, while
 * being loose leaves a live credential for patient audio in a third party's queue. Tight wins.
 */
export const PRESIGN_TTL_SECONDS = 900;

/** Between polls of one job. */
export const POLL_INTERVAL_MS = 3_000;
/** Per-HTTP-call timeout. The API answers submits and polls in well under a second. */
export const HTTP_TIMEOUT_MS = 30_000;
/** How many pages of /v2/jobs to walk looking for our job's record before giving up on the model. */
export const JOB_RECORD_MAX_PAGES = 3;
export const JOB_RECORD_PAGE_SIZE = 50;

/** Terminal and non-terminal job states, as the API reports them. */
const TERMINAL_OK = "succeeded";
const TERMINAL_BAD = ["failed", "canceled", "cancelled"] as const;

/**
 * Every error this client reports. CODES, not messages: a code is safe to store on a row and safe
 * to count, and it cannot smuggle a provider sentence about the audio into the database.
 */
export type PyannoteErrorCode =
  | "pyannoteai_key_missing"
  | "pyannoteai_submit_failed"
  | "pyannoteai_poll_failed"
  | "pyannoteai_job_failed"
  | "pyannoteai_job_canceled"
  | "pyannoteai_no_segments"
  | "pyannoteai_bad_response";

export type PyannoteSubmit =
  | { ok: true; jobId: string }
  | { ok: false; error: PyannoteErrorCode; retryable: boolean };

export type PyannotePoll =
  | { ok: true; state: "pending" }
  | { ok: true; state: "done"; segments: DiarizeSegment[]; speakerLabels: string[] }
  | { ok: false; error: PyannoteErrorCode; retryable: boolean };

/** The v2 job record, reduced to the fields we read. `model` is the whole reason it is fetched. */
export type PyannoteJobRecord = { id: string; model: string | null; type: string | null; status: string | null };

const base = (env: NodeJS.ProcessEnv = process.env): string =>
  (env[PYANNOTEAI_BASE_ENV] || PYANNOTEAI_BASE_DEFAULT).replace(/\/+$/, "");

const requestedModel = (env: NodeJS.ProcessEnv = process.env): string =>
  (env[PYANNOTEAI_MODEL_ENV] || PYANNOTEAI_MODEL_DEFAULT).trim();

/**
 * One authenticated call.
 *
 * The key is read here and goes into the Authorization header and nowhere else. On any failure the
 * thrown/returned value carries the STATUS and a truncated body for the log — never the headers,
 * never the URL we called when that URL carries a signature.
 */
async function call(
  method: "GET" | "POST",
  path: string,
  body: unknown | undefined,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; status: number | null; detail: string }> {
  const key = (env[PYANNOTEAI_API_KEY_ENV] ?? "").trim();
  if (!key) return { ok: false, status: null, detail: "no key" };
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${base(env)}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) return { ok: false, status: res.status, detail: text.slice(0, 180) };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, detail: "unparseable body" };
    }
    if (typeof json !== "object" || json === null) return { ok: false, status: res.status, detail: "non-object body" };
    return { ok: true, json: json as Record<string, unknown> };
  } catch (e: unknown) {
    // The message of a fetch failure can contain the URL we called, and that URL is signed.
    // Name the class of failure; never the message.
    const aborted = controller.signal.aborted;
    return { ok: false, status: null, detail: aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(tid);
  }
}

/** A 4xx that is not 408/429 will not become a success on a retry; anything else might. */
const retryableStatus = (status: number | null): boolean =>
  status === null || status === 408 || status === 429 || status >= 500 || status < 400;

/**
 * Submit one window. `audioUrl` is a presigned GET URL for exactly one object.
 *
 * NOTHING HERE LOGS `audioUrl`. It is a bearer credential for patient audio until it expires, and
 * a log line is the easiest place in this system for one to end up somewhere it outlives its own
 * TTL. The window id identifies the call instead.
 */
export async function submitDiarize(
  audioUrl: string,
  opts: { label: string; env?: NodeJS.ProcessEnv },
): Promise<PyannoteSubmit> {
  const env = opts.env ?? process.env;
  if (!(env[PYANNOTEAI_API_KEY_ENV] ?? "").trim()) return { ok: false, error: "pyannoteai_key_missing", retryable: false };
  const r = await call("POST", "/v1/diarize", { url: audioUrl, model: requestedModel(env) }, env);
  if (!r.ok) {
    console.error("[pyannoteai] submit failed", JSON.stringify({ window: opts.label, status: r.status, detail: r.detail }));
    return { ok: false, error: "pyannoteai_submit_failed", retryable: retryableStatus(r.status) };
  }
  const jobId = typeof r.json.jobId === "string" ? r.json.jobId.trim() : "";
  if (!jobId) {
    console.error("[pyannoteai] submit returned no jobId", JSON.stringify({ window: opts.label }));
    return { ok: false, error: "pyannoteai_bad_response", retryable: false };
  }
  return { ok: true, jobId };
}

/**
 * Poll one job ONCE. The caller owns the waiting, so a step can bound it against its own lease.
 *
 * `pending` covers every non-terminal state the API has, INCLUDING ONES THIS BUILD HAS NOT SEEN —
 * a state we do not recognise is not a finished job, and treating it as one would throw away work
 * that is still running and still being paid for.
 */
export async function pollDiarize(jobId: string, opts: { env?: NodeJS.ProcessEnv } = {}): Promise<PyannotePoll> {
  const env = opts.env ?? process.env;
  const r = await call("GET", `/v1/jobs/${encodeURIComponent(jobId)}`, undefined, env);
  if (!r.ok) {
    console.error("[pyannoteai] poll failed", JSON.stringify({ job: jobId, status: r.status, detail: r.detail }));
    return { ok: false, error: "pyannoteai_poll_failed", retryable: retryableStatus(r.status) };
  }
  const status = typeof r.json.status === "string" ? r.json.status.trim().toLowerCase() : "";
  if ((TERMINAL_BAD as readonly string[]).includes(status)) {
    console.error("[pyannoteai] job ended", JSON.stringify({ job: jobId, status }));
    return { ok: false, error: status === "failed" ? "pyannoteai_job_failed" : "pyannoteai_job_canceled", retryable: false };
  }
  if (status !== TERMINAL_OK) return { ok: true, state: "pending" };

  const output = r.json.output;
  const raw = typeof output === "object" && output !== null ? (output as Record<string, unknown>).diarization : undefined;
  if (!Array.isArray(raw)) return { ok: false, error: "pyannoteai_bad_response", retryable: false };
  const mapped = mapSegments(raw);
  // A succeeded job with no spans is a real answer — the window held no diarizable speech — but it
  // is NOT the answer this switch was made for, and the caller treats it as a reason to let the
  // local diarizer have its say rather than storing an empty window on a paid engine's word.
  if (mapped.segments.length === 0) return { ok: false, error: "pyannoteai_no_segments", retryable: false };
  return { ok: true, state: "done", segments: mapped.segments, speakerLabels: mapped.speakerLabels };
}

/**
 * pyannote.ai spans -> the local service's segment shape.
 *
 * TWO CONVERSIONS AND ONE DECISION:
 *  - seconds (float) -> milliseconds (int), rounded. Clip-relative at both ends: pyannote.ai times
 *    from the start of the audio it fetched, exactly as the local service does, so the caller's
 *    existing clip-relative -> wall-clock step is unchanged.
 *  - `speaker` label -> `speaker_idx`. BY ORDER OF FIRST APPEARANCE, never by parsing digits out
 *    of "SPEAKER_00": the index must not depend on how a provider spells its labels. Sorting by
 *    start time first makes the mapping deterministic for a given response.
 *  - a span that is not readable, or does not end after it starts, is dropped individually —
 *    the same tolerance `parseDiarizeSegments` shows the local service.
 */
export function mapSegments(raw: unknown[]): { segments: DiarizeSegment[]; speakerLabels: string[] } {
  const rows: Array<{ start: number; end: number; speaker: string }> = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const start = Number(o.start);
    const end = Number(o.end);
    const speaker = typeof o.speaker === "string" ? o.speaker : "";
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0 || !speaker) continue;
    rows.push({ start, end, speaker });
  }
  rows.sort((a, b) => a.start - b.start || a.end - b.end);
  const idxOf = new Map<string, number>();
  const segments: DiarizeSegment[] = [];
  for (const r of rows) {
    let idx = idxOf.get(r.speaker);
    if (idx === undefined) {
      idx = idxOf.size;
      idxOf.set(r.speaker, idx);
    }
    const start_ms = Math.round(r.start * 1000);
    const end_ms = Math.round(r.end * 1000);
    // Rounding can collapse a span shorter than half a millisecond. Dropping it keeps the
    // invariant `end_ms > start_ms` that every reader of this shape already relies on.
    if (end_ms <= start_ms) continue;
    segments.push({ start_ms, end_ms, speaker_idx: idx });
  }
  const labels: string[] = new Array(idxOf.size);
  for (const [label, idx] of idxOf) labels[idx] = label;
  return { segments, speakerLabels: labels };
}

/**
 * The job's own record, for its `model` — the ONLY place the API reports which model ran.
 *
 * Walks /v2/jobs (newest first) looking for this id. Bounded: a handful of pages, then it gives up
 * and the caller stores a NULL model. It never falls back to the model we asked for, because a
 * label that restates our own request is not provenance — it would survive the API silently
 * running something else, which is the one thing a stored model label exists to detect.
 */
export async function fetchJobRecord(jobId: string, opts: { env?: NodeJS.ProcessEnv } = {}): Promise<PyannoteJobRecord | null> {
  const env = opts.env ?? process.env;
  let cursor: string | null = null;
  for (let page = 0; page < JOB_RECORD_MAX_PAGES; page++) {
    const q = `/v2/jobs?limit=${JOB_RECORD_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await call("GET", q, undefined, env);
    if (!r.ok) {
      console.warn("[pyannoteai] job record lookup failed", JSON.stringify({ job: jobId, status: r.status, detail: r.detail }));
      return null;
    }
    const items = Array.isArray(r.json.items) ? r.json.items : [];
    for (const it of items) {
      if (typeof it !== "object" || it === null) continue;
      const o = it as Record<string, unknown>;
      if (o.id !== jobId) continue;
      return {
        id: jobId,
        model: typeof o.model === "string" && o.model.trim() ? o.model.trim() : null,
        type: typeof o.type === "string" && o.type.trim() ? o.type.trim() : null,
        status: typeof o.status === "string" && o.status.trim() ? o.status.trim() : null,
      };
    }
    cursor = typeof r.json.nextCursor === "string" && r.json.nextCursor ? r.json.nextCursor : null;
    if (!cursor) break;
  }
  return null;
}
