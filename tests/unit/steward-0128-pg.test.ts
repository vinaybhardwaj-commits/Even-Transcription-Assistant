/**
 * tests/unit/steward-0128-pg.test.ts — REQUIRED PROOF: migration 0128 (Room Steward part 1) and the ticket endpoint, result ingestion and retention
 * against a real postgres:16, with BOUND parameters (tests/support/s1-pg.ts). Only the driver is a stand-in: `@/lib/db` is the harness's psql-backed sql.
 *
 *   1. 0128 applies twice (idempotent), registers itself as 128, seeds exactly the seven config keys without overwriting an edited one.
 *   2. Tickets: GET returns only this machine's issued + unexpired tickets, oldest first, marks them fetched, caps at 10, flips expired rows lazily;
 *      a second outstanding (machine, action) is blocked by the partial unique index and by issueTicket; an expired one frees the slot.
 *      The tickets the endpoint returns verify against the public key (the to_char timestamps are byte-identical to what was signed).
 *   3. Results: happy path, replayed nonce, wrong machine -> through the real tables; a failing ticket update leaves the nonce unspent (resend works); oversize detail truncated.
 *   4. Retention: steward_nonces > 7 d, steward_decisions > 30 d and finished steward_tickets > 30 d are deleted (a recent ticket pointing at an old decision survives, decision_id nulled).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));

import { GET as getTickets } from "@/app/api/steward/tickets/route";
import { GET as retention } from "@/app/api/cron/kiosk-health-retention/route";
import { issueTicket, verifyTicket, type StewardSql } from "@/lib/steward/tickets";
import { applyStewardResults } from "@/lib/steward/results";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-steward-0128");

const kp = generateKeyPairSync("ed25519");
const PRIV = kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const PUB = kp.publicKey.export({ type: "spki", format: "pem" }) as string;
const TOKEN = "tok-pg";
const SAVED = { tok: process.env.KIOSK_HEALTH_INGEST_TOKEN, cron: process.env.CRON_SECRET };

const mig = (n: string) => readFileSync(`db/migrations/${n}`, "utf8");
const rows = async (q: TemplateStringsArray, ...v: unknown[]) => (await H.sql!(q, ...v)) as Array<Record<string, unknown>>;
const sql = ((s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v)) as unknown as StewardSql;
const fetchFor = async (machine: string) => {
  const r = await getTickets(new NextRequest(`https://x.test/api/steward/tickets?machine=${machine}`, { headers: { authorization: `Bearer ${TOKEN}` } }));
  return { status: r.status, body: (await r.json()) as { ok: boolean; key_id: string; tickets: Array<{ ticket: Record<string, any>; signature: string }> } };
};
const issue = (machine: string, action: any, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  issueTicket(sql, { machine, action, params, decision_id: null, ttl_s: 600, privateKeyPem: PRIV, ...extra });

beforeEach(() => {
  process.env.KIOSK_HEALTH_INGEST_TOKEN = TOKEN;
  process.env.CRON_SECRET = "cron-pg";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (SAVED.tok === undefined) delete process.env.KIOSK_HEALTH_INGEST_TOKEN; else process.env.KIOSK_HEALTH_INGEST_TOKEN = SAVED.tok;
  if (SAVED.cron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = SAVED.cron;
  vi.restoreAllMocks();
});

describe("REQUIRED PROOF — 0128 against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/steward-0128-pg.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

describe.skipIf(!HAVE_DOCKER)("0128 room steward over real postgres", () => {
  it("migration: applies twice, records itself, seeds the config once and never overwrites an edit", async () => {
    pg.start();
    H.sql = pg.sql as never;
    pg.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    pg.exec(mig("0126_kiosk_health_events.sql")); // the retention cron also deletes from it
    pg.exec(mig("0123_eta_encounter_windows.sql")); // 0129 grants SELECT on it; the retention cron also deletes from the 0129 room_audio tables
    pg.exec(mig("0129_room_audio_state.sql"));
    pg.exec(mig("0128_room_steward.sql"));
    pg.exec(mig("0128_room_steward.sql")); // idempotent
    expect(await rows`SELECT version, name FROM schema_migrations WHERE version = 128`).toEqual([{ version: 128, name: "0128_room_steward" }]);

    const cfg = await rows`SELECT key, value FROM steward_config ORDER BY key`;
    expect(cfg.map((r) => r.key)).toEqual(["caps", "days", "kill_switch", "priority", "rooms", "schedule", "shadow"]);
    const by = Object.fromEntries(cfg.map((r) => [r.key as string, r.value])) as Record<string, any>;
    expect(by.kill_switch).toEqual({ on: true });
    expect(by.shadow).toEqual({ global: true, actions: {} });
    expect(by.days).toEqual({ mode: "every_day", closed: [] });
    expect(by.caps).toEqual({ actions_per_room_per_hour: 4, policy_cycle_per_profile_per_day: 1, start_retries: 3 });
    expect(by.priority).toEqual({ order: ["ot", "opd", "clinic"] });
    expect(by.schedule).toEqual({
      clinic: { start: "07:30", end: "21:30", tz: "Asia/Kolkata", late_stop_max_min: 30 },
      ot: { start: "06:00", end: "04:00", tz: "Asia/Kolkata", late_stop_max_min: 30 },
    });
    expect(Object.keys(by.rooms).sort()).toEqual(["room_2qe955hy", "room_jwyrr4dc", "room_mah3aspr"]);
    expect(by.rooms.room_jwyrr4dc.flags).toEqual(["dev", "test"]);
    expect(by.rooms.room_2qe955hy.flags).toEqual(["dev", "test"]);
    expect(by.rooms.room_mah3aspr.class).toBe("ot");

    // an edited value survives a re-apply
    pg.exec(`UPDATE steward_config SET value = '{"on":false}'::jsonb, updated_by = 'v' WHERE key = 'kill_switch'`);
    pg.exec(mig("0128_room_steward.sql"));
    expect((await rows`SELECT value FROM steward_config WHERE key = 'kill_switch'`)[0]!.value).toEqual({ on: false });

    // the decision log's CHECK and defaults
    pg.exec(`INSERT INTO steward_decisions (rule, action, mode) VALUES ('r', 'wake', 'shadow')`);
    expect(() => pg.exec(`INSERT INTO steward_decisions (rule, action, mode) VALUES ('r', 'wake', 'maybe')`)).toThrow();
    expect(await rows`SELECT actor, params, inputs FROM steward_decisions`).toEqual([{ actor: "steward", params: {}, inputs: {} }]);
    expect(() => pg.exec(`INSERT INTO steward_tickets (ticket_id, machine, action, issued_at, expires_at, nonce, signature, status) VALUES ('x','m','wake',now(),now(),'n','s','bogus')`)).toThrow();
  }, 180_000);

  it("endpoint: only this machine's issued + unexpired tickets, oldest first, marked fetched, cap 10; outstanding duplicates blocked; tickets verify", async () => {
    const a = await issue("EHRC-ECHOs-Mac-mini", "wake", {}, { now: Date.now() - 3000 });
    const b = await issue("EHRC-ECHOs-Mac-mini", "open_pulse", { profile: "Default" }, { now: Date.now() - 2000 });
    const other = await issue("EHRC-OTHERs-Mac-mini", "wake");
    expect([a.ok, b.ok, other.ok]).toEqual([true, true, true]);

    // duplicate outstanding (machine, action): issueTicket says so, and the index backs it up
    expect(await issue("EHRC-ECHOs-Mac-mini", "wake")).toEqual({ ok: false, reason: "outstanding" });
    expect(() => pg.exec(`INSERT INTO steward_tickets (ticket_id, machine, action, issued_at, expires_at, nonce, signature, status) VALUES ('dupe','EHRC-ECHOs-Mac-mini','wake',now(),now() + interval '5 min','nd','s','issued')`)).toThrow(/steward_tickets_one_outstanding_idx/);

    // an already-expired outstanding ticket does not block, and is never served
    const stale = await issue("EHRC-ECHOs-Mac-mini", "restart_recorder_app", {}, { now: Date.now() - 1_200_000, ttl_s: 300 });
    expect(stale.ok).toBe(true);

    const { status, body } = await fetchFor("EHRC-ECHOs-Mac-mini");
    expect(status).toBe(200);
    expect(body.key_id).toMatch(/^[0-9a-f]{8}$/);
    expect(body.tickets.map((t) => t.ticket.action)).toEqual(["wake", "open_pulse"]); // oldest first; stale and other machine absent
    for (const t of body.tickets) {
      expect(verifyTicket(t.ticket, t.signature, PUB, { machine: "EHRC-ECHOs-Mac-mini" })).toEqual({ ok: true });
    }

    const st = await rows`SELECT action, status, fetched_at IS NOT NULL AS fetched FROM steward_tickets WHERE machine = 'EHRC-ECHOs-Mac-mini' ORDER BY action`;
    expect(st).toEqual([
      { action: "open_pulse", status: "fetched", fetched: true },
      { action: "restart_recorder_app", status: "expired", fetched: false }, // flipped lazily by the GET
      { action: "wake", status: "fetched", fetched: true },
    ]);
    expect((await rows`SELECT status FROM steward_tickets WHERE machine = 'EHRC-OTHERs-Mac-mini'`)[0]!.status).toBe("issued");

    // fetched tickets are not served again; a fetched one still blocks a new issue of the same action
    expect((await fetchFor("EHRC-ECHOs-Mac-mini")).body.tickets).toEqual([]);
    expect(await issue("EHRC-ECHOs-Mac-mini", "wake")).toEqual({ ok: false, reason: "outstanding" });
  }, 120_000);

  it("endpoint caps at 10 per fetch, oldest first; the remainder arrives on the next fetch", async () => {
    // issueTicket can hold at most six outstanding tickets per machine (one per action), so the cap is exercised with twelve directly inserted rows.
    const m = "EHRC-CAPs-Mac-mini";
    for (let i = 1; i <= 12; i++) {
      const id = `cap-${String(i).padStart(2, "0")}`;
      pg.exec(`INSERT INTO steward_tickets (ticket_id, machine, action, issued_at, expires_at, nonce, signature, status)
               VALUES ('${id}', '${m}', 'a${id}', now() - interval '${100 - i} seconds', now() + interval '10 minutes', 'n-${id}', 's', 'issued')`);
    }
    const first = await fetchFor(m);
    expect(first.body.tickets.map((t) => t.ticket.ticket_id)).toEqual(Array.from({ length: 10 }, (_, i) => `cap-${String(i + 1).padStart(2, "0")}`));
    const iso = first.body.tickets.map((t) => t.ticket.issued_at as string);
    expect(iso.every((x) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x))).toBe(true);
    expect([...iso].sort()).toEqual(iso);
    const second = await fetchFor(m);
    expect(second.body.tickets.map((t) => t.ticket.ticket_id)).toEqual(["cap-11", "cap-12"]);
    expect((await fetchFor(m)).body.tickets).toEqual([]);
  }, 120_000);

  it("results: happy path, replayed nonce ignored, wrong machine ignored; the ticket ends done/failed", async () => {
    const m = "EHRC-RESs-Mac-mini";
    const t1 = await issue(m, "wake");
    const t2 = await issue(m, "restart_recorder_app");
    if (!t1.ok || !t2.ok) throw new Error("issue failed");
    await fetchFor(m);

    // wrong machine: nothing consumed
    expect(await applyStewardResults(sql, [{ machine: "EHRC-OTHERs-Mac-mini", kind: "steward.result", payload: { ticket_id: t1.ticket.ticket_id, nonce: t1.ticket.nonce, outcome: "done" } }])).toEqual({ applied: 0, ignored: 1, errors: 0 });
    expect(await rows`SELECT nonce FROM steward_nonces WHERE nonce = ${t1.ticket.nonce}`).toEqual([]);

    // happy path
    expect(await applyStewardResults(sql, [{ machine: m, kind: "steward.result", payload: { ticket_id: t1.ticket.ticket_id, nonce: t1.ticket.nonce, outcome: "done", detail: "woke" } }])).toEqual({ applied: 1, ignored: 0, errors: 0 });
    const done = (await rows`SELECT status, completed_at IS NOT NULL AS completed, result FROM steward_tickets WHERE ticket_id = ${t1.ticket.ticket_id}`)[0]!;
    expect(done).toMatchObject({ status: "done", completed: true });
    expect(done.result).toMatchObject({ outcome: "done", detail: "woke" });

    // replay: ignored, and a different outcome cannot overwrite
    expect(await applyStewardResults(sql, [{ machine: m, kind: "steward.result", payload: { ticket_id: t1.ticket.ticket_id, nonce: t1.ticket.nonce, outcome: "failed" } }])).toEqual({ applied: 0, ignored: 1, errors: 0 });
    expect((await rows`SELECT status FROM steward_tickets WHERE ticket_id = ${t1.ticket.ticket_id}`)[0]!.status).toBe("done");

    // rejected -> failed with the outcome kept; the slot is free again
    await applyStewardResults(sql, [{ machine: m, kind: "steward.result", payload: { ticket_id: t2.ticket.ticket_id, nonce: t2.ticket.nonce, outcome: "rejected", detail: "bad_signature" } }]);
    const failed = (await rows`SELECT status, result FROM steward_tickets WHERE ticket_id = ${t2.ticket.ticket_id}`)[0]!;
    expect(failed.status).toBe("failed");
    expect(failed.result).toMatchObject({ outcome: "rejected" });
    expect((await issue(m, "restart_recorder_app")).ok).toBe(true);
  }, 120_000);

  it("a failed ticket update never spends the nonce: with a failing trigger the nonce row count stays 0, and a resend succeeds once the trigger is dropped", async () => {
    const m = "EHRC-ATOMs-Mac-mini";
    const t = await issue(m, "wake");
    if (!t.ok) throw new Error("issue failed");
    await fetchFor(m);
    pg.exec(`CREATE FUNCTION steward_fail_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'steward test: update refused'; END $$;
             CREATE TRIGGER steward_fail_update_trg BEFORE UPDATE ON steward_tickets FOR EACH ROW WHEN (NEW.status IN ('done', 'failed')) EXECUTE FUNCTION steward_fail_update();`);
    const payload = { ticket_id: t.ticket.ticket_id, nonce: t.ticket.nonce, outcome: "done", detail: "first try" };
    expect(await applyStewardResults(sql, [{ machine: m, kind: "steward.result", payload }])).toEqual({ applied: 0, ignored: 0, errors: 1 });
    expect(await rows`SELECT count(*)::int AS n FROM steward_nonces WHERE nonce = ${t.ticket.nonce}`).toEqual([{ n: 0 }]);
    expect((await rows`SELECT status FROM steward_tickets WHERE ticket_id = ${t.ticket.ticket_id}`)[0]!.status).toBe("fetched");

    pg.exec(`DROP TRIGGER steward_fail_update_trg ON steward_tickets; DROP FUNCTION steward_fail_update();`);
    expect(await applyStewardResults(sql, [{ machine: m, kind: "steward.result", payload }])).toEqual({ applied: 1, ignored: 0, errors: 0 });
    expect(await rows`SELECT count(*)::int AS n FROM steward_nonces WHERE nonce = ${t.ticket.nonce}`).toEqual([{ n: 1 }]);
    expect((await rows`SELECT status FROM steward_tickets WHERE ticket_id = ${t.ticket.ticket_id}`)[0]!.status).toBe("done");
  }, 120_000);

  it("an oversize detail is truncated, not dropped: the stored result carries <= 2048 bytes and the ticket still completes", async () => {
    const m = "EHRC-TRUNCs-Mac-mini";
    const t = await issue(m, "wake");
    if (!t.ok) throw new Error("issue failed");
    await fetchFor(m);
    expect(await applyStewardResults(sql, [{ machine: m, kind: "steward.result", payload: { ticket_id: t.ticket.ticket_id, nonce: t.ticket.nonce, outcome: "failed", detail: "€".repeat(4000) } }])).toEqual({ applied: 1, ignored: 0, errors: 0 });
    const r = (await rows`SELECT status, result->>'detail' AS detail, result->>'outcome' AS outcome FROM steward_tickets WHERE ticket_id = ${t.ticket.ticket_id}`)[0]!;
    expect(r).toMatchObject({ status: "failed", outcome: "failed" });
    expect(Buffer.byteLength(r.detail as string, "utf8")).toBeLessThanOrEqual(2048);
    expect((r.detail as string).endsWith("…")).toBe(true);
  }, 120_000);

  it("retention: nonces > 7 d, decisions > 30 d and finished tickets > 30 d go (stale issued/fetched ones are flipped to expired first); younger rows, live tickets and recent finished tickets survive", async () => {
    pg.exec(`
      INSERT INTO steward_nonces (nonce, machine, seen_at) VALUES
        ('old-n', 'm', now() - interval '8 days'), ('new-n', 'm', now() - interval '6 days');
      INSERT INTO steward_decisions (id, ts, rule, action, mode) VALUES
        (9001, now() - interval '31 days', 'r', 'wake', 'shadow'), (9002, now() - interval '29 days', 'r', 'wake', 'shadow');
      INSERT INTO steward_tickets (ticket_id, machine, action, decision_id, issued_at, expires_at, nonce, signature, status, completed_at) VALUES
        ('tk-done-old',    'm-ret', 'wake',                 NULL, now() - interval '32 days', now() - interval '32 days', 'tk-n1', 's', 'done',    now() - interval '31 days'),
        ('tk-failed-old',  'm-ret', 'open_pulse',           NULL, now() - interval '32 days', now() - interval '32 days', 'tk-n2', 's', 'failed',  now() - interval '31 days'),
        ('tk-expired-old', 'm-ret', 'relaunch_chrome',      NULL, now() - interval '32 days', now() - interval '31 days', 'tk-n3', 's', 'expired', NULL),
        ('tk-done-new',    'm-ret', 'policy_cycle',         9001, now() - interval '32 days', now() - interval '32 days', 'tk-n4', 's', 'done',    now() - interval '2 days'),
        ('tk-expired-new', 'm-ret', 'restart_recorder_app', NULL, now() - interval '3 days',  now() - interval '2 days',  'tk-n5', 's', 'expired', NULL),
        ('tk-issued-old',  'm-ret2','wake',                 NULL, now() - interval '40 days', now() - interval '40 days', 'tk-n6', 's', 'issued',  NULL),
        ('tk-fetched-old', 'm-ret3','wake',                 NULL, now() - interval '41 days', now() - interval '40 days', 'tk-n7', 's', 'fetched', NULL),
        ('tk-issued-recent','m-ret4','wake',                NULL, now() - interval '3 days',  now() - interval '2 days',  'tk-n8', 's', 'issued',  NULL),
        ('tk-issued-live', 'm-ret5','wake',                 NULL, now(),                      now() + interval '10 minutes', 'tk-n9', 's', 'issued', NULL);
    `);
    const r = await retention(new Request("https://x.test/api/cron/kiosk-health-retention", { headers: { authorization: "Bearer cron-pg" } }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ steward_nonces_deleted: 1, steward_decisions_deleted: 1, steward_tickets_deleted: 5, steward_tickets_expired: 3, budget_hit: false });
    expect((await rows`SELECT nonce FROM steward_nonces ORDER BY nonce`).map((x) => x.nonce)).not.toContain("old-n");
    expect((await rows`SELECT nonce FROM steward_nonces WHERE nonce = 'new-n'`)).toHaveLength(1);
    expect((await rows`SELECT id FROM steward_decisions WHERE id IN (9001, 9002) ORDER BY id`).map((x) => Number(x.id))).toEqual([9002]);
    // a recent finished ticket that pointed at the old decision survives with decision_id nulled (ON DELETE SET NULL)
    expect(await rows`SELECT ticket_id, decision_id FROM steward_tickets WHERE ticket_id LIKE 'tk-%' ORDER BY ticket_id`).toEqual([
      { ticket_id: "tk-done-new", decision_id: null },
      { ticket_id: "tk-expired-new", decision_id: null },
      { ticket_id: "tk-issued-live", decision_id: null },
      { ticket_id: "tk-issued-recent", decision_id: null },
    ]);
    // the old issued and old fetched rows were flipped to expired, then deleted in the same run; the recent stale one is flipped but kept; the live one is untouched
    expect(await rows`SELECT ticket_id, status FROM steward_tickets WHERE ticket_id IN ('tk-issued-old', 'tk-fetched-old', 'tk-issued-recent', 'tk-issued-live') ORDER BY ticket_id`).toEqual([
      { ticket_id: "tk-issued-live", status: "issued" },
      { ticket_id: "tk-issued-recent", status: "expired" },
    ]);
  }, 120_000);

  it("teardown", () => { pg.stop(); });
});
