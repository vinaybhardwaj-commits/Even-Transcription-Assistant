/**
 * Tier 2 §2.4 / §2.6 / §2.7 — the `detail` flag, `listChanged`, and `scribe_fleet`.
 *
 * `summary` must be a NARROWER SELECTION OF THE SAME FACTS: every field it returns must be
 * byte-identical to the same field under `full`, or the flag is a second implementation of the
 * answer and the two will drift. That is what these assert, rather than a hand-written field list.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const ROOM = { id: "room_a", slug: "room-a", name: "Room A" };
let installRow: Row | null = null;

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    void values;
    if (/^SELECT id, slug, name FROM room WHERE/.test(text)) {
      return Promise.resolve([{ ...ROOM, created_at: new Date() }]);
    }
    if (/^SELECT state_flags FROM room_install/.test(text)) {
      return Promise.resolve([{ state_flags: { flags: ["DISK_LOW"], drift_since: null } }]);
    }
    if (/FROM room WHERE \(/.test(text)) return Promise.resolve([{ id: ROOM.id, slug: ROOM.slug, name: ROOM.name, disabled_at: null }]);
    if (/SELECT install_id, room_id, created_at/.test(text)) return Promise.resolve(installRow ? [installRow] : []);
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});
vi.mock("@/lib/brain/db", async (o) => ({ ...(await o() as Row), brainLog: () => {}, query: async () => ({ rows: [], rowCount: 0 }) }));
vi.mock("@/lib/bench-bus", async (o) => ({ ...(await o() as Row), getListener: async () => null }));

const { BENCH_TOOLS } = await import("@/lib/mcp/tools/bench");
const { SUMMARY_ROOM_FIELDS } = await import("@/lib/mcp/tools/bench");
const tool = (n: string) => BENCH_TOOLS.find((t) => t.name === n)!;
const ctx = { origin: "https://x" };

beforeEach(() => {
  installRow = {
    install_id: "install_a", room_id: ROOM.id, created_at: new Date().toISOString(),
    enrolled_at: new Date().toISOString(), retired_at: null, app_version: "0.1.22",
    build_sha: "d516204", update_channel: "test", assigned_channel: null, channel_locked: false,
    state_flags: { flags: [], drift_since: null }, session_open: false,
    last_seen_at: new Date().toISOString(), mic_state: "authorized",
    input_device_name: "C270 HD WEBCAM", disk_free_bytes: "400000000000",
  };
});

describe("§2.4 — detail on scribe_diff_room", () => {
  const call = (args: Row) => tool("scribe_diff_room").handler(args, ctx) as Promise<{ rooms: Row[] }>;

  it("summary is the DEFAULT", async () => {
    const a = (await call({})).rooms[0]!;
    const b = (await call({ detail: "summary" })).rooms[0]!;
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });

  it("summary keeps only the named fields, and full is strictly wider", async () => {
    const s = (await call({ detail: "summary" })).rooms[0]!;
    const f = (await call({ detail: "full" })).rooms[0]!;
    for (const k of Object.keys(s)) expect(SUMMARY_ROOM_FIELDS as readonly string[], k).toContain(k);
    expect(Object.keys(f).length).toBeGreaterThan(Object.keys(s).length);
    for (const k of Object.keys(s)) expect(k in f, k).toBe(true);
  });

  it("every summary field is IDENTICAL to the same field under full — one answer, two widths", async () => {
    const s = (await call({ detail: "summary" })).rooms[0]!;
    const f = (await call({ detail: "full" })).rooms[0]!;
    for (const k of Object.keys(s)) {
      expect(JSON.stringify(s[k]), `${k} differs between summary and full`).toBe(JSON.stringify(f[k]));
    }
  });

  it("room_state with its Tier 1 flags survives into summary — it is the point of the tool", async () => {
    const s = (await call({})).rooms[0]!;
    expect((s.room_state as Row).flags).toEqual(["DISK_LOW"]);
    expect(s.room_state).toHaveProperty("drift_since");
    expect(s.room_state).toHaveProperty("state");
  });

  it("an unknown detail value is treated as summary, never as full", async () => {
    const weird = (await call({ detail: "everything" })).rooms[0]!;
    const s = (await call({ detail: "summary" })).rooms[0]!;
    expect(Object.keys(weird).sort()).toEqual(Object.keys(s).sort());
  });

  it("the flag is on the schema with its default", () => {
    const props = tool("scribe_diff_room").inputSchema.properties as Record<string, Row>;
    expect(props.detail).toMatchObject({ type: "string", default: "summary", enum: ["summary", "full"] });
  });
});

describe("§2.7 — scribe_fleet", () => {
  const call = (args: Row = {}) => tool("scribe_fleet").handler(args, ctx) as Promise<Row>;

  it("is registered, read-scope, and takes detail", () => {
    const t = tool("scribe_fleet");
    expect(t.scope).toBe("read");
    expect((t.inputSchema.properties as Record<string, Row>).detail).toBeTruthy();
  });

  it("returns one row per room with the install's version, channel and flags", async () => {
    const out = await call();
    const rooms = out.rooms as Row[];
    expect(rooms).toHaveLength(1);
    const i = rooms[0]!.install as Row;
    expect(i.app_version).toBe("0.1.22");
    expect(i.update_channel).toBe("test");
    expect(i.state_flags).toEqual([]);
    expect(rooms[0]!).toHaveProperty("assigned_pending");
  });

  it("full is wider than summary and carries the whole derived row", async () => {
    const s = ((await call({ detail: "summary" })).rooms as Row[])[0]!;
    const f = ((await call({ detail: "full" })).rooms as Row[])[0]!;
    expect(f).toHaveProperty("derived");
    expect(Object.keys(f).length).not.toBe(Object.keys(s).length);
  });

  it("a room with no bound Mac reports install: null — different from a bound Mac gone quiet", async () => {
    installRow = null;
    const rooms = (await call()).rooms as Row[];
    expect(rooms[0]!.install).toBeNull();
  });

  it("never throws: a failed read answers with the empty envelope", async () => {
    const out = await call({ room: "nothing-matches-this" });
    expect(Array.isArray(out.rooms)).toBe(true);
    expect(out.rooms).toHaveLength(0);
  });
});

describe("§2.4 — the flag is on all four named tools, with the same wording", () => {
  it("scribe_diff_room, scribe_day_report, scribe_system_map and scribe_fuse_report all take it", async () => {
    const { HEALTH_TOOLS } = await import("@/lib/mcp/tools/health");
    const { FUSE_REPORT_TOOLS } = await import("@/lib/mcp/tools/fuse-report");
    const all = [...BENCH_TOOLS, ...HEALTH_TOOLS, ...FUSE_REPORT_TOOLS];
    for (const n of ["scribe_diff_room", "scribe_day_report", "scribe_system_map", "scribe_fuse_report", "scribe_fleet"]) {
      const t = all.find((x) => x.name === n)!;
      const d = (t.inputSchema.properties as Record<string, Row>).detail;
      expect(d, n).toMatchObject({ type: "string", default: "summary", enum: ["summary", "full"] });
    }
  });

  it("scribe_day_report summary is one line per session and full keeps the pieces", async () => {
    const t = BENCH_TOOLS.find((x) => x.name === "scribe_day_report")!;
    const s = (await t.handler({ room: ROOM.id, detail: "summary" }, ctx)) as { sessions?: Row[] };
    const f = (await t.handler({ room: ROOM.id, detail: "full" }, ctx)) as { sessions?: Row[] };
    expect(Array.isArray(s.sessions)).toBe(true);
    expect(Array.isArray(f.sessions)).toBe(true);
  });

  it("scribe_system_map summary keeps health/flags/env and drops the codebase map", async () => {
    const { HEALTH_TOOLS } = await import("@/lib/mcp/tools/health");
    const t = HEALTH_TOOLS.find((x) => x.name === "scribe_system_map")!;
    const sm = (await t.handler({}, ctx)) as Row;
    expect(Object.keys(sm).sort()).toEqual(["env_set", "flags", "health"]);
    const fm = (await t.handler({ detail: "full" }, ctx)) as Row;
    expect(fm).toHaveProperty("stores");
    expect(fm).toHaveProperty("brain_routes");
    // The same facts, not a second computation.
    expect(JSON.stringify(fm.flags)).toBe(JSON.stringify(sm.flags));
    expect(JSON.stringify(fm.env_set)).toBe(JSON.stringify(sm.env_set));
  });
});

describe("§2.6 — listChanged", () => {
  it("initialize advertises tools.listChanged: true", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("lib/mcp/handler.ts", "utf8"));
    expect(src).toMatch(/capabilities:\s*\{\s*tools:\s*\{\s*listChanged:\s*true\s*\}\s*\}/);
    expect(src).not.toMatch(/listChanged:\s*false/);
  });
});
