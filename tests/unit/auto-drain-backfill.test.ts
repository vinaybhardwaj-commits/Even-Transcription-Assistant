/**
 * The auto-drain BACKFILL (lib/stt/auto-drain-backfill.ts + its seam in lib/stt/auto-drain.ts).
 *
 * Pure parts are tested directly. The candidate scan and the guard's job statistics run against a REAL
 * postgres:16 (0041 room and bench_session, 0057, 0061, 0082, 0092, 0100 verbatim) through bound parameters.
 * Append-only fixtures: every state is reached by INSERTing rows, never by a DELETE. Env names are literal.
 * drainRoomWindow is mocked (it is the authority and is proven elsewhere); what is proven here is WHICH
 * windows are offered to it, WHEN, and that it is called exactly as the live path calls it.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer, type Sql } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>,
  drained: [] as Array<{ windowId: string; origin: string; opts: Record<string, unknown> }>,
  fetches: [] as string[],
}));
vi.mock("@/lib/room-access/check", async (orig) => ({ ...(await orig<Record<string, unknown>>()), blindWindowIds: async () => [] as string[] }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.mock("@/lib/stt/room-drain", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  drainRoomWindow: async (windowId: string, origin: string, opts: Record<string, unknown>) => {
    H.drained.push({ windowId, origin, opts });
    return { window_id: windowId, ok: true, step: "enqueued", job_id: `job_${H.drained.length}` };
  },
}));

const { enqueueAutoDrain, AUTO_DRAIN_MAX_AGE_HOURS } = await import("@/lib/stt/auto-drain");
const B = await import("@/lib/stt/auto-drain-backfill");

const FLAG = "ROOM_AUTO_DRAIN_ENABLED";
const SINCE = "AUTO_DRAIN_BACKFILL_SINCE";
const LIMIT = "AUTO_DRAIN_BACKFILL_LIMIT";
const ENV_KEYS = [FLAG, SINCE, LIMIT, "ETA_ROUTER_URL", "ETA_ROUTER_URLS", "ETA_ROUTER_BULK_URLS", "BULK_AGE_MINUTES", "POOL_BULK_FALLBACK_LIVE"];
let saved: Record<string, string | undefined> = {};
const silent = () => {};

const istDate = (epochMs: number) => new Date(epochMs + 5.5 * 3_600_000).toISOString().slice(0, 10);
const daysAgo = (d: number) => istDate(Date.now() - d * 86_400_000);

beforeEach(() => {
  H.drained.length = 0;
  H.fetches.length = 0;
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete (process.env as Record<string, string | undefined>)[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
});

const healthy = async (url: string) => { H.fetches.push(url); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
const unhealthy = async (url: string) => { H.fetches.push(url); return new Response(JSON.stringify({ ok: false }), { status: 200 }); };

// ═══ 1. PURE ═══════════════════════════════════════════════════════════════════════════════════

describe("pure: since, off-peak, plan, guard", () => {
  it("parseBackfillSince: a real IST date is its IST midnight; anything else is null", () => {
    expect(B.parseBackfillSince("2026-10-05")).toBe(Date.UTC(2026, 9, 5) - 5.5 * 3_600_000);
    for (const bad of [undefined, "", "05-10-2026", "2026-13-01", "2026-02-30", "2026-10-5", "yesterday", "2026-10-05T00:00"]) {
      expect(B.parseBackfillSince(bad), String(bad)).toBeNull();
    }
  });

  it("plan: unset/empty is off; a bad date is off; a good date is on at ANY hour (no clock gate)", () => {
    expect(B.backfillPlan({})).toEqual({ on: false, reason: "unset" });
    expect(B.backfillPlan({ [SINCE]: "  " })).toEqual({ on: false, reason: "unset" });
    expect(B.backfillPlan({ [SINCE]: "5 Oct" })).toEqual({ on: false, reason: "bad_since" });
    expect(B.backfillPlan({ [SINCE]: "2026-10-05" })).toEqual({ on: true, sinceMs: B.parseBackfillSince("2026-10-05"), limit: 2 });
  });
  it("no time-of-day gate exists in the module", () => {
    const code = readFileSync("lib/stt/auto-drain-backfill.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/off.?peak|START_HOUR|END_HOUR|getHours|istHour|Date\.now/i);
  });

  it("limit: default 2, clamped to 1..5, garbage gives the default", () => {
    const l = (v?: string) => B.backfillLimit(v === undefined ? {} : { [LIMIT]: v });
    expect([l(), l("0"), l("-3"), l("1"), l("5"), l("6"), l("99"), l("many"), l("3")]).toEqual([2, 1, 1, 1, 5, 5, 5, 2, 3]);
  });

  it("guardVerdict: in-flight at the limit, failure rate, latency; thin samples are not judged", () => {
    const ok = { n: 10, failed: 3, avg_job_s: 1800, in_flight: 1 };
    expect(B.guardVerdict(ok, 2)).toBeNull(); // 30% is not MORE than 30%; 1800 s is not over 1800 s
    expect(B.guardVerdict({ ...ok, in_flight: 2 }, 2)).toBe("in_flight_at_limit");
    expect(B.guardVerdict({ ...ok, failed: 4 }, 2)).toBe("recent_failure_rate");
    expect(B.guardVerdict({ ...ok, avg_job_s: 1801 }, 2)).toBe("recent_latency");
    expect(B.guardVerdict({ n: 4, failed: 4, avg_job_s: 9999, in_flight: 0 }, 2)).toBeNull();
    expect(B.guardVerdict({ n: 0, failed: 0, avg_job_s: null, in_flight: 0 }, 2)).toBeNull();
  });
});

describe("routerHealthy", () => {
  it("GETs <base>/healthz and trusts the parsed ok, not the status", async () => {
    const urls: string[] = [];
    const f = (body: unknown, status = 200) => async (u: string) => { urls.push(u); return new Response(typeof body === "string" ? body : JSON.stringify(body), { status }); };
    expect(await B.routerHealthy(f({ ok: true }), { ETA_ROUTER_URL: "https://router.test/" })).toBe(true);
    expect(urls).toEqual(["https://router.test/healthz"]);
    expect(await B.routerHealthy(f({ ok: false }), {})).toBe(false);
    expect(await B.routerHealthy(f({ detail: "Not Found" }, 404), {})).toBe(false);
    expect(await B.routerHealthy(f("up"), {})).toBe(false);
    expect(await B.routerHealthy(async () => { throw new Error("connect"); }, {})).toBe(false);
  });

  it("uses the same base URL as the router client (default host) and the service-access headers", async () => {
    let seen: { url: string; id: string | null } | null = null;
    await B.routerHealthy(async (u, init) => { seen = { url: u, id: new Headers(init.headers).get("CF-Access-Client-Id") }; return new Response('{"ok":true}'); },
      { CF_ACCESS_CLIENT_ID: "id.access", CF_ACCESS_CLIENT_SECRET: "s3" });
    expect(seen!.url).toBe("https://route.llmvinayminihome.uk/healthz");
    expect(seen!.id).toBe("id.access");
  });

  it("with BULK_AGE_MINUTES set it probes the bulk endpoints, and any one answering ok is enough (more cases: auto-drain-backfill-oref.test.ts)", async () => {
    const urls: string[] = [];
    const f = async (u: string) => { urls.push(u); return new Response(JSON.stringify({ ok: u.startsWith("https://b2") }), { status: 200 }); };
    expect(await B.routerHealthy(f, { ETA_ROUTER_BULK_URLS: "https://b1.test,https://b2.test", BULK_AGE_MINUTES: "60" }, 360)).toBe(true);
    expect(urls).toEqual(["https://b1.test/healthz", "https://b2.test/healthz"]);
  });
});

// ═══ 2. AGAINST A REAL POSTGRES ═════════════════════════════════════════════════════════════════

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-auto-drain-backfill");

describe("REQUIRED PROOF — the backfill selector against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/auto-drain-backfill.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  const m0041 = readFileSync("db/migrations/0041_room_bench.sql", "utf8");
  const keep = (name: string) => { const i = m0041.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`); return m0041.slice(i, m0041.indexOf(");", i) + 2); };
  pg.exec("CREATE TABLE schema_migrations (version int PRIMARY KEY, name text);");
  pg.exec(keep("room"));
  pg.exec(noRecord("db/migrations/0065_room_processing_switches.sql"));
  pg.exec(keep("bench_session"));
  pg.exec(`
    INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) VALUES
      ('room_a', 'a', 'A', 'x', TRUE), ('room_b', 'b', 'B', 'x', TRUE), ('room_c', 'c', 'C', 'x', TRUE), ('room_off', 'off', 'Off', 'x', FALSE);
    INSERT INTO bench_session (id, room_id) VALUES ('sess_a', 'room_a'), ('sess_b', 'room_b'), ('sess_c', 'room_c'), ('sess_off', 'room_off');
  `);
  pg.exec(noRecord("db/migrations/0057_bench_window.sql"));
  pg.exec(noRecord("db/migrations/0061_stt_subject_job.sql"));
  pg.exec(noRecord("db/migrations/0082_scribe_job.sql"));
  pg.exec(noRecord("db/migrations/0092_bench_window_auto_drain_refusal.sql"));
  pg.exec(noRecord("db/migrations/0100_bench_window_auto_drain_refused_idx.sql"));
}, 180_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

let startMs = 0;
const HOUR_MIN = 60;
const LIVE_AGE = 30; // minutes: inside the 6 h live horizon
const BACKLOG_AGE = (AUTO_DRAIN_MAX_AGE_HOURS + 20) * HOUR_MIN; // 26 h ago: past the live horizon, inside SINCE=3 days ago
const OLD_AGE = 10 * 24 * HOUR_MIN; // 10 days ago: before SINCE
function win(id: string, session: string, ageMin: number, o: { state?: string; refusedMin?: number; grid?: boolean } = {}): void {
  startMs += 900_000;
  pg.exec(`INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, grid_aligned, state, closed_at, auto_drain_refused_at, auto_drain_refused_reason)
           VALUES ('${id}', '${session}', 'rd_1', ${startMs}, ${startMs + 900_000}, 'primary', ${o.grid ?? true}, '${o.state ?? "closed"}',
                   NOW() - (${ageMin} * INTERVAL '1 minute'),
                   ${o.refusedMin === undefined ? "NULL" : `NOW() - (${o.refusedMin} * INTERVAL '1 minute')`}, ${o.refusedMin === undefined ? "NULL" : "'flag_off'"});`);
}
function job(id: string, windowId: string, status: string, o: { finishedMinAgo?: number; runS?: number } = {}): void {
  const fin = o.finishedMinAgo ?? 5;
  pg.exec(`INSERT INTO scribe_job (id, kind, args, status, created_at, started_at, finished_at)
           VALUES ('${id}', 'room_window', '{"window_id":"${windowId}"}'::jsonb, '${status}', NOW() - (${fin + 20} * INTERVAL '1 minute'),
                   ${status === "queued" ? "NULL" : `NOW() - (${fin} * INTERVAL '1 minute') - (${o.runS ?? 600} * INTERVAL '1 second')`},
                   ${status === "done" || status === "failed" ? `NOW() - (${fin} * INTERVAL '1 minute')` : "NULL"});`);
}
const resetDb = () => {
  pg.exec("TRUNCATE bench_window, scribe_job, stt_subject_job; UPDATE room SET transcript_enabled = (id <> 'room_off');");
  H.sql = pg.sql as unknown as typeof H.sql;
  process.env[FLAG] = "1";
  process.env[SINCE] = daysAgo(3);
};
const tick = (o: { fetchImpl?: (u: string, i: RequestInit) => Promise<Response> } = {}) =>
  enqueueAutoDrain("https://x.test", { log: silent, fetchImpl: o.fetchImpl ?? healthy });
const offered = () => H.drained.map((d) => d.windowId);

describe.skipIf(!HAVE_DOCKER)("backfill through enqueueAutoDrain", () => {
  beforeEach(resetDb);

  it("OFF when SINCE is unset: no field, no extra query, backlog not touched (the live path is the shipped state)", async () => {
    delete process.env[SINCE];
    win("bw_back", "sess_a", BACKLOG_AGE);
    const r = await tick({ fetchImpl: async () => { throw new Error("must not probe"); } });
    expect(r.backfill).toBeUndefined();
    expect(r.considered).toBe(0);
    expect(offered()).toEqual([]);
  });

  it("a malformed SINCE: skipped with the reason, nothing offered, no probe", async () => {
    win("bw_back", "sess_a", BACKLOG_AGE);
    process.env[SINCE] = "5 Oct";
    expect((await tick({ fetchImpl: async () => { throw new Error("must not probe"); } })).backfill).toMatchObject({ active: false, skipped: "bad_since" });
    expect(offered()).toEqual([]);
  });

  it("offers a backlog window with the SAME drain call as the live path (origin and system actor)", async () => {
    win("bw_back", "sess_a", BACKLOG_AGE);
    const r = await tick();
    expect(r).toMatchObject({ enqueued: 1, considered: 1, backfill: { active: true, candidates: 1, offered: 1, per_room: { room_a: 1 } } });
    expect(H.drained[0]).toMatchObject({ windowId: "bw_back", origin: "https://x.test", opts: { via: "cron" } });
  });

  it("LIVE FIRST: a live-eligible window means no backfill this tick, and the guard/probe is not consulted", async () => {
    win("bw_live", "sess_a", LIVE_AGE);
    win("bw_back", "sess_b", BACKLOG_AGE);
    const r = await tick({ fetchImpl: async () => { throw new Error("must not probe"); } });
    expect(offered()).toEqual(["bw_live"]);
    expect(r.backfill).toMatchObject({ active: false, skipped: "live_set_busy", offered: 0 });
  });

  it("the load guard never blocks LIVE draining: unhealthy router, live window still offered", async () => {
    win("bw_live", "sess_a", LIVE_AGE);
    await tick({ fetchImpl: unhealthy });
    expect(offered()).toEqual(["bw_live"]);
  });

  it("selector: only Transcript-on rooms, closed, grid-aligned, from SINCE to now-max-age, never refused in cooldown, no job in ANY state", async () => {
    win("bw_ok", "sess_a", BACKLOG_AGE);
    win("bw_too_old", "sess_b", OLD_AGE);
    win("bw_room_off", "sess_off", BACKLOG_AGE);
    win("bw_open", "sess_b", BACKLOG_AGE, { state: "open" });
    win("bw_grid", "sess_b", BACKLOG_AGE, { grid: false });
    win("bw_refused", "sess_b", BACKLOG_AGE, { refusedMin: 10 });
    for (const [i, st] of (["queued", "running", "done", "failed", "cancelled"] as const).entries()) {
      win(`bw_job_${st}`, "sess_c", BACKLOG_AGE);
      job(`j_${st}`, `bw_job_${st}`, st, { finishedMinAgo: 100 + i });
    }
    process.env[LIMIT] = "5";
    const r = await tick({ fetchImpl: healthy });
    // the guard sees one queued and one running job (in flight 2 < 5) and one failed of five (20%)
    expect(r.backfill).toMatchObject({ active: true, candidates: 1 });
    expect(offered()).toEqual(["bw_ok"]);
  });

  it("a refusal OLDER than the cooldown is offered again (same row, only the field changed)", async () => {
    win("bw_refused", "sess_a", BACKLOG_AGE, { refusedMin: 24 * 60 });
    await tick();
    expect(offered()).toEqual(["bw_refused"]);
  });

  it("fair across rooms: one per room, newest first within a room, least recently served room first, limit honoured", async () => {
    win("bw_a_old", "sess_a", BACKLOG_AGE + 120);
    win("bw_a_new", "sess_a", BACKLOG_AGE + 60);
    win("bw_b_new", "sess_b", BACKLOG_AGE + 30);
    win("bw_c_new", "sess_c", BACKLOG_AGE + 10);
    // room_b was served 2 h ago (a done job), so it ranks after never-served rooms a and c
    win("bw_b_served", "sess_b", BACKLOG_AGE + 600);
    job("j_b", "bw_b_served", "done", { finishedMinAgo: 120 });
    process.env[LIMIT] = "2";
    await tick();
    expect(offered().sort()).toEqual(["bw_a_new", "bw_c_new"]);
    H.drained.length = 0;
    pg.exec("UPDATE room SET transcript_enabled = (id = 'room_a')");
    process.env[LIMIT] = "5";
    await tick();
    expect(offered(), "one per room, newest in the room").toEqual(["bw_a_new"]);
  });

  it("limit clamp end to end: 9 -> 5 rooms' worth at most, 0 -> 1", async () => {
    for (const r of ["a", "b", "c"]) win(`bw_${r}`, `sess_${r}`, BACKLOG_AGE);
    process.env[LIMIT] = "0";
    await tick();
    expect(offered()).toHaveLength(1);
    H.drained.length = 0;
    // no reset: three newer windows (a later grid slot per room) are what the next tick sees
    for (const r of ["a", "b", "c"]) win(`bw2_${r}`, `sess_${r}`, BACKLOG_AGE);
    process.env[LIMIT] = "9";
    await tick();
    expect(offered()).toHaveLength(3); // 3 rooms, one each; the clamp is 5
  });

  it("guard: router unhealthy skips the tick and says why; healthy again offers", async () => {
    win("bw_back", "sess_a", BACKLOG_AGE);
    const r = await tick({ fetchImpl: unhealthy });
    expect(r.backfill).toMatchObject({ active: false, skipped: "router_unhealthy", offered: 0 });
    expect(offered()).toEqual([]);
    await tick({ fetchImpl: healthy });
    expect(offered()).toEqual(["bw_back"]);
  });

  it("guard: a high recent failure rate skips; the same sample with one fewer failure passes", async () => {
    win("bw_back", "sess_b", BACKLOG_AGE);
    for (let i = 0; i < 6; i++) { win(`bw_h${i}`, "sess_a", BACKLOG_AGE + 500 + i); job(`j_h${i}`, `bw_h${i}`, i < 4 ? "failed" : "done", { finishedMinAgo: 10 + i }); }
    expect((await tick()).backfill).toMatchObject({ skipped: "recent_failure_rate" });
    // append-only: ten newer successful runs push the failures out of the 10-job sample
    for (let i = 0; i < 10; i++) job(`j_k${i}`, `bw_none_${i}`, "done", { finishedMinAgo: 0.5 + i * 0.5 });
    await tick();
    expect(offered()).toEqual(["bw_back"]);
  });

  it("guard: a slow recent average skips; ten newer fast runs clear it", async () => {
    win("bw_back", "sess_b", BACKLOG_AGE);
    for (let i = 0; i < 5; i++) { win(`bw_s${i}`, "sess_a", BACKLOG_AGE + 500 + i); job(`j_s${i}`, `bw_s${i}`, "done", { finishedMinAgo: 10 + i, runS: 2400 }); }
    expect((await tick()).backfill).toMatchObject({ skipped: "recent_latency" });
    for (let i = 0; i < 10; i++) job(`j_f${i}`, `bw_none_${i}`, "done", { finishedMinAgo: 0.5 + i * 0.5, runS: 300 });
    await tick();
    expect(offered()).toEqual(["bw_back"]);
  });

  it("guard: failures older than 12 h are not counted (fresh fixture)", async () => {
    win("bw_back", "sess_b", BACKLOG_AGE);
    for (let i = 0; i < 5; i++) { win(`bw_o${i}`, "sess_a", BACKLOG_AGE + 500 + i); job(`j_o${i}`, `bw_o${i}`, "failed", { finishedMinAgo: 13 * 60 + i }); }
    await tick();
    expect(offered()).toEqual(["bw_back"]);
  });

  it("guard: in-flight room_window jobs at the limit skip the tick (self-pacing)", async () => {
    win("bw_back", "sess_b", BACKLOG_AGE);
    win("bw_f1", "sess_a", BACKLOG_AGE + 500); win("bw_f2", "sess_a", LIVE_AGE + 301);
    job("j_f1", "bw_f1", "queued"); job("j_f2", "bw_f2", "running");
    process.env[LIMIT] = "2";
    expect((await tick()).backfill).toMatchObject({ skipped: "in_flight_at_limit" });
    process.env[LIMIT] = "3";
    await tick();
    expect(offered()).toEqual(["bw_back"]);
  });
});

// ═══ 3. O4 AND THE SHAPE OF THE CODE ════════════════════════════════════════════════════════════

describe("O4 and non-writing", () => {
  const code = readFileSync("lib/stt/auto-drain-backfill.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it("the backfill module names no engine, writes nothing, and cannot reach a paid service", () => {
    expect(code).not.toMatch(/sarvam|clef|llm-roles|openrouter/i);
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
  it("auto-drain reaches the drain only through drainRoomWindow, with the same arguments for live and backfill", () => {
    const src = readFileSync("lib/stt/auto-drain.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src.match(/drainRoomWindow\(/g)).toHaveLength(1);
    expect(src).toContain("drainRoomWindow(w.id, origin, actor)");
  });
});

const _typecheckSql: Sql | null = null; void _typecheckSql;
