/**
 * lib/diarize-nemotron/worker-health.ts — PURE. The "Nemotron diarize" board row (epic #23, ticket i) from the last
 * heartbeat per worker and 24 h of stored rows. Counts, ids and timings only.
 *
 *   down     no heartbeat has ever been stored
 *   stale    the newest heartbeat is older than NEMOTRON_STALE_S (10 min) → ALERT
 *   lagging  fresh, but in clinic hours (07:30–21:30 IST) the p95 close-to-stored latency is over the SLO, or the
 *            oldest waiting window is → WARNING
 *   ok       otherwise
 * The SLO (p95 ≤ 30 min in clinic hours) is the PRD's PROPOSAL, exported so a ruling can move it.
 */
export const NEMOTRON_STALE_S = 600;
export const NEMOTRON_SLO_P95_S = 1800;
export const CLINIC_START_MIN = 7 * 60 + 30;
export const CLINIC_END_MIN = 21 * 60 + 30;

export type WorkerRow = { worker_id: string; last_seen_at: string | Date; payload: Record<string, unknown> | null };
export type LatencyStats = { windows_24h: number; box_24h: number; hf_24h: number; p95_latency_s: number | null };

export type WorkerStatus = "ok" | "lagging" | "stale" | "down";

export type WorkerBoard = {
  status: WorkerStatus;
  alert: boolean;
  warning: boolean;
  workers: Array<{
    worker_id: string; age_s: number; status: "ok" | "stale"; host: string | null; gpu: string | null; model_rev: string | null;
    queue_depth: number | null; oldest_wait_s: number | null; windows_24h: number | null; hf_jobs_24h: number | null;
    hf_usd_24h: number | null; last_error_code: string | null; last_ok_at: string | null;
  }>;
  queue_depth: number | null;
  oldest_wait_s: number | null;
  windows_per_hour: number | null;
  p95_latency_s: number | null;
  box_share: number | null;
  hf_share: number | null;
  hf_usd_today_reported: number | null;
  last_error_code: string | null;
  slo_p95_s: number;
  in_clinic_hours: boolean;
};

const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const tok = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9._:\/-]{1,80}$/.test(v) ? v : null);

/** PURE — is `now` inside clinic hours, IST. */
export function inClinicHours(now: Date): boolean {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return m >= CLINIC_START_MIN && m < CLINIC_END_MIN;
}

export function workerBoard(rows: ReadonlyArray<WorkerRow>, lat: LatencyStats, now: Date): WorkerBoard {
  const clinic = inClinicHours(now);
  const workers = rows.map((r) => {
    const p = r.payload ?? {};
    const age = Math.max(0, Math.round((now.getTime() - new Date(r.last_seen_at).getTime()) / 1000));
    const usd = typeof p.hf_usd_24h === "number" && Number.isFinite(p.hf_usd_24h) ? p.hf_usd_24h : null;
    return {
      worker_id: r.worker_id, age_s: age, status: (age > NEMOTRON_STALE_S ? "stale" : "ok") as "ok" | "stale",
      host: tok(p.host), gpu: tok(p.gpu), model_rev: tok(p.model_rev),
      queue_depth: int(p.queue_depth), oldest_wait_s: int(p.oldest_wait_s), windows_24h: int(p.windows_24h), hf_jobs_24h: int(p.hf_jobs_24h),
      hf_usd_24h: usd, last_error_code: tok(p.last_error_code), last_ok_at: typeof p.last_ok_at === "string" ? p.last_ok_at : null,
    };
  });
  const fresh = workers.filter((w) => w.status === "ok");
  const newest = [...workers].sort((a, b) => a.age_s - b.age_s)[0];
  const sum = (f: (w: (typeof workers)[number]) => number | null): number | null => {
    const v = fresh.map(f).filter((x): x is number => x !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) : null;
  };
  const oldest = fresh.map((w) => w.oldest_wait_s).filter((x): x is number => x !== null);
  const oldest_wait_s = oldest.length ? Math.max(...oldest) : null;
  const total = lat.box_24h + lat.hf_24h;
  let status: WorkerStatus;
  if (workers.length === 0) status = "down";
  else if (fresh.length === 0) status = "stale";
  else if (clinic && ((lat.p95_latency_s ?? 0) > NEMOTRON_SLO_P95_S || (oldest_wait_s ?? 0) > NEMOTRON_SLO_P95_S)) status = "lagging";
  else status = "ok";
  return {
    status, alert: status === "down" || status === "stale", warning: status === "lagging",
    workers,
    queue_depth: sum((w) => w.queue_depth), oldest_wait_s,
    windows_per_hour: lat.windows_24h ? Math.round((lat.windows_24h / 24) * 10) / 10 : lat.windows_24h === 0 ? 0 : null,
    p95_latency_s: lat.p95_latency_s === null ? null : Math.round(lat.p95_latency_s),
    box_share: total ? Math.round((lat.box_24h / total) * 1000) / 1000 : null,
    hf_share: total ? Math.round((lat.hf_24h / total) * 1000) / 1000 : null,
    hf_usd_today_reported: sum((w) => w.hf_usd_24h),
    last_error_code: (newest ?? undefined)?.last_error_code ?? null,
    slo_p95_s: NEMOTRON_SLO_P95_S, in_clinic_hours: clinic,
  };
}
