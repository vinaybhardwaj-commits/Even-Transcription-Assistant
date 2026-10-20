/**
 * mcp-oauth-o3-pg.test.ts — the whole O3 path on a REAL postgres:16 with every migration (the O2/O3 file included): grant (scribe_admin), mint (O2 store helpers), call, audit row,
 * actor filter, revoke, refuse. The DB behind lib/db is the container; nothing else is faked. Synthetic addresses at example.test only. DOCKER: CI host only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]> }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-mcp-oauth-o3");
type Row = Record<string, any>;
const q = async <T = Row>(strings: TemplateStringsArray, ...v: unknown[]) => (await pg.sql(strings, ...v)) as T[];

const { POST } = await import("@/app/api/mcp/route");
const S = await import("@/lib/mcp/oauth/store");
const { hashSecret } = await import("@/lib/mcp/oauth/crypto");

const ALICE = "alice@example.test";
const BOB = "bob@example.test";
const ADMIN_TOKEN = "a".repeat(24);
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const RESOURCE = "https://www.evenscribe.app/api/mcp";

const call = (token: string, body: unknown, ip = "203.0.113.9") =>
  POST(new NextRequest("https://www.evenscribe.app/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-forwarded-for": ip }, body: JSON.stringify(body) }));
const tool = (name: string, args: Record<string, unknown> = {}, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const result = async (res: Response) => (await res.json()).result.structuredContent as Record<string, any>;

/** C4 B1: audit_log person rows are append-only (0171), so no DELETE. Each check takes a marker from the server clock and reads only rows written after it. */
const mark = async () => (await q<{ t: string }>`SELECT clock_timestamp()::text AS t`)[0]!.t;

let n = 0;
async function mint(email: string, ttl_s = 3600): Promise<string> {
  const token = `esp_pg${++n}-${"y".repeat(32)}`;
  await S.insertToken({ token_hash: hashSecret(token), kind: "access", email, client_id: "https://client.example.test/meta.json", scopes: ["read", "invoke", "write", "admin"], resource: RESOURCE, family_id: `f_pgfamily${n}`, ttl_s });
  return token;
}

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
  process.env.SCRIBE_MCP_OAUTH = "on";
  process.env.MCP_OAUTH_TOKEN_PEPPER = "p".repeat(32);
  process.env.SCRIBE_MCP_OAUTH_DOMAIN_TEST = "example.test";
  process.env.SCRIBE_MCP_TOKENS_ADMIN = JSON.stringify({ [sha(ADMIN_TOKEN)]: { actor: "admin:gating", scopes: ["read", "admin"] } });
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); });

describe.skipIf(!HAVE)("grant, mint, call, row, revoke, refuse on real postgres", () => {
  it("the enum accepts 'person' and the O2/O3 migration is idempotent on top of every other migration", () => {
    pg.exec(readFileSync("db/migrations/0170_mcp_oauth.sql", "utf8"));
    expect(() => pg.exec(`SELECT 'person'::actor_type`)).not.toThrow();
  });

  it("grant by the static admin token; a bad domain is refused", async () => {
    const ok = await result(await call(ADMIN_TOKEN, tool("scribe_admin", { action: "person_grant", email: ALICE, reason: "pg test" })));
    expect(ok).toMatchObject({ ok: true, person: { email: ALICE, status: "active" } });
    await result(await call(ADMIN_TOKEN, tool("scribe_admin", { action: "person_grant", email: BOB })));
    const bad = await result(await call(ADMIN_TOKEN, tool("scribe_admin", { action: "person_grant", email: ["x", "gmail.example.test"].join("@") })));
    expect(bad.error).toBe("wrong_domain");
    const list = await result(await call(ADMIN_TOKEN, tool("scribe_admin", { action: "person_list" })));
    expect(list.people.map((p: Row) => p.email)).toEqual([ALICE, BOB]);
    const rows = await q`SELECT actor_type::text AS t, actor_id, action, target_type, target_id, metadata_json FROM audit_log WHERE action LIKE 'admin.person%' ORDER BY created_at`;
    expect(rows.map((r) => r.action).sort()).toEqual(["admin.person_grant", "admin.person_grant", "admin.person_grant.refused", "admin.person_list"]);
    expect(rows.find((r) => r.action === "admin.person_grant")).toMatchObject({ actor_id: "mcp:admin:gating", target_type: "mcp_person", target_id: ALICE });
  });

  it("a minted token calls the door: one audit_log row per call, actor_type person, the right shape, client_ip from the first hop", async () => {
    const t = await mint(ALICE);
    const since = await mark();
    expect((await call(t, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, "198.51.100.4, 192.0.2.1")).status).toBe(200);
    expect((await call(t, tool("scribe_help", { tool: "scribe_now" }), "198.51.100.4")).status).toBe(200);
    const rows = await q`SELECT actor_type::text AS t, actor_id, action, target_type, target_id, metadata_json AS m, host(ip) AS ip FROM audit_log WHERE actor_id = ${`person:${ALICE}`} AND created_at > ${since}::timestamptz ORDER BY created_at, id`;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.t, r.action, r.target_type, r.target_id])).toEqual([["person", "mcp.rpc", "mcp_method", "initialize"], ["person", "mcp.tools/call", "mcp_tool", "scribe_help"]]);
    for (const r of rows) {
      expect(Object.keys(r.m).sort()).toEqual(["arg_keys", "bytes_out", "client_ip", "err_kind", "ms", "ok", "outcome", "session_id", "subject"].sort());
      expect(r.m.session_id).toMatch(/^f_pgfamily/);
      expect(r.m.client_ip).toBe("198.51.100.4");
      expect(r.ip).toBe("198.51.100.4");
    }
    expect(JSON.stringify(rows)).not.toContain(t);
  });

  it("scribe_audit_recent with actor= returns exactly that person's rows (the real filter), and another actor gets none of them", async () => {
    const t = await mint(ALICE);
    const mine = await result(await call(t, tool("scribe_audit_recent", { actor: `person:${ALICE}`, limit: 50 })));
    expect(mine.rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(mine.rows.map((r: Row) => r.actor))).toEqual(new Set([`person:${ALICE}`]));
    expect(mine.rows.every((r: Row) => r.actor_type === "person")).toBe(true);
    const bobs = await result(await call(t, tool("scribe_audit_recent", { actor: `person:${BOB}` })));
    expect(bobs.rows).toEqual([]);
    const rpc = await result(await call(t, tool("scribe_audit_recent", { action: "mcp.rpc", actor: `person:${ALICE}` })));
    expect(rpc.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("revoke_person: person and every token revoked in one statement; the next call is 401 with a mcp.denied row; a re-grant restores the person but not the old tokens", async () => {
    const bobTok = await mint(BOB);
    expect((await call(bobTok, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
    const out = await result(await call(ADMIN_TOKEN, tool("scribe_admin", { action: "revoke_person", email: BOB, reason: "pg test" })));
    expect(out).toMatchObject({ ok: true, changed: true, tokens_revoked: expect.any(Number) });
    expect(out.tokens_revoked).toBeGreaterThanOrEqual(1);
    expect((await q`SELECT status FROM mcp_person WHERE email = ${BOB}`)[0]!.status).toBe("revoked");
    expect((await q`SELECT count(*)::int AS n FROM mcp_oauth_token WHERE email = ${BOB} AND revoked_at IS NULL`)[0]!.n).toBe(0);
    const res = await call(bobTok, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    const denied = await q`SELECT actor_type::text AS t, actor_id, action, metadata_json AS m FROM audit_log WHERE action = 'mcp.denied' AND actor_id = ${`person:${BOB}`}`;
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ t: "person", m: { reason: "revoked" } });
    await call(ADMIN_TOKEN, tool("scribe_admin", { action: "person_grant", email: BOB }));
    expect((await call(bobTok, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401); // the old token stays revoked
    expect((await call(await mint(BOB), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
  });

  it("refuse: a token for an address not on the allowlist and an expired token are 401 and logged; self-revoke is refused", async () => {
    expect((await call(await mint("ghost@example.test"), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    expect((await call(await mint(ALICE, -5), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    const denied = await q`SELECT actor_id, metadata_json AS m FROM audit_log WHERE action = 'mcp.denied' AND actor_id IN ('person:ghost@example.test', ${`person:${ALICE}`}) ORDER BY actor_id`;
    expect(denied.map((r) => [r.actor_id, r.m.reason])).toEqual([[`person:${ALICE}`, "expired"], ["person:ghost@example.test", "inactive"]]);
    const t = await mint(ALICE);
    // V ruling: a signed-in person cannot use scribe_admin writes at all, themselves included
    expect((await result(await call(t, tool("scribe_admin", { action: "revoke_person", email: ALICE })))).error).toBe("admin_actor_required");
    expect((await q`SELECT status FROM mcp_person WHERE email = ${ALICE}`)[0]!.status).toBe("active");
    expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'admin.revoke_person.refused' AND actor_id = ${`person:${ALICE}`} AND actor_type::text = 'person'`)[0]!.n).toBe(1);
  });

  it("a revoked person whose old token is replayed after revoke is refused even if the token row were somehow live (person status is checked on every call)", async () => {
    const t = await mint(ALICE);
    pg.exec(`UPDATE mcp_person SET status = 'revoked' WHERE email = '${ALICE}'`);
    expect((await call(t, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    pg.exec(`UPDATE mcp_person SET status = 'active' WHERE email = '${ALICE}'`);
    expect((await call(t, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
  });

  it("a token whose family is tombstoned is refused even though its own row is still live (the O2-FIX1 race left it unswept)", async () => {
    const t = await mint(ALICE);
    expect((await call(t, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
    const fam = (await q<{ family_id: string }>`SELECT family_id FROM mcp_oauth_token WHERE token_hash = ${hashSecret(t)}`)[0]!.family_id;
    await q`INSERT INTO mcp_oauth_family (family_id, reason) VALUES (${fam}, 'test')`;
    expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM mcp_oauth_token WHERE family_id = ${fam} AND revoked_at IS NULL`)[0]!.n).toBe(1);
    expect((await call(t, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
  });

  it("MUST-1: a malformed X-Forwarded-For (1.2.3.999, deadbeef, ::::::, empty) gives 200, a row, and a NULL ip on real postgres", async () => {
    const t = await mint(ALICE);
    for (const xff of ["1.2.3.999", "deadbeef", "::::::", ""]) {
      const since = await mark();
      const res = await call(t, tool("scribe_help", { tool: "scribe_now" }), xff);
      expect(res.status, xff).toBe(200);
      const rows = await q`SELECT host(ip) AS ip, metadata_json->>'client_ip' AS cip FROM audit_log WHERE actor_id = ${`person:${ALICE}`} AND created_at > ${since}::timestamptz`;
      expect(rows, xff).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ip: null, cip: null });
    }
  });

  it("a failing audit insert on real postgres (a trigger rejects person rows) gives audit_unavailable, and removing it restores service", async () => {
    const t = await mint(ALICE);
    pg.exec(`CREATE OR REPLACE FUNCTION no_person_rows() RETURNS trigger AS $$ BEGIN IF NEW.actor_type::text = 'person' THEN RAISE EXCEPTION 'blocked'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
             CREATE TRIGGER no_person_rows_t BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION no_person_rows();`);
    try {
      const res = await call(t, tool("scribe_help", { tool: "scribe_now" }));
      expect(res.status).toBe(503);
      expect((await res.json()).error).toEqual({ code: -32003, message: "audit_unavailable" });
    } finally {
      pg.exec(`DROP TRIGGER no_person_rows_t ON audit_log; DROP FUNCTION no_person_rows();`);
    }
    expect((await call(t, tool("scribe_help", { tool: "scribe_now" }))).status).toBe(200);
  });

  it("SHOULD-1 (the refuter's race): revoke_person tombstones every family in one statement; a token inserted after the sweep stays dead after a re-grant; a fresh token works", async () => {
    const early = await mint(BOB);
    const famEarly = (await q<{ family_id: string }>`SELECT family_id FROM mcp_oauth_token WHERE token_hash = ${hashSecret(early)}`)[0]!.family_id;
    const out = await result(await call(ADMIN_TOKEN, tool("scribe_admin", { action: "revoke_person", email: BOB })));
    expect(out.ok).toBe(true);
    expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM mcp_oauth_family WHERE family_id = ${famEarly} AND reason = 'person_revoked'`)[0]!.n).toBe(1);
    const racing = await mint(BOB); // inserted after the sweep, in a family nobody tombstoned
    expect((await call(racing, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401); // person revoked
    await call(ADMIN_TOKEN, tool("scribe_admin", { action: "person_grant", email: BOB }));
    expect((await call(racing, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401); // still dead: created_at < granted_at
    expect((await call(early, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    expect((await call(await mint(BOB), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
  });

  it("changing the scopes of an ACTIVE person keeps their token (granted_at does not move)", async () => {
    const t = await mint(BOB);
    const before = (await q<{ g: string }>`SELECT granted_at::text AS g FROM mcp_person WHERE email = ${BOB}`)[0]!.g;
    await call(ADMIN_TOKEN, tool("scribe_admin", { action: "person_grant", email: BOB, scopes: ["read", "invoke"] }));
    expect((await q<{ g: string }>`SELECT granted_at::text AS g FROM mcp_person WHERE email = ${BOB}`)[0]!.g).toBe(before);
    expect((await call(t, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
    await call(ADMIN_TOKEN, tool("scribe_admin", { action: "person_grant", email: BOB })); // back to all four
  });

  it("refresh refuses a refresh token created before the person's last re-grant (real SQL)", async () => {
    const { POST: tokenPost } = await import("@/app/api/oauth/token/route");
    const raw = `esr_pg-old-${"z".repeat(30)}`;
    await S.insertToken({ token_hash: hashSecret(raw), kind: "refresh", email: BOB, client_id: "https://client.example.test/meta.json", scopes: ["read"], resource: RESOURCE, family_id: "f_pg-old-refresh", ttl_s: 3600 });
    await call(ADMIN_TOKEN, tool("scribe_admin", { action: "revoke_person", email: BOB }));
    await call(ADMIN_TOKEN, tool("scribe_admin", { action: "person_grant", email: BOB }));
    const res = await tokenPost(new NextRequest("https://www.evenscribe.app/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: raw, client_id: "https://client.example.test/meta.json" }).toString() }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("C4 B1: after the whole suite the person rows are still there and a DELETE of them is refused by 0171", async () => {
    expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM audit_log WHERE actor_type::text = 'person'`)[0]!.n).toBeGreaterThan(0);
    expect(() => pg.exec(`DELETE FROM audit_log WHERE actor_type::text = 'person'`)).toThrow(/audit_append_only/);
  });
});
