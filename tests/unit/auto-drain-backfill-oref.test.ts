/** OREF adversarial tests for the auto-drain backfill (throwaway; refuter only). Synthetic ids, append-only fixtures. */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>,
  exec: (_s: string) => {},
  drained: [] as string[],
  steps: {} as Record<string, string>,
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
    const step = H.steps[windowId] ?? "enqueued";
    if (step === "enqueued") {
      // as production's submit does: a room_window job row appears
      H.n += 1;
      H.exec(`INSERT INTO scribe_job (id, kind, args, status) VALUES ('oj_${H.n}', 'room_window', '{"window_id":"${windowId}"}'::jsonb, 'queued');`);
      return { window_id: windowId, ok: true, step, job_id: `oj_${H.n}` };
    }
    return { window_id: windowId, ok: false, step };
  },
}));

const NEW = await import("@/lib/stt/auto-drain");
const MAIN = await import("../support/auto-drain-main-baseline");
const B = await import("@/lib/stt/auto-drain-backfill");
const R1 = await import("../support/auto-drain-backfill-r1");
const MAXAGE = NEW.AUTO_DRAIN_MAX_AGE_HOURS;

const KEYS = ["ROOM_AUTO_DRAIN_ENABLED", "AUTO_DRAIN_BACKFILL_SINCE", "AUTO_DRAIN_BACKFILL_LIMIT", "ETA_ROUTER_URL", "ETA_ROUTER_URLS", "ETA_ROUTER_BULK_URLS", "BULK_AGE_MINUTES", "POOL_BULK_FALLBACK_LIVE"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); for (const k of KEYS) delete process.env[k]; H.drained.length = 0; H.steps = {}; H.blind = []; });
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const istDate = (ms: number) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10);
const healthy = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const HAVE = dockerAvailable();
const pg = pgContainer("eta-oref-backfill");
const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");
const ROOMS = ["r1", "r2", "r3", "r4"];

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  const m = readFileSync("db/migrations/0041_room_bench.sql", "utf8");
  const keep = (n: string) => { const i = m.indexOf(`CREATE TABLE IF NOT EXISTS ${n} (`); return m.slice(i, m.indexOf(");", i) + 2); };
  pg.exec("CREATE TABLE schema_migrations (version int PRIMARY KEY, name text);");
  pg.exec(keep("room"));
  pg.exec(noRecord("db/migrations/0065_room_processing_switches.sql"));
  pg.exec(keep("bench_session"));
  pg.exec(ROOMS.map((r) => `INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) VALUES ('${r}','${r}','${r}','x',TRUE); INSERT INTO bench_session (id, room_id) VALUES ('s_${r}','${r}');`).join("\n"));
  pg.exec("INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) VALUES ('roff','roff','roff','x',FALSE); INSERT INTO bench_session (id, room_id) VALUES ('s_roff','roff');");
  for (const f of ["0057_bench_window", "0061_stt_subject_job", "0082_scribe_job", "0092_bench_window_auto_drain_refusal", "0100_bench_window_auto_drain_refused_idx"]) pg.exec(noRecord(`db/migrations/${f}.sql`));
  H.exec = (s) => pg.exec(s);
}, 180_000);
afterAll(() => { if (HAVE) pg.stop(); });

let slot = 0;
function win(id: string, room: string, ageMin: number, o: { refusedMin?: number; state?: string } = {}) {
  slot += 1;
  pg.exec(`INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, grid_aligned, state, closed_at, auto_drain_refused_at)
    VALUES ('${id}','s_${room}','rd_1',${slot * 900_000},${slot * 900_000 + 900_000},'primary',TRUE,'${o.state ?? "closed"}', NOW() - (${ageMin} * INTERVAL '1 minute'),
    ${o.refusedMin === undefined ? "NULL" : `NOW() - (${o.refusedMin} * INTERVAL '1 minute')`});`);
}
const reset = () => { pg.exec("TRUNCATE bench_window, scribe_job, stt_subject_job; UPDATE room SET transcript_enabled = (id <> 'roff');"); H.sql = pg.sql as never; process.env.ROOM_AUTO_DRAIN_ENABLED = "1"; };
const runnerFinishesAll = () => pg.exec("UPDATE scribe_job SET status='done', started_at=NOW()-INTERVAL '5 minutes', finished_at=NOW() WHERE status IN ('queued','running');");
const tickNew = (o: { limit?: number; log?: (m: string) => void; fetchImpl?: typeof healthy } = {}) => NEW.enqueueAutoDrain("https://x.test", { log: o.log ?? (() => {}), fetchImpl: o.fetchImpl ?? healthy, ...(o.limit ? { limit: o.limit } : {}) });

describe.skipIf(!HAVE)("OREF adversarial", () => {
  beforeEach(reset);

  it("differential: live selection identical to main over random fixtures (SINCE unset, and SINCE set with a live window)", async () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let trial = 0; trial < 12; trial++) {
      const fx: Array<[string, string, number, number | undefined]> = [];
      for (let i = 0; i < 10; i++) fx.push([`w${trial}_${i}`, ROOMS[Math.floor(rnd() * 4)], Math.floor(rnd() * 600), rnd() < 0.2 ? Math.floor(rnd() * 120) : undefined]);
      fx.push([`wlive${trial}`, "r1", 10, undefined]);
      const load = () => { reset(); delete process.env.AUTO_DRAIN_BACKFILL_SINCE; slot = 0; for (const [id, r, a, ref] of fx) win(id, r, a, { refusedMin: ref }); if (trial % 3 === 0) pg.exec(`INSERT INTO scribe_job (id,kind,args,status,created_at) VALUES ('pre${trial}','room_window','{"window_id":"${fx[0][0]}"}','done',NOW()-INTERVAL '1 hour');`); };
      for (const since of [undefined, istDate(Date.now() - 3 * 86_400_000)]) {
        load(); if (since) process.env.AUTO_DRAIN_BACKFILL_SINCE = since; H.drained.length = 0;
        const m = await MAIN.enqueueAutoDrain("https://x.test", { log: () => {} });
        const dm = [...H.drained];
        load(); if (since) process.env.AUTO_DRAIN_BACKFILL_SINCE = since; H.drained.length = 0;
        const n = await tickNew();
        expect(H.drained, `trial ${trial} since ${since}`).toEqual(dm);
        const { backfill, ...rest } = n;
        const strip = (x: typeof m) => ({ ...x, results: x.results.map(({ job_id: _j, ...q }) => q) });
        expect(strip(rest as typeof m)).toEqual(strip(m));
        if (!since) expect(backfill).toBeUndefined(); else expect(backfill).toMatchObject({ skipped: "live_set_busy" });
      }
    }
  }, 120_000);

  it("drain-down over many ticks: every eligible window offered exactly once, newest-first per room, round-robin across rooms", async () => {
    process.env.AUTO_DRAIN_BACKFILL_SINCE = istDate(Date.now() - 5 * 86_400_000);
    const plan: Record<string, string[]> = {};
    for (const r of ROOMS) { plan[r] = []; for (let k = 0; k < (r === "r4" ? 1 : 4); k++) { const id = `b_${r}_${k}`; win(id, r, (MAXAGE + 2) * 60 + k * 30); plan[r].push(id); } }
    win("b_off", "roff", (MAXAGE + 2) * 60);
    const seq: string[] = [];
    for (let t = 0; t < 30; t++) {
      H.drained.length = 0;
      const r = await tickNew();
      seq.push(...H.drained);
      runnerFinishesAll();
      if (r.backfill?.active && r.backfill.candidates === 0) break;
    }
    expect(new Set(seq).size).toBe(seq.length);
    expect(seq.sort()).toEqual(Object.values(plan).flat().sort());
  }, 120_000);

  it("order: within a room newest first, and a room never gets its (k+1)-th turn while another still waits for its k-th", async () => {
    process.env.AUTO_DRAIN_BACKFILL_SINCE = istDate(Date.now() - 5 * 86_400_000);
    for (const r of ROOMS.slice(0, 3)) for (let k = 2; k >= 0; k--) win(`o_${r}_${k}`, r, (MAXAGE + 2) * 60 + k * 30); // k=0 newest
    const seq: string[] = [];
    for (let t = 0; t < 12; t++) { H.drained.length = 0; await tickNew(); seq.push(...H.drained); runnerFinishesAll(); }
    expect(seq).toHaveLength(9);
    const turns: Record<string, number> = {};
    for (const id of seq) {
      const [, r, k] = id.split("_");
      expect(Number(k), `${id} newest-first`).toBe(turns[r] ?? 0);
      turns[r] = (turns[r] ?? 0) + 1;
      expect(Math.max(...Object.values(turns)) - Math.min(...ROOMS.slice(0, 3).map((x) => turns[x] ?? 0))).toBeLessThanOrEqual(1);
    }
  }, 120_000);

  it("a live window arriving mid-backfill wins the very next tick", async () => {
    process.env.AUTO_DRAIN_BACKFILL_SINCE = istDate(Date.now() - 5 * 86_400_000);
    for (let k = 0; k < 4; k++) win(`l_r1_${k}`, "r1", (MAXAGE + 2) * 60 + k);
    await tickNew(); runnerFinishesAll();
    win("live_now", "r2", 1);
    H.drained.length = 0;
    const r = await tickNew();
    expect(H.drained).toEqual(["live_now"]);
    expect(r.backfill?.skipped).toBe("live_set_busy");
  });

  it("blind windows are never offered by the backfill", async () => {
    process.env.AUTO_DRAIN_BACKFILL_SINCE = istDate(Date.now() - 5 * 86_400_000);
    win("bl_old", "r1", (MAXAGE + 3) * 60);
    win("bl_new", "r1", (MAXAGE + 1) * 60);
    H.blind = ["bl_new"];
    const r = await tickNew();
    expect(H.drained).toEqual(["bl_old"]);
    expect(r.backfill?.candidates).toBe(1);
  });

  it("boundaries: max-age split is complementary; SINCE is IST midnight inclusive", async () => {
    const since = istDate(Date.now() - 3 * 86_400_000);
    const sinceMs = B.parseBackfillSince(since)!;
    process.env.AUTO_DRAIN_BACKFILL_SINCE = since;
    win("edge_live", "r1", MAXAGE * 60 - 1);
    const r1 = await tickNew();
    expect(H.drained).toEqual(["edge_live"]); expect(r1.backfill?.skipped).toBe("live_set_busy");
    reset(); process.env.AUTO_DRAIN_BACKFILL_SINCE = since; H.drained.length = 0;
    win("edge_back", "r1", MAXAGE * 60 + 1);
    pg.exec(`INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, grid_aligned, state, closed_at) VALUES
      ('since_in','s_r2','rd_1',1,900001,'primary',TRUE,'closed',to_timestamp(${sinceMs / 1000 + 60})),
      ('since_out','s_r3','rd_1',1,900001,'primary',TRUE,'closed',to_timestamp(${sinceMs / 1000 - 60}));`);
    process.env.AUTO_DRAIN_BACKFILL_LIMIT = "5";
    await tickNew();
    expect(H.drained.sort()).toEqual(["edge_back", "since_in"]);
  });

  it("malformed SINCE values are off with a reason, no probe, no offer", async () => {
    win("m1", "r1", (MAXAGE + 1) * 60);
    for (const bad of ["2026/10/05", "2026-10-05T00:00", "0000-00-00", "2026-00-10", "+2026-10-05", "２０２６-10-05", "2026-10-05,2026-10-06"]) {
      process.env.AUTO_DRAIN_BACKFILL_SINCE = bad; H.drained.length = 0;
      const r = await tickNew({ fetchImpl: async () => { throw new Error("probe"); } });
      expect(r.backfill, bad).toMatchObject({ active: false, skipped: "bad_since" });
      expect(H.drained).toEqual([]);
    }
  });

  it("unset SINCE: no backfill SQL is issued at all (counted at the sql seam)", async () => {
    win("u1", "r1", (MAXAGE + 1) * 60);
    const texts: string[] = [];
    H.sql = (async (s: TemplateStringsArray, ...v: unknown[]) => { texts.push(s.join("?")); return (pg.sql as never as typeof H.sql)(s, ...v); }) as never;
    let probed = 0;
    await tickNew({ fetchImpl: async () => { probed++; return healthy(); } });
    expect(probed).toBe(0);
    expect(texts.some((t) => /BACKFILL|in_flight|finished_at >= NOW\(\)/.test(t) || /closed_at < NOW\(\)/.test(t))).toBe(false);
    expect(texts).toHaveLength(1); // the live scan only
  });

  it("a refused backlog window waits out the cooldown and does not block its room", async () => {
    process.env.AUTO_DRAIN_BACKFILL_SINCE = istDate(Date.now() - 5 * 86_400_000);
    win("rf_old", "r1", (MAXAGE + 2) * 60); win("rf_new", "r1", (MAXAGE + 1) * 60);
    H.steps.rf_new = "too_long";
    await tickNew(); runnerFinishesAll();
    H.drained.length = 0; await tickNew();
    expect(H.drained).toEqual(["rf_old"]);
  });

  it("F2: the caller's limit=1 caps the backfill too (min of the two), and is reported as the backfill cap", async () => {
    process.env.AUTO_DRAIN_BACKFILL_SINCE = istDate(Date.now() - 5 * 86_400_000);
    for (const r of ROOMS) win(`cl_${r}`, r, (MAXAGE + 1) * 60);
    const r = await tickNew({ limit: 1 });
    expect(H.drained).toHaveLength(1);
    expect(r.backfill?.cap).toBe(1);
  });

  it("log lines carry no URL, host or credential", async () => {
    process.env.AUTO_DRAIN_BACKFILL_SINCE = istDate(Date.now() - 5 * 86_400_000);
    process.env.ETA_ROUTER_BULK_URLS = "https://bulk-a.oref.test";
    win("lg", "r1", (MAXAGE + 1) * 60);
    const logs: string[] = [];
    await tickNew({ log: (m) => logs.push(m), fetchImpl: async () => new Response("{}", { status: 200 }) });
    await tickNew({ log: (m) => logs.push(m) });
    expect(logs.join("\n")).not.toMatch(/oref\.test|https?:|CF-Access/);
    expect(logs.join("\n")).toMatch(/router_unhealthy/);
  });

  it("RTF and windows-per-day SQL from the report is correct on fixtures", async () => {
    pg.exec(`INSERT INTO scribe_job (id,kind,args,status,started_at,finished_at,result) VALUES
      ('rt1','room_window','{}','done', NOW()-INTERVAL '300 seconds', NOW(), '{"audio_seconds":900,"silent_window":false}'),
      ('rt2','room_window','{}','done', NOW()-INTERVAL '450 seconds', NOW(), '{"audio_seconds":900,"silent_window":false}'),
      ('rt3','room_window','{}','done', NOW()-INTERVAL '10 seconds', NOW(), '{"audio_seconds":900,"silent_window":true}'),
      ('rt4','room_window','{}','failed', NOW()-INTERVAL '10 seconds', NOW(), NULL),
      ('rt5','route_transcribe','{}','done', NOW()-INTERVAL '10 seconds', NOW(), '{"audio_seconds":900}');`);
    const rows = (await pg.sql`SELECT date_trunc('day', finished_at AT TIME ZONE 'Asia/Kolkata') AS ist_day, count(*) AS windows_done,
       round(avg((result->>'audio_seconds')::float8 / NULLIF(EXTRACT(EPOCH FROM finished_at - started_at),0))::numeric,2) AS rtf_avg
  FROM scribe_job WHERE kind='room_window' AND status='done' AND (result->>'silent_window') IS DISTINCT FROM 'true'
   AND result->>'audio_seconds' IS NOT NULL GROUP BY 1 ORDER BY 1 DESC`) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].windows_done)).toBe(2);
    expect(Number(rows[0].rtf_avg)).toBe(2.5);
  });

  it("EXPLAIN at volume: 18 d x 9 rooms x 60 + history", async () => {
    pg.exec(`INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) SELECT 'v'||g,'v'||g,'v','x',TRUE FROM generate_series(1,9) g;
      INSERT INTO bench_session (id, room_id) SELECT 'sv'||g,'v'||g FROM generate_series(1,9) g;
      INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, grid_aligned, state, closed_at)
        SELECT 'bv_'||r||'_'||d||'_'||k, 'sv'||r, 'rd_'||d, (d*100+k)::bigint*900000, (d*100+k)::bigint*900000+900000, 'primary', TRUE,
               CASE WHEN d < 18 THEN 'closed' ELSE (CASE WHEN k % 5 = 0 THEN 'closed' ELSE 'transcribed' END) END,
               NOW() - ((d*24*60 + k*10 + 7*60) * INTERVAL '1 minute')
          FROM generate_series(1,9) r, generate_series(0,60) d, generate_series(1,60) k;
      INSERT INTO scribe_job (id, kind, args, status, created_at, started_at, finished_at)
        SELECT 'jv'||g, CASE WHEN g % 3 = 0 THEN 'room_window' ELSE 'other_kind' END, jsonb_build_object('window_id','bv_1_40_'||g), 'done',
               NOW() - (g * INTERVAL '1 minute'), NOW() - (g * INTERVAL '1 minute'), NOW() - (g * INTERVAL '1 minute') FROM generate_series(1,60000) g;
      ANALYZE;`);
    const sinceMs = Date.now() - 18 * 86_400_000;
    const cap: string[] = [];
    let t0 = Date.now();
    const rows = await B.scanBackfillCandidates(pg.sql as never, { sinceMs, maxAgeHours: MAXAGE, cooldownMinutes: 60, blind: [], maxRefusals: 3 });
    const ms = Date.now() - t0;
    let text = "";
    const capture = (async (s: TemplateStringsArray, ...v: unknown[]) => { text = s.reduce((a, p, i) => a + p + (i < v.length ? (typeof v[i] === "number" ? String(v[i]) : Array.isArray(v[i]) ? "'{}'" : `'${String(v[i])}'`) : ""), ""); return []; }) as never;
    await B.scanBackfillCandidates(capture, { sinceMs, maxAgeHours: MAXAGE, cooldownMinutes: 60, blind: [], maxRefusals: 3 });
    const plan = execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-U", "postgres", "-d", "postgres"], { input: "EXPLAIN (ANALYZE, BUFFERS) " + text + ";", encoding: "utf8" });
    cap.push(`rows=${rows.length} wall_ms=${ms}`, plan);
    // PROPOSAL ONLY (not a migration in this branch): the expression index, built in this throwaway container.
    pg.exec("CREATE INDEX proposal_scribe_job_room_window_wid ON scribe_job ((args->>'window_id')) WHERE kind = 'room_window'; ANALYZE scribe_job;");
    const plan2 = execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-U", "postgres", "-d", "postgres"], { input: "EXPLAIN (ANALYZE, BUFFERS) " + text + ";", encoding: "utf8" });
    cap.push("--- WITH PROPOSED INDEX ---", plan2);
    t0 = Date.now(); const g = await B.readGuardStats(pg.sql as never); cap.push(`guard_ms=${Date.now() - t0} ${JSON.stringify(g)}`);
    writeFileSync(".bc/oref-explain.txt", cap.join("\n") + "\n");
    expect(rows.length).toBe(9); // F3: one row per room crosses the wire, not ~10k
  }, 180_000);
});

describe("healthz bounded", () => {
  it("a hung router: routerHealthy returns false within the timeout per endpoint", async () => {
    const hang = (_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    let t0 = Date.now();
    expect(await B.routerHealthy(hang, {})).toBe(false);
    expect(Date.now() - t0).toBeLessThan(B.BACKFILL_HEALTHZ_TIMEOUT_MS + 1500);
    t0 = Date.now();
    expect(await B.routerHealthy(hang, { ETA_ROUTER_BULK_URLS: "https://a.oref.test,https://b.oref.test", BULK_AGE_MINUTES: "1" })).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2 * B.BACKFILL_HEALTHZ_TIMEOUT_MS + 1500);
  }, 20_000);
  it("a body that streams forever after headers is still bounded by the same signal", async () => {
    const slowBody = async (_u: string, init: RequestInit) => new Response(new ReadableStream({ start(c) { init.signal?.addEventListener("abort", () => c.error(new Error("aborted"))); } }), { status: 200 });
    const t0 = Date.now();
    expect(await B.routerHealthy(slowBody as never, {})).toBe(false);
    expect(Date.now() - t0).toBeLessThan(B.BACKFILL_HEALTHZ_TIMEOUT_MS + 1500);
  }, 20_000);
  it("service-access headers are attached for an allowed host", async () => {
    let hdr: Headers | undefined;
    await B.routerHealthy(async (_u, i) => { hdr = new Headers(i.headers); return healthy(); }, { CF_ACCESS_CLIENT_ID: "id_x", CF_ACCESS_CLIENT_SECRET: "sec_x" });
    expect(hdr?.has("CF-Access-Client-Id") ?? false).toBe(true);
  });
});

describe.skipIf(!HAVE)("R2 — F3 identical offers, F4 permanent refusals", () => {
  beforeEach(reset);

  it("F3: SQL one-per-room picks exactly the offers R1's fetch-everything-then-pick made (random fixtures, blind, refusals, jobs, ties)", async () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const since = Date.now() - 5 * 86_400_000;
    for (let trial = 0; trial < 25; trial++) {
      reset(); slot = 0;
      const ids: string[] = [];
      for (let i = 0; i < 14; i++) {
        const id = `d${trial}_${i}`; ids.push(id);
        win(id, [...ROOMS, "roff"][Math.floor(rnd() * 5)], (MAXAGE + 1) * 60 + Math.floor(rnd() * 3000), { refusedMin: rnd() < 0.25 ? Math.floor(rnd() * 120) : undefined });
        if (rnd() < 0.15) pg.exec(`UPDATE bench_window SET end_ms = (SELECT end_ms FROM bench_window WHERE id = '${ids[0]}'), start_ms = (SELECT start_ms FROM bench_window WHERE id = '${ids[0]}') , source_mic = 'tie_${id}' WHERE id = '${id}';`); // exact slot ties (lane differs)
        if (rnd() < 0.15) pg.exec(`INSERT INTO scribe_job (id,kind,args,status,created_at) VALUES ('dj${trial}_${i}','room_window','{"window_id":"${id}"}','done',NOW()-INTERVAL '${Math.floor(rnd() * 1500)} minutes');`);
      }
      const blind = ids.filter(() => rnd() < 0.25);
      const o = { sinceMs: since, maxAgeHours: MAXAGE, cooldownMinutes: 60 };
      const toC = (rows: Array<Record<string, unknown>>, b: Set<string>) => rows.filter((e) => !b.has(String(e.id))).map((e) => ({
        id: String(e.id), room_id: String(e.room_id), start_ms: Number(e.start_ms), end_ms: Number(e.end_ms), closed_ms: Number(e.closed_ms),
        last_served_ms: e.last_served_ms === null || e.last_served_ms === undefined ? null : Number(e.last_served_ms),
      }));
      const old = NEW.orderAutoDrainOffers(toC(await R1.scanBackfillCandidates(pg.sql as never, o), new Set(blind)), 5).map((c) => c.id);
      const neu = NEW.orderAutoDrainOffers(toC(await B.scanBackfillCandidates(pg.sql as never, { ...o, blind, maxRefusals: 3 }), new Set()), 5).map((c) => c.id);
      expect(neu, `trial ${trial}`).toEqual(old);
    }
  }, 180_000);

  it("F4: a permanent refusal is stamped with a running count, parked after 3, counted in the tick; a transient one is never parked", async () => {
    process.env.AUTO_DRAIN_BACKFILL_SINCE = istDate(Date.now() - 5 * 86_400_000);
    win("pm_perm", "r1", (MAXAGE + 1) * 60); win("pm_trans", "r2", (MAXAGE + 1) * 60);
    H.steps.pm_perm = "too_long"; H.steps.pm_trans = "flag_off";
    process.env.AUTO_DRAIN_BACKFILL_LIMIT = "5";
    const offers = (id: string) => H.drained.filter((d) => d === id).length;
    for (let t = 0; t < 5; t++) {
      await tickNew();
      pg.exec("UPDATE bench_window SET auto_drain_refused_at = NOW() - INTERVAL '2 days' WHERE auto_drain_refused_at IS NOT NULL;"); // cooldown over: time passes, nothing is deleted
    }
    expect(offers("pm_perm")).toBe(3);
    expect(offers("pm_trans")).toBe(5);
    const row = (await pg.sql`SELECT auto_drain_refused_reason AS r FROM bench_window WHERE id = 'pm_perm'`) as Array<{ r: string }>;
    expect(row[0].r).toBe("too_long#3");
    const r = await tickNew();
    expect(r.backfill).toMatchObject({ active: true, parked_permanent: 1 });
  });

  it("F4: the live path still stamps the plain step text (no count suffix)", async () => {
    win("lv", "r1", 10);
    H.steps.lv = "too_long";
    await tickNew();
    const row = (await pg.sql`SELECT auto_drain_refused_reason AS r FROM bench_window WHERE id = 'lv'`) as Array<{ r: string }>;
    expect(row[0].r).toBe("too_long");
  });

  it("F4 pure: classification and counting", () => {
    expect(B.isPermanentRefusal("too_long")).toBe(true);
    expect(B.isPermanentRefusal("wrong_state", "claim_lost")).toBe(false);
    expect(B.isPermanentRefusal("wrong_state", "not_grid_aligned")).toBe(true);
    for (const t of ["flag_off", "join_failed", "engine_failed", "no_chunks", "join_busy"]) expect(B.isPermanentRefusal(t)).toBe(false);
    expect(B.backfillRefusalReason("too_long", undefined, null)).toBe("too_long#1");
    expect(B.backfillRefusalReason("too_long", undefined, "too_long#2")).toBe("too_long#3");
    expect(B.backfillRefusalReason("too_long", undefined, "no_room_day#2")).toBe("too_long#1");
    expect(B.backfillRefusalReason("flag_off", undefined, "too_long#2")).toBe("flag_off");
  });
});

describe("R2 — F1 the health probe asks the endpoint the job will use", () => {
  const ok = (urls: string[], down: string[] = []) => async (u: string) => { urls.push(u); return new Response(JSON.stringify({ ok: !down.some((d) => u.startsWith(d)) }), { status: 200 }); };
  const M = "https://mini.test", T1 = "https://twin1.test", T2 = "https://twin2.test";
  it("BULK_AGE unset + bulk list set: only the ordinary list is probed (the twins are never used)", async () => {
    const urls: string[] = [];
    expect(await B.routerHealthy(ok(urls, [T1, T2]), { ETA_ROUTER_URL: M, ETA_ROUTER_BULK_URLS: `${T1},${T2}` })).toBe(true);
    expect(urls).toEqual([`${M}/healthz`]);
    urls.length = 0;
    expect(await B.routerHealthy(ok(urls, [M]), { ETA_ROUTER_URL: M, ETA_ROUTER_BULK_URLS: `${T1},${T2}` })).toBe(false);
  });
  it("BULK_AGE set (<= max age): only the bulk list, any one ok; the Mini is not asked", async () => {
    const urls: string[] = [];
    const env = { ETA_ROUTER_URL: M, ETA_ROUTER_BULK_URLS: `${T1},${T2}`, BULK_AGE_MINUTES: "60" };
    expect(await B.routerHealthy(ok(urls, [T1]), env, 360)).toBe(true);
    expect(urls).toEqual([`${T1}/healthz`, `${T2}/healthz`]);
    urls.length = 0;
    expect(await B.routerHealthy(ok(urls, [T1, T2]), env, 360)).toBe(false);
    expect(urls).not.toContain(`${M}/healthz`);
  });
  it("BULK_AGE set but longer than max age: some backlog windows still go to the ordinary list, so BOTH must pass", async () => {
    const env = { ETA_ROUTER_URL: M, ETA_ROUTER_BULK_URLS: T1, BULK_AGE_MINUTES: "1440" };
    expect(await B.routerHealthy(ok([]), env, 360)).toBe(true);
    expect(await B.routerHealthy(ok([], [M]), env, 360)).toBe(false);
    expect(await B.routerHealthy(ok([], [T1]), env, 360)).toBe(false);
  });
  it("POOL_BULK_FALLBACK_LIVE: a dead bulk pool does not pass because the Mini answers", async () => {
    const env = { ETA_ROUTER_URL: M, ETA_ROUTER_BULK_URLS: `${T1},${T2}`, BULK_AGE_MINUTES: "60", POOL_BULK_FALLBACK_LIVE: "1" };
    const urls: string[] = [];
    expect(await B.routerHealthy(ok(urls, [T1, T2]), env, 360)).toBe(false);
    expect(urls).not.toContain(`${M}/healthz`);
    expect(await B.routerHealthy(ok([], [T1]), env, 360)).toBe(true);
  });
  it("no pool at all: the default router host, as before; bulk age with no bulk list is the ordinary list", async () => {
    const urls: string[] = [];
    expect(await B.routerHealthy(ok(urls), {})).toBe(true);
    expect(urls).toEqual(["https://route.llmvinayminihome.uk/healthz"]);
    expect(await B.routerHealthy(ok([], [M]), { ETA_ROUTER_URL: M, BULK_AGE_MINUTES: "60" }, 360)).toBe(false);
  });
  it("a bad BULK_AGE_MINUTES is off (as the job reads it): ordinary list only", async () => {
    const urls: string[] = [];
    expect(await B.routerHealthy(ok(urls, [T1]), { ETA_ROUTER_URL: M, ETA_ROUTER_BULK_URLS: T1, BULK_AGE_MINUTES: "soon" }, 360)).toBe(true);
    expect(urls).toEqual([`${M}/healthz`]);
  });
});
