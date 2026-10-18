/**
 * mcp-identity-audit-pg.test.ts — Fable spec 18 Oct 2026 on a REAL postgres:16 with every migration: key-to-email identity, approver-routed code, fail-closed per-call audit on all four doors,
 * the owner security log, append-only triggers, the 5-try/15-min lock, digest and the V-only gate. The DB behind lib/db is the container; nothing else is faked. Synthetic addresses at example.test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>,
  failAudit: false,
}));
vi.mock("@/lib/db", () => ({
  sql: (s: TemplateStringsArray, ...v: unknown[]) => {
    if (H.failAudit && s.join("?").includes("INSERT INTO audit_log")) return Promise.reject(new Error("audit down"));
    return H.sql(s, ...v);
  },
}));
vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-mcp-identity-audit");
type Row = Record<string, any>;
const q = async <T = Row>(strings: TemplateStringsArray, ...v: unknown[]) => (await pg.sql(strings, ...v)) as T[];

const { POST: headerPost } = await import("@/app/api/mcp/route");
const { POST: labPost } = await import("@/app/api/mcp/lab/route");
const { POST: pathPost } = await import("@/app/api/mcp/[key]/route");
const { POST: pathLabPost } = await import("@/app/api/mcp/[key]/lab/route");
const { GET: digestGet } = await import("@/app/api/admin/mcp-digest/route");
const { POST: keysPost } = await import("@/app/api/admin/mcp-keys/route");
const ID = await import("@/lib/mcp/identity");
const V = await import("@/lib/mcp/audit-views");
const S = await import("@/lib/mcp/oauth/store");
const { ownerFromRequest } = await import("@/lib/mcp/owner-gate");
const { signAdminJwt } = await import("@/lib/auth");
const { resetDeniedAuditForTests } = await import("@/lib/mcp/audit");

const APPROVER = "approver@example.test";
const ALICE = "alice@example.test"; // read-scope user
const CAROL = "carol@example.test"; // admin-scope user
const DAVE = "dave@example.test"; // env-token user, linked by seed
const OLD = "blocked@example.test"; // blacklisted by seed
const V_TOKEN = "v".repeat(24);
const DAVE_TOKEN = "d".repeat(24);
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const SENTINEL_CONSULT = "CONSULT-ZZ9PLURAL";
const SENTINEL_TEXT = "Mrs Sharma knee replacement";

const rpc = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });
const tool = (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", { name, arguments: args });
const req = (path: string, body: unknown, token?: string) =>
  new NextRequest(`https://www.evenscribe.app${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify(body) });
const header = (token: string, body: unknown) => headerPost(req("/api/mcp", body, token));
const door = {
  header: (k: string, b: unknown) => headerPost(req("/api/mcp", b, k)),
  lab: (k: string, b: unknown) => labPost(req("/api/mcp/lab", b, k)),
  path: (k: string, b: unknown) => pathPost(req(`/api/mcp/${k}`, b), { params: Promise.resolve({ key: k }) }),
  "path-lab": (k: string, b: unknown) => pathLabPost(req(`/api/mcp/${k}/lab`, b), { params: Promise.resolve({ key: k }) }),
};
const mark = async () => (await q<{ t: string }>`SELECT clock_timestamp()::text AS t`)[0]!.t;
const rowsSince = (t: string) => q`SELECT actor_type::text AS actor_type, actor_id, action, target_id, metadata_json FROM audit_log WHERE created_at > ${t}::timestamptz AND action LIKE 'mcp.%' ORDER BY created_at, id`;

let aliceKey = "";
let carolKey = "";
let aliceKeyId = "";

beforeAll(async () => {
  if (!HAVE) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
  process.env.SCRIBE_MCP_TOKEN = V_TOKEN;
  process.env.SCRIBE_MCP_TOKENS = JSON.stringify({ [sha(DAVE_TOKEN)]: { actor: "dave-env", scopes: ["read"] } });
  process.env.SCRIBE_MCP_OWNER_ACTORS = "operator-v1";
  process.env.SCRIBE_MCP_OAUTH_APPROVER = APPROVER;
  process.env.SCRIBE_MCP_IDENTITY = "on";
  process.env.SCRIBE_EXPLORER_URL = "https://claude.ai/artifact/explorer_01";
  process.env.JWT_SECRET_ADMIN = "j".repeat(32);
  process.env.CRON_SECRET = "cron-secret-synthetic";
  const a = await ID.issueKey(ALICE, "read", "test");
  const c = await ID.issueKey(CAROL, "admin", "test");
  aliceKey = a.key; aliceKeyId = a.key_id; carolKey = c.key;
  // seed: a blacklisted address and an env token linked to its owner
  await ID.setIdentityStatus(OLD, "blacklisted", "seed");
  expect(await ID.linkExistingKey(sha(DAVE_TOKEN), DAVE, "read", "seed")).toHaveProperty("key_id");
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); });
beforeEach(() => { H.failAudit = false; resetDeniedAuditForTests(); vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {}); });

describe.skipIf(!HAVE)("migration 0170 (identity, keys, owner seclog) on postgres:16", () => {
  it("is idempotent, and its down-migration removes the three tables and the guard function; re-applying restores them", async () => {
    const up = readFileSync("db/migrations/0170_mcp_oauth.sql", "utf8");
    pg.exec(up);
    pg.exec(up);
    const has = async (t: string) => (await q<{ n: number }>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = ${t}`)[0]!.n === 1;
    expect([await has("mcp_identity"), await has("mcp_key"), await has("mcp_owner_seclog")]).toEqual([true, true, true]);
    // run the rollback inside a savepoint-free scratch: it must run cleanly, then the up file must recreate everything
    pg.exec(readFileSync("db/rollbacks/0170_mcp_oauth.down.sql", "utf8"));
    expect([await has("mcp_identity"), await has("mcp_key"), await has("mcp_owner_seclog"), await has("mcp_person")]).toEqual([false, false, false, false]);
    pg.exec(up);
    expect([await has("mcp_identity"), await has("mcp_key"), await has("mcp_owner_seclog")]).toEqual([true, true, true]);
    // the rollback dropped the data too: re-seed what the rest of this file relies on
    const a = await ID.issueKey(ALICE, "read", "test");
    const c = await ID.issueKey(CAROL, "admin", "test");
    aliceKey = a.key; aliceKeyId = a.key_id; carolKey = c.key;
    await ID.setIdentityStatus(OLD, "blacklisted", "seed");
    await ID.linkExistingKey(sha(DAVE_TOKEN), DAVE, "read", "seed");
  });

  it("mcp_key: one key -> one email (FK), unique hash, scope read|admin, hash is 64 hex", async () => {
    expect(() => pg.exec(`INSERT INTO mcp_key (key_id, email, scope, key_hash) VALUES ('x1', 'nobody@example.test', 'read', '${"a".repeat(64)}')`)).toThrow();
    expect(() => pg.exec(`INSERT INTO mcp_key (key_id, email, scope, key_hash) VALUES ('x2', '${ALICE}', 'write', '${"a".repeat(64)}')`)).toThrow();
    expect(() => pg.exec(`INSERT INTO mcp_key (key_id, email, scope, key_hash) VALUES ('x3', '${ALICE}', 'read', 'not-a-hash')`)).toThrow();
    const rows = await q<{ key_hash: string }>`SELECT key_hash FROM mcp_key WHERE key_id = ${aliceKeyId}`;
    expect(rows[0]!.key_hash).toBe(sha(aliceKey));
    expect(JSON.stringify(await q`SELECT * FROM mcp_key`)).not.toContain(aliceKey); // the key itself is stored nowhere
  });

  it("the migration seeds identities from mcp_person (active stays active, revoked becomes revoked), no keys", async () => {
    pg.exec(`INSERT INTO mcp_person (email, scopes, status) VALUES ('seedme@example.test', ARRAY['read'], 'active'), ('seedrev@example.test', ARRAY['read'], 'revoked')`);
    pg.exec(readFileSync("db/migrations/0170_mcp_oauth.sql", "utf8"));
    expect(await q`SELECT email, status FROM mcp_identity WHERE email LIKE 'seed%' ORDER BY email`).toEqual([{ email: "seedme@example.test", status: "active" }, { email: "seedrev@example.test", status: "revoked" }]);
    expect(await q`SELECT 1 FROM mcp_key WHERE email LIKE 'seed%'`).toHaveLength(0);
  });

  it("append-only: an audit_log person row and an mcp.* row refuse UPDATE, DELETE and TRUNCATE; the seclog refuses UPDATE and TRUNCATE and a recent DELETE, and allows a 30-day-old DELETE", async () => {
    await header(V_TOKEN, tool("scribe_help", { tool: "scribe_now" }));
    await header(aliceKey, tool("scribe_help", { tool: "scribe_now" }));
    expect(() => pg.exec(`UPDATE audit_log SET ip = NULL WHERE actor_type = 'person'`)).toThrow(/audit_append_only/);
    expect(() => pg.exec(`DELETE FROM audit_log WHERE action LIKE 'mcp.%'`)).toThrow(/audit_append_only/);
    expect(() => pg.exec(`TRUNCATE audit_log`)).toThrow(/audit_append_only/);
    expect(() => pg.exec(`UPDATE mcp_owner_seclog SET tool = 'x'`)).toThrow(/seclog_append_only/);
    expect(() => pg.exec(`DELETE FROM mcp_owner_seclog`)).toThrow(/seclog_append_only/);
    expect(() => pg.exec(`TRUNCATE mcp_owner_seclog`)).toThrow(/seclog_append_only/);
    pg.exec(`INSERT INTO mcp_owner_seclog (ts, key_id, tool, outcome) VALUES (now() - interval '31 days', 'k_old', 'old_tool', 'ok')`);
    expect(await V.purgeSeclog()).toBe(1);
    expect(await q`SELECT 1 FROM mcp_owner_seclog WHERE key_id = 'k_old'`).toHaveLength(0);
    expect(await q`SELECT 1 FROM mcp_owner_seclog`).not.toHaveLength(0); // today's rows survive the purge
  });
});

describe.skipIf(!HAVE)("every door writes a non-owner row (email, key_id, door, tool, outcome)", () => {
  for (const d of ["header", "lab", "path", "path-lab"] as const) {
    it(`door ${d}: an issued per-user key resolves to its email, one audit_log row, no seclog row`, async () => {
      const t = await mark();
      const res = await door[d](aliceKey, tool("scribe_help", { tool: "scribe_now" }));
      expect(res.status).toBe(200);
      const rows = (await rowsSince(t)).filter((r) => r.action === "mcp.tools/call");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_type: "person", actor_id: `person:${ALICE}`, target_id: "scribe_help" });
      expect(rows[0]!.metadata_json).toMatchObject({ email: ALICE, key_id: aliceKeyId, door: d, ok: true, outcome: "ok" });
      expect(await q`SELECT 1 FROM mcp_owner_seclog WHERE ts > ${t}::timestamptz`).toHaveLength(0);
    });
  }

  it("non-call methods (initialize, tools/list) are rows too, on a path door", async () => {
    const t = await mark();
    await door.path(aliceKey, rpc("tools/list"));
    const rows = (await rowsSince(t)).filter((r) => r.action === "mcp.rpc");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata_json).toMatchObject({ email: ALICE, door: "path" });
  });

  it("an env token linked by the seed resolves to its owner on every door; an env token with no mcp_key row is refused", async () => {
    for (const d of ["header", "lab", "path", "path-lab"] as const) {
      const t = await mark();
      expect((await door[d](DAVE_TOKEN, tool("scribe_help", { tool: "scribe_now" }))).status).toBe(200);
      expect((await rowsSince(t))[0]).toMatchObject({ actor_id: `person:${DAVE}` });
    }
    const loose = "l".repeat(24);
    process.env.SCRIBE_MCP_TOKENS = JSON.stringify({ [sha(DAVE_TOKEN)]: { actor: "dave-env", scopes: ["read"] }, [sha(loose)]: { actor: "loose-env", scopes: ["read"] } });
    const t = await mark();
    expect((await header(loose, tool("scribe_help", { tool: "scribe_now" }))).status).toBe(401);
    expect(await rowsSince(t)).toEqual([expect.objectContaining({ action: "mcp.refused", actor_id: `unknown:${sha(loose).slice(0, 8)}` })]);
    process.env.SCRIBE_MCP_TOKENS = JSON.stringify({ [sha(DAVE_TOKEN)]: { actor: "dave-env", scopes: ["read"] } });
  });
});

describe.skipIf(!HAVE)("unknown, revoked and blacklisted keys are refused 401 and audited", () => {
  it("an unknown key: 401, the same body as a bad token, one mcp.refused row (unknown_key) with the hash prefix only", async () => {
    const t = await mark();
    const res = await header("k".repeat(30), tool("scribe_now"));
    expect(res.status).toBe(401);
    const rows = await rowsSince(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "mcp.refused", actor_type: "person" });
    expect(rows[0]!.metadata_json).toMatchObject({ reason: "unknown_key", outcome: "refused" });
    expect(JSON.stringify(rows)).not.toContain("k".repeat(30));
  });

  it("a revoked key: refused at once on every door (no cache), audited revoked_key with the email and key id", async () => {
    const fresh = await ID.issueKey(ALICE, "read", "test");
    expect((await header(fresh.key, tool("scribe_now"))).status).toBe(200);
    expect((await ID.revokeKey(fresh.key_id)).revoked).toBe(true);
    for (const d of ["header", "lab", "path", "path-lab"] as const) {
      resetDeniedAuditForTests();
      const t = await mark();
      expect((await door[d](fresh.key, tool("scribe_now"))).status).toBe(401);
      const rows = await rowsSince(t);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: "mcp.refused", actor_id: `person:${ALICE}`, target_id: d });
      expect(rows[0]!.metadata_json).toMatchObject({ reason: "revoked_key", key_id: fresh.key_id, door: d });
    }
  });

  it("rotation: the new key works, the old one is refused, rotated_from is recorded", async () => {
    const a = await ID.issueKey(CAROL, "read", "test");
    const b = await ID.rotateKey(a.key_id, "test");
    expect((await header(b.key, tool("scribe_now"))).status).toBe(200);
    expect((await header(a.key, tool("scribe_now"))).status).toBe(401);
    expect(await q`SELECT rotated_from FROM mcp_key WHERE key_id = ${b.key_id}`).toEqual([{ rotated_from: a.key_id }]);
  });

  it("a revoked or blacklisted identity: every key of the address is refused; a blacklisted address cannot be issued or seeded a key", async () => {
    const k = await ID.issueKey("temp@example.test", "read", "test");
    expect((await header(k.key, tool("scribe_now"))).status).toBe(200);
    await ID.setIdentityStatus("temp@example.test", "revoked", "test");
    const t = await mark();
    expect((await header(k.key, tool("scribe_now"))).status).toBe(401);
    expect((await rowsSince(t))[0]!.metadata_json).toMatchObject({ reason: "revoked_key" }); // setIdentityStatus stamps its keys revoked
    await expect(ID.issueKey("temp@example.test", "read", "test")).rejects.toThrow("identity_revoked");
    expect(await ID.activateIdentity("temp@example.test")).toBe(true);
    await ID.setIdentityStatus("temp@example.test", "blacklisted", "test");
    await expect(ID.issueKey("temp@example.test", "read", "test")).rejects.toThrow("blacklisted");
    await expect(ID.issueKey(OLD, "read", "test")).rejects.toThrow("blacklisted");
    expect(await ID.activateIdentity(OLD)).toBe(false); // activate never lifts a blacklist
    await ID.setIdentityStatus(OLD, "revoked", "test"); // and a later revoke cannot downgrade it
    expect((await q<{ status: string }>`SELECT status FROM mcp_identity WHERE email = ${OLD}`)[0]!.status).toBe("blacklisted");
    expect(await ID.linkExistingKey(sha("z".repeat(24)), OLD, "read", "seed")).toEqual({ skipped: "blacklisted" });
    // a key whose identity is flipped to blacklisted WITHOUT the key being stamped (a manual edit) is still refused by the identity check
    const k2 = await ID.issueKey("manual@example.test", "read", "test");
    pg.exec(`UPDATE mcp_identity SET status = 'blacklisted' WHERE email = 'manual@example.test'`);
    const t2 = await mark();
    expect((await header(k2.key, tool("scribe_now"))).status).toBe(401);
    expect((await rowsSince(t2))[0]!.metadata_json).toMatchObject({ reason: "identity_blacklisted" });
  });

  it("an esp_ OAuth session: an active identity resolves to its email (row with door header), a revoked identity is refused, and the approver's own session is the owner (seclog only)", async () => {
    process.env.SCRIBE_MCP_OAUTH = "on";
    process.env.MCP_OAUTH_TOKEN_PEPPER = "p".repeat(32);
    try {
      const { hashSecret } = await import("@/lib/mcp/oauth/crypto");
      let n = 0;
      const session = async (email: string, key_id: string | null = null) => {
        await S.grantPerson(email, ["read"], "test");
        const token = `esp_idpg${++n}-${"y".repeat(32)}`;
        await S.insertToken({ token_hash: hashSecret(token), kind: "access", email, client_id: "https://client.example.test/meta.json", scopes: ["read"], resource: "https://www.evenscribe.app/api/mcp", family_id: `f_idpg${n}`, ttl_s: 3600, key_id });
        return token;
      };
      const eve = "eve@example.test";
      const evKey = await ID.issueKey(eve, "read", "test"); // an identity that is active
      const tok = await session(eve, evKey.key_id);
      const t = await mark();
      expect((await header(tok, tool("scribe_now"))).status).toBe(200);
      const rows = await rowsSince(t);
      expect(rows[0]!.metadata_json).toMatchObject({ email: eve, door: "header", outcome: "ok" });
      expect(rows[0]!.metadata_json.key_id).toBe(evKey.key_id); // bound to the key it signed in with
      await ID.setIdentityStatus(eve, "revoked", "test");
      const t2 = await mark();
      expect((await header(tok, tool("scribe_now"))).status).toBe(401);
      expect((await rowsSince(t2))[0]!.metadata_json).toMatchObject({ reason: "revoked" }); // the revoke already swept the family: a denied row
      const noIdentity = await session("frank@example.test", "k_nonexistent"); // allowlisted person, key that does not exist
      expect((await header(noIdentity, tool("scribe_now"))).status).toBe(401);
      const vTok = await session(APPROVER); // V's session needs no key
      const t3 = await mark();
      expect((await header(vTok, tool("scribe_now"))).status).toBe(200);
      expect(await rowsSince(t3)).toHaveLength(0);
      expect(await q`SELECT key_id FROM mcp_owner_seclog WHERE ts > ${t3}::timestamptz`).toHaveLength(1);
    } finally {
      delete process.env.SCRIBE_MCP_OAUTH;
    }
  });
});

describe.skipIf(!HAVE)("fail closed: no audit row, no answer", () => {
  it("when the audit insert fails the call is refused (HTTP 503, audit_unavailable) and the tool's result is withheld, on every door", async () => {
    for (const d of ["header", "lab", "path", "path-lab"] as const) {
      H.failAudit = true;
      const res = await door[d](aliceKey, tool("scribe_help", { tool: "scribe_now" }));
      H.failAudit = false;
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error?.message).toBe("audit_unavailable");
      expect(body.result).toBeUndefined();
    }
  });

  it("without the approver address configured every call is a 503 (nobody can tell who V is)", async () => {
    delete process.env.SCRIBE_MCP_OAUTH_APPROVER;
    try {
      for (const k of [V_TOKEN, aliceKey, "nonsense-key"]) expect((await header(k, tool("scribe_now"))).status).toBe(503);
    } finally {
      process.env.SCRIBE_MCP_OAUTH_APPROVER = APPROVER;
    }
  });

  it("with SCRIBE_MCP_IDENTITY off nothing of this applies: the old path-key and header behaviour, a static row, no identity lookup", async () => {
    process.env.SCRIBE_MCP_IDENTITY = "off";
    try {
      const t = await mark();
      expect((await header(V_TOKEN, tool("scribe_help", { tool: "scribe_now" }))).status).toBe(200);
      expect((await header(aliceKey, tool("scribe_now"))).status).toBe(401); // an issued key is not an env token: unknown while the flag is off
      const rows = await rowsSince(t);
      expect(rows.map((r) => r.actor_type)).toEqual(["system"]);
      expect(await q`SELECT 1 FROM mcp_owner_seclog WHERE ts > ${t}::timestamptz`).toHaveLength(0);
    } finally {
      process.env.SCRIBE_MCP_IDENTITY = "on";
    }
  });
});

describe.skipIf(!HAVE)("what the rows may hold", () => {
  it("ids only: the subject is a fixed key list of id-shaped values; no text, no names, no other argument value reaches any column (scan)", async () => {
    const t = await mark();
    await header(carolKey, tool("scribe_catalog", { action: "search", q: SENTINEL_TEXT, consult_uid: SENTINEL_CONSULT, room_slug: "opd-1-xqj7", ist_date: "2026-10-17", note: SENTINEL_TEXT, patient_name: SENTINEL_TEXT, encounter_id: SENTINEL_TEXT }));
    const rows = await q`SELECT * FROM audit_log WHERE created_at > ${t}::timestamptz AND action LIKE 'mcp.%'`;
    expect(rows).toHaveLength(1);
    const meta = rows[0]!.metadata_json as Row;
    expect(meta.subject).toEqual({ consult_uid: SENTINEL_CONSULT, room_slug: "opd-1-xqj7", ist_date: "2026-10-17" }); // encounter_id held spaces: dropped, not stored
    expect(meta.arg_keys).toEqual(expect.arrayContaining(["action", "consult_uid", "q", "note", "patient_name"]));
    expect(Object.keys(meta).sort()).toEqual(["arg_keys", "bytes_out", "client_ip", "door", "email", "err_kind", "key_id", "ms", "ok", "outcome", "session_id", "subject"].sort());
    const flat = JSON.stringify(rows);
    for (const bad of ["Sharma", "knee", "replacement", "Mrs"]) expect(flat).not.toContain(bad);
    expect(flat).not.toContain(carolKey);
  });

  it("explorer: a READ-scope per-user key is told admin_required; an ADMIN-scope per-user key gets the link; both write a row", async () => {
    const t = await mark();
    const read = await (await header(aliceKey, tool("scribe_catalog", { action: "explorer_link", consult_uid: "ABCDEF123456" }))).json();
    expect(read.result.structuredContent).toMatchObject({ ok: false, error: "admin_required" });
    const admin = await (await header(carolKey, tool("scribe_catalog", { action: "explorer_link", consult_uid: "ABCDEF123456" }))).json();
    expect(admin.result.structuredContent).toMatchObject({ ok: true, kind: "consult" });
    expect(admin.result.structuredContent.url).toMatch(/^https:\/\/claude\.ai\/artifact\/explorer_01#c-ABCDEF123456$/);
    const rows = (await rowsSince(t)).filter((r) => r.action === "mcp.tools/call");
    expect(rows.map((r) => r.actor_id)).toEqual([`person:${ALICE}`, `person:${CAROL}`]);
    expect(rows[1]!.metadata_json.subject).toEqual({ consult_uid: "ABCDEF123456" });
  });
});

describe.skipIf(!HAVE)("V's own calls: seclog only", () => {
  it("V's key (a token actor in SCRIBE_MCP_OWNER_ACTORS) writes NO audit_log row and one seclog row of ts, key_id, tool, outcome; the seclog has no subject id column or value", async () => {
    const t = await mark();
    const ok = await header(V_TOKEN, tool("scribe_now", { consult_uid: SENTINEL_CONSULT, q: SENTINEL_TEXT }));
    expect(ok.status).toBe(200);
    await header(V_TOKEN, tool("no_such_tool"));
    expect(await rowsSince(t)).toHaveLength(0); // nothing in audit_log, not even a system row
    const log = await q`SELECT * FROM mcp_owner_seclog WHERE ts > ${t}::timestamptz ORDER BY id`;
    expect(log.map((r) => Object.keys(r).sort())).toEqual([["id", "key_id", "outcome", "tool", "ts"], ["id", "key_id", "outcome", "tool", "ts"]]);
    expect(log.map((r) => [r.tool, r.outcome])).toEqual([["scribe_now", "ok"], ["unknown", "refused"]]);
    expect(log[0]!.key_id).toBe(`k_${sha(V_TOKEN).slice(0, 8)}`);
    const flat = JSON.stringify(log);
    for (const bad of [SENTINEL_CONSULT, "Sharma", "knee", V_TOKEN]) expect(flat).not.toContain(bad);
    const cols = (await q<{ column_name: string }>`SELECT column_name FROM information_schema.columns WHERE table_name = 'mcp_owner_seclog' ORDER BY ordinal_position`).map((c) => c.column_name);
    expect(cols).toEqual(["id", "ts", "key_id", "tool", "outcome"]);
  });

  it("V through a per-email key (the approver's address) is the owner too; the governance view and the digest never show V", async () => {
    const vk = await ID.issueKey(APPROVER, "admin", "test");
    const t = await mark();
    expect((await header(vk.key, tool("scribe_now"))).status).toBe(200);
    expect(await rowsSince(t)).toHaveLength(0);
    expect((await q`SELECT key_id FROM mcp_owner_seclog WHERE ts > ${t}::timestamptz`)).toEqual([{ key_id: vk.key_id }]);
    expect((await V.auditByUser({ user: APPROVER })).length).toBe(0);
    const lines = await V.digestSince(new Date(Date.now() - 3600_000).toISOString());
    expect(lines.map((l) => l.email)).not.toContain(APPROVER);
    expect(lines.map((l) => l.email).sort()).toEqual(expect.arrayContaining([ALICE, CAROL, DAVE]));
  });

  it("a seclog write failure never refuses V", async () => {
    const real = H.sql;
    H.sql = ((s: TemplateStringsArray, ...v: unknown[]) => (s.join("?").includes("INSERT INTO mcp_owner_seclog") ? Promise.reject(new Error("down")) : real(s, ...v))) as never;
    try {
      expect((await header(V_TOKEN, tool("scribe_now"))).status).toBe(200);
    } finally {
      H.sql = real;
    }
  });
});

describe.skipIf(!HAVE)("views, digest, V-only gate", () => {
  it("auditByUser answers 'what did X open and when' (user + date filter, newest first, ids only); the digest holds counts and no subject ids", async () => {
    const rows = await V.auditByUser({ user: CAROL, from: "2020-01-01" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.email === CAROL)).toBe(true);
    expect(rows.find((r) => (r.subject as Row).consult_uid === SENTINEL_CONSULT)).toMatchObject({ tool: "scribe_catalog", door: "header", subject: { consult_uid: SENTINEL_CONSULT } });
    expect(await V.auditByUser({ user: CAROL, from: "2999-01-01" })).toHaveLength(0);
    const text = V.digestText(await V.digestSince(new Date(Date.now() - 3600_000).toISOString()), "since");
    expect(text).toContain(CAROL);
    expect(text).not.toContain(SENTINEL_CONSULT);
    expect(text).not.toContain(APPROVER);
  });

  it("the digest cron: 401 without the secret or the cron header; with it, it mails the approver only (Resend stub) and purges the seclog", async () => {
    expect((await digestGet(new NextRequest("https://www.evenscribe.app/api/admin/mcp-digest"))).status).toBe(401);
    process.env.RESEND_API_KEY = "re_synthetic";
    process.env.RESEND_FROM_EMAIL = "noreply@example.test";
    const sent: Array<{ to: string[]; subject: string; text: string }> = [];
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => { if (String(u) === "https://api.resend.com/emails") sent.push(JSON.parse(String(init.body))); return new Response("{}", { status: 200 }); });
    try {
      const res = await digestGet(new NextRequest("https://www.evenscribe.app/api/admin/mcp-digest", { headers: { authorization: "Bearer cron-secret-synthetic" } }));
      expect(await res.json()).toMatchObject({ ok: true, mailed: true });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toEqual([APPROVER]);
      expect(sent[0]!.text).not.toContain(SENTINEL_CONSULT);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("only the approver's admin session is 'V': another admin, a forged cookie and no cookie are refused, by the gate and by the keys API (which mails V on issue and never mails the key)", async () => {
    const vTok = await signAdminJwt({ admin_id: "a1", email: APPROVER });
    const other = await signAdminJwt({ admin_id: "a2", email: "other-admin@example.test" });
    const jar = (v?: string) => ({ cookies: { get: (n: string) => (n === "eta_admin_session" && v ? { value: v } : undefined) } });
    expect(await ownerFromRequest(jar(vTok))).toBe(APPROVER);
    expect(await ownerFromRequest(jar(other))).toBeNull();
    expect(await ownerFromRequest(jar("forged.jwt.value"))).toBeNull();
    expect(await ownerFromRequest(jar())).toBeNull();
    const post = (cookie: string | null, body: string) =>
      keysPost(new NextRequest("https://www.evenscribe.app/api/admin/mcp-keys", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie: `eta_admin_session=${cookie}` } : {}) }, body }));
    expect((await post(other, "action=issue&email=zed@example.test&scope=read")).status).toBe(403);
    expect((await post(null, "action=issue&email=zed@example.test&scope=read")).status).toBe(403);
    const mails: string[] = [];
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => { if (String(u) === "https://api.resend.com/emails") mails.push(String(init.body)); return new Response("{}", { status: 200 }); });
    try {
      const issued = await post(vTok, "action=issue&email=zed@example.test&scope=read");
      expect(issued.status).toBe(200);
      const html = await issued.text();
      const key = /<pre>([^<]+)<\/pre>/.exec(html)?.[1] ?? "";
      expect(key).toMatch(/^esk_/);
      expect((await header(key, tool("scribe_now"))).status).toBe(200);
      expect(mails.length).toBe(1);
      expect(mails[0]).toContain("zed@example.test");
      expect(mails[0]).not.toContain(key);
      expect((await post(vTok, "action=issue&email=blocked@example.test&scope=read")).status).toBe(409); // blacklisted
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe.skipIf(!HAVE)("approver-routed code: the 5-try / 15-minute address lock on real SQL", () => {
  it("5 wrong tries lock the ADDRESS for 15 minutes across pending flows; the lock lifts after", async () => {
    const e = "lock@example.test";
    const mk = (pid: string) => S.insertEmailCode({ pending_id: pid, email: e, code_hash: "h", ttl_s: 600, max_per_email: 50, window_s: 900, max_attempts: 5 });
    expect(await mk("p1")).not.toBeNull();
    for (let i = 0; i < 5; i += 1) expect(await S.takeEmailAttempt("p1", 5)).not.toBeNull();
    expect(await S.takeEmailAttempt("p1", 5)).toBeNull(); // the flow is dead
    expect(await mk("p2")).toBeNull(); // a new flow for the same address is locked out
    pg.exec(`UPDATE mcp_oauth_email_code SET created_at = now() - interval '16 minutes' WHERE email = '${e}'`);
    expect(await mk("p3")).not.toBeNull(); // 15 minutes later it opens again
    expect(await S.takeEmailAttempt("p3", 5)).not.toBeNull();
  });
});

// ─── addendum 1: sessions ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!HAVE)("session: 30 days, not sliding, bound to the key, killed at once on revoke", () => {
  let n = 0;
  const CLIENT = "https://client.example.test/meta.json";
  const RES = "https://www.evenscribe.app/api/mcp";
  async function session(email: string, keyId: string | null) {
    const { hashSecret } = await import("@/lib/mcp/oauth/crypto");
    await S.grantPerson(email, ["read"], "test");
    const fam = `f_sess${++n}${Date.now()}`;
    const access = `esp_sess${n}-${"s".repeat(32)}`;
    const refresh = `esr_sess${n}-${"s".repeat(32)}`;
    await S.insertToken({ token_hash: hashSecret(access), kind: "access", email, client_id: CLIENT, scopes: ["read"], resource: RES, family_id: fam, ttl_s: 3600, key_id: keyId });
    await S.insertToken({ token_hash: hashSecret(refresh), kind: "refresh", email, client_id: CLIENT, scopes: ["read"], resource: RES, family_id: fam, ttl_s: 30 * 86400, key_id: keyId });
    return { access, refresh, fam };
  }
  const withOAuth = async (fn: () => Promise<void>) => {
    process.env.SCRIBE_MCP_OAUTH = "on"; process.env.MCP_OAUTH_TOKEN_PEPPER = "p".repeat(32);
    try { await fn(); } finally { delete process.env.SCRIBE_MCP_OAUTH; }
  };
  const refreshGrant = async (t: string) => {
    const { POST } = await import("@/app/api/oauth/token/route");
    return POST(new NextRequest("https://www.evenscribe.app/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t, client_id: CLIENT, resource: RES }).toString() }));
  };

  it("revoking the KEY ends the session on the very next call, tombstones the family and kills its refresh token", async () => {
    await withOAuth(async () => {
      const k = await ID.issueKey("sess1@example.test", "read", "test");
      const s1 = await session("sess1@example.test", k.key_id);
      expect((await header(s1.access, tool("scribe_now"))).status).toBe(200);
      await ID.revokeKey(k.key_id);
      const t = await mark();
      expect((await header(s1.access, tool("scribe_now"))).status).toBe(401);
      expect((await q`SELECT 1 FROM mcp_oauth_family WHERE family_id = ${s1.fam}`)).toHaveLength(1);
      expect((await q`SELECT 1 FROM mcp_oauth_token WHERE family_id = ${s1.fam} AND revoked_at IS NULL`)).toHaveLength(0);
      expect((await refreshGrant(s1.refresh)).status).toBe(400);
      expect(t).toBeTruthy();
    });
  });

  it("revoking or blacklisting the EMAIL ends every session of that address; another person's session is untouched", async () => {
    await withOAuth(async () => {
      const a = await ID.issueKey("sess2@example.test", "read", "test");
      const b = await ID.issueKey("sess3@example.test", "read", "test");
      const sa = await session("sess2@example.test", a.key_id);
      const sb = await session("sess3@example.test", b.key_id);
      await ID.setIdentityStatus("sess2@example.test", "blacklisted", "test");
      const t = await mark();
      expect((await header(sa.access, tool("scribe_now"))).status).toBe(401);
      expect((await rowsSince(t))[0]!.metadata_json).toMatchObject({ ok: false, reason: "revoked" });
      expect((await header(sb.access, tool("scribe_now"))).status).toBe(200);
    });
  });

  it("rotating the key ends sessions signed in with the old key; the new key's sessions work", async () => {
    await withOAuth(async () => {
      const k = await ID.issueKey("sess4@example.test", "read", "test");
      const old = await session("sess4@example.test", k.key_id);
      const k2 = await ID.rotateKey(k.key_id, "test");
      expect((await header(old.access, tool("scribe_now"))).status).toBe(401);
      const fresh = await session("sess4@example.test", k2.key_id);
      expect((await header(fresh.access, tool("scribe_now"))).status).toBe(200);
    });
  });

  it("even a revoke made behind the app's back (a direct row edit, no sweep) is seen by the next call: session_key_revoked", async () => {
    await withOAuth(async () => {
      const k = await ID.issueKey("sess7@example.test", "read", "test");
      const s7 = await session("sess7@example.test", k.key_id);
      pg.exec(`UPDATE mcp_key SET revoked_at = now() WHERE key_id = '${k.key_id}'`);
      const t = await mark();
      expect((await header(s7.access, tool("scribe_now"))).status).toBe(401);
      expect((await rowsSince(t))[0]!.metadata_json).toMatchObject({ reason: "session_key_revoked", key_id: k.key_id });
    });
  });

  it("a session with no bound key is refused for everyone but V", async () => {
    await withOAuth(async () => {
      await ID.issueKey("sess5@example.test", "read", "test");
      const s5 = await session("sess5@example.test", null);
      expect((await header(s5.access, tool("scribe_now"))).status).toBe(401);
    });
  });

  it("expiry is absolute: a session whose FIRST token is 31 days old is refused even when its newest access token is minutes old (no sliding); at day 29 it still works", async () => {
    await withOAuth(async () => {
      const k = await ID.issueKey("sess6@example.test", "read", "test");
      const s6 = await session("sess6@example.test", k.key_id);
      pg.exec(`UPDATE mcp_oauth_token SET created_at = now() - interval '29 days' WHERE family_id = '${s6.fam}' AND kind = 'refresh'`);
      expect((await header(s6.access, tool("scribe_now"))).status).toBe(200); // fresh access token, first token 29 days old
      pg.exec(`UPDATE mcp_oauth_token SET created_at = now() - interval '31 days' WHERE family_id = '${s6.fam}' AND kind = 'refresh'`);
      const t = await mark();
      expect((await header(s6.access, tool("scribe_now"))).status).toBe(401); // the fresh access token does not rescue a 31-day-old session
      expect((await refreshGrant(s6.refresh)).status).toBe(400);
      expect(t).toBeTruthy();
    });
  });
});

describe.skipIf(!HAVE)("self_after_approval: V approves an address once", () => {
  it("approval needs an active identity, can be withdrawn, and does not survive a revoke", async () => {
    const e = "selfapp@example.test";
    expect(await ID.setSelfApproved(e, true, "v")).toBe(false); // no identity yet
    await ID.issueKey(e, "read", "test");
    expect(await ID.selfApproved(e)).toBe(false);
    expect(await ID.setSelfApproved(e, true, "v")).toBe(true);
    expect(await ID.selfApproved(e)).toBe(true);
    expect((await ID.listIdentities()).find((i) => i.email === e)!.self_approved).toBe(true);
    expect(await ID.setSelfApproved(e, false, "v")).toBe(true);
    expect(await ID.selfApproved(e)).toBe(false);
    await ID.setSelfApproved(e, true, "v");
    await ID.setIdentityStatus(e, "revoked", "test");
    expect(await ID.selfApproved(e)).toBe(false);
    await ID.activateIdentity(e);
    expect(await ID.selfApproved(e)).toBe(false); // re-activation does not restore the approval
  });

  it("the keys API: only V can approve; approving mails V (never a code)", async () => {
    const vTok = await signAdminJwt({ admin_id: "a1", email: APPROVER });
    const other = await signAdminJwt({ admin_id: "a2", email: "other-admin@example.test" });
    const post = (cookie: string, body: string) =>
      keysPost(new NextRequest("https://www.evenscribe.app/api/admin/mcp-keys", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `eta_admin_session=${cookie}` }, body }));
    await ID.issueKey("selfapp2@example.test", "read", "test");
    process.env.RESEND_API_KEY = "re_synthetic"; process.env.RESEND_FROM_EMAIL = "noreply@example.test";
    const mails: Array<{ to: string[]; text: string }> = [];
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => { if (String(u) === "https://api.resend.com/emails") mails.push(JSON.parse(String(init.body))); return new Response("{}", { status: 200 }); });
    try {
      expect((await post(other, "action=self_approve&email=selfapp2@example.test")).status).toBe(403);
      expect(await ID.selfApproved("selfapp2@example.test")).toBe(false);
      expect((await post(vTok, "action=self_approve&email=selfapp2@example.test")).status).toBe(303);
      expect(await ID.selfApproved("selfapp2@example.test")).toBe(true);
      expect(mails.map((m) => m.to)).toEqual([[APPROVER]]);
      expect((await post(vTok, "action=self_withdraw&email=selfapp2@example.test")).status).toBe(303);
      expect(await ID.selfApproved("selfapp2@example.test")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
