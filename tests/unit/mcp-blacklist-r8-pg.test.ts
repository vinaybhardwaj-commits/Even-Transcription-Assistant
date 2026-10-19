/** R8: X1 (flag on/off through the real admin tool and start route), X3 (lookup failure fails closed) and Y1 (env denylist wired into the script's real sources) on a test-owned postgres:16 with every migration. Synthetic addresses only. Skipped when Docker is absent. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { mailed, resendFetch, resetMail } from "../support/mcp-oauth-email-flow";

type Hook = (t: string, v: unknown[]) => "fail" | "empty" | null;
const H = vi.hoisted(() => ({ sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>, hook: null as null | Hook }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => { const t = s.join("?"); const h = H.hook?.(t, v); if (h === "fail") return Promise.reject(new Error("injected")); if (h === "empty") return Promise.resolve([]); return H.sql(s, ...v); } }));
vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-r8-blacklist");
type Row = Record<string, any>;
const q = async <T = Row>(s: TemplateStringsArray, ...v: unknown[]) => (await pg.sql(s, ...v)) as T[];
const S = await import("@/lib/mcp/oauth/store");
const ID = await import("@/lib/mcp/identity");
const A = await import("@/lib/mcp/audit");
const BL = await import("@/lib/mcp/blacklist-file");
const G = await import("@/lib/mcp/oauth/blacklist-guard");
const { adminTool } = await import("@/lib/mcp/tools/admin");
const { signBlob } = await import("@/lib/mcp/oauth/crypto");
const { resetEmailLimitForTests } = await import("@/lib/mcp/oauth/email-limit");
const { POST: startPost } = await import("@/app/api/oauth/email/start/route");
const SCRIPT = await import("../../scripts/blacklist-from-revocations");

const DOMAIN = "example.test";
const dir = mkdtempSync(`${tmpdir()}/oref6-bl-`);
const blFile = (list: unknown) => { const p = `${dir}/${Math.random().toString(36).slice(2)}.json`; writeFileSync(p, JSON.stringify(list)); chmodSync(p, 0o600); return p; };
const pending = (pid: string) => signBlob("pending", { cid: "c", ru: "https://claude.ai/cb", cc: "x".repeat(43), st: null, res: "https://www.evenscribe.app/api/mcp", pid, exp: Math.floor(Date.now() / 1000) + 600 });
const start = (email: string) => startPost(new NextRequest("https://www.evenscribe.app/api/oauth/email/start", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://www.evenscribe.app", cookie: `mcp_oauth_pending=${pending(`p_${Math.random().toString(36).slice(2)}`)}`, "x-forwarded-for": "203.0.113.9" }, body: `email=${email}`,
}));
const codes = async (e: string) => (await q<{ n: number }>`SELECT count(*)::int AS n FROM mcp_oauth_email_code WHERE email = ${e}`)[0]!.n;
const status = async (e: string) => (await S.getPerson(e))?.status;
const admin = async (email: string) => (await adminTool.handler({ action: "person_grant", email }, { actor: "mcp:admin:oref", scopes: new Set(["read", "admin"]) } as never)) as unknown as Record<string, unknown>;
const refusedRows = async (action: string, e: string) => (await q`SELECT 1 FROM audit_log WHERE action = ${action} AND target_id = ${e}`).length;

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); vi.unstubAllGlobals(); });
beforeEach(() => {
  A.resetDeniedAuditForTests(); G.resetBlacklistGuardLogForTests(); S.resetGrantRefusalLogForTests(); resetEmailLimitForTests(); resetMail(); H.hook = null;
  vi.stubGlobal("fetch", vi.fn(async (i: string | URL, init?: RequestInit) => { const m = resendFetch(i, init); if (m) return m; throw new Error("unexpected fetch"); }));
  process.env.SCRIBE_MCP_OAUTH = "on"; process.env.MCP_OAUTH_TOKEN_PEPPER = "p".repeat(32); process.env.RESEND_API_KEY = "re_synthetic"; process.env.RESEND_FROM_EMAIL = "noreply@example.test";
  process.env.SCRIBE_MCP_OAUTH_APPROVER = "approver@example.test"; process.env.SCRIBE_MCP_OAUTH_DOMAIN_TEST = DOMAIN; delete process.env.SCRIBE_MCP_IDENTITY; delete process.env.SCRIBE_MCP_TOKENS_DENY;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe.skipIf(!HAVE)("blacklist re-grant and fail-closed on postgres:16", () => {
  for (const flag of ["off", "on"] as const) {
    it(`X1 flag ${flag}: admin re-grant of a blacklisted address is refused (row, no grant), start mints 0 codes; a near-name granted by admin gets 1`, async () => {
      const e = `x1${flag}@${DOMAIN}`, near = `x1${flag}1@${DOMAIN}`;
      await S.grantPerson(e, ["read"], "t"); await ID.issueKey(e, "read", "t");
      await BL.applyBlacklistFile("t", blFile([e]));
      if (flag === "on") process.env.SCRIBE_MCP_IDENTITY = "on";
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const out = await admin(e);
      expect(out.ok).toBe(false);
      expect(out.error).toBe("blacklisted");
      expect(await status(e)).toBe("revoked");
      expect(await refusedRows("admin.person_grant.refused", e)).toBe(1);
      expect((await start(e)).status).toBe(200);
      expect(await codes(e)).toBe(0);
      const ok = await admin(near);
      expect(ok.ok).toBe(true);
      if (flag === "on") await ID.issueKey(near, "read", "t");
      expect((await start(near)).status).toBe(200);
      expect([await codes(e), await codes(near)]).toEqual([0, 1]);
      expect(mailed).toHaveLength(1);
      expect(JSON.stringify(err.mock.calls)).not.toContain(e);
      err.mockRestore();
    });
  }
  it("X3 the blacklist lookup failing (DB error) means no grant, in the admin tool and in grantPerson (fail closed)", async () => {
    const e = `x3@${DOMAIN}`;
    await S.grantPerson(e, ["read"], "t"); await BL.applyBlacklistFile("t", blFile([e]));
    H.hook = (t) => (t.includes("status = 'blacklisted'") ? "fail" : null);
    expect((await admin(e)).ok).toBe(false);
    await expect(S.grantPerson(e, ["read"], "t")).rejects.toThrow();
    H.hook = null;
    expect(await status(e)).toBe("revoked");
  });
});

describe.skipIf(!HAVE)("script, REAL sources (db + env denylist) through main()", () => {
  const root = mkdtempSync(`${tmpdir()}/oref6-s-`); const repo = `${root}/repo`; const outside = `${root}/out`; mkdirSync(repo); mkdirSync(outside);
  const run = async (argv: string[]) => { const lines: string[] = []; const err = vi.spyOn(console, "error").mockImplementation((...a) => { lines.push(a.join(" ")); }); try { return { code: await SCRIPT.main(argv, undefined, repo, (s) => lines.push(s)), lines }; } finally { err.mockRestore(); } };
  it("Y1 env denylist source is wired into the real run; dry-count is the exact union of db and env (overlap counted once)", async () => {
    const k = await ID.issueKey(`y1.env@${DOMAIN}`, "read", "t");
    const hash = (await q<{ key_hash: string }>`SELECT key_hash FROM mcp_key WHERE key_id = ${k.key_id}`)[0]!.key_hash;
    const dbBefore = (await BL.revocationAddresses16Oct()).length;
    process.env.SCRIBE_MCP_TOKENS_DENY = JSON.stringify([hash.toUpperCase(), "e".repeat(64)]);
    const r = await run(["--dry-count"]);
    expect(r).toEqual({ code: 0, lines: [`db=${dbBefore} env=1 union=${dbBefore + 1} rejected=0`] });
    const f = `${outside}/y1.json`;
    const w = await run([f]);
    expect(w.code).toBe(0);
    expect(JSON.parse(readFileSync(f, "utf8"))).toContain(`y1.env@${DOMAIN}`);
    expect(w.lines.join("\n")).not.toContain("@");
  });
});

