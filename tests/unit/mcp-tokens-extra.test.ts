/**
 * SCRIBE_MCP_TOKENS_EXTRA — the ADDITIVE token map (Fable ruling 137; herdr-kit #207 option C). SCRIBE_MCP_TOKENS is a write-only Secret that cannot be
 * read back, so a new token (the room-alert relay's read-only one, the night feeder's) cannot be added to it without destroying every existing entry. The
 * extra map takes the same hash-keyed JSON and sits BEHIND the primary: it can add a token, never change one. Every door goes through checkMcpBearer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { checkMcpBearer, mergeTokenMaps, parseTokenMap, MCP_TOKENS_EXTRA_ENV } from "@/lib/mcp/auth";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const req = (token?: string) => new Request("https://x/api/mcp", { headers: token ? { authorization: `Bearer ${token}` } : {} });
const map = (o: Record<string, { actor: string; scopes: string[] }>) => JSON.stringify(o);
const who = (t?: string) => {
  const r = checkMcpBearer(req(t));
  return r.ok ? { actor: r.principal.token_id, scopes: [...r.principal.scopes].sort() } : { fail: r.failure.status };
};

const ENV = { ...process.env };
beforeEach(() => {
  delete process.env.SCRIBE_MCP_TOKEN; delete process.env.SCRIBE_MCP_TOKENS; delete process.env[MCP_TOKENS_EXTRA_ENV];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { process.env = { ...ENV }; vi.restoreAllMocks(); });

describe("the additive map", () => {
  it("DARK: unset, blank or an empty object changes nothing", () => {
    process.env.SCRIBE_MCP_TOKENS = map({ [sha("old")]: { actor: "watcher", scopes: ["read"] } });
    const before = who("old");
    for (const v of [undefined, "", "   ", "{}"]) {
      if (v === undefined) delete process.env[MCP_TOKENS_EXTRA_ENV]; else process.env[MCP_TOKENS_EXTRA_ENV] = v;
      expect(who("old")).toEqual(before);
      expect(who("nope")).toEqual({ fail: 401 });
    }
  });

  it("adds a token BESIDE the primary: both resolve, each with its own actor and scopes", () => {
    process.env.SCRIBE_MCP_TOKENS = map({ [sha("old")]: { actor: "watcher", scopes: ["read", "invoke"] } });
    process.env[MCP_TOKENS_EXTRA_ENV] = map({ [sha("relay")]: { actor: "room-alert-relay", scopes: ["read"] } });
    expect(who("old")).toEqual({ actor: "watcher", scopes: ["invoke", "read"] });
    expect(who("relay")).toEqual({ actor: "room-alert-relay", scopes: ["read"] });
    expect(who("stranger")).toEqual({ fail: 401 });
  });

  it("works ALONE: with only the extra map configured the door is configured, not a 503", () => {
    process.env[MCP_TOKENS_EXTRA_ENV] = map({ [sha("relay")]: { actor: "room-alert-relay", scopes: ["read"] } });
    expect(who("relay")).toEqual({ actor: "room-alert-relay", scopes: ["read"] });
    expect(who("stranger")).toEqual({ fail: 401 });
    expect(who()).toEqual({ fail: 401 });
  });

  it("a read-only extra entry gets ONLY read; an entry with no readable scopes gets nothing", () => {
    process.env[MCP_TOKENS_EXTRA_ENV] = map({
      [sha("r")]: { actor: "relay", scopes: ["read"] },
      [sha("x")]: { actor: "empty", scopes: ["bogus"] },
    });
    expect(who("r")).toEqual({ actor: "relay", scopes: ["read"] });
    expect(who("x")).toEqual({ actor: "empty", scopes: [] });
  });

  it("COLLISION: the PRIMARY entry wins whole. The extra map can never widen or rename an existing token", () => {
    process.env.SCRIBE_MCP_TOKENS = map({ [sha("same")]: { actor: "watcher", scopes: ["read"] } });
    process.env[MCP_TOKENS_EXTRA_ENV] = map({ [sha("same")]: { actor: "attacker-renamed", scopes: ["read", "invoke", "write"] } });
    expect(who("same")).toEqual({ actor: "watcher", scopes: ["read"] });
  });

  it("a primary entry that EXISTS but cannot be read still reserves its hash: the extra map cannot take it over (Refuter #519 note 1)", () => {
    process.env.SCRIBE_MCP_TOKENS = JSON.stringify({ [sha("held")]: { scopes: ["read"] } });        // no actor: unreadable, grants nothing
    process.env[MCP_TOKENS_EXTRA_ENV] = map({ [sha("held")]: { actor: "someone", scopes: ["read", "invoke", "write"] } });
    // refused either way: with nothing readable left the door is "not configured" (503), otherwise 401. What matters is that it is NOT let in.
    expect("fail" in who("held"), "not let in").toBe(true);
    // an UPPERCASE copy of the same hash is the same key
    process.env[MCP_TOKENS_EXTRA_ENV] = map({ [sha("held").toUpperCase()]: { actor: "someone", scopes: ["write"] } });
    expect("fail" in who("held"), "not let in (uppercase copy)").toBe(true);
  });

  it("an extra entry may NOT reuse the single-token actor or an actor the primary names: audit rows stay attributable (Refuter #519 note 2)", () => {
    process.env.SCRIBE_MCP_TOKENS = map({ [sha("old")]: { actor: "watcher", scopes: ["read"] } });
    process.env[MCP_TOKENS_EXTRA_ENV] = map({
      [sha("a")]: { actor: "operator-v1", scopes: ["read"] },
      [sha("b")]: { actor: "watcher", scopes: ["read"] },
      [sha("c")]: { actor: "room-alert-relay", scopes: ["read"] },
    });
    expect(who("a")).toEqual({ fail: 401 });
    expect(who("b")).toEqual({ fail: 401 });
    expect(who("c")).toEqual({ actor: "room-alert-relay", scopes: ["read"] });
    expect(who("old")).toEqual({ actor: "watcher", scopes: ["read"] });
  });

  it("two extra entries may share a NEW actor (a token rotation), and a clean merge logs nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[MCP_TOKENS_EXTRA_ENV] = map({
      [sha("r1")]: { actor: "room-alert-relay", scopes: ["read"] },
      [sha("r2")]: { actor: "room-alert-relay", scopes: ["read"] },
    });
    expect(who("r1")).toEqual({ actor: "room-alert-relay", scopes: ["read"] });
    expect(who("r2")).toEqual({ actor: "room-alert-relay", scopes: ["read"] });
    expect(warn, "nothing skipped, so nothing logged (also pins the > 0 guards)").not.toHaveBeenCalled();
  });

  it("the single-token fallback still works beside it", () => {
    process.env.SCRIBE_MCP_TOKEN = "legacy";
    process.env[MCP_TOKENS_EXTRA_ENV] = map({ [sha("relay")]: { actor: "relay", scopes: ["read"] } });
    expect(who("legacy")).toEqual({ actor: "operator-v1", scopes: ["invoke", "read", "write"] });
    expect(who("relay")).toEqual({ actor: "relay", scopes: ["read"] });
  });
});

describe("a bad extra value can never break the door", () => {
  it("unreadable JSON and non-hex keys are ignored; the warning names the variable and carries no token or hash", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SCRIBE_MCP_TOKENS = map({ [sha("old")]: { actor: "watcher", scopes: ["read"] } });
    process.env[MCP_TOKENS_EXTRA_ENV] = "{not json, secret-looking-text";
    expect(who("old")).toEqual({ actor: "watcher", scopes: ["read"] });
    expect(warn.mock.calls.some((c) => String(c[0]).includes(MCP_TOKENS_EXTRA_ENV))).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-looking-text");
    process.env[MCP_TOKENS_EXTRA_ENV] = JSON.stringify({ "plain-token": { actor: "a", scopes: ["read"] } });
    expect(parseTokenMap(process.env[MCP_TOKENS_EXTRA_ENV], MCP_TOKENS_EXTRA_ENV)).toEqual({});
    expect(who("old")).toEqual({ actor: "watcher", scopes: ["read"] });
  });

  it("a shadowed entry is logged as a COUNT only, never a hash", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = sha("same");
    const merged = mergeTokenMaps(
      { [h]: { actor: "a", scopes: new Set(["read"]) } },
      { [h]: { actor: "b", scopes: new Set(["write"]) }, [sha("new")]: { actor: "c", scopes: new Set(["read"]) } },
    );
    expect(Object.keys(merged)).toHaveLength(2);
    expect(merged[h]!.actor).toBe("a");
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/^\[mcp-auth\] 1 entry in SCRIBE_MCP_TOKENS_EXTRA shadowed/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(h);
  });

  it("holds no usable credential: the env value is a hash map, so a leaked copy grants nothing", () => {
    process.env[MCP_TOKENS_EXTRA_ENV] = map({ [sha("relay")]: { actor: "relay", scopes: ["read"] } });
    expect(who(process.env[MCP_TOKENS_EXTRA_ENV])).toEqual({ fail: 401 });
    expect(who(sha("relay")), "presenting the HASH is not the token").toEqual({ fail: 401 });
  });
});
