/**
 * Renaming a room — the fourth action on PATCH /api/bench/rooms.
 *
 * The point of these tests is what a rename must NOT do. `room.name` is a display label; the login
 * URL is built from `slug` (/room/opd-7-y74w), the scratch graph derives from `room.id`, and every
 * historical session references `room_id`. So a rename must leave slug, pin_hash, disabled_at,
 * failed_attempts and locked_until byte-identical — otherwise a clinic that renamed a room on
 * Monday morning would find nobody could sign in to it.
 *
 * The real route handler runs against a fake Postgres that models one thing the schema does not:
 * room.name has NO unique constraint, so the duplicate check has to be in the statement.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

const calls: Array<{ text: string; values: unknown[] }> = [];
let responder: (text: string, values: unknown[]) => Row[] = () => [];
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    return Promise.resolve(responder(text, values));
  },
}));
vi.mock("@/lib/bench", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, benchAdminGuard: async () => ({ ok: true, claims: { email: "v@even.in" } }) };
});

import { PATCH } from "@/app/api/bench/rooms/route";
import { NextRequest } from "next/server";

/** The world: two live rooms and one disabled one that still holds an old name. */
type RoomRec = { id: string; slug: string; name: string; pin_hash: string; disabled_at: string | null; failed_attempts: number; locked_until: string | null };
let rooms: RoomRec[];

const patch = async (body: Row) =>
  PATCH(new NextRequest("https://x/api/bench/rooms", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(() => {
  calls.length = 0;
  rooms = [
    { id: "room_a", slug: "opd-7-y74w", name: "OPD 7", pin_hash: "$2a$12$aaa", disabled_at: null, failed_attempts: 3, locked_until: "2026-08-24T00:00:00Z" },
    { id: "room_b", slug: "cardiology-opd-gh4a", name: "Cardiology OPD", pin_hash: "$2a$12$bbb", disabled_at: null, failed_attempts: 0, locked_until: null },
    { id: "room_old", slug: "old-room-zzzz", name: "Retired Room", pin_hash: "$2a$12$ccc", disabled_at: "2026-08-01T00:00:00Z", failed_attempts: 0, locked_until: null },
  ];
  responder = (text, values) => {
    if (/^SELECT id FROM room WHERE lower\(name\)/.test(text)) {
      const [name, selfId] = values as [string, string];
      return rooms.filter((r) => r.name.toLowerCase() === name.toLowerCase() && r.id !== selfId && r.disabled_at === null).map((r) => ({ id: r.id }));
    }
    if (/^UPDATE room SET name =/.test(text)) {
      const [name, id] = values as [string, string];
      const r = rooms.find((x) => x.id === id);
      if (!r) return [];
      r.name = name;
      return [{ id: r.id, slug: r.slug, name: r.name }];
    }
    return [];
  };
});

const snapshot = () => JSON.stringify(rooms.map(({ id, slug, pin_hash, disabled_at, failed_attempts, locked_until }) => ({ id, slug, pin_hash, disabled_at, failed_attempts, locked_until })));

describe("rename — the happy path, and what it leaves alone", () => {
  it("renames, and returns the room with its slug unchanged", async () => {
    const before = snapshot();
    const res = await patch({ room_id: "room_a", action: "rename", name: "OPD 7 · Ortho" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as Row;
    expect((j.room as Row).name).toBe("OPD 7 · Ortho");
    expect((j.room as Row).slug).toBe("opd-7-y74w");
    expect(rooms.find((r) => r.id === "room_a")!.name).toBe("OPD 7 · Ortho");
    // EVERYTHING ELSE IS BYTE-IDENTICAL — slug, pin_hash, disabled_at, failed_attempts, locked_until
    expect(snapshot()).toBe(before);
  });

  it("the UPDATE sets name and NOTHING else", async () => {
    await patch({ room_id: "room_a", action: "rename", name: "New Name" });
    const upd = calls.find((c) => /^UPDATE room/.test(c.text))!;
    expect(upd.text).toMatch(/^UPDATE room SET name = \?/);
    // Only the SET clause is a write. `RETURNING id, slug, name` reads the slug back so the
    // caller can show the unchanged login URL, which is the opposite of touching it.
    const setClause = upd.text.slice(0, upd.text.search(/\bWHERE\b/));
    for (const forbidden of ["pin_hash", "slug", "disabled_at", "failed_attempts", "locked_until"]) {
      expect(setClause, `SET clause must not touch ${forbidden}`).not.toContain(forbidden);
    }
    expect(upd.text).toContain("RETURNING id, slug, name");
  });

  it("trims before it stores", async () => {
    await patch({ room_id: "room_a", action: "rename", name: "   OPD 9   " });
    expect(rooms.find((r) => r.id === "room_a")!.name).toBe("OPD 9");
  });
});

describe("rename — what it refuses", () => {
  it("refuses empty and whitespace-only", async () => {
    for (const name of ["", "   ", "a"]) {
      const res = await patch({ room_id: "room_a", action: "rename", name });
      expect(res.status).not.toBe(200);
      expect(JSON.stringify(await res.json())).toContain("room_name_required");
    }
  });

  it("refuses over 64 characters", async () => {
    const res = await patch({ room_id: "room_a", action: "rename", name: "x".repeat(65) });
    expect(JSON.stringify(await res.json())).toContain("room_name_too_long");
    expect(calls.some((c) => /^UPDATE room/.test(c.text))).toBe(false);
    // and 64 exactly is fine — the cap is inclusive
    expect((await (await patch({ room_id: "room_a", action: "rename", name: "y".repeat(64) })).json()).ok).toBe(true);
  });

  it("REFUSES A DUPLICATE of another live room, case-insensitively", async () => {
    for (const name of ["Cardiology OPD", "cardiology opd", "CARDIOLOGY OPD"]) {
      const res = await patch({ room_id: "room_a", action: "rename", name });
      expect(JSON.stringify(await res.json())).toContain("room_name_already_exists");
    }
    // nothing was written
    expect(rooms.find((r) => r.id === "room_a")!.name).toBe("OPD 7");
    expect(calls.some((c) => /^UPDATE room/.test(c.text))).toBe(false);
  });

  it("renaming a room to its OWN name is not a duplicate", async () => {
    const res = await patch({ room_id: "room_a", action: "rename", name: "OPD 7" });
    expect((await res.json()).ok).toBe(true);
  });

  it("a DISABLED room's name is free to reuse — it is out of play", async () => {
    const res = await patch({ room_id: "room_a", action: "rename", name: "Retired Room" });
    expect((await res.json()).ok).toBe(true);
  });

  it("an unknown room is named, not silently a no-op", async () => {
    const res = await patch({ room_id: "room_nope", action: "rename", name: "Anything" });
    expect(JSON.stringify(await res.json())).toContain("unknown_room");
  });

  it("a bad room_id is refused before any query", async () => {
    const res = await patch({ room_id: "nope", action: "rename", name: "Anything" });
    expect(JSON.stringify(await res.json())).toContain("bad_room_id");
    expect(calls).toHaveLength(0);
  });
});

describe("the other three actions are untouched", () => {
  it("an unknown action is still refused by name", async () => {
    const res = await patch({ room_id: "room_a", action: "nonsense" });
    expect(JSON.stringify(await res.json())).toContain("unknown_action");
  });

  it("disable still writes disabled_at and never name", async () => {
    await patch({ room_id: "room_a", action: "disable" });
    const upd = calls.find((c) => /^UPDATE room/.test(c.text))!;
    expect(upd.text).toContain("disabled_at = NOW()");
    expect(upd.text).not.toContain("SET name");
  });

  it("no rename path ever issues a bcrypt hash or touches a PIN", async () => {
    await patch({ room_id: "room_a", action: "rename", name: "Fresh Name" });
    for (const c of calls) expect(c.text).not.toMatch(/pin_hash/);
  });
});
