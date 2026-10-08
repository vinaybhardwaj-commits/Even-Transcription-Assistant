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

const WRITE_ALLOW: RegExp[] = [/^sarvam\/ledger\/scribe-mcp\/\d{4}-\d{2}-\d{2}\.jsonl$/, /^lanes\/sarvam-scribe-mcp\.json$/];
const READ_ALLOW_PREFIXES = ["lanes/", LEDGER_PREFIX];
export const labWritable = (key: string): boolean => WRITE_ALLOW.some((r) => r.test(key));
export const labReadable = (key: string): boolean => READ_ALLOW_PREFIXES.some((p) => key.startsWith(p)) && !key.includes("..");
function assertWritable(key: string): void {
  if (!labWritable(key)) throw new Error("lab_key_not_writable");
}
function assertReadable(key: string): void {
  if (!labReadable(key)) throw new Error("lab_key_not_readable");
}

export type SarvamScope = "encounter" | "consult_clip";
export type CallLine = {
  caller: typeof CALLER; machine: typeof MACHINE; job_id: string; request_id: string | null; route: "gateway"; mode: "batch" | "sync";
  task: "transcribe" | "text_translate"; model: string; audio_s: number; chars?: number; started_at: string; finished_at: string;
  status: "ok" | "failed" | "cancelled"; http_status: number | null; throttled: boolean; scope: SarvamScope; ref: string;
};
export type LaneActive = { job_id: string; mode: string; task: string; model: string; audio_s: number; started_at: string; scope: string };

// --- the store ----------------------------------------------------------------------------------------------------------------------------
export type StoredObject = { body: string; etag: string | null };
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
      return { body, etag: r.ETag ?? null };
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
    get: (k) => { assertReadable(k); return inner.get(k); },
    put: (k, b, c) => { assertWritable(k); return inner.put(k, b, c); },
    list: (p) => { assertReadable(p); return inner.list(p); },
  };
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

export type Tally = { jobs: number; audio_min: number; failed: number; throttled: number };
export function tallyOf(jsonl: string): Tally {
  const t: Tally = { jobs: 0, audio_min: 0, failed: 0, throttled: 0 };
  let audioS = 0;
  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const l = JSON.parse(raw) as Partial<CallLine>;
      t.jobs++;
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
        task: transcribe ? "transcribe" : "text_translate",
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
    let todayTally: Tally = { jobs: 0, audio_min: 0, failed: 0, throttled: 0 };
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
