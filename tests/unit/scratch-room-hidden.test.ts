/**
 * Fix 2 — the scratch room is hidden from the three listings, and from nowhere else.
 *
 * Slice 2 creates its scratch rooms ENABLED on purpose: POST /api/brain/cues checks
 * roomExists(room_id), and that check requires disabled_at IS NULL. So they cannot be hidden
 * by disabling them — they have to be filtered out of the places a human reads, and left
 * alone everywhere the machinery reads.
 *
 * Filtered (this file proves each one):
 *   scribe_list_rooms          — unless include_scratch:true
 *   GET /api/bench/rooms       — always
 *   scribe_diff_room           — the all-rooms sweep, always
 *
 * NOT filtered (this file proves each one too, because getting this wrong is how slice 2
 * breaks — silently, and only in production):
 *   SQL_ROOM_EXISTS  — the cue route's room check. Filter it and every scratch write 404s.
 *   resolveRoom      — the id/slug/name lookup every room-addressed tool uses. Filter it and
 *                      scribe_list_cues can no longer read the scratch day back.
 *
 * The fake `sql` does not just record statements: it INTERPRETS the prefix predicate against
 * a real room table, using the parameter the query actually bound. A predicate that is dropped,
 * or one whose parameter never arrives, changes the rows this fake returns.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
type Call = { text: string; values: unknown[] };

const appCalls: Call[] = [];

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    appCalls.push({ text, values });
    return Promise.resolve(appSql(text, values));
  },
}));

const brainCalls: Call[] = [];
vi.mock("@/lib/brain/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    brainLog: () => {},
    getPool: () => ({ connect: async () => ({ query: async (t: string, v?: unknown[]) => brainSql(t, v ?? []), release: () => {} }) }),
    query: async (t: string, v?: unknown[]) => brainSql(t, v ?? []),
  };
});

// The admin cookie/JWT is not what is under test; everything else in lib/bench stays real.
vi.mock("@/lib/bench", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, benchAdminGuard: async () => ({ ok: true, claims: { sub: "admin" } }) };
});

vi.mock("@/lib/bench-bus", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getListener: async () => null };
});

import { BRAIN_TOOLS } from "@/lib/mcp/tools/brain";
import { resolveRoom } from "@/lib/mcp/tools/brain";
import { BENCH_TOOLS } from "@/lib/mcp/tools/bench";
import { GET as getBenchRooms } from "@/app/api/bench/rooms/route";
import { SQL_ROOM_EXISTS, roomExists } from "@/lib/brain/state";
import { SCRATCH_ROOM_PREFIX, scratchRoomIdFor, scratchSlugFor, scratchNameFor } from "@/lib/brain/scratch";

const tool = (name: string) => {
  const t = [...BRAIN_TOOLS, ...BENCH_TOOLS].find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};
const ctx = { origin: "https://preview.example" };

// ---------------------------------------------------------------------------
// The room table: two real rooms and the scratch room derived from the first.
// ---------------------------------------------------------------------------

const ROOM_A = { id: "room_a7q91234", slug: "opd-7-a7q9", name: "OPD 7" };
const ROOM_B = { id: "room_b3k48810", slug: "opd-3-b3k4", name: "OPD 3" };
const SCRATCH = { id: scratchRoomIdFor(ROOM_A.id), slug: scratchSlugFor(ROOM_A.slug), name: scratchNameFor(ROOM_A.name) };

const ROOMS: Row[] = [ROOM_A, ROOM_B, SCRATCH].map((r, i) => ({
  ...r,
  created_at: new Date(Date.UTC(2026, 7, 1 + i)),
  disabled_at: null,
}));

/** The scratch id must actually carry the prefix, or every assertion below is vacuous. */
it("the fixture is real: the scratch room id carries the prefix, the live ones do not", () => {
  expect(SCRATCH.id.startsWith(SCRATCH_ROOM_PREFIX)).toBe(true);
  expect(ROOM_A.id.startsWith(SCRATCH_ROOM_PREFIX)).toBe(false);
  expect(ROOM_B.id.startsWith(SCRATCH_ROOM_PREFIX)).toBe(false);
  // and the underscore that makes a bare LIKE wrong is really in there
  expect(SCRATCH_ROOM_PREFIX).toContain("_");
});

// ---------------------------------------------------------------------------
// The fakes — the prefix predicate is INTERPRETED, not just recorded.
// ---------------------------------------------------------------------------

/** `left(x, length(?)) <> ?` (either aliased or bare), as the mock renders it. */
const PREFIX_PREDICATE = /left\((?:r\.)?id, length\(\?::text\)\) <> \?::text/;
/** The include_scratch escape hatch, as the mock renders it. */
const INCLUDE_SCRATCH = /WHERE \?::boolean OR /;

function filterRooms(text: string, values: unknown[]): Row[] {
  let rows = ROOMS;
  if (/disabled_at IS NULL/.test(text)) rows = rows.filter((r) => r.disabled_at === null);
  if (PREFIX_PREDICATE.test(text)) {
    // The prefix the statement actually bound — not the constant this test imports.
    const bound = values.filter((v) => v === SCRATCH_ROOM_PREFIX);
    expect(bound.length, `the prefix predicate in ${text} bound no prefix parameter`).toBeGreaterThan(0);
    const prefix = String(bound[0]);
    const includeScratch = INCLUDE_SCRATCH.test(text) && values[0] === true;
    if (!includeScratch) rows = rows.filter((r) => !String(r.id).startsWith(prefix));
  }
  return rows;
}

function appSql(text: string, values: unknown[]): Row[] {
  // The two listings (scribe_list_rooms, GET /api/bench/rooms) and the diff sweep
  if (/FROM room r LEFT JOIN LATERAL/.test(text) || /^SELECT id, slug, name FROM room WHERE/.test(text)) {
    return filterRooms(text, values).map((r) => ({ ...r, last_session_at: null, last_session_status: null }));
  }
  // resolveRoom — id / slug / name, UNFILTERED by design
  if (/FROM room WHERE \(\?::text IS NOT NULL AND id = \?::text\)/.test(text)) {
    const [id, , slug, , free] = values as Array<string | null>;
    return ROOMS.filter(
      (r) =>
        (id != null && r.id === id) ||
        (slug != null && r.slug === slug) ||
        (free != null && (r.id === free || r.slug === free || String(r.name).toLowerCase() === free.toLowerCase())),
    ).slice(0, 10);
  }
  if (/FROM bench_session/.test(text)) return [];
  return [];
}

function brainSql(text: string, values: unknown[]): { rows: Row[]; rowCount: number } {
  brainCalls.push({ text, values });
  let rows: Row[] = [];
  if (text === SQL_ROOM_EXISTS) {
    rows = ROOMS.filter((r) => r.id === values[0] && r.disabled_at === null).map(() => ({ "?column?": 1 }));
  }
  return { rows, rowCount: rows.length };
}

beforeEach(() => {
  appCalls.length = 0;
  brainCalls.length = 0;
});

const call = (name: string, args: Row) => tool(name).handler(args, ctx) as Promise<Row>;
const ids = (rows: unknown) => (rows as Array<Row>).map((r) => String(r.id)).sort();

// ===========================================================================

describe("scribe_list_rooms — scratch is hidden by default, listed on request", () => {
  it("no argument: the two live rooms, and not the scratch one", async () => {
    const out = await call("scribe_list_rooms", {});
    expect(ids(out.rooms)).toEqual([ROOM_A.id, ROOM_B.id].sort());
    expect(ids(out.rooms)).not.toContain(SCRATCH.id);
    expect(out.include_scratch).toBe(false);
  });

  it("include_scratch:false is the same as omitting it", async () => {
    const out = await call("scribe_list_rooms", { include_scratch: false });
    expect(ids(out.rooms)).toEqual([ROOM_A.id, ROOM_B.id].sort());
  });

  it("include_scratch:true lists them as before", async () => {
    const out = await call("scribe_list_rooms", { include_scratch: true });
    expect(ids(out.rooms)).toEqual([ROOM_A.id, ROOM_B.id, SCRATCH.id].sort());
    expect(out.include_scratch).toBe(true);
    // the shape of a listed room is unchanged
    expect((out.rooms as Row[]).find((r) => r.id === SCRATCH.id)).toMatchObject({ slug: SCRATCH.slug, name: SCRATCH.name, enabled: true });
  });

  it("the flag is on the schema, boolean, defaulting to false", () => {
    const props = tool("scribe_list_rooms").inputSchema.properties as Record<string, Row>;
    expect(props.include_scratch).toMatchObject({ type: "boolean", default: false });
  });

  it("the predicate is a prefix match, not a LIKE — the wildcard `_` never reaches the database", async () => {
    await call("scribe_list_rooms", {});
    const q = appCalls.find((c) => /FROM room r LEFT JOIN LATERAL/.test(c.text))!;
    expect(q.text).toMatch(PREFIX_PREDICATE);
    expect(q.text).not.toMatch(/LIKE/i);
    expect(q.values).toContain(SCRATCH_ROOM_PREFIX);
  });
});

describe("GET /api/bench/rooms — the admin list always excludes scratch, with no opt-out", () => {
  it("the two live rooms only", async () => {
    const res = await getBenchRooms();
    const body = (await res.json()) as { data?: { rooms: Row[] }; rooms?: Row[] };
    const rooms = body.data?.rooms ?? body.rooms ?? [];
    expect(rooms.map((r) => String(r.id)).sort()).toEqual([ROOM_A.id, ROOM_B.id].sort());
    expect(rooms.map((r) => String(r.id))).not.toContain(SCRATCH.id);
  });

  it("the filter is unconditional — the statement carries no include_scratch branch", async () => {
    await getBenchRooms();
    const q = appCalls.find((c) => /FROM room r LEFT JOIN LATERAL/.test(c.text))!;
    expect(q.text).toMatch(PREFIX_PREDICATE);
    expect(q.text).not.toMatch(INCLUDE_SCRATCH);
    expect(q.text).not.toMatch(/LIKE/i);
  });
});

describe("scribe_diff_room — the all-rooms sweep skips scratch; naming one still works", () => {
  it("the sweep reports the live rooms only", async () => {
    const out = await call("scribe_diff_room", {});
    expect((out.rooms as Row[]).map((r) => String((r.room as Row).id)).sort()).toEqual([ROOM_A.id, ROOM_B.id].sort());
    const q = appCalls.find((c) => /^SELECT id, slug, name FROM room WHERE/.test(c.text))!;
    expect(q.text).toMatch(PREFIX_PREDICATE);
    expect(q.text).toMatch(/disabled_at IS NULL/);
    expect(q.text).not.toMatch(/LIKE/i);
  });

  it("a scratch room named explicitly still resolves — the single-room path is not filtered", async () => {
    const byId = await call("scribe_diff_room", { room_id: SCRATCH.id });
    expect((byId.rooms as Row[]).map((r) => String((r.room as Row).id))).toEqual([SCRATCH.id]);
    expect(byId.error).toBeUndefined();

    const bySlug = await call("scribe_diff_room", { room_slug: SCRATCH.slug });
    expect((bySlug.rooms as Row[]).map((r) => String((r.room as Row).id))).toEqual([SCRATCH.id]);
  });
});

describe("NOT FILTERED — the two reads slice 2 depends on still see the scratch room", () => {
  it("SQL_ROOM_EXISTS is byte-for-byte the statement it always was, and mentions no prefix", () => {
    expect(SQL_ROOM_EXISTS).toBe("SELECT 1 FROM room WHERE id = $1 AND disabled_at IS NULL");
    expect(SQL_ROOM_EXISTS).not.toMatch(/scratch/i);
    expect(SQL_ROOM_EXISTS).not.toMatch(/left\(/i);
  });

  it("roomExists(scratch room) is true — the cue route's existence check still passes", async () => {
    await expect(roomExists(SCRATCH.id)).resolves.toBe(true);
    await expect(roomExists(ROOM_A.id)).resolves.toBe(true);
    await expect(roomExists("room_ghost")).resolves.toBe(false);
    // and the statement it issued carried no prefix parameter at all
    expect(brainCalls.every((c) => !c.values.includes(SCRATCH_ROOM_PREFIX))).toBe(true);
  });

  it("resolveRoom finds the scratch room by id, by slug, and by exact name", async () => {
    expect(await resolveRoom({ room_id: SCRATCH.id })).toMatchObject({ id: SCRATCH.id, enabled: true });
    expect(await resolveRoom({ room_slug: SCRATCH.slug })).toMatchObject({ id: SCRATCH.id });
    expect(await resolveRoom({ room: SCRATCH.id })).toMatchObject({ id: SCRATCH.id });
    expect(await resolveRoom({ room: SCRATCH.name })).toMatchObject({ id: SCRATCH.id });
    // its statement never learned about the prefix
    for (const c of appCalls) {
      if (/FROM room WHERE \(\?::text IS NOT NULL/.test(c.text)) {
        expect(c.text).not.toMatch(PREFIX_PREDICATE);
        expect(c.values).not.toContain(SCRATCH_ROOM_PREFIX);
      }
    }
  });

  it("scribe_list_cues can still address the scratch day — the tool resolves the room", async () => {
    const out = await call("scribe_list_cues", { room_id: SCRATCH.id, ist_date: "2026-08-19" });
    expect(out.error).not.toBe("unknown_room");
  });
});
