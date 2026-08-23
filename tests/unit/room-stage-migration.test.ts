/**
 * K4b Part B — migration 0062: the 'room' routing stage and the fifth partial cue index.
 *
 * Both halves are enumerated TWICE — once in SQL here, once in TypeScript — because an index
 * predicate cannot interpolate a constant and a routing stage cannot be read from a type. These
 * tests are the thing that keeps the two copies honest.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WINDOW_CUE_TYPE } from "@/lib/brain/state";
import { SQL_LAST_WINDOW_MARKER } from "@/lib/admin/rooms-live";

const migration = readFileSync(join(process.cwd(), "db", "migrations", "0062_room_stage_and_marker_index.sql"), "utf8");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const body = squash(migration.replace(/^--.*$/gm, ""));

describe("0062 — the room stage", () => {
  it("seeds both language buckets at sarvam", () => {
    expect(body).toContain("INSERT INTO stt_routing (stage, language_bucket, engine_id) VALUES ('room', 'english', 'sarvam'), ('room', 'indic', 'sarvam')");
  });

  it("cannot overwrite an engine an admin has since pinned by hand", () => {
    expect(body).toContain("ON CONFLICT (stage, language_bucket) DO NOTHING");
  });

  it("the stage vocabulary is widened everywhere it is enumerated", () => {
    // A routing row nothing can name is inert; these four are the whole surface.
    expect(readFileSync("app/api/admin/stt-lab/routing/route.ts", "utf8")).toContain('const STAGES = ["live", "note", "room"]');
    const mcp = readFileSync("lib/mcp/tools/stt.ts", "utf8");
    expect(mcp.match(/stages: \["live", "note", "room"\]/g) ?? []).toHaveLength(2);
    expect(readFileSync("lib/stt/routing.ts", "utf8")).toContain('export type Stage = "live" | "note" | "diarize" | "room"');
    expect(readFileSync("lib/stt/types.ts", "utf8")).toContain('export type SttStage = "live" | "note" | "diarize" | "room"');
  });

  it("'room' is NOT 'live' — changing the room engine cannot change what a doctor sees", () => {
    const drain = readFileSync("lib/stt/room-drain.ts", "utf8");
    expect(drain).toContain('DRAIN_STAGE = "room"');
  });
});

describe("0062 — the fifth partial index", () => {
  it("matches 0054's shape: same table, same leading columns, partial on type", () => {
    expect(body).toContain("CREATE INDEX IF NOT EXISTS cue_window_recent_idx ON cue (room_day_id, at DESC) WHERE type = 'stt_window';");
  });

  it("its predicate is the SAME string the marker query filters on", () => {
    expect(WINDOW_CUE_TYPE).toBe("stt_window");
    expect(body).toContain(`WHERE type = '${WINDOW_CUE_TYPE}'`);
    expect(SQL_LAST_WINDOW_MARKER).toContain(`c.type = '${WINDOW_CUE_TYPE}'`);
  });

  it("the query it serves still leads on room_day_id and orders by at DESC", () => {
    // If the query stops matching the index's leading columns the index stops being used, and
    // nothing would fail — it would just get slow again on the day it matters.
    expect(SQL_LAST_WINDOW_MARKER).toContain("c.room_day_id = rd.id");
    expect(SQL_LAST_WINDOW_MARKER).toContain("ORDER BY rd.room_id, c.at DESC");
  });

  it("RECORDS ITSELF", () => {
    expect(squash(migration)).toContain("INSERT INTO schema_migrations (version, name) VALUES (62, '0062_room_stage_and_marker_index') ON CONFLICT DO NOTHING;");
  });

  it("is additive only — nothing dropped, no unique index, no column touched", () => {
    expect(body).not.toMatch(/\bDROP\b/i);
    expect(body).not.toMatch(/\bUNIQUE\b/i);
    expect(body).not.toMatch(/ALTER TABLE/i);
    expect(body).not.toMatch(/\bDELETE\b/i);
    expect(body).not.toMatch(/\bUPDATE\b/i);
  });
});
