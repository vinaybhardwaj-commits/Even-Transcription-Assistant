/** Pure pieces of the 18 Oct 2026 own-login / per-user-audit spec: no database, no network. */
import { describe, expect, it, afterEach } from "vitest";
import { readFileSync } from "node:fs";


import { subjectIds } from "@/lib/mcp/audit";
import { keyRefusal, normaliseEmail, refusalForStatus, sha256Hex, newKeyValue } from "@/lib/mcp/identity";
import { digestText } from "@/lib/mcp/audit-views";
import { approverEmail, identityEnforced, ownerActors } from "@/lib/mcp/oauth/config";

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

describe("subjectIds: ids and dates only", () => {
  it("keeps the fixed key list with id-shaped values and numbers; drops free text, names, nested values and every other key", () => {
    expect(subjectIds({ consult_uid: "C-123_x", room_slug: "opd-1-xqj7", ist_date: "2026-10-17", start: 5, q: "free text", note_text: "X" })).toEqual({ consult_uid: "C-123_x", room_slug: "opd-1-xqj7", ist_date: "2026-10-17", start: 5 });
    expect(subjectIds({ consult_uid: "Mrs Sharma", encounter_id: { a: 1 }, visit_id: "a".repeat(129), since: NaN })).toEqual({});
    expect(subjectIds(null)).toEqual({});
  });

  it("A6: a real window id, built as lib/bench-window.ts builds it, passes; so do bench sessions and encounter ids; a name-shaped window id does not", () => {
    const session = "bs_k3j9x2m4q8";
    const win = `bw_${session.replace(/^bs_/, "")}_${1760700000000}_room`.slice(0, 128);
    expect(subjectIds({ window_id: win, session_id: session, encounter_id: "enc_k3j9x2m4q8" })).toEqual({ window_id: win, session_id: session, encounter_id: "enc_k3j9x2m4q8" });
    expect(subjectIds({ window_id: "bw_ShanthiRamesh" })).toEqual({});
    expect(subjectIds({ window_id: "bw_ramesh_kumar" })).toEqual({});
  });

  it("A6: a name-shaped single token does not pass; each key needs its own id shape", () => {
    expect(subjectIds({ consult_uid: "ShanthiRamesh", room_slug: "Ramesh", room: "kumar", room_id: "Sharma", encounter_id: "Ramesh", visit_id: "vis_x", session_id: "Priya", window_id: "bw_short", ist_date: "Tuesday", since: "yesterday", start: "ramesh" })).toEqual({});
    expect(subjectIds({ consult_uid: "C4721ABC", room_id: "room_abc", room_slug: "cardiology-opd-gh4a", encounter_id: "enc_a1b2c3d4", visit_id: "vis_a1b2c3d4", session_id: "bs_a1b2c3d4", window_id: "bw_a1b2c3d4_1760700000000_room", since: "2026-10-17T10:00:00Z" }))
      .toEqual({ consult_uid: "C4721ABC", room_id: "room_abc", room_slug: "cardiology-opd-gh4a", encounter_id: "enc_a1b2c3d4", visit_id: "vis_a1b2c3d4", session_id: "bs_a1b2c3d4", window_id: "bw_a1b2c3d4_1760700000000_room", since: "2026-10-17T10:00:00Z" });
    expect(subjectIds([1])).toEqual({});
  });
});

describe("identity decisions", () => {
  it("keyRefusal: no row is unknown, a stamped revoke is revoked_key, an inactive identity is named; an active key passes", () => {
    const row = { key_id: "k_1", email: "a@example.test", scope: "read" as const, revoked_at: null, identity_status: "active" as const };
    expect(keyRefusal(null)).toBe("unknown_key");
    expect(keyRefusal({ ...row, revoked_at: "2026-10-18" })).toBe("revoked_key");
    expect(keyRefusal({ ...row, identity_status: "revoked" })).toBe("identity_revoked");
    expect(keyRefusal({ ...row, identity_status: "blacklisted" })).toBe("identity_blacklisted");
    expect(keyRefusal(row)).toBeNull();
    expect(refusalForStatus(null)).toBe("no_identity");
  });

  it("emails are trimmed and lowercased; junk is refused; a new key has the esk_ prefix, 43+ chars of entropy and a 64-hex hash", () => {
    expect(normaliseEmail("  ALICE@example.test ")).toBe("alice@example.test");
    for (const bad of ["", "no-at", "a@b@c", "a b@c.d", "x".repeat(260) + "@e.t"]) expect(normaliseEmail(bad)).toBeNull();
    const k = newKeyValue();
    expect(k).toMatch(/^esk_[A-Za-z0-9_-]{43}$/);
    expect(sha256Hex(k)).toMatch(/^[0-9a-f]{64}$/);
    expect(newKeyValue()).not.toBe(k);
  });
});

describe("config", () => {
  it("approver, owner actors and the identity flag", () => {
    delete process.env.SCRIBE_MCP_OAUTH_APPROVER; delete process.env.SCRIBE_MCP_OWNER_ACTORS; delete process.env.SCRIBE_MCP_IDENTITY;
    expect(approverEmail()).toBeNull();
    expect(identityEnforced()).toBe(false);
    expect([...ownerActors()]).toEqual([]);
    process.env.SCRIBE_MCP_OAUTH_APPROVER = " V@example.test "; process.env.SCRIBE_MCP_OWNER_ACTORS = "operator-v1, v-admin ,"; process.env.SCRIBE_MCP_IDENTITY = "ON";
    expect(approverEmail()).toBe("v@example.test");
    expect(identityEnforced()).toBe(true);
    expect([...ownerActors()]).toEqual(["operator-v1", "v-admin"]);
    process.env.SCRIBE_MCP_OAUTH_APPROVER = "a@b.c, d@e.f"; // two addresses are not one approver
    expect(approverEmail()).toBeNull();
    process.env.SCRIBE_MCP_IDENTITY = "yes";
    expect(identityEnforced()).toBe(false);
  });
});

describe("digest and schedule", () => {
  it("the digest text holds counts, tools and times, no subject ids; an empty day says so", () => {
    const t = digestText([{ email: "a@example.test", calls: 3, refused: 1, errors: 1, tools: { scribe_catalog: 2, scribe_now: 1 }, first: "t1", last: "t2" }], "S");
    expect(t).toContain("a@example.test: 3 calls (1 errors), 1 refused. scribe_catalog x2, scribe_now x1.");
    expect(digestText([], "S")).toContain("no activity");
  });

  it("vercel.json schedules the digest at 14:30 UTC = 20:00 IST", () => {
    const cron = (JSON.parse(readFileSync("vercel.json", "utf8")).crons as Array<{ path: string; schedule: string }>).find((c) => c.path === "/api/admin/mcp-digest");
    expect(cron?.schedule).toBe("30 14 * * *");
  });
});
