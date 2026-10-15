/**
 * AD2-4 (15 Oct 2026) — takenHashes catches every spelling of a hash the parser would accept as a key. Synthetic tokens only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { checkMcpBearer, takenHashes, MCP_TOKENS_ADMIN_ENV, MCP_TOKENS_ADMIN_2_ENV, MCP_TOKENS_EXTRA_ENV } from "@/lib/mcp/auth";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const req = (token: string) => new Request("https://x/api/mcp", { headers: { authorization: `Bearer ${token}` } });
const status = (t: string) => { const r = checkMcpBearer(req(t)); return r.ok ? { actor: r.principal.token_id, scopes: [...r.principal.scopes].sort() } : { fail: r.failure.status }; };
const json = (o: unknown) => JSON.stringify(o);
/** The hash's first character spelled as a JSON \u escape, inside a key. */
const letterFirst = (seed: string) => { for (let i = 0; ; i += 1) { const t = `${seed}${i}`; if (/^[a-f]/.test(sha(t))) return t; } };
const escapedKey = (h: string) => `\\u00${h.charCodeAt(0).toString(16)}${h.slice(1)}`;

const ENV = { ...process.env };
beforeEach(() => {
  for (const k of ["SCRIBE_MCP_TOKEN", "SCRIBE_MCP_TOKENS", MCP_TOKENS_EXTRA_ENV, MCP_TOKENS_ADMIN_ENV, MCP_TOKENS_ADMIN_2_ENV]) delete process.env[k];
  for (const m of ["log", "warn"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => { process.env = { ...ENV }; vi.restoreAllMocks(); });

describe("takenHashes", () => {
  it("H1: a hash inside a 65- and a 128-hex run is taken (every 64-char window)", () => {
    const h = sha("th1");
    expect(takenHashes(`x${h}a y`).has(h)).toBe(true);
    expect(takenHashes(`a${h}`).has(h)).toBe(true);
    expect(takenHashes(`${sha("th2")}${h}`).has(h)).toBe(true);
    expect(takenHashes(`${sha("th2")}${h}`.toUpperCase()).has(h)).toBe(true);
    expect(takenHashes(h).has(h)).toBe(true);
    expect(takenHashes("a".repeat(63)).size).toBe(0);
  });

  it("H2: a \\u-escaped key is taken, at any depth; bad JSON still gets H1", () => {
    const h = sha(letterFirst("th3"));
    const raw = `{"nest":[{"${escapedKey(h)}":{"actor":"x"}}]}`;
    expect(raw).not.toContain(h);
    expect(takenHashes(raw).has(h)).toBe(true);
    expect(takenHashes(`{bad ${h}`).has(h)).toBe(true);
    expect(takenHashes(`{bad "${escapedKey(h)}"`).has(h)).toBe(false);
  });

  it("unset, blank or non-hash envs give an empty set", () => {
    expect(takenHashes().size).toBe(0);
    expect(takenHashes(undefined, "", "  ", "{}", "[]", "{\"short\":1}").size).toBe(0);
  });
});

describe("a taken spelling blocks ADMIN, ADMIN_2 and EXTRA entries with that hash", () => {
  it("escaped primary key blocks EXTRA, ADMIN and ADMIN_2", () => {
    const tok = letterFirst("tb1"); const hp = sha(tok);
    process.env.SCRIBE_MCP_TOKENS = `{"${escapedKey(hp)}":{"actor":"watcher","scopes":["read"]},"${sha("tb0")}":{"actor":"w2","scopes":["read"]}}`;
    process.env[MCP_TOKENS_EXTRA_ENV] = json({ [hp]: { actor: "relay", scopes: ["read"] } });
    process.env[MCP_TOKENS_ADMIN_ENV] = json({ [hp]: { actor: "admin:a", scopes: ["read", "admin"] } });
    process.env[MCP_TOKENS_ADMIN_2_ENV] = json({ [hp]: { actor: "admin:b", scopes: ["read", "admin"] } });
    // the primary parser accepts the escaped key, so the token works as the primary entry and nothing widens it
    expect(status(tok)).toMatchObject({ actor: "watcher", scopes: ["read"] });
  });

  it("a hash inside a longer run in an unreadable primary blocks ADMIN and ADMIN_2", () => {
    const h = sha("tb2");
    process.env.SCRIBE_MCP_TOKENS = `{bad f${h}`;
    process.env[MCP_TOKENS_ADMIN_ENV] = json({ [h]: { actor: "admin:a", scopes: ["admin"] } });
    process.env[MCP_TOKENS_ADMIN_2_ENV] = json({ [sha("tb3")]: { actor: "admin:c", scopes: ["admin"] } });
    expect(status("tb2")).toEqual({ fail: 401 });
  });

  it("an escaped key in ADMIN blocks the same hash in ADMIN_2", () => {
    const tok = letterFirst("tb4"); const h = sha(tok);
    process.env[MCP_TOKENS_ADMIN_ENV] = `{"${escapedKey(h)}":{"actor":"bad","scopes":["admin"]},"${sha("tb5")}":{"actor":"admin:ok","scopes":["admin"]}}`;
    process.env[MCP_TOKENS_ADMIN_2_ENV] = json({ [h]: { actor: "admin:two", scopes: ["read", "admin"] } });
    expect(status(tok)).toEqual({ fail: 401 });
    expect(status("tb5")).toEqual({ actor: "admin:ok", scopes: ["admin"] });
  });

  it("an ADMIN key written inside a longer hex run in a bad-JSON EXTRA-style text still blocks ADMIN_2", () => {
    const h = sha("tb6");
    process.env[MCP_TOKENS_ADMIN_ENV] = `{"k":"0${h}"`; // not JSON, but not blank: ADMIN_2 is ignored whole anyway
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("tb7")]: { actor: "watcher", scopes: ["read"] } });
    process.env[MCP_TOKENS_ADMIN_2_ENV] = json({ [h]: { actor: "admin:two", scopes: ["admin"] } });
    expect(status("tb6")).toEqual({ fail: 401 });
  });
});

describe("takenHashes never throws (R1)", () => {
  it("a JSON array of 200000 items and a 10000-deep nested array give no throw, and checkMcpBearer still answers", () => {
    const big = `[${Array.from({ length: 200000 }, (_, i) => String(i)).join(",")}]`;
    const deep = "[".repeat(10000) + "]".repeat(10000);
    expect(() => takenHashes(big)).not.toThrow();
    expect(() => takenHashes(deep)).not.toThrow();
    const h = sha("rr1");
    expect(takenHashes(`${big} ${h}`).has(h)).toBe(true);
    process.env.SCRIBE_MCP_TOKENS = big;
    process.env[MCP_TOKENS_EXTRA_ENV] = deep;
    process.env[MCP_TOKENS_ADMIN_ENV] = json({ [sha("rr2")]: { actor: "admin:ok", scopes: ["admin"] } });
    expect(() => status("rr2")).not.toThrow();
    expect(status("rr2")).toBeDefined();
  });

  it("A2: with an unreadable primary, an escaped EXTRA key blocks an ADMIN entry with that hash (H2 on the EXTRA argument)", () => {
    const tok = letterFirst("rr3"); const h = sha(tok);
    process.env.SCRIBE_MCP_TOKENS = "{bad";
    process.env[MCP_TOKENS_EXTRA_ENV] = `{"${escapedKey(h)}":{"actor":"relay","scopes":["read"]}}`;
    process.env[MCP_TOKENS_ADMIN_ENV] = json({ [h]: { actor: "admin:a", scopes: ["admin"] }, [sha("rr4")]: { actor: "admin:ok", scopes: ["admin"] } });
    expect(status(tok)).toEqual({ fail: 401 });
    expect(status("rr4")).toEqual({ actor: "admin:ok", scopes: ["admin"] });
  });

  it("T1: an escaped key visited after a 200000-element array is still taken; a __proto__ parent is walked too", () => {
    const h = sha(letterFirst("rr5"));
    const raw = `[{"${escapedKey(h)}":1},[${Array(200000).fill("0").join(",")}]]`;
    expect(raw).not.toContain(h);
    expect(takenHashes(raw).has(h)).toBe(true);
    expect(takenHashes(`{"__proto__":{"${escapedKey(h)}":1}}`).has(h)).toBe(true);
  });
});
