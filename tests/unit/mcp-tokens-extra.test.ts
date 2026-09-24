/**
 * SCRIBE_MCP_TOKENS_EXTRA — the ADDITIVE token map (Fable rulings 137 and 154; herdr-kit #207 option C). SCRIBE_MCP_TOKENS is a write-only Secret that cannot be read
 * back, so a new token (the room-alert relay's read-only one, the night feeder's) cannot be added to it without destroying every existing entry. The extra map takes the
 * same hash-keyed JSON and sits BEHIND the primary: it can add a token, never change one. Ruling 154: every actor it adds is prefixed `extra:`, and if the primary is not
 * FULLY readable the whole extra map is ignored (fail closed). Every door goes through checkMcpBearer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { checkMcpBearer, mergeTokenMaps, parseTokenMap, primaryFullyParsed, MCP_TOKENS_EXTRA_ENV, EXTRA_ACTOR_PREFIX } from "@/lib/mcp/auth";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const req = (token?: string) => new Request("https://x/api/mcp", { headers: token ? { authorization: `Bearer ${token}` } : {} });
const map = (o: Record<string, { actor: string; scopes: string[] }>) => JSON.stringify(o);
const who = (t?: string) => {
  const r = checkMcpBearer(req(t));
  return r.ok ? { actor: r.principal.token_id, scopes: [...r.principal.scopes].sort() } : { fail: r.failure.status };
};
const refused = (t: string) => "fail" in who(t);

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

  it("adds a token BESIDE the primary: both resolve; the added one's actor carries the extra: prefix, the primary's is untouched", () => {
    process.env.SCRIBE_MCP_TOKENS = map({ [sha("old")]: { actor: "watcher", scopes: ["read", "invoke"] } });
    process.env[MCP_TOKENS_EXTRA_ENV] = map({ [sha("relay")]: { actor: "room-alert-relay", scopes: ["read"] } });
    expect(who("old")).toEqual({ actor: "watcher", scopes: ["invoke", "read"] });
    expect(who("relay")).toEqual({ actor: `${EXTRA_ACTOR_PREFIX}room-alert-relay`, scopes: ["read"] });
    expect(who("stranger")).toEqual({ fail: 401 });
  });

  it("works ALONE: with only the extra map configured the door is configured, not a 503", () => {
    process.env[MCP_TOKENS_EXTRA_ENV] = map({ [sha("relay")]: { actor: "room-alert-relay", scopes: ["read"] } });
    expect(who("relay")).toEqual({ actor: "extra:room-alert-relay", scopes: ["read"] });
    expect(who("stranger")).toEqual({ fail: 401 });
    expect(who()).toEqual({ fail: 401 });
  });

  it("a read-only extra entry gets ONLY read; an entry with no readable scopes gets nothing", () => {
    process.env[MCP_TOKENS_EXTRA_ENV] = map({
      [sha("r")]: { actor: "relay", scopes: ["read"] },
      [sha("x")]: { actor: "empty", scopes: ["bogus"] },
    });
    expect(who("r")).toEqual({ actor: "extra:relay", scopes: ["read"] });
    expect(who("x")).toEqual({ actor: "extra:empty", scopes: [] });
  });

  it("COLLISION: the PRIMARY entry wins whole. The extra map can never widen or rename an existing token", () => {
    process.env.SCRIBE_MCP_TOKENS = map({ [sha("same")]: { actor: "watcher", scopes: ["read"] } });
    process.env[MCP_TOKENS_EXTRA_ENV] = map({ [sha("same")]: { actor: "attacker-renamed", scopes: ["read", "invoke", "write"] } });
    expect(who("same")).toEqual({ actor: "watcher", scopes: ["read"] });
    process.env[MCP_TOKENS_EXTRA_ENV] = map({ [sha("same").toUpperCase()]: { actor: "attacker-renamed", scopes: ["write"] } });
    expect(who("same"), "an UPPERCASE copy of the hash is the same key").toEqual({ actor: "watcher", scopes: ["read"] });
  });

  it("the single-token fallback still works beside it", () => {
    process.env.SCRIBE_MCP_TOKEN = "legacy";
    process.env[MCP_TOKENS_EXTRA_ENV] = map({ [sha("relay")]: { actor: "relay", scopes: ["read"] } });
    expect(who("legacy")).toEqual({ actor: "operator-v1", scopes: ["invoke", "read", "write"] });
    expect(who("relay")).toEqual({ actor: "extra:relay", scopes: ["read"] });
  });

  it("two extra entries may share a NEW actor (a token rotation), and a clean merge logs nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[MCP_TOKENS_EXTRA_ENV] = map({
      [sha("r1")]: { actor: "room-alert-relay", scopes: ["read"] },
      [sha("r2")]: { actor: "room-alert-relay", scopes: ["read"] },
    });
    expect(who("r1")).toEqual({ actor: "extra:room-alert-relay", scopes: ["read"] });
    expect(who("r2")).toEqual({ actor: "extra:room-alert-relay", scopes: ["read"] });
    expect(warn, "nothing skipped, so nothing logged").not.toHaveBeenCalled();
  });
});

describe("ruling 154 — FAIL CLOSED: a primary that is not fully readable rejects ALL extras", () => {
  const extraOk = () => { process.env[MCP_TOKENS_EXTRA_ENV] = map({ [sha("relay")]: { actor: "relay", scopes: ["read"] } }); };

  it("an entry with no actor, scopes that are not a list, a non-object entry, or a key that is not a hash: every extra is ignored", () => {
    const readable = { [sha("old")]: { actor: "watcher", scopes: ["read"] } };
    const bads: Array<[string, Record<string, unknown>]> = [
      ["no actor", { [sha("held")]: { scopes: ["read"] } }],
      ["scopes as a string", { [sha("held")]: { actor: "x", scopes: "read" } }],
      ["a null entry", { [sha("held")]: null }],
      ["an array entry", { [sha("held")]: [] }],
      ["a key that is not a hash", { "plain-token": { actor: "x", scopes: ["read"] } }],
    ];
    for (const [label, bad] of bads) {
      process.env.SCRIBE_MCP_TOKENS = JSON.stringify({ ...readable, ...bad });
      extraOk();
      expect(who("old"), `${label}: the readable primary entry still works`).toEqual({ actor: "watcher", scopes: ["read"] });
      expect(refused("relay"), `${label}: but the extra token is NOT let in`).toBe(true);
    }
  });

  it("primary JSON that does not parse, or is not an object: the extra map is ignored and the single token still works", () => {
    process.env.SCRIBE_MCP_TOKEN = "legacy";
    extraOk();
    for (const raw of ["{not json", "[]", "\"str\"", "12", "true"]) {
      process.env.SCRIBE_MCP_TOKENS = raw;
      expect(who("legacy"), raw).toEqual({ actor: "operator-v1", scopes: ["invoke", "read", "write"] });
      expect(refused("relay"), raw).toBe(true);
    }
  });

  it("with the primary fully readable the extra map works; an absent or blank primary is not 'unreadable'", () => {
    extraOk();
    for (const raw of [undefined, "", "  ", "{}", map({ [sha("old")]: { actor: "w", scopes: ["read"] } })]) {
      if (raw === undefined) delete process.env.SCRIBE_MCP_TOKENS; else process.env.SCRIBE_MCP_TOKENS = raw;
      expect(who("relay"), String(raw)).toEqual({ actor: "extra:relay", scopes: ["read"] });
    }
  });

  it("the ignore is logged ONCE per request as a COUNT with no hash, no token and no actor name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SCRIBE_MCP_TOKENS = JSON.stringify({ [sha("held")]: { scopes: ["read"] } });
    process.env[MCP_TOKENS_EXTRA_ENV] = map({ [sha("relay")]: { actor: "secret-actor-name", scopes: ["read"] } });
    who("relay");
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => /not fully readable; ignoring all 1 entry .*fail closed/.test(l))).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-actor-name");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sha("relay"));
  });

  it("primaryFullyParsed, directly", () => {
    expect(primaryFullyParsed(undefined)).toBe(true);
    expect(primaryFullyParsed("{}")).toBe(true);
    expect(primaryFullyParsed(map({ [sha("a")]: { actor: "a", scopes: [] } }))).toBe(true);
    expect(primaryFullyParsed("{oops")).toBe(false);
    expect(primaryFullyParsed(JSON.stringify({ [sha("a")]: { actor: "  ", scopes: [] } }))).toBe(false);
  });
});

describe("ruling 154 — the extra: prefix makes an additive principal distinguishable in the audit log", () => {
  it("an extra actor that ALREADY looks like an existing principal cannot be made to equal one: mcp: prefix, 64-char cut, operator-v1 (eta-refuter #528)", async () => {
    const { mcpActorId } = await import("@/lib/mcp/audit");
    const long = "x".repeat(70);
    process.env.SCRIBE_MCP_TOKENS = map({ [sha("old")]: { actor: "watcher", scopes: ["read"] }, [sha("pre")]: { actor: "extra:watcher", scopes: ["read"] } });
    process.env[MCP_TOKENS_EXTRA_ENV] = map({
      [sha("p1")]: { actor: "mcp:operator-v1", scopes: ["read"] },
      [sha("p2")]: { actor: "mcp:watcher", scopes: ["read"] },
      [sha("p3")]: { actor: "watcher", scopes: ["read"] },     // becomes "extra:watcher": equals the primary's OWN actor "extra:watcher"
      [sha("ok")]: { actor: "room-alert-relay", scopes: ["read"] },
    });
    // p1/p2 are prefixed, so they are NOT look-alikes of operator-v1 / watcher any more, and p3 IS a look-alike and is refused
    expect(who("p1")).toEqual({ actor: "extra:mcp:operator-v1", scopes: ["read"] });
    expect(who("p2")).toEqual({ actor: "extra:mcp:watcher", scopes: ["read"] });
    expect(refused("p3"), "an extra actor that lands on a primary actor's audit id is skipped").toBe(true);
    expect(who("ok")).toEqual({ actor: "extra:room-alert-relay", scopes: ["read"] });
    expect(mcpActorId(who("p1").actor!)).not.toBe(mcpActorId("operator-v1"));
    expect(mcpActorId(who("p2").actor!)).not.toBe(mcpActorId("watcher"));
    expect(mcpActorId(`extra:${long}`).length, "and the audit id is cut at 64 like every other").toBe(64);
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
    expect(merged[sha("new")]!.actor).toBe("extra:c");
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/^\[mcp-auth\] 1 entry in SCRIBE_MCP_TOKENS_EXTRA shadowed/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(h);
  });

  it("holds no usable credential: the env value is a hash map, so a leaked copy grants nothing", () => {
    process.env[MCP_TOKENS_EXTRA_ENV] = map({ [sha("relay")]: { actor: "relay", scopes: ["read"] } });
    expect(who(process.env[MCP_TOKENS_EXTRA_ENV])).toEqual({ fail: 401 });
    expect(who(sha("relay")), "presenting the HASH is not the token").toEqual({ fail: 401 });
  });
});
