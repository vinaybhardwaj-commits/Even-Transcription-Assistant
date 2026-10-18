/**
 * mcp-oauth-o2-pg.test.ts — the REAL SQL of lib/mcp/oauth/store on postgres:16: the O2 migration alone (twice: idempotent), the CHECKs, the single-use code claim,
 * the refresh rotation claim, family revoke, and that a DCR client is never overwritten by a CIMD upsert. Synthetic data. DOCKER: CI host only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]> }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-mcp-oauth-o2");
const S = await import("@/lib/mcp/oauth/store");
const { POST: tokenPost } = await import("@/app/api/oauth/token/route");
const { hashSecret, s256, randomToken } = await import("@/lib/mcp/oauth/crypto");
const { NextRequest } = await import("next/server");
type Row = Record<string, any>;
const q = async <T = Row>(strings: TemplateStringsArray, ...v: unknown[]) => (await pg.sql(strings, ...v)) as T[];

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  pg.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`); // the runner's table, which the migration's own INSERT writes to
  pg.exec(`CREATE TYPE actor_type AS ENUM ('admin', 'doctor', 'system')`); // the enum from migration 0001, which the O3 ALTER TYPE extends
  const mig = readFileSync("db/migrations/0170_mcp_oauth.sql", "utf8");
  pg.exec(mig);
  pg.exec(mig); // idempotent
  const burn = readFileSync("db/migrations/0172_mcp_oauth_consent_burn.sql", "utf8");
  pg.exec(burn);
  pg.exec(burn); // idempotent
  H.sql = pg.sql as never;
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); });

const RESOURCE = "https://www.evenscribe.app/api/mcp";
const CLIENT = "https://client.example.test/meta.json";
const CB = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "r".repeat(60);
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const grant = (o: Record<string, string>) => tokenPost(new NextRequest("https://www.evenscribe.app/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(o) }));
const live = async (fam: string) => (await q<{ n: number }>`SELECT count(*)::int AS n FROM mcp_oauth_token WHERE family_id = ${fam} AND revoked_at IS NULL`)[0]!.n;
const tomb = async (fam: string) => (await q<{ n: number }>`SELECT count(*)::int AS n FROM mcp_oauth_family WHERE family_id = ${fam}`)[0]!.n;

describe.skipIf(!HAVE)("O2 store on real postgres", () => {
  it("mcp_person: lowercase email CHECK and status CHECK", async () => {
    pg.exec(`INSERT INTO mcp_person (email, scopes) VALUES ('ok@example.test', ARRAY['read'])`);
    expect(() => pg.exec(`INSERT INTO mcp_person (email, scopes) VALUES ('Bad@example.test', ARRAY['read'])`)).toThrow();
    expect(() => pg.exec(`INSERT INTO mcp_person (email, scopes, status) VALUES ('x@example.test', ARRAY['read'], 'maybe')`)).toThrow();
    expect(await S.getPerson("ok@example.test")).toMatchObject({ email: "ok@example.test", scopes: ["read"], status: "active" });
    expect(await S.getPerson("nobody@example.test")).toBeNull();
  });

  it("a code is claimed exactly once, an expired one never, and a replay is detectable", async () => {
    await S.insertCode({ code_hash: "h1", client_id: "c", email: "ok@example.test", code_challenge: "x", redirect_uri: "r", resource: "res", scopes: ["read"], ttl_s: 60 });
    const [a, b] = await Promise.all([S.claimCode("h1"), S.claimCode("h1")]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await S.codeWasUsed("h1")).toBe(true);
    await S.insertCode({ code_hash: "h2", client_id: "c", email: "ok@example.test", code_challenge: "x", redirect_uri: "r", resource: "res", scopes: ["read"], ttl_s: -5 });
    expect(await S.claimCode("h2")).toBeNull();
    expect(await S.codeWasUsed("h2")).toBe(false);
    expect(await S.claimCode("nope")).toBeNull();
  });

  it("a refresh token rotates once under concurrency; family revoke kills the lot", async () => {
    const fam = S.familyOfCode("c".repeat(36));
    const base = { email: "ok@example.test", client_id: "c", scopes: ["read"], resource: "res", family_id: fam };
    await S.insertToken({ ...base, token_hash: "a1", kind: "access", ttl_s: 3600 });
    await S.insertToken({ ...base, token_hash: "r1", kind: "refresh", ttl_s: 3600 });
    const wins = await Promise.all([S.claimRefresh("r1", "r2"), S.claimRefresh("r1", "r3")]);
    expect(wins.filter(Boolean)).toHaveLength(1);
    const t = await S.getToken("r1");
    expect(t?.rotated_to).toMatch(/^r[23]$/);
    expect(t?.expired).toBe(false);
    await S.revokeFamily(fam);
    expect((await S.getToken("a1"))?.revoked_at).not.toBeNull();
    expect((await S.getToken("r1"))?.revoked_at).not.toBeNull();
    await S.insertToken({ ...base, family_id: "f_untombstoned", token_hash: "r9", kind: "refresh", ttl_s: -1 }); // a fresh family: the one above is tombstoned
    expect(await S.claimRefresh("r9", "r10")).toBe(false); // expired
    expect((await S.getToken("r9"))?.expired).toBe(true);
    expect(await S.getToken("missing")).toBeNull();
  });

  it("upsertClient refreshes a CIMD row (bumping created_at) but never overwrites a DCR row", async () => {
    await S.upsertClient({ client_id: "https://c.example.test/m", kind: "cimd", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], metadata_url: "https://c.example.test/m", client_name: "n" });
    const first = (await S.getClient("https://c.example.test/m"))!;
    await new Promise((r) => setTimeout(r, 20));
    await S.upsertClient({ client_id: "https://c.example.test/m", kind: "cimd", redirect_uris: ["http://localhost/callback"], metadata_url: "https://c.example.test/m", client_name: "n2" });
    const second = (await S.getClient("https://c.example.test/m"))!;
    expect(second.redirect_uris).toEqual(["http://localhost/callback"]);
    expect(new Date(second.created_at).getTime()).toBeGreaterThan(new Date(first.created_at).getTime());
    await S.upsertClient({ client_id: "dcr_x", kind: "dcr", redirect_uris: ["http://localhost/callback"], metadata_url: null, client_name: null });
    await S.upsertClient({ client_id: "dcr_x", kind: "cimd", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], metadata_url: "u", client_name: "evil" });
    expect(await S.getClient("dcr_x")).toMatchObject({ kind: "dcr", redirect_uris: ["http://localhost/callback"], client_name: null });
    await S.touchClient("dcr_x");
    expect(((await q`SELECT last_used_at FROM mcp_oauth_client WHERE client_id = 'dcr_x'`)[0] as Row).last_used_at).not.toBeNull();
  });

  // ─── O2-FIX1 MUST-2: the refuter's R1 and R2, concurrently, on the real routes and the real SQL ───────────────────────────────────────────────────────
  describe("family tombstone: a revoke racing a redemption never leaves a live token", () => {
    beforeAll(() => {
      process.env.SCRIBE_MCP_OAUTH = "on";
      process.env.MCP_OAUTH_TOKEN_PEPPER = "p".repeat(32);
      pg.exec(`INSERT INTO mcp_person (email, scopes) VALUES ('racer@example.test', ARRAY['read','invoke']) ON CONFLICT DO NOTHING`);
    });

    it("insertToken refuses a tombstoned family; revokeFamily tombstones first then sweeps (deterministic interleaving)", async () => {
      const fam = "f_det1";
      const base = { email: "racer@example.test", client_id: CLIENT, scopes: ["read"], resource: RESOURCE, family_id: fam, ttl_s: 3600 };
      // A claims, B revokes, A inserts late: the insert is refused
      await S.revokeFamily(fam, "test");
      expect(await S.insertToken({ ...base, token_hash: "det-a1", kind: "access" })).toBe(false);
      expect(await live(fam)).toBe(0);
      expect(await tomb(fam)).toBe(1);
      // A inserts, THEN B revokes: the sweep takes it
      const fam2 = "f_det2";
      expect(await S.insertToken({ ...base, family_id: fam2, token_hash: "det-b1", kind: "access" })).toBe(true);
      await S.revokeFamily(fam2, "test");
      expect(await live(fam2)).toBe(0);
      await S.revokeFamily(fam2, "again"); // idempotent
      expect(await tomb(fam2)).toBe(1);
      // claimRefresh refuses a tombstoned family even for a live refresh row
      await q`INSERT INTO mcp_oauth_token (token_hash, kind, email, client_id, scopes, resource, family_id, expires_at) VALUES ('det-r', 'refresh', 'racer@example.test', ${CLIENT}, ARRAY['read'], ${RESOURCE}, ${fam}, now() + interval '1 hour')`;
      expect(await S.claimRefresh("det-r", "det-r2")).toBe(false);
      expect((await S.getToken("det-r"))?.family_revoked).toBe(true);
    });

    it("R1: the same code redeemed twice at once (x12): 0 live tokens at the end, a tombstone, and at most one 200", async () => {
      for (let i = 0; i < 12; i++) {
        const raw = randomToken("code_");
        const h = hashSecret(raw);
        await S.insertCode({ code_hash: h, client_id: CLIENT, email: "racer@example.test", code_challenge: s256(VERIFIER), redirect_uri: CB, resource: RESOURCE, scopes: ["read", "invoke"], ttl_s: 60 });
        const body = { grant_type: "authorization_code", code: raw, client_id: CLIENT, redirect_uri: CB, code_verifier: VERIFIER, resource: RESOURCE };
        const [a, b] = await Promise.all([grant(body), grant(body)]);
        const fam = S.familyOfCode(h);
        expect([a.status, b.status].filter((x) => x === 200).length, `iteration ${i}`).toBeLessThanOrEqual(1);
        expect(await live(fam), `iteration ${i}: live tokens`).toBe(0);
        expect(await tomb(fam), `iteration ${i}: tombstone`).toBe(1);
      }
    });

    it("R2: the same refresh token presented twice at once (x12): 0 live tokens in the family at the end, and a tombstone", async () => {
      for (let i = 0; i < 12; i++) {
        const fam = `f_race${i}`;
        const raw = randomToken("esr_");
        expect(await S.insertToken({ token_hash: hashSecret(raw), kind: "refresh", email: "racer@example.test", client_id: CLIENT, scopes: ["read"], resource: RESOURCE, family_id: fam, ttl_s: 3600 })).toBe(true);
        expect(await S.insertToken({ token_hash: hashSecret(`acc${i}`), kind: "access", email: "racer@example.test", client_id: CLIENT, scopes: ["read"], resource: RESOURCE, family_id: fam, ttl_s: 3600 })).toBe(true);
        const body = { grant_type: "refresh_token", refresh_token: raw, client_id: CLIENT };
        const [a, b] = await Promise.all([grant(body), grant(body)]);
        expect([a.status, b.status].filter((x) => x === 200).length, `iteration ${i}`).toBeLessThanOrEqual(1);
        expect(await live(fam), `iteration ${i}: live tokens`).toBe(0);
        expect(await tomb(fam), `iteration ${i}: tombstone`).toBe(1);
      }
    });

    it("control: a single redemption and a single refresh still work and leave live tokens", async () => {
      const raw = randomToken("code_");
      const h = hashSecret(raw);
      await S.insertCode({ code_hash: h, client_id: CLIENT, email: "racer@example.test", code_challenge: s256(VERIFIER), redirect_uri: CB, resource: RESOURCE, scopes: ["read"], ttl_s: 60 });
      const ok = await grant({ grant_type: "authorization_code", code: raw, client_id: CLIENT, redirect_uri: CB, code_verifier: VERIFIER, resource: RESOURCE });
      expect(ok.status).toBe(200);
      const t = await ok.json();
      expect(await live(S.familyOfCode(h))).toBe(2);
      const r = await grant({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CLIENT });
      expect(r.status).toBe(200);
      expect(await live(S.familyOfCode(h))).toBe(4); // old access, old refresh (rotated_to set, not revoked), new access, new refresh
      expect(await tomb(S.familyOfCode(h))).toBe(0);
    });
  });
});

describe.skipIf(!HAVE)("LOW-7 on real postgres: a code minted before a re-grant is refused", () => {
  it("granted_at >= (expires_at - ttl) refuses the code; a code minted after the grant works", async () => {
    pg.exec(`INSERT INTO mcp_person (email, scopes) VALUES ('late@example.test', ARRAY['read']) ON CONFLICT DO NOTHING`);
    const mk = async (tag: string) => {
      const raw = randomToken("code_");
      await S.insertCode({ code_hash: hashSecret(raw), client_id: CLIENT, email: "late@example.test", code_challenge: s256(VERIFIER), redirect_uri: CB, resource: RESOURCE, scopes: ["read"], ttl_s: 60 });
      return { raw, tag };
    };
    const body = (raw: string) => ({ grant_type: "authorization_code", code: raw, client_id: CLIENT, redirect_uri: CB, code_verifier: VERIFIER, resource: RESOURCE });
    const before = await mk("before");
    await new Promise((r) => setTimeout(r, 30));
    pg.exec(`UPDATE mcp_person SET granted_at = now() WHERE email = 'late@example.test'`); // the re-grant inside the code minute
    expect((await grant(body(before.raw))).status).toBe(400);
    expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM mcp_oauth_token WHERE email = 'late@example.test'`)[0]!.n).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    const after = await mk("after");
    expect((await grant(body(after.raw))).status).toBe(200);
  });
});

describe.skipIf(!HAVE)("R2 F3 on real postgres: the refresh family ends 30 days after its FIRST token", () => {
  it("family_expired reads min(created_at) over the family: a rotated chain inside 30 d works, the same chain whose first token is 30 d old is refused and tombstoned", async () => {
    process.env.SCRIBE_MCP_OAUTH = "on";
    process.env.MCP_OAUTH_TOKEN_PEPPER = "p".repeat(32);
    pg.exec(`INSERT INTO mcp_person (email, scopes) VALUES ('aged@example.test', ARRAY['read']) ON CONFLICT DO NOTHING`);
    const fam = "f_aged";
    const first = randomToken("esr_");
    await S.insertToken({ token_hash: hashSecret(first), kind: "refresh", email: "aged@example.test", client_id: CLIENT, scopes: ["read"], resource: RESOURCE, family_id: fam, ttl_s: 3600 });
    const r1 = await grant({ grant_type: "refresh_token", refresh_token: first, client_id: CLIENT });
    expect(r1.status).toBe(200);
    const second = ((await r1.json()) as { refresh_token: string }).refresh_token;
    expect((await S.getToken(hashSecret(second)))?.family_expired).toBe(false);
    // backdate ONLY the family's first token: the newest refresh token is fresh, but the family is 30 d + 1 min old
    await q`UPDATE mcp_oauth_token SET created_at = now() - interval '30 days 1 minute' WHERE token_hash = ${hashSecret(first)}`;
    expect((await S.getToken(hashSecret(second)))?.family_expired).toBe(true);
    expect((await S.getToken(hashSecret(second)))?.expired).toBe(false);
    const r2 = await grant({ grant_type: "refresh_token", refresh_token: second, client_id: CLIENT });
    expect(r2.status).toBe(400);
    expect((await r2.json()).error).toBe("invalid_grant");
    expect((await q<{ reason: string }>`SELECT reason FROM mcp_oauth_family WHERE family_id = ${fam}`)[0]?.reason).toBe("family_expired");
    expect(await live(fam)).toBe(0);
    // a family exactly inside the limit is not expired
    const fam2 = "f_young";
    const young = randomToken("esr_");
    await S.insertToken({ token_hash: hashSecret(young), kind: "refresh", email: "aged@example.test", client_id: CLIENT, scopes: ["read"], resource: RESOURCE, family_id: fam2, ttl_s: 3600 });
    await q`UPDATE mcp_oauth_token SET created_at = now() - interval '29 days 23 hours' WHERE family_id = ${fam2}`;
    expect((await S.getToken(hashSecret(young)))?.family_expired).toBe(false);
  });
});

describe.skipIf(!HAVE)("R3 on real postgres: a consent page is burned exactly once (0172)", () => {
  it("burnConsent: one winner under concurrency (x12), every later call false, distinct hashes independent", async () => {
    for (let i = 0; i < 12; i++) {
      const h = `burn-${i}`;
      const wins = await Promise.all([S.burnConsent(h), S.burnConsent(h), S.burnConsent(h)]);
      expect(wins.filter(Boolean), `iteration ${i}`).toHaveLength(1);
      expect(await S.burnConsent(h)).toBe(false);
    }
    expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM mcp_oauth_consent_burn WHERE csrf_hash LIKE 'burn-%'`)[0]!.n).toBe(12);
    expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM schema_migrations WHERE version = 172`)[0]!.n).toBe(1);
  });
});

describe.skipIf(!HAVE)("email sign-in codes on real postgres (amended 0170: mcp_oauth_email_code)", () => {
  const base = { ttl_s: 600, max_per_email: 3, window_s: 900, max_attempts: 5 };
  const ins = (pending_id: string, email: string, code_hash = "h") => S.insertEmailCode({ pending_id, email, code_hash, ...base });

  it("the table has the ordered columns and both indexes; the migration applied twice without error", async () => {
    const cols = (await q<{ column_name: string }>`SELECT column_name FROM information_schema.columns WHERE table_name = 'mcp_oauth_email_code' ORDER BY ordinal_position`).map((c) => c.column_name);
    expect(cols).toEqual(["id", "pending_id", "email", "code_hash", "expires_at", "attempts", "used_at", "created_at"]);
    const idx = (await q<{ indexname: string }>`SELECT indexname FROM pg_indexes WHERE tablename = 'mcp_oauth_email_code'`).map((i) => i.indexname);
    expect(idx).toEqual(expect.arrayContaining(["mcp_oauth_email_code_pending_idx", "mcp_oauth_email_code_email_idx"]));
    expect((await q`SELECT count(*)::int AS n FROM schema_migrations WHERE version = 170`)[0]).toEqual({ n: 1 });
  });

  it("per address: 3 codes in the window, the 4th is refused; another address is unaffected", async () => {
    for (let i = 0; i < 3; i++) expect(await ins(`pa${i}`, "rate@example.test")).not.toBeNull();
    expect(await ins("pa3", "rate@example.test")).toBeNull();
    expect(await ins("pa4", "other@example.test")).not.toBeNull();
    expect(await S.countRecentEmailCodes("rate@example.test", 900)).toBe(3);
  });

  it("takeEmailAttempt: spends one try on the newest live code; the 5th wrong try is the last; the flow is then dead for every code; consume is single use", async () => {
    const id1 = (await ins("pb", "att@example.test", "old"))!;
    const id2 = (await ins("pb", "att@example.test", "new"))!;
    const first = await S.takeEmailAttempt("pb", 5);
    expect(first).toMatchObject({ id: id2, code_hash: "new", email: "att@example.test" }); // the newest wins
    for (let i = 0; i < 4; i++) expect(await S.takeEmailAttempt("pb", 5)).not.toBeNull();
    expect(await S.takeEmailAttempt("pb", 5)).toBeNull(); // 5 spent across the flow
    expect(await ins("pb", "att2@example.test")).toBeNull(); // and no new code is issued into a dead flow
    expect(id1).not.toBe(id2);
    const idc = (await ins("pc", "cons@example.test"))!;
    const wins = await Promise.all([S.consumeEmailCode(idc), S.consumeEmailCode(idc), S.consumeEmailCode(idc)]);
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(await S.takeEmailAttempt("pc", 5)).toBeNull(); // used
  });

  it("parallel guesses cannot exceed the per-row cap (x12 concurrent takes on a fresh flow: at most 5 rows returned)", async () => {
    await ins("pd", "par@example.test");
    const rs = await Promise.all(Array.from({ length: 12 }, () => S.takeEmailAttempt("pd", 5)));
    expect(rs.filter(Boolean).length).toBeLessThanOrEqual(5);
    expect((await q<{ attempts: number }>`SELECT attempts FROM mcp_oauth_email_code WHERE pending_id = 'pd'`)[0]!.attempts).toBeLessThanOrEqual(5);
  });

  it("an expired code is not offered; a code of another pending flow is not offered; deleteEmailCode removes the row", async () => {
    await S.insertEmailCode({ pending_id: "pe", email: "exp@example.test", code_hash: "x", ...base, ttl_s: -1 });
    expect(await S.takeEmailAttempt("pe", 5)).toBeNull();
    const id = (await ins("pf", "del@example.test"))!;
    expect(await S.takeEmailAttempt("pg-other", 5)).toBeNull();
    await S.deleteEmailCode(id);
    expect(await S.takeEmailAttempt("pf", 5)).toBeNull();
    expect(await S.countRecentEmailCodes("del@example.test", 900)).toBe(0);
  });
});
