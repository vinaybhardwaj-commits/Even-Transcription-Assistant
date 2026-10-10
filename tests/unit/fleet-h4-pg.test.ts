/**
 * TS-H4 (#41) + TS-H13 (#50) on a REAL postgres:16 with EVERY migration: the admin-only enqueue route (one catalogued command, one device, signed, audited), the closed
 * catalogue through the route, the approval rule against the clock, the read-only views (admin GET and the MCP door), and that no secret ever appears in them.
 * The signing key is a FIXED FAKE seed (0x0d x 32). All ids are fake.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

process.env.JWT_SECRET_ADMIN = "test-admin-secret-for-fleet-h4-tests-only";
process.env.JWT_SECRET_DOCTOR = "test-doctor-secret-for-fleet-h4-tests-only";
const KEY = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 13)]).toString("base64"); // gitleaks:allow
process.env.FLEET_COMMAND_SIGNING_KEY = KEY;

const H = vi.hoisted(() => ({
  sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>,
  cookie: null as string | null,
  statements: [] as string[],
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => { H.statements.push(s.join("?")); return H.sql(s, ...v); } }));
vi.mock("@/lib/cookie", async (orig) => ({ ...(await orig<Record<string, unknown>>()), readAdminCookie: async () => H.cookie }));
vi.setConfig({ testTimeout: 90_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-fleet-h4");

import { signAdminJwt, signDoctorJwt } from "@/lib/auth";
import { loadSigner } from "@/lib/fleet/signing";
import { claimCommands } from "@/lib/fleet/poll";
import { publicKeysOf, verifyEnvelope, type Envelope } from "@/lib/fleet/envelope";

const q = async <T = Record<string, unknown>>(s: TemplateStringsArray, ...v: unknown[]) => (await H.sql(s, ...v)) as T[];
const DEV = "dev_" + "a".repeat(24);
const DEV2 = "dev_" + "b".repeat(24);
const PUB = Buffer.alloc(32, 5).toString("base64");
const SIGNER = loadSigner()!;
const KEYS = publicKeysOf(SIGNER);

async function enqueue(body: unknown, opts: { cookie?: string | null; raw?: string } = {}) {
  const { POST } = await import("@/app/api/admin/fleet/commands/route");
  H.cookie = opts.cookie === undefined ? await signAdminJwt({ admin_id: "adm_fake1", email: "admin@example.invalid" }) : opts.cookie;
  const res = await POST(new NextRequest("https://x.test/api/admin/fleet/commands", { method: "POST", body: opts.raw ?? JSON.stringify(body), headers: { "content-type": "application/json" } }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
async function overview(cookie?: string | null) {
  const { GET } = await import("@/app/api/admin/fleet/route");
  H.cookie = cookie === undefined ? await signAdminJwt({ admin_id: "adm_fake1", email: "admin@example.invalid" }) : cookie;
  const res = await GET(new NextRequest("https://x.test/api/admin/fleet"));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const kiosks = async (args: Record<string, unknown>) => {
  const { CALLABLE_TOOLS } = await import("@/lib/mcp/surface");
  return (await CALLABLE_TOOLS.get("scribe_kiosks")!.handler(args, { origin: "x", actor: "a", scopes: new Set(["read"]) } as never)) as Record<string, unknown>;
};

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); });

beforeEach(() => {
  if (!HAVE) return;
  process.env.FLEET_COMMAND_SIGNING_KEY = KEY;
  pg.exec(`
    TRUNCATE fleet_results, fleet_commands, fleet_devices, fleet_jti, fleet_control, fleet_audit RESTART IDENTITY CASCADE;
    DELETE FROM room_install WHERE install_id LIKE 'inst_h4_%'; DELETE FROM room WHERE id IN ('room_h4a', 'room_h4b');
    INSERT INTO room (id, slug, name, pin_hash) VALUES ('room_h4a', 'h4-a', 'H4 A', 'x'), ('room_h4b', 'h4-b', 'H4 B', 'x');
    INSERT INTO fleet_devices (device_id, install_id, room_id, machine, public_key, helper_version, last_poll_at) VALUES
      ('${DEV}', 'inst_h4_1', 'room_h4a', 'EXAMPLE-MAC-A', '${PUB}', '0.2.0', now() - interval '12 seconds'),
      ('${DEV2}', 'inst_h4_2', 'room_h4b', 'EXAMPLE-MAC-B', '${PUB}', '0.2.0', NULL);
  `);
  H.statements.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

(HAVE ? describe : describe.skip)("TS-H4 server on real postgres", () => {
  describe("admin-only enqueue", () => {
    it("REFUSED without an admin: no cookie, a junk cookie, a doctor's cookie, an expired admin cookie; nothing is stored or audited", async () => {
      const body = { device_id: DEV, verb: "helper_status" };
      expect((await enqueue(body, { cookie: null })).status).toBe(401);
      expect((await enqueue(body, { cookie: "not.a.jwt" })).status).toBe(401);
      expect((await enqueue(body, { cookie: await signDoctorJwt({ doctor_id: "doc_fake", email: "d@example.invalid", slug: "dr-fake" } as never) })).status).toBe(401);
      const { SignJWT } = await import("jose");
      const old = await new SignJWT({ admin_id: "adm_fake1", email: "a@example.invalid" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt(1).setAudience("admin").setExpirationTime(2).sign(new TextEncoder().encode(process.env.JWT_SECRET_ADMIN));
      expect((await enqueue(body, { cookie: old })).status).toBe(401);
      expect(await q`SELECT 1 FROM fleet_commands`).toHaveLength(0);
      expect(await q`SELECT 1 FROM fleet_audit`).toHaveLength(0);
    });

    it("an admin queues ONE catalogued command for ONE device: signed (verifies under the public key), stored as issued, audited with the admin as actor", async () => {
      const r = await enqueue({ device_id: DEV, verb: "collect_diag", params: { scope: "audio", log_lines: 200 } });
      expect(r.status).toBe(200);
      const row = (await q<Record<string, unknown>>`SELECT * FROM fleet_commands WHERE cmd_id = ${r.json.cmd_id}`)[0]!;
      expect(row).toMatchObject({ device_id: DEV, machine: "EXAMPLE-MAC-A", verb: "collect_diag", state: "queued", issuer_kind: "operator", issuer_id: "adm_fake1", key_id: "fk1", approval_ref: null });
      const env: Envelope = {
        v: 2, cmd_id: String(row.cmd_id), device_id: DEV, machine: String(row.machine), verb: String(row.verb), params: row.params as never,
        issued_at: new Date(String(row.issued_at)).toISOString(), expires_at: new Date(String(row.expires_at)).toISOString(), nonce: String(row.nonce),
        issuer: { kind: "operator", id: "adm_fake1" }, approval_ref: null, key_id: "fk1", signature: String(row.signature),
      };
      expect(verifyEnvelope(env, { publicKeys: KEYS, nowMs: Date.now(), nonceSeen: () => false, deviceId: DEV, machine: "EXAMPLE-MAC-A" })).toEqual({ ok: true });
      expect(Date.parse(env.expires_at) - Date.parse(env.issued_at)).toBe(300_000);
      const audit = await q<{ actor: string; action: string; cmd_id: string; summary: string }>`SELECT actor, action, cmd_id, summary FROM fleet_audit`;
      expect(audit).toEqual([{ actor: "operator:adm_fake1", action: "queue", cmd_id: r.json.cmd_id, summary: "verb collect_diag" }]);
      expect(JSON.stringify(audit)).not.toContain(String(row.signature));
    });

    it("EVERY accepted enqueue writes exactly one audit row; every refusal writes none and stores nothing", async () => {
      const ok = [{ device_id: DEV, verb: "helper_status" }, { device_id: DEV, verb: "wake" }, { device_id: DEV2, verb: "list_audio_inputs" }];
      for (const b of ok) expect((await enqueue(b)).status).toBe(200);
      expect(await q`SELECT 1 FROM fleet_audit WHERE action = 'queue'`).toHaveLength(3);
      const refused = [
        { device_id: DEV, verb: "bash" }, { device_id: DEV, verb: "sh -c id" }, { device_id: DEV, verb: "wake", params: { cmd: "ls" } }, { device_id: DEV, verb: "collect_diag" },
        { device_id: DEV, verb: "helper_status", command: "ls -la" }, { device_id: DEV, verb: "helper_status", shell: "id" }, { device_id: "dev_nope", verb: "wake" },
        { device_id: DEV, verb: "report_diag", ttl_s: 5 }, { device_id: DEV, verb: "report_diag", ttl_s: 901 }, { device_id: DEV, verb: "report_diag", approval_ref: "x y" }, { device_id: DEV, verb: "report_diag", params: [] },
      ];
      for (const b of refused) expect((await enqueue(b)).status, JSON.stringify(b)).toBeGreaterThanOrEqual(400);
      expect(await q`SELECT 1 FROM fleet_audit`).toHaveLength(3);
      expect(await q`SELECT 1 FROM fleet_commands`).toHaveLength(3);
    });

    it("NO FREE-FORM TEXT: only the five body fields exist; an unknown verb is verb_not_allowed; a body that is not an object, bad JSON, or oversized is refused", async () => {
      expect(await enqueue({ device_id: DEV, verb: "echo hi" })).toMatchObject({ status: 400, json: { error: "verb_not_allowed" } });
      expect(await enqueue({ device_id: DEV, verb: "wake", script: "rm -rf /" })).toMatchObject({ status: 400, json: { error: "bad_body" } });
      expect(await enqueue(null, { raw: "[1,2]" })).toMatchObject({ status: 400, json: { error: "bad_body" } });
      expect(await enqueue(null, { raw: "{nope" })).toMatchObject({ status: 400, json: { error: "bad_json" } });
      expect(await enqueue(null, { raw: JSON.stringify({ device_id: DEV, verb: "wake", params: { pad: "x".repeat(5000) } }) })).toMatchObject({ status: 413 });
      expect(await enqueue({ device_id: "../etc/passwd", verb: "wake" })).toMatchObject({ status: 400, json: { error: "bad_device_id" } });
    });

    it("a revoked device, an unknown device; one outstanding command per (device, verb); a different verb or device is fine", async () => {
      expect((await enqueue({ device_id: DEV, verb: "wake" })).status).toBe(200);
      expect(await enqueue({ device_id: DEV, verb: "wake" })).toMatchObject({ status: 409, json: { error: "outstanding" } });
      expect((await enqueue({ device_id: DEV, verb: "helper_status" })).status).toBe(200);
      expect((await enqueue({ device_id: DEV2, verb: "wake" })).status).toBe(200);
      pg.exec(`UPDATE fleet_commands SET state = 'done' WHERE device_id = '${DEV}' AND verb = 'wake'`);
      expect((await enqueue({ device_id: DEV, verb: "wake" })).status).toBe(200);
      pg.exec(`UPDATE fleet_devices SET status = 'revoked' WHERE device_id = '${DEV2}'`);
      expect(await enqueue({ device_id: DEV2, verb: "helper_status" })).toMatchObject({ status: 409, json: { error: "device_revoked" } });
      expect(await enqueue({ device_id: "dev_" + "c".repeat(24), verb: "helper_status" })).toMatchObject({ status: 404, json: { error: "unknown_device" } });
    });

    it("F1: the command and its audit row are ONE statement — a failing audit insert leaves NO command, the route says 503, and nothing is ever served to the device", async () => {
      pg.exec(`
        CREATE OR REPLACE FUNCTION fleet_audit_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit is down'; END $$;
        CREATE TRIGGER fleet_audit_boom BEFORE INSERT ON fleet_audit FOR EACH ROW EXECUTE FUNCTION fleet_audit_boom();
      `);
      try {
        vi.spyOn(console, "error").mockImplementation(() => {});
        expect(await enqueue({ device_id: DEV, verb: "wake" })).toMatchObject({ status: 503, json: { error: "db" } });
        expect(await q`SELECT 1 FROM fleet_commands`).toHaveLength(0);
        expect(await claimCommands(H.sql as never, DEV)).toEqual([]);
        // and the operator's retry once audit is back is the FIRST and only command (no orphan stacked behind it)
        pg.exec("DROP TRIGGER fleet_audit_boom ON fleet_audit");
        expect((await enqueue({ device_id: DEV, verb: "wake" })).status).toBe(200);
        expect(await q`SELECT 1 FROM fleet_commands`).toHaveLength(1);
        expect(await q`SELECT 1 FROM fleet_audit`).toHaveLength(1);
      } finally {
        pg.exec("DROP TRIGGER IF EXISTS fleet_audit_boom ON fleet_audit; DROP FUNCTION IF EXISTS fleet_audit_boom()");
      }
    });

    it("F2: SIX parallel enqueues of the same (device, verb) leave exactly ONE command and ONE audit row; the other five are a clean 409 outstanding", async () => {
      const rs = await Promise.all(Array.from({ length: 6 }, () => enqueue({ device_id: DEV, verb: "wake" })));
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409 && r.json.error === "outstanding")).toHaveLength(5);
      expect(await q`SELECT 1 FROM fleet_commands WHERE device_id = ${DEV} AND verb = 'wake'`).toHaveLength(1);
      expect(await q`SELECT 1 FROM fleet_audit WHERE action = 'queue'`).toHaveLength(1);
      // the same verb for another device, and another verb for the same device, are not blocked
      const more = await Promise.all([enqueue({ device_id: DEV2, verb: "wake" }), enqueue({ device_id: DEV, verb: "helper_status" })]);
      expect(more.map((r) => r.status)).toEqual([200, 200]);
    });

    it("F2: the index counts only queued/delivered — a done command frees its verb; an EXPIRED one (queued past its TTL, or delivered and unanswered) is flipped and frees it too; a late result for the delivered one is still accepted", async () => {
      const first = await enqueue({ device_id: DEV, verb: "wake" });
      pg.exec(`UPDATE fleet_commands SET state = 'delivered', delivery_count = 1, expires_at = now() - interval '1 second', issued_at = now() - interval '200 seconds' WHERE cmd_id = '${first.json.cmd_id}'`);
      expect((await enqueue({ device_id: DEV, verb: "wake" })).status).toBe(200); // the stale delivered one no longer blocks
      expect((await q<{ state: string }>`SELECT state FROM fleet_commands WHERE cmd_id = ${first.json.cmd_id}`)[0]!.state).toBe("expired");
      const { recordResult } = await import("@/lib/fleet/results");
      const late = await recordResult(H.sql as never, DEV, "EXAMPLE-MAC-A", { cmd_id: String(first.json.cmd_id), device_id: DEV, outcome: "refused", reason: "expired", started_at: new Date().toISOString(), finished_at: new Date().toISOString(), detail: {}, upload: null });
      expect(late).toMatchObject({ ok: true, duplicate: false });
      // a QUEUED command past its TTL frees the verb as well
      pg.exec(`UPDATE fleet_commands SET expires_at = now() - interval '1 second', issued_at = now() - interval '200 seconds' WHERE device_id = '${DEV}' AND state = 'queued'`);
      expect((await enqueue({ device_id: DEV, verb: "wake" })).status).toBe(200);
      expect(await q`SELECT 1 FROM fleet_commands WHERE device_id = ${DEV} AND state IN ('queued', 'delivered')`).toHaveLength(1);
      // a DONE command frees it too
      pg.exec(`UPDATE fleet_commands SET state = 'done' WHERE device_id = '${DEV}' AND state = 'queued'`);
      expect((await enqueue({ device_id: DEV, verb: "wake" })).status).toBe(200);
    });

    it("M14/M13: GET /api/admin/fleet refuses a junk cookie and a doctor's cookie; an admin token with an empty admin_id cannot enqueue", async () => {
      expect((await overview("not.a.jwt")).status).toBe(401);
      expect((await overview(await signDoctorJwt({ doctor_id: "doc_fake", email: "d@example.invalid", slug: "dr-fake" } as never))).status).toBe(401);
      const empty = await signAdminJwt({ admin_id: "", email: "a@example.invalid" });
      expect(await enqueue({ device_id: DEV, verb: "wake" }, { cookie: empty })).toMatchObject({ status: 401 });
      expect(await q`SELECT 1 FROM fleet_commands`).toHaveLength(0);
    });

    it("no signing key configured: 503 signer_not_configured and nothing is queued; the secret is not in any response", async () => {
      delete process.env.FLEET_COMMAND_SIGNING_KEY;
      expect(await enqueue({ device_id: DEV, verb: "wake" })).toMatchObject({ status: 503, json: { error: "signer_not_configured" } });
      process.env.FLEET_COMMAND_SIGNING_KEY = "garbage";
      expect(await enqueue({ device_id: DEV, verb: "wake" })).toMatchObject({ status: 503 });
      expect(await q`SELECT 1 FROM fleet_commands`).toHaveLength(0);
    });

    it("APPROVAL against the clock (IST 07:30-21:30): privileged without approval_ref is refused in clinic hours, allowed at night; force always needs one", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-10T10:00:00+05:30"));
      expect(await enqueue({ device_id: DEV, verb: "coreaudiod_reset" })).toMatchObject({ status: 400, json: { error: "approval_required" } });
      expect(await enqueue({ device_id: DEV, verb: "coreaudiod_reset", approval_ref: "go_fake123" })).toMatchObject({ status: 200 });
      expect((await q<{ approval_ref: string }>`SELECT approval_ref FROM fleet_commands`)[0]!.approval_ref).toBe("go_fake123");
      expect((await enqueue({ device_id: DEV, verb: "wake" })).status).toBe(200); // not privileged
      vi.setSystemTime(new Date("2026-10-10T22:00:00+05:30"));
      expect((await enqueue({ device_id: DEV2, verb: "reload_launchagent" })).status).toBe(200);
      expect(await enqueue({ device_id: DEV, verb: "restart_recorder", params: { force: true } })).toMatchObject({ status: 400, json: { error: "approval_required" } });
      expect((await enqueue({ device_id: DEV, verb: "restart_recorder", params: { force: true }, approval_ref: "go_fake456" })).status).toBe(200);
      vi.setSystemTime(new Date("2026-10-10T07:29:00+05:30"));
      expect((await enqueue({ device_id: DEV2, verb: "usb_reseat" })).status).toBe(200);
      vi.setSystemTime(new Date("2026-10-10T07:30:00+05:30"));
      expect(await enqueue({ device_id: DEV2, verb: "coreaudiod_reset" })).toMatchObject({ status: 400, json: { error: "approval_required" } });
    });
  });

  describe("results surfaced; Bench and MCP are read-only and carry no secrets", () => {
    const seed = async () => {
      const a = await enqueue({ device_id: DEV, verb: "collect_diag", params: { scope: "audio" } });
      const b = await enqueue({ device_id: DEV, verb: "wake" });
      pg.exec(`
        UPDATE fleet_commands SET state = 'done', delivery_count = 1 WHERE cmd_id = '${a.json.cmd_id}';
        INSERT INTO fleet_results (cmd_id, device_id, outcome, reason, started_at, finished_at, detail, upload_key)
          VALUES ('${a.json.cmd_id}', '${DEV}', 'ok', NULL, now() - interval '3 seconds', now() - interval '2 seconds', '{"secret_detail": "DETAILMARKER"}'::jsonb, 'fleet/diag/${DEV}/x.zip');
        UPDATE fleet_commands SET state = 'delivered', delivery_count = 1 WHERE cmd_id = '${b.json.cmd_id}';
      `);
      return { a: String(a.json.cmd_id), b: String(b.json.cmd_id) };
    };
    const noSecrets = async (text: string) => {
      const sigs = (await q<{ signature: string; nonce: string }>`SELECT signature, nonce FROM fleet_commands`).flatMap((r) => [r.signature, r.nonce]);
      for (const s of [...sigs, PUB, KEY, "DETAILMARKER", "signature", "public_key", "nonce"]) expect(text, s.slice(0, 20)).not.toContain(s);
    };

    it("GET /api/admin/fleet: admin only; devices with last poll, counts, the commands with their outcome; audit; no signature, nonce, key or result detail", async () => {
      const { a, b } = await seed();
      expect((await overview(null)).status).toBe(401);
      const r = await overview();
      expect(r.status).toBe(200);
      const dev = (r.json.devices as Array<Record<string, any>>).find((d) => d.device_id === DEV)!;
      expect(dev).toMatchObject({ room_name: "H4 A", machine: "EXAMPLE-MAC-A", helper_version: "0.2.0", commands: { queued: 0, delivered: 1, done: 1, expired: 0 } });
      expect(dev.last_poll_age_s).toBeGreaterThanOrEqual(12);
      expect((r.json.devices as Array<Record<string, any>>).find((d) => d.device_id === DEV2)!.last_poll_age_s).toBeNull();
      const cmds = r.json.commands as Array<Record<string, any>>;
      expect(cmds.find((c) => c.cmd_id === a)).toMatchObject({ verb: "collect_diag", state: "done", outcome: "ok", has_upload: true, issuer_id: "adm_fake1" });
      expect(cmds.find((c) => c.cmd_id === b)).toMatchObject({ state: "delivered", outcome: null });
      expect((r.json.audit as unknown[]).length).toBe(2);
      await noSecrets(JSON.stringify(r.json));
    });

    it("the MCP door (scribe_kiosks view=helper|commands): read scope, SELECT only, the same facts, a room filter, no secrets", async () => {
      const { CALLABLE_TOOLS } = await import("@/lib/mcp/surface");
      expect(CALLABLE_TOOLS.get("scribe_kiosks")!.scope).toBe("read");
      const { a } = await seed();
      H.statements.length = 0;
      const helper = await kiosks({ view: "helper" });
      const commands = await kiosks({ view: "commands" });
      const narrowed = await kiosks({ view: "helper", room: "h4-b" });
      expect((helper.devices as Array<Record<string, any>>).map((d) => d.device_id).sort()).toEqual([DEV, DEV2].sort());
      expect((narrowed.devices as Array<Record<string, any>>).map((d) => d.device_id)).toEqual([DEV2]);
      expect((commands.commands as Array<Record<string, any>>).find((c) => c.cmd_id === a)).toMatchObject({ outcome: "ok", verb: "collect_diag" });
      expect(H.statements.length).toBeGreaterThan(0);
      expect(H.statements.filter((s) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i.test(s)), "a write statement was issued").toEqual([]);
      await noSecrets(JSON.stringify([helper, commands, narrowed]));
      expect(await q`SELECT 1 FROM fleet_audit WHERE action <> 'queue'`).toHaveLength(0);
    });
  });
});
