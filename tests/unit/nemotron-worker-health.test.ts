/** worker-health (epic #23 i): the board row's status rules, with mutation controls on every edge. */
import { describe, it, expect } from "vitest";
import { workerBoard, inClinicHours, NEMOTRON_STALE_S, NEMOTRON_SLO_P95_S } from "@/lib/diarize-nemotron/worker-health";

// 2026-10-10 06:30 UTC = 12:00 IST (clinic hours); 20:00 UTC = 01:30 IST next day (closed)
const NOON = new Date("2026-10-10T06:30:00Z"), NIGHT = new Date("2026-10-10T20:00:00Z");
const row = (ageS: number, now: Date, payload: Record<string, unknown> = {}) =>
  ({ worker_id: "box-fake-1", last_seen_at: new Date(now.getTime() - ageS * 1000).toISOString(), payload });
const lat = (o: Partial<{ windows_24h: number; box_24h: number; hf_24h: number; p95_latency_s: number | null }> = {}) =>
  ({ windows_24h: 48, box_24h: 40, hf_24h: 8, p95_latency_s: 600, ...o });

describe("workerBoard status", () => {
  it("down: no heartbeat ever", () => expect(workerBoard([], lat(), NOON)).toMatchObject({ status: "down", alert: true, warning: false }));
  it("stale beyond 10 min is an ALERT; exactly 10 min is still ok", () => {
    expect(workerBoard([row(NEMOTRON_STALE_S + 1, NOON)], lat(), NOON)).toMatchObject({ status: "stale", alert: true });
    expect(workerBoard([row(NEMOTRON_STALE_S, NOON)], lat(), NOON)).toMatchObject({ status: "ok", alert: false });
  });
  it("lagging in clinic hours on p95 over the SLO, or the oldest wait over it", () => {
    expect(workerBoard([row(30, NOON)], lat({ p95_latency_s: NEMOTRON_SLO_P95_S + 1 }), NOON)).toMatchObject({ status: "lagging", warning: true });
    expect(workerBoard([row(30, NOON, { oldest_wait_s: NEMOTRON_SLO_P95_S + 1 })], lat(), NOON).status).toBe("lagging");
    expect(workerBoard([row(30, NOON)], lat({ p95_latency_s: NEMOTRON_SLO_P95_S }), NOON).status).toBe("ok");
  });
  it("the same lag outside clinic hours is not lagging (overnight backlog is expected)", () =>
    expect(workerBoard([row(30, NIGHT)], lat({ p95_latency_s: 9999 }), NIGHT).status).toBe("ok"));
  it("clinic-hour edges are IST 07:30 inclusive to 21:30 exclusive", () => {
    expect(inClinicHours(new Date("2026-10-10T02:00:00Z"))).toBe(true);   // 07:30
    expect(inClinicHours(new Date("2026-10-10T01:59:00Z"))).toBe(false);  // 07:29
    expect(inClinicHours(new Date("2026-10-10T16:00:00Z"))).toBe(false);  // 21:30
    expect(inClinicHours(new Date("2026-10-10T15:59:00Z"))).toBe(true);   // 21:29
  });
});

describe("workerBoard figures", () => {
  it("sums fresh workers only, ignores malformed payload fields, never echoes a free-form string", () => {
    const b = workerBoard([
      row(10, NOON, { queue_depth: 5, oldest_wait_s: 120, hf_jobs_24h: 2, hf_usd_24h: 1.5, last_error_code: "infer_failed", host: "box one with spaces" }),
      { ...row(5000, NOON, { queue_depth: 99 }), worker_id: "old" },
    ], lat(), NOON);
    expect(b.queue_depth).toBe(5);
    expect(b.oldest_wait_s).toBe(120);
    expect(b.hf_usd_today_reported).toBe(1.5);
    expect(b.workers.find((w) => w.worker_id === "box-fake-1")!.host).toBeNull();
    expect(b.workers.find((w) => w.worker_id === "old")!.status).toBe("stale");
    expect(b.last_error_code).toBe("infer_failed");
    expect(JSON.stringify(b)).not.toMatch(/spaces/);
  });
  it("shares and rates", () => {
    const b = workerBoard([row(1, NOON)], lat(), NOON);
    expect(b).toMatchObject({ windows_per_hour: 2, box_share: 0.833, hf_share: 0.167, p95_latency_s: 600 });
    expect(workerBoard([row(1, NOON)], lat({ windows_24h: 0, box_24h: 0, hf_24h: 0, p95_latency_s: null }), NOON)).toMatchObject({ windows_per_hour: 0, box_share: null, p95_latency_s: null });
  });
});
