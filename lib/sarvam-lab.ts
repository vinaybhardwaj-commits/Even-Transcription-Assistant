/**
 * lib/sarvam-lab.ts — S8A-FIX: the Sarvam usage contract v1 (SARVAM-USAGE-CONTRACT-v1.md) from the Scribe MCP side.
 *
 *   ledger  one `sarvam.call.v1` line per finished Sarvam job, appended to R2 eta-lab-results  sarvam/ledger/scribe-mcp/<ist_date>.jsonl
 *           R2 has no append: read, add the line, write back with a CONDITIONAL put (If-None-Match: * for a new object, If-Match: <etag>
 *           otherwise); on 412 read again and retry, up to 5 times.
 *   lane    the live state  lanes/sarvam-scribe-mcp.json  (sarvam.lane.v1): the active jobs (from the scribe_job rows past `prepare`), `today`
 *           and `all_time` COMPUTED FROM THE LEDGER FILES (today's file read each time, earlier days cached 10 min). Rewritten on every step
 *           of a Sarvam job (the poll loop at most every 20 s) and once when work ends.
 *
 * THE ALLOWLIST. This code may WRITE only those two keys (the lane, and a ledger file of this caller) and READ only under `lanes/` and
 * `sarvam/ledger/scribe-mcp/`. Every store call passes `assertWritable` / `assertReadable` first; a test pins both.
 * CREDENTIALS: SCRIBE_LAB_R2_ACCESS_KEY_ID, SCRIBE_LAB_R2_SECRET_ACCESS_KEY, SCRIBE_LAB_R2_ENDPOINT (bucket eta-lab-results is in code).
 * Missing -> emission is skipped with a logged code and the Sarvam job runs on. A ledger or lane failure NEVER fails a job (D4); only codes are logged.
 * No transcript text, name or patient identifier goes into either file: ids, counts, times and enums only.
 */
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { sql } from "@/lib/db";

export const LAB_BUCKET = "eta-lab-results";
export const CALLER = "scribe-mcp";
export const MACHINE = "vercel";
export const LANE_KEY = "lanes/sarvam-scribe-mcp.json";
export const LEDGER_PREFIX = "sarvam/ledger/scribe-mcp/";
export const LAB_ENV = ["SCRIBE_LAB_R2_ACCESS_KEY_ID", "SCRIBE_LAB_R2_SECRET_ACCESS_KEY", "SCRIBE_LAB_R2_ENDPOINT"] as const;
export const ledgerKey = (istDate: string): string => `${LEDGER_PREFIX}${istDate}.jsonl`;
const MAX_ATTEMPTS = 5;
export const LANE_MIN_INTERVAL_MS = 20_000;
const PAST_CACHE_MS = 10 * 60_000;

/** S7-0: rubric evidence and bench reports, rubric/<rubric_id>/<semver>/<name>.json. NOT reb/ (the REB track index stays outside this code's reach). */
export const RUBRIC_PREFIX = "rubric/";
const RUBRIC_KEY = /^rubric\/[a-z][a-z0-9_]{1,63}\/\d+\.\d+\.\d+\/[A-Za-z0-9_.:@=-]{1,200}\.json$/;
const WRITE_ALLOW: RegExp[] = [/^sarvam\/ledger\/scribe-mcp\/\d{4}-\d{2}-\d{2}\.jsonl$/, /^lanes\/sarvam-scribe-mcp\.json$/, RUBRIC_KEY];
const READ_ALLOW_PREFIXES = ["lanes/", LEDGER_PREFIX, RUBRIC_PREFIX];
export const labWritable = (key: string): boolean => WRITE_ALLOW.some((r) => r.test(key));
/**
 * S7-2B: the ONE reb/ shape this code may READ (never write, never list): palimpsest's consult-clip tracks and manifest,
 * reb/<ist_date>/<room_id>/_consults/<consult_uid>/tracks/<file>.json and .../manifest.json. Any other reb/ path stays unreadable, and nothing under reb/ is writable.
 */
export const REB_CONSULT_KEY = /^reb\/(\d{4}-\d{2}-\d{2})\/([A-Za-z0-9_-]{1,64})\/_consults\/([A-Za-z0-9]{10,60})\/(?:tracks\/[A-Za-z0-9._-]{1,200}\.json|manifest\.json)$/;
/** S8C: CONSULT's index mirror: exactly these two objects, GET only (nothing else under consult/ is readable, and nothing is writable). */
export const CONSULT_INDEX_KEYS = ["consult/index/latest.jsonl", "consult/index/manifest.json"] as const;
export const labReadable = (key: string): boolean =>
  !key.includes("..") && ((READ_ALLOW_PREFIXES.some((p) => key.startsWith(p)) && !key.startsWith("reb/")) || REB_CONSULT_KEY.test(key) || (CONSULT_INDEX_KEYS as readonly string[]).includes(key));
function assertWritable(key: string): void {
  if (!labWritable(key)) throw new Error("lab_key_not_writable");
}
function assertReadable(key: string): void {
  if (!labReadable(key)) throw new Error("lab_key_not_readable");
}

/** sarvam.call.v1 (contract v1.2): scope consult_clip | encounter | room_segment | window | synthetic | other; use production | mcp | research. */
export type SarvamScope = "encounter" | "consult_clip" | "room_segment" | "window" | "synthetic" | "other";
export type SarvamUse = "production" | "mcp" | "research";
export type CallLine = {
  caller: typeof CALLER; machine: typeof MACHINE; job_id: string; request_id: string | null; route: "gateway"; mode: "batch" | "sync";
  task: "transcribe" | "translate" | "text_translate"; model: string; audio_s: number; chars?: number | null; started_at: string; finished_at: string;
  status: "ok" | "failed" | "cancelled"; http_status: number | null; throttled: boolean; scope: SarvamScope; ref: string;
  /** O5 / usage contract v1.2: who asked. A line without it reads as production. */
  use?: SarvamUse;
};
export type LaneActive = { job_id: string; mode: string; task: string; model: string; audio_s: number; started_at: string; scope: string };

// --- the store ----------------------------------------------------------------------------------------------------------------------------
export type StoredObject = { body: string; etag: string | null; /** the object's own modified time, when the store reports one */ last_modified?: string | null };
export interface LabStore {
  get(key: string): Promise<StoredObject | null>;
  put(key: string, body: string, cond: { ifMatch?: string; ifNoneMatch?: boolean }): Promise<"ok" | "precondition_failed">;
  list(prefix: string): Promise<string[]>;
}

export function labStoreConfigured(): boolean {
  return LAB_ENV.every((n) => (process.env[n] ?? "").trim() !== "");
}

let s3: S3Client | null = null;
function client(): S3Client {
  if (s3) return s3;
  s3 = new S3Client({
    region: "auto",
    endpoint: (process.env.SCRIBE_LAB_R2_ENDPOINT ?? "").trim(),
    credentials: { accessKeyId: (process.env.SCRIBE_LAB_R2_ACCESS_KEY_ID ?? "").trim(), secretAccessKey: (process.env.SCRIBE_LAB_R2_SECRET_ACCESS_KEY ?? "").trim() },
  });
  return s3;
}
const status = (e: unknown): number | undefined => (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;

const realStore: LabStore = {
  async get(key) {
    try {
      const r = await client().send(new GetObjectCommand({ Bucket: LAB_BUCKET, Key: key }), { abortSignal: AbortSignal.timeout(15_000) });
      const body = r.Body ? await (r.Body as unknown as { transformToString: () => Promise<string> }).transformToString() : "";
      return { body, etag: r.ETag ?? null, last_modified: r.LastModified ? r.LastModified.toISOString() : null };
    } catch (e) {
      if ((e as { name?: string })?.name === "NoSuchKey" || status(e) === 404) return null;
      throw e;
    }
  },
  async put(key, body, cond) {
    try {
      await client().send(
        new PutObjectCommand({
          Bucket: LAB_BUCKET, Key: key, Body: Buffer.from(body, "utf8"),
          ContentType: key.endsWith(".jsonl") ? "application/x-ndjson" : "application/json",
          ...(cond.ifMatch ? { IfMatch: cond.ifMatch } : {}),
          ...(cond.ifNoneMatch ? { IfNoneMatch: "*" } : {}),
        }),
        { abortSignal: AbortSignal.timeout(15_000) },
      );
      return "ok";
    } catch (e) {
      if (status(e) === 412) return "precondition_failed";
      throw e;
    }
  },
  async list(prefix) {
    const out: string[] = [];
    let token: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await client().send(new ListObjectsV2Command({ Bucket: LAB_BUCKET, Prefix: prefix, ContinuationToken: token }), { abortSignal: AbortSignal.timeout(15_000) });
      for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key);
      if (!r.IsTruncated) break;
      token = r.NextContinuationToken;
    }
    return out;
  },
};

let override: LabStore | null = null;
/** Test hook: a store in memory. */
export function setLabStoreForTests(s: LabStore | null): void {
  override = s;
  pastCache = null;
  lastLaneAt = 0;
}
/** Every call is allowlist-checked HERE, whichever store is behind it. */
function guarded(): LabStore {
  const inner = override ?? realStore;
  return {
    // async, so a refused key is always a REJECTED promise, never a synchronous throw
    get: async (k) => { assertReadable(k); return inner.get(k); },
    put: async (k, b, c) => { assertWritable(k); return inner.put(k, b, c); },
    list: async (p) => { assertReadable(p); return inner.list(p); },
  };
}

/**
 * S2L: a READ-ONLY view of the same guarded store, for scribe_lanes. get / list only, both allowlist-checked (reads under `lanes/` and the ledger prefix;
 * writes are not reachable through it). null when the lab credentials are not configured (and no test store is set).
 */
/** S7-0: the guarded store (allowlisted get / put / list) for rubric evidence; null when the lab credentials are not configured (and no test store is set). */
export function labStore(): LabStore | null {
  return available() ? guarded() : null;
}

export function labReader(): Pick<LabStore, "get" | "list"> | null {
  if (!available()) return null;
  const g = guarded();
  return { get: (k) => g.get(k), list: (p) => g.list(p) };
}

const logCode = (code: string, extra: Record<string, unknown> = {}): void => {
  console.warn("[sarvam-lab]", JSON.stringify({ code, ...extra }));
};
const available = (): boolean => override !== null || labStoreConfigured();

export const istDateOf = (ms: number): string => new Date(ms + 19_800_000).toISOString().slice(0, 10);

// --- the ledger ---------------------------------------------------------------------------------------------------------------------------
/**
 * Append one line. Returns true when it landed (or is already there). NEVER throws (D4).
 * ONE LINE PER JOB ID, looked for in BOTH the finish-date file and the start-date file (a job that crosses IST midnight lives in either), so a replayed
 * step, a cancel that races a finish, or the runner's end-of-job hook cannot double-count a job.
 * AN `ok` LINE WINS (G13a): if the job's existing line is NOT ok (a cancel or a runner failure that raced a finish Sarvam completed), the ok line REPLACES it
 * in place, so audio_min counts the audio Sarvam finished; the cancel stays on the job row. An existing ok line is never replaced, and a non-ok line
 * never replaces another line.
 */
export async function appendLedger(line: CallLine): Promise<boolean> {
  if (!available()) {
    logCode("lab_store_not_configured", { what: "ledger" });
    return false;
  }
  const finishedMs = Date.parse(line.finished_at);
  const startedMs = Date.parse(line.started_at);
  const keys = [...new Set([ledgerKey(istDateOf(Number.isFinite(finishedMs) ? finishedMs : Date.now())), ...(Number.isFinite(startedMs) ? [ledgerKey(istDateOf(startedMs))] : [])])];
  const marker = `"job_id":${JSON.stringify(line.job_id)}`;
  const text = `${JSON.stringify(line)}\n`;
  try {
    const store = guarded();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const objs = await Promise.all(keys.map((k) => store.get(k)));
      // is this job already in a file?
      let hitKey: string | null = null;
      let hitObj: StoredObject | null = null;
      let hitIdx = -1;
      let hitLines: string[] = [];
      for (let i = 0; i < keys.length && hitIdx < 0; i++) {
        const o = objs[i];
        if (!o) continue;
        const lines = o.body.split("\n");
        const idx = lines.findIndex((l) => l.includes(marker));
        if (idx >= 0) { hitKey = keys[i]!; hitObj = o; hitIdx = idx; hitLines = lines; }
      }
      let key: string;
      let cur: StoredObject | null;
      let body: string;
      if (hitObj && hitKey) {
        let existingStatus = "";
        try { existingStatus = String((JSON.parse(hitLines[hitIdx]!) as { status?: unknown }).status ?? ""); } catch { /* a torn line counts as present */ }
        if (existingStatus === "ok" || line.status !== "ok") return true; // already there; a non-ok line never displaces one
        hitLines[hitIdx] = JSON.stringify(line); // the ok line replaces the cancelled / failed one
        key = hitKey; cur = hitObj; body = hitLines.join("\n");
      } else {
        key = keys[0]!; cur = objs[0] ?? null;
        body = cur ? (cur.body.endsWith("\n") || cur.body === "" ? cur.body : `${cur.body}\n`) + text : text;
      }
      // an existing object must carry an ETag to be replaced safely; without one we cannot make the write conditional, so we do not write
      if (cur && !cur.etag) {
        logCode("ledger_no_etag");
        return false;
      }
      const res = await store.put(key, body, cur ? { ifMatch: cur.etag! } : { ifNoneMatch: true });
      if (res === "ok") return true;
      logCode("ledger_412_retry", { attempt });
    }
    logCode("ledger_412_exhausted");
    return false;
  } catch (e) {
    logCode("ledger_write_failed", { err: (e as Error)?.message === "lab_key_not_writable" ? "not_writable" : (e as { name?: string })?.name ?? "error" });
    return false;
  }
}

export type Tally = { jobs: number; audio_min: number; failed: number; throttled: number; by_use?: Record<string, number>; by_scope?: Record<string, number>; by_status?: Record<string, number> };
export function tallyOf(jsonl: string): Tally {
  const t: Tally = { jobs: 0, audio_min: 0, failed: 0, throttled: 0, by_use: {}, by_scope: {}, by_status: {} };
  const bump = (m: Record<string, number>, k: unknown): void => { const key = typeof k === "string" && k ? k : "unknown"; m[key] = (m[key] ?? 0) + 1; };
  let audioS = 0;
  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const l = JSON.parse(raw) as Partial<CallLine>;
      t.jobs++;
      bump(t.by_use!, (l as { use?: unknown }).use ?? "production"); // a line without use reads as production
      bump(t.by_scope!, l.scope);
      bump(t.by_status!, l.status);
      if (l.status === "ok") audioS += Number(l.audio_s) || 0;
      else if (l.status === "failed") t.failed++;
      if (l.throttled) t.throttled++;
    } catch {
      /* a torn line is skipped, never fatal */
    }
  }
  t.audio_min = Math.round((audioS / 60) * 1000) / 1000;
  return t;
}

let pastCache: { at: number; before: string; jobs: number; audio_min: number } | null = null;
async function allTime(store: LabStore, today: string, todayTally: Tally): Promise<{ jobs: number; audio_min: number }> {
  if (!pastCache || Date.now() - pastCache.at > PAST_CACHE_MS || pastCache.before !== today) {
    let jobs = 0;
    let min = 0;
    const keys = (await store.list(LEDGER_PREFIX)).filter((k) => labWritable(k) && k !== ledgerKey(today)).sort().slice(-400);
    for (const k of keys) {
      const o = await store.get(k);
      if (!o) continue;
      const t = tallyOf(o.body);
      jobs += t.jobs;
      min += t.audio_min;
    }
    pastCache = { at: Date.now(), before: today, jobs, audio_min: min };
  }
  return { jobs: pastCache.jobs + todayTally.jobs, audio_min: Math.round((pastCache.audio_min + todayTally.audio_min) * 1000) / 1000 };
}

// --- the lane -----------------------------------------------------------------------------------------------------------------------------
type ActiveRow = { id: string; kind: string; step: string | null; duration_ms: string | number | null; scope: string | null; started_at: string | null; created_at: string | Date };

/** The Sarvam jobs in flight now: scribe_job rows of our two kinds, running or queued, past `prepare` (that is, Sarvam has work or is about to). */
export async function activeJobs(excludeJobId?: string | null): Promise<LaneActive[]> {
  const rows = (await sql`
    SELECT id, kind, step, progress->>'duration_ms' AS duration_ms, progress->>'scope' AS scope, progress->>'started_at' AS started_at, created_at
      FROM scribe_job
     WHERE kind = ANY(${["sarvam_transcribe", "sarvam_translate"]}::text[]) AND status IN ('queued', 'running')
       AND step IS NOT NULL AND step <> 'prepare' AND updated_at > now() - interval '45 minutes'
     ORDER BY created_at LIMIT 50
  `) as ActiveRow[];
  return rows
    .filter((r) => r.id !== excludeJobId)
    .map((r) => {
      const transcribe = r.kind === "sarvam_transcribe";
      const ms = Number(r.duration_ms);
      return {
        job_id: r.id,
        mode: transcribe ? "batch" : "sync",
        task: transcribe ? (String(r.step ?? "").startsWith("en_") ? "translate" : "transcribe") : "text_translate", // the English pass of a transcribe job is task translate
        model: transcribe ? "saaras:v3" : "mayura:v1",
        audio_s: transcribe && Number.isFinite(ms) ? Math.round(ms / 10) / 100 : 0,
        started_at: r.started_at ?? new Date(r.created_at).toISOString(),
        scope: r.scope ?? "other",
      };
    });
}

let lastLaneAt = 0;
/**
 * Rewrite the lane file. `force` ignores the 20 s throttle (the end of a job). Never throws (D4).
 * `excludeJobId`: the job whose terminal step is running (its row still says running until the step returns).
 */
export async function touchLane(opts: { force?: boolean; excludeJobId?: string | null } = {}): Promise<boolean> {
  if (!available()) {
    logCode("lab_store_not_configured", { what: "lane" });
    return false;
  }
  const now = Date.now();
  if (!opts.force && now - lastLaneAt < LANE_MIN_INTERVAL_MS) return false;
  lastLaneAt = now;
  try {
    const store = guarded();
    const today = istDateOf(now);
    let todayTally: Tally = { jobs: 0, audio_min: 0, failed: 0, throttled: 0, by_use: {}, by_scope: {}, by_status: {} };
    let total = { jobs: 0, audio_min: 0 };
    try {
      const cur = await store.get(ledgerKey(today));
      todayTally = cur ? tallyOf(cur.body) : todayTally;
      total = await allTime(store, today, todayTally);
    } catch (e) {
      logCode("lane_ledger_read_failed", { err: (e as { name?: string })?.name ?? "error" });
    }
    const lane = {
      caller: CALLER, machine: MACHINE, updated_at: new Date(now).toISOString(),
      active: await activeJobs(opts.excludeJobId ?? null),
      today: todayTally, all_time: total,
    };
    await store.put(LANE_KEY, JSON.stringify(lane), {});
    return true;
  } catch (e) {
    logCode("lane_write_failed", { err: (e as { name?: string })?.name ?? "error" });
    return false;
  }
}


// --- O5 / contract v1.2: the day file rewritten WHOLE from Neon ---------------------------------------------------------------------------
type NeonCall = { job_id: string; created_at: string | Date; meta: Record<string, unknown> | null; job_status: string | null; job_finished_at: string | Date | null; job_progress: Record<string, unknown> | null };

/** PURE — one sarvam.call.v1 line from a paid-call audit row (and its job): counts, ids and enums only. null when the job has not finished (the lane's `active` covers it). */
export function lineFromNeon(r: NeonCall): CallLine | null {
  const m = r.meta ?? {};
  const status = r.job_status === "done" ? "ok" : r.job_status === "failed" ? "failed" : r.job_status === "cancelled" ? "cancelled" : null;
  if (!status) return null;
  const jobId = String(r.job_id);
  const en = jobId.endsWith(":en");
  const scope = ["encounter", "consult_clip", "room_segment", "window", "synthetic", "other"].includes(String(m.scope)) ? (m.scope as SarvamScope) : "other";
  const use: SarvamUse = m.use === "mcp" || m.use === "research" ? m.use : "production";
  const started = typeof (r.job_progress ?? {})[en ? "en_started_at" : "started_at"] === "string" ? String((r.job_progress ?? {})[en ? "en_started_at" : "started_at"]) : new Date(r.created_at).toISOString();
  return {
    caller: CALLER, machine: MACHINE, job_id: jobId, request_id: typeof m.sarvam_job_id === "string" ? m.sarvam_job_id : null, route: "gateway", mode: "batch",
    task: en ? "translate" : "transcribe", model: "saaras:v3", audio_s: Math.round(((Number(m.duration_ms) || 0) / 1000) * 100) / 100,
    started_at: started, finished_at: new Date(r.job_finished_at ?? r.created_at).toISOString(), status, http_status: status === "ok" ? 200 : null,
    throttled: (r.job_progress ?? {})[en ? "en_throttled" : "throttled"] === true, scope, ref: typeof m.ref === "string" ? m.ref : jobId.replace(/:en$/, ""), use, chars: null, // D-2: sarvam.call.v1 lists chars; null for an audio call
  };
}

const keyOf = (l: { job_id?: unknown; task?: unknown }): string => `${String(l.job_id)}|${String(l.task)}`;

/**
 * Rewrite the WHOLE ledger file of an IST day from the Neon paid-call rows (the source of record), merged with the lines already in the file that Neon does not
 * hold (text translations carry no audit row). Idempotent: the same Neon rows give the same file; two concurrent finishes both compute from Neon, and the
 * conditional put retries on 412, so the file holds both. An existing ok line is never replaced by a non-ok one. Never throws (D4): a failed write is logged and the
 * next finish rewrites it; the call still counts in Neon.
 */
export async function rewriteLedgerDay(istDate: string): Promise<boolean> {
  if (!available()) {
    logCode("lab_store_not_configured", { what: "ledger_rewrite" });
    return false;
  }
  try {
    const key = ledgerKey(istDate);
    const store = guarded();
    const from = new Date(Date.parse(`${istDate}T00:00:00+05:30`)).toISOString();
    const to = new Date(Date.parse(`${istDate}T00:00:00+05:30`) + 86_400_000).toISOString();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const rows = (await sql`
        SELECT a.metadata_json->>'job_id' AS job_id, a.created_at, a.metadata_json AS meta, j.status AS job_status, j.finished_at AS job_finished_at, j.progress AS job_progress
          FROM audit_log a LEFT JOIN scribe_job j ON j.id = regexp_replace(a.metadata_json->>'job_id', ':en$', '')
         WHERE a.action = 'stt.paid_call' AND a.target_type = 'stt_engine' AND a.target_id = 'sarvam-gw'
           AND a.created_at >= ${from}::timestamptz AND a.created_at < ${to}::timestamptz
         ORDER BY a.created_at, a.id LIMIT 5000
      `) as NeonCall[];
      const cur = await store.get(key);
      if (cur && !cur.etag) { logCode("ledger_no_etag"); return false; }
      const merged = new Map<string, CallLine>();
      if (cur) for (const raw of cur.body.split("\n")) { if (!raw.trim()) continue; try { const l = JSON.parse(raw) as CallLine; merged.set(keyOf(l), l); } catch { /* a torn line is dropped */ } }
      for (const r of rows) {
        const l = lineFromNeon(r);
        if (!l) continue;
        const had = merged.get(keyOf(l));
        if (had && had.status === "ok" && l.status !== "ok") continue; // an ok line is never displaced
        merged.set(keyOf(l), had ? { ...had, ...l, ...(typeof (had as { chars?: unknown }).chars === "number" ? { chars: (had as { chars?: number }).chars } : {}) } : l);
      }
      const body = [...merged.values()].sort((a, b) => a.started_at.localeCompare(b.started_at) || a.job_id.localeCompare(b.job_id)).map((l) => JSON.stringify(l)).join("\n") + (merged.size ? "\n" : "");
      if (cur && cur.body === body) return true;
      const res = await store.put(key, body, cur ? { ifMatch: cur.etag! } : { ifNoneMatch: true });
      if (res === "ok") return true;
      logCode("ledger_rewrite_412_retry", { attempt });
    }
    logCode("ledger_rewrite_412_exhausted");
    return false;
  } catch (e) {
    logCode("ledger_rewrite_failed", { err: (e as { name?: string })?.name ?? "error" });
    return false;
  }
}

/** After a Sarvam call finishes: rewrite today's (and the start day's) ledger file from Neon, then the lane. Never throws. Per call, which is far more often than every 15 minutes while calls run. */
export async function refreshContractFiles(startedAtIso?: string | null): Promise<void> {
  const days = new Set<string>([istDateOf(Date.now())]);
  const st = startedAtIso ? Date.parse(startedAtIso) : NaN;
  if (Number.isFinite(st)) days.add(istDateOf(st));
  for (const d of days) await rewriteLedgerDay(d);
  await touchLane({ force: true });
}
