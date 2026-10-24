/** OREF R2 adversarial (throwaway; refuter only). Synthetic ids, append-only fixtures (TRUNCATE only between independent fixtures). */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>,
  exec: (_s: string) => {},
  drained: [] as string[],
  steps: {} as Record<string, string | { step: string; detail?: string }>,
  blind: [] as string[],
  n: 0,
}));
vi.mock("@/lib/room-access/check", async (orig) => ({ ...(await orig<Record<string, unknown>>()), blindWindowIds: async () => [...H.blind] }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.mock("@/lib/stt/fanout", async (orig) => ({ ...(await orig<Record<string, unknown>>()), enqueueSubject: async () => ({}) }));
vi.mock("@/lib/stt/room-drain", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  drainRoomWindow: async (windowId: string) => {
    H.drained.push(windowId);
    const s = H.steps[windowId] ?? "enqueued";
    const step = typeof s === "string" ? s : s.step;
    const detail = typeof s === "string" ? undefined : s.detail;
    if (step === "enqueued") {
      H.n += 1;
      H.exec(`INSERT INTO scribe_job (id, kind, args, status) VALUES ('zj_${H.n}', 'room_window', '{"window_id":"${windowId}"}'::jsonb, 'queued');`);
      return { window_id: windowId, ok: true, step, job_id: `zj_${H.n}` };
    }
    return { window_id: windowId, ok: false, step, ...(detail ? { detail } : {}) };
  },
}));

const NEW = await import("@/lib/stt/auto-drain");
const B = await import("@/lib/stt/auto-drain-backfill");
const R1 = await import("../support/auto-drain-backfill-r1");
const SP = await import("@/lib/service-pool");
const MAXAGE = NEW.AUTO_DRAIN_MAX_AGE_HOURS;
const KEYS = ["ROOM_AUTO_DRAIN_ENABLED", "AUTO_DRAIN_BACKFILL_SINCE", "AUTO_DRAIN_BACKFILL_LIMIT", "ETA_ROUTER_URL", "ETA_ROUTER_URLS", "ETA_ROUTER_BULK_URLS", "BULK_AGE_MINUTES", "POOL_BULK_FALLBACK_LIVE", "CRON_SECRET"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); for (const k of KEYS) delete process.env[k]; H.drained.length = 0; H.steps = {}; H.blind = []; });
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const M = "https://mini.z.test", M2 = "https://mini2.z.test", T1 = "https://twin1.z.test", T2 = "https://twin2.z.test";
const fx = (up: Set<string>, urls: string[] = []) => async (u: string) => { urls.push(u); return new Response(JSON.stringify({ ok: [...up].some((b) => u.startsWith(b)) }), { status: 200 }); };

// ── F1: exhaustive env matrix against an INDEPENDENT model of what the job does ─────────────────
describe("F1 matrix: routerHealthy == every pool a backfill job can use has one endpoint up", () => {
  it("all combinations", async () => {
    const maxMin = MAXAGE * 60;
    let n = 0;
    for (const urls of [undefined, `${M},${M2}`]) for (const single of [undefined, M]) for (const bulk of [undefined, T1, `${T1},${T2}`])
      for (const age of [undefined, "60", String(maxMin), String(maxMin + 1), "1440", "soon"]) for (const fb of [undefined, "1", "0", "maybe"]) {
        const env: Record<string, string | undefined> = { ETA_ROUTER_URLS: urls, ETA_ROUTER_URL: single, ETA_ROUTER_BULK_URLS: bulk, BULK_AGE_MINUTES: age, POOL_BULK_FALLBACK_LIVE: fb };
        const all = [M, M2, T1, T2, "https://route.llmvinayminihome.uk"];
        for (let mask = 0; mask < 32; mask++) {
          const up = new Set(all.filter((_, i) => mask & (1 << i)));
          // model: backlog windows closed between maxAge (+1 min) and 60 d ago; each picks bulk by isBulkWindow at run time.
          const now = Date.now();
          const pools = new Set<string>();
          for (const closedAgoMin of [maxMin + 1, maxMin + 30, 2000, 60 * 24 * 60]) {
            const isBulk = SP.isBulkWindow(now - closedAgoMin * 60_000, now, env);
            const list = SP.poolEndpoints("router", { bulk: isBulk, fallback: "https://route.llmvinayminihome.uk" }, isBulk ? { ...env, POOL_BULK_FALLBACK_LIVE: undefined } : env);
            pools.add(JSON.stringify(list));
          }
          const want = [...pools].every((p) => (JSON.parse(p) as string[]).some((b) => up.has(b)));
          const got = await B.routerHealthy(fx(up), env, maxMin);
          expect(got, `${JSON.stringify(env)} up=${[...up]}`).toBe(want);
          n++;
        }
      }
    expect(n).toBeGreaterThan(5000);
  }, 60_000);

  it("each endpoint is probed at most once per call (bulk list == ordinary list when no BULK_URLS)", async () => {
    const urls: string[] = [];
    await B.routerHealthy(fx(new Set()), { ETA_ROUTER_URLS: `${M},${M2}`, BULK_AGE_MINUTES: "1440" }, 360);
    expect(urls.length).toBe(0); // fx captured into a different array; re-run capturing
    const seen: string[] = [];
    await B.routerHealthy(fx(new Set(), seen), { ETA_ROUTER_URLS: `${M},${M2}`, BULK_AGE_MINUTES: "1440" }, 360);
    expect(seen).toEqual([`${M}/healthz`, `${M2}/healthz`]);
  });
});

// ── F2: the route ────────────────────────────────────────────────────────────────────────────────
describe("F2 route: live cap unchanged, backfill cap reported separately, caller limit forwarded only when given", () => {
  const call = async (q: string) => {
    const route = await import("@/app/api/admin/drain-windows/route");
    return route.GET(new NextRequest(`https://x.test/api/admin/drain-windows${q}`, { headers: { authorization: "Bearer z-cron" } }));
  };
  it("no backfill field -> response keys exactly as before (no backfill_cap); ?limit forwarded raw, cap = live clamp", async () => {
    process.env.CRON_SECRET = "z-cron";
    // flag off: enqueueAutoDrain returns the empty result, no backfill field
    for (const q of ["", "?limit=3", "?limit=abc", "?limit=0", "?limit=-2"]) {
      const res = await call(q);
      expect(res.status, q).toBe(200);
      const body = await res.json();
      expect(body.cap, q).toBe(q === "?limit=3" ? Math.min(NEW.AUTO_DRAIN_BATCH_LIMIT, 3) : NEW.AUTO_DRAIN_BATCH_LIMIT);
      expect("backfill_cap" in body, q).toBe(false);
      expect(Object.keys(body).sort(), q).toEqual(["cap", "considered", "enqueued", "max_age_hours", "n_blind_excluded", "refusal_cooldown_minutes", "results", ...(("ok" in body) ? ["ok"] : [])].sort());
    }
  });
});

// ── pg-backed ────────────────────────────────────────────────────────────────────────────────────
const istDate = (ms: number) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10);
const healthy = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const HAVE = dockerAvailable();
const pg = pgContainer("eta-oref2-r2z");
const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");
const ROOMS = ["r1", "r2", "r3", "r4"];
beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  const m = readFileSync("db/migrations/0041_room_bench.sql", "utf8");
  const keep = (x: string) => { const i = m.indexOf(`CREATE TABLE IF NOT EXISTS ${x} (`); return m.slice(i, m.indexOf(");", i) + 2); };
  pg.exec("CREATE TABLE schema_migrations (version int PRIMARY KEY, name text);");
  pg.exec(keep("room"));
  pg.exec(noRecord("db/migrations/0065_room_processing_switches.sql"));
  pg.exec(keep("bench_session"));
  pg.exec(ROOMS.map((r) => `INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) VALUES ('${r}','${r}','${r}','x',TRUE); INSERT INTO bench_session (id, room_id) VALUES ('s_${r}','${r}'), ('s2_${r}','${r}');`).join("\n"));
  pg.exec("INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) VALUES ('roff','roff','roff','x',FALSE); INSERT INTO bench_session (id, room_id) VALUES ('s_roff','roff');");
  for (const f of ["0057_bench_window", "0061_stt_subject_job", "0082_scribe_job", "0092_bench_window_auto_drain_refusal", "0100_bench_window_auto_drain_refused_idx"]) pg.exec(noRecord(`db/migrations/${f}.sql`));
  H.exec = (s) => pg.exec(s);
}, 180_000);
afterAll(() => { if (HAVE) pg.stop(); });

let slot = 0;
function win(id: string, sess: string, ageMin: number, o: { refusedMin?: number; reason?: string; slotOf?: number; closedSql?: string } = {}) {
  slot += 1;
  const s = o.slotOf ?? slot;
  pg.exec(`INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, grid_aligned, state, closed_at, auto_drain_refused_at, auto_drain_refused_reason)
    VALUES ('${id}','${sess}','rd_1',${s * 900_000},${s * 900_000 + 900_000},'${o.slotOf !== undefined ? `m_${id}` : "primary"}',TRUE,'closed', ${o.closedSql ?? `NOW() - (${ageMin} * INTERVAL '1 minute')`},
    ${o.refusedMin === undefined ? "NULL" : `NOW() - (${o.refusedMin} * INTERVAL '1 minute')`}, ${o.reason ? `'${o.reason}'` : "NULL"});`);
}
const reset = () => { pg.exec("TRUNCATE bench_window, scribe_job, stt_subject_job;"); H.sql = pg.sql as never; process.env.ROOM_AUTO_DRAIN_ENABLED = "1"; slot = 0; };
const tick = (o: { limit?: number; fetchImpl?: (u: string, i: RequestInit) => Promise<Response> } = {}) =>
  NEW.enqueueAutoDrain("https://x.test", { log: () => {}, fetchImpl: o.fetchImpl ?? healthy, ...(o.limit !== undefined ? { limit: o.limit } : {}) });
const toC = (rows: Array<Record<string, unknown>>, b: Set<string>) => rows.filter((e) => !b.has(String(e.id))).map((e) => ({
  id: String(e.id), room_id: String(e.room_id), start_ms: Number(e.start_ms), end_ms: Number(e.end_ms), closed_ms: Number(e.closed_ms),
  last_served_ms: e.last_served_ms === null || e.last_served_ms === undefined ? null : Number(e.last_served_ms),
}));

describe.skipIf(!HAVE)("OREF R2 pg", () => {
  beforeEach(reset);

  it("F1 wired: enqueueAutoDrain passes max age — BULK_AGE=60, Mini down, twin up: backfill runs; twin down: skipped; live never probes", async () => {
    process.env.AUTO_DRAIN_BACKFILL_SINCE = istDate(Date.now() - 5 * 86_400_000);
    Object.assign(process.env, { ETA_ROUTER_URL: M, ETA_ROUTER_BULK_URLS: T1, BULK_AGE_MINUTES: "60" });
    win("f1_b", "s_r1", (MAXAGE + 1) * 60);
    let r = await tick({ fetchImpl: fx(new Set([T1])) });
    expect(r.backfill).toMatchObject({ active: true });
    expect(H.drained).toEqual(["f1_b"]);
    reset(); process.env.AUTO_DRAIN_BACKFILL_SINCE = istDate(Date.now() - 5 * 86_400_000); H.drained.length = 0;
    win("f1_c", "s_r1", (MAXAGE + 1) * 60);
    r = await tick({ fetchImpl: fx(new Set([M])) });
    expect(r.backfill).toMatchObject({ active: false, skipped: "router_unhealthy" });
    expect(H.drained).toEqual([]);
    win("f1_live", "s_r2", 5);
    const probes: string[] = [];
    r = await tick({ fetchImpl: fx(new Set(), probes) });
    expect(H.drained).toEqual(["f1_live"]);
    expect(probes).toEqual([]);
  });

  it("F2: caller limit min'd with the backfill cap; absent = backfill's own; cap reported", async () => {
    process.env.AUTO_DRAIN_BACKFILL_SINCE = istDate(Date.now() - 5 * 86_400_000);
    process.env.AUTO_DRAIN_BACKFILL_LIMIT = "3";
    for (const r of ROOMS) win(`f2_${r}`, `s_${r}`, (MAXAGE + 1) * 60);
    let res = await tick({ limit: 9 });
    expect(res.backfill).toMatchObject({ cap: 3, offered: 3 });
    reset(); process.env.AUTO_DRAIN_BACKFILL_SINCE = istDate(Date.now() - 5 * 86_400_000); process.env.AUTO_DRAIN_BACKFILL_LIMIT = "3";
    for (const r of ROOMS) win(`f2b_${r}`, `s_${r}`, (MAXAGE + 1) * 60);
    res = await tick({ limit: 2 });
    expect(res.backfill).toMatchObject({ cap: 2, offered: 2 });
    reset(); process.env.AUTO_DRAIN_BACKFILL_SINCE = istDate(Date.now() - 5 * 86_400_000); process.env.AUTO_DRAIN_BACKFILL_LIMIT = "3";
    for (const r of ROOMS) win(`f2c_${r}`, `s_${r}`, (MAXAGE + 1) * 60);
    res = await tick();
    expect(res.backfill).toMatchObject({ cap: 3, offered: 3 });
  });

  it("F3 own differential: blind newest per room, all-blind room, refused-in-cooldown newest, two sessions per room, transcript-off room, done jobs", async () => {
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const since = Date.now() - 5 * 86_400_000;
    for (let trial = 0; trial < 30; trial++) {
      reset();
      const ids: string[] = [];
      const sess = ["s_r1", "s2_r1", "s_r2", "s2_r2", "s_r3", "s_r4", "s_roff"];
      for (let i = 0; i < 16; i++) {
        const id = `z${trial}_${i}`; ids.push(id);
        win(id, sess[Math.floor(rnd() * sess.length)], (MAXAGE + 1) * 60 + Math.floor(rnd() * 4000), {
          refusedMin: rnd() < 0.3 ? Math.floor(rnd() * 200) : undefined, slotOf: rnd() < 0.3 ? 1 + Math.floor(rnd() * 3) : undefined,
        });
        if (rnd() < 0.2) pg.exec(`INSERT INTO scribe_job (id,kind,args,status,created_at) VALUES ('zj${trial}_${i}','room_window','{"window_id":"${id}"}','${rnd() < 0.5 ? "done" : "failed"}',NOW()-INTERVAL '${Math.floor(rnd() * 2000)} minutes');`);
      }
      // blind = each room's newest few (the dangerous case) plus random
      const newest = (await pg.sql`SELECT DISTINCT ON (s.room_id) w.id FROM bench_window w JOIN bench_session s ON s.id = w.session_id ORDER BY s.room_id, w.end_ms DESC`) as Array<{ id: string }>;
      const blind = [...new Set([...newest.map((x) => x.id).filter(() => rnd() < 0.7), ...ids.filter(() => rnd() < 0.15)])];
      const o = { sinceMs: since, maxAgeHours: MAXAGE, cooldownMinutes: 60 };
      const old = NEW.orderAutoDrainOffers(toC(await R1.scanBackfillCandidates(pg.sql as never, o), new Set(blind)), 5).map((c) => c.id);
      const neuRows = await B.scanBackfillCandidates(pg.sql as never, { ...o, blind, maxRefusals: 3 });
      expect(neuRows.some((r) => blind.includes(String(r.id))), `trial ${trial} blind leaked`).toBe(false);
      const neu = NEW.orderAutoDrainOffers(toC(neuRows, new Set()), 5).map((c) => c.id);
      expect(neu, `trial ${trial}`).toEqual(old);
    }
  }, 180_000);

  it("F3 tie order: exact slot+closed_at tie broken by id — SQL collation vs JS code-unit order", async () => {
    const coll = (await pg.sql`SELECT datcollate FROM pg_database WHERE datname = current_database()`) as Array<{ datcollate: string }>;
    const since = Date.now() - 5 * 86_400_000;
    const closedSql = `TIMESTAMPTZ '2026-10-20 10:00:00+00'`;
    win("bw_B", "s_r1", 0, { slotOf: 7, closedSql });
    win("bw_a", "s2_r1", 0, { slotOf: 7, closedSql });
    const o = { sinceMs: since, maxAgeHours: MAXAGE, cooldownMinutes: 60 };
    const old = NEW.orderAutoDrainOffers(toC(await R1.scanBackfillCandidates(pg.sql as never, o), new Set()), 5).map((c) => c.id);
    const neu = NEW.orderAutoDrainOffers(toC(await B.scanBackfillCandidates(pg.sql as never, { ...o, blind: [], maxRefusals: 3 }), new Set()), 5).map((c) => c.id);
    console.log(`[oref] collation=${coll[0]?.datcollate} R1=${old} R2=${neu}`);
    expect({ coll: coll[0]?.datcollate, old, neu }).toMatchObject({ old: ["bw_B"] });
  });

  it("F4: live plain reason ages into backfill and counts from 1; claim_lost transient; wrong_state(other) permanent; alternating transient resets the count", async () => {
    process.env.AUTO_DRAIN_BACKFILL_SINCE = istDate(Date.now() - 5 * 86_400_000);
    process.env.AUTO_DRAIN_BACKFILL_LIMIT = "5";
    win("f4_aged", "s_r1", (MAXAGE + 1) * 60, { refusedMin: 120, reason: "too_long" });
    win("f4_claim", "s_r2", (MAXAGE + 1) * 60);
    win("f4_ws", "s_r3", (MAXAGE + 1) * 60);
    H.steps = { f4_aged: "too_long", f4_claim: { step: "wrong_state", detail: "claim_lost" }, f4_ws: { step: "wrong_state", detail: "transcribed" } };
    const reason = async (id: string) => ((await pg.sql`SELECT auto_drain_refused_reason AS r FROM bench_window WHERE id = ${id}`) as Array<{ r: string }>)[0].r;
    await tick();
    expect(await reason("f4_aged")).toBe("too_long#1");
    expect(await reason("f4_claim")).toBe("wrong_state");
    expect(await reason("f4_ws")).toBe("wrong_state#1");
    const age = () => pg.exec("UPDATE bench_window SET auto_drain_refused_at = NOW() - INTERVAL '2 days' WHERE auto_drain_refused_at IS NOT NULL;");
    age(); await tick(); age(); await tick(); age();
    H.drained.length = 0;
    const r = await tick();
    expect(H.drained.sort()).toEqual(["f4_claim"]);
    expect(r.backfill?.parked_permanent).toBe(2);
    // un-park: no operator path in code; a successful enqueue (e.g. after a manual fix) clears it as before
  });

  it("F2 route with backfill: cap = live clamp, backfill_cap = min(backfill limit, ?limit); absent ?limit = backfill's own", async () => {
    process.env.CRON_SECRET = "z-cron";
    process.env.AUTO_DRAIN_BACKFILL_SINCE = istDate(Date.now() - 5 * 86_400_000);
    process.env.AUTO_DRAIN_BACKFILL_LIMIT = "4";
    vi.stubGlobal("fetch", healthy);
    try {
      const route = await import("@/app/api/admin/drain-windows/route");
      const get = async (q: string) => (await route.GET(new NextRequest(`https://x.test/api/admin/drain-windows${q}`, { headers: { authorization: "Bearer z-cron" } }))).json();
      for (const r of ROOMS) win(`rt_${r}`, `s_${r}`, (MAXAGE + 1) * 60);
      let b = await get("?limit=1");
      expect(b.cap).toBe(1); expect(b.backfill_cap).toBe(1); expect(b.backfill.offered).toBe(1);
      b = await get("");
      expect(b.cap).toBe(NEW.AUTO_DRAIN_BATCH_LIMIT); expect(b.backfill_cap).toBe(3 >= 0 ? Math.min(4, 4) : 0); expect(b.backfill.offered).toBe(3);
    } finally { vi.unstubAllGlobals(); }
  });

  it("F4: parked count never returns ids; a parked window is not offered even when its room has nothing else", async () => {
    process.env.AUTO_DRAIN_BACKFILL_SINCE = istDate(Date.now() - 5 * 86_400_000);
    win("pk", "s_r1", (MAXAGE + 1) * 60, { refusedMin: 3000, reason: "too_long#3" });
    win("pk_hi", "s_r2", (MAXAGE + 1) * 60, { refusedMin: 3000, reason: "too_long#2" });
    const r = await tick();
    expect(H.drained).toEqual(["pk_hi"]);
    expect(r.backfill).toMatchObject({ parked_permanent: 1, candidates: 1 });
    expect(JSON.stringify(r)).not.toContain("\"pk\"");
  });
});
