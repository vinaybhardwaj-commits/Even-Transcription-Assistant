/**
 * Speech turns, slice A — kickoff K2, the three corrections.
 *
 * Slice A shipped and worked. What it could not do was prove itself:
 *
 *   1. THE KEY WAS NEVER NARROWED. §4's second statement did not reach the build, so a turn
 *      avoided 0046's (session_id, type, at) index by leaving session_id NULL. That works —
 *      NULLs are distinct in a unique index — but it drops a column the design requires and
 *      reopens the collision for the next writer that sets it. 0051 narrows the predicate
 *      instead, and the session goes back on the row.
 *   2. THE CONFLICT TARGET WAS UNQUALIFIED, so EVERY unique violation came back as
 *      already_existed and `dropped` could not be non-zero however wrong the write was.
 *      SQL_CUE_INSERT_TURN names the arbiter; everything else throws and is counted.
 *   3. THE COUNTS WERE THE BUILDER'S, not PRD §10's. payload.window and payload.source_used are
 *      what the day's tape counters roll up from, and neither existed.
 *
 * No live database: the migration is read as text, the statements are read as constants, and
 * insertScratchCue is driven against a fake client that records which statement it was given.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  SQL_CUE_INSERT,
  SQL_CUE_INSERT_SCRATCH,
  SQL_CUE_INSERT_TURN,
  TURN_CUE_TYPES,
  insertScratchCue,
  isTurnCue,
} from "@/lib/brain/state";

const migration = (name: string) => readFileSync(join(process.cwd(), "db", "migrations", name), "utf8");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// 1. migration 0051 — the statement that did not arrive
// ---------------------------------------------------------------------------

describe("0051 — the replay key is narrowed, and only the replay key", () => {
  const sql = migration("0051_narrow_replay_key.sql");
  const body = squash(sql.replace(/^--.*$/gm, ""));

  it("drops the wide index and recreates it with the turn types excluded", () => {
    expect(body).toContain("DROP INDEX IF EXISTS cue_replay_natural_key;");
    expect(body).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS cue_replay_natural_key ON cue (session_id, type, at) " +
        "WHERE source = 'replay' AND type NOT IN ('stt_turn', 'stt_silence', 'speaker_match');",
    );
    // the DROP comes first: a create against the old name would simply be a no-op otherwise
    expect(body.indexOf("DROP INDEX")).toBeLessThan(body.indexOf("CREATE UNIQUE INDEX"));
  });

  it("is idempotent by name in both directions — a second run is a no-op", () => {
    expect(body).toContain("DROP INDEX IF EXISTS");
    expect(body).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
  });

  it("RECORDS ITSELF — the runner writes no schema_migrations row, each file does", () => {
    expect(squash(sql)).toContain("INSERT INTO schema_migrations (version, name) VALUES (51, '0051_narrow_replay_key') ON CONFLICT DO NOTHING;");
  });

  it("touches NOTHING else: not 0050's turn key, not 0047's warehouse key, no table", () => {
    expect(body).not.toContain("cue_turn_natural_key");
    expect(body).not.toContain("cue_warehouse_natural_key");
    expect(body).not.toMatch(/ALTER TABLE|DROP TABLE|DELETE FROM cue|UPDATE cue/);
    // exactly three statements: the drop, the create, and its own migration row
    expect(body.split(";").filter((p) => p.trim().length > 0)).toHaveLength(3);
  });

  it("0050 is accepted as built and is not edited by this slice", () => {
    const b = squash(migration("0050_turn_cue_keys.sql").replace(/^--.*$/gm, ""));
    expect(b).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS cue_turn_natural_key ON cue (source_ref, type) " +
        "WHERE source = 'replay' AND type IN ('stt_turn', 'stt_silence', 'speaker_match');",
    );
    expect(b).not.toContain("DROP INDEX");
  });
});

// ---------------------------------------------------------------------------
// 2. the conflict target — the reason `dropped` can be non-zero at all
// ---------------------------------------------------------------------------

describe("SQL_CUE_INSERT_TURN — the arbiter is NAMED, and its predicate is the index's", () => {
  it("names (source_ref, type) and repeats the partial index predicate verbatim", () => {
    expect(squash(SQL_CUE_INSERT_TURN)).toContain(
      "ON CONFLICT (source_ref, type) WHERE source = 'replay' AND type IN ('stt_turn', 'stt_silence', 'speaker_match') DO NOTHING",
    );
  });

  it("its predicate is CHARACTER FOR CHARACTER 0050's index predicate", () => {
    const fromIndex = squash(migration("0050_turn_cue_keys.sql").replace(/^--.*$/gm, ""))
      .match(/cue_turn_natural_key ON cue \(source_ref, type\) (WHERE .*?);/)![1]!;
    expect(squash(SQL_CUE_INSERT_TURN)).toContain(fromIndex);
    // and the same three names 0051 excludes from the replay key
    expect(squash(migration("0051_narrow_replay_key.sql"))).toContain("('stt_turn', 'stt_silence', 'speaker_match')");
  });

  it("TURN_CUE_TYPES is the same closed set, in the same order", () => {
    expect([...TURN_CUE_TYPES]).toEqual(["stt_turn", "stt_silence", "speaker_match"]);
    expect(squash(SQL_CUE_INSERT_TURN)).toContain(TURN_CUE_TYPES.map((t) => `'${t}'`).join(", "));
  });

  it("writes the same eight columns in the same order as the shared statement — only the conflict clause differs", () => {
    const cols = /INSERT INTO cue \((.*?)\) VALUES \((.*?)\)/;
    const turn = squash(SQL_CUE_INSERT_TURN).match(cols)!;
    const scratch = squash(SQL_CUE_INSERT_SCRATCH).match(cols)!;
    expect(turn[1]).toBe(scratch[1]);
    expect(turn[2]).toBe(scratch[2]);
    expect(squash(SQL_CUE_INSERT_TURN)).toContain("RETURNING id, at, created_at");
  });

  it("SQL_CUE_INSERT_SCRATCH is UNTOUCHED — it is shared with the marks and the warehouse loader", () => {
    expect(squash(SQL_CUE_INSERT_SCRATCH)).toBe(
      "INSERT INTO cue (id, room_day_id, type, payload, at, session_id, source, source_ref) " +
        "VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::text, $7::text, $8::text) " +
        "ON CONFLICT DO NOTHING RETURNING id, at, created_at",
    );
  });

  it("the live statement is untouched too — no new column reaches the live path", () => {
    expect(squash(SQL_CUE_INSERT)).toBe(
      "INSERT INTO cue (id, room_day_id, type, payload, at) VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz) RETURNING id, at, created_at",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. which statement a row gets, decided from the row
// ---------------------------------------------------------------------------

describe("isTurnCue — BOTH halves of the predicate, never one", () => {
  it.each(TURN_CUE_TYPES.map((t) => [t] as const))("a replay %s is a turn cue", (type) => {
    expect(isTurnCue("replay", type)).toBe(true);
  });

  it("a turn TYPE with another source is not: naming this arbiter would break the loader's DO NOTHING", () => {
    expect(isTurnCue("warehouse", "stt_turn")).toBe(false);
    expect(isTurnCue(null, "stt_turn")).toBe(false);
  });

  it("a replay cue of any other type is not — the marks keep the shared statement", () => {
    expect(isTurnCue("replay", "consult_mark")).toBe(false);
    expect(isTurnCue("replay", "pqm_called")).toBe(false);
  });
});

describe("insertScratchCue — the row picks its own arbiter", () => {
  const fake = () => {
    const seen: Array<{ text: string; values: unknown[] }> = [];
    let rows: Array<Record<string, unknown>> = [{ id: "cue_x", at: new Date("2026-08-19T05:06:00Z"), created_at: new Date("2026-08-19T05:06:00Z") }];
    let throwNext: Error | null = null;
    return {
      seen,
      setRows: (r: Array<Record<string, unknown>>) => { rows = r; },
      setThrow: (e: Error) => { throwNext = e; },
      client: {
        query: async (text: string, values: unknown[]) => {
          seen.push({ text, values });
          if (throwNext) throw throwNext;
          return { rows, rowCount: rows.length };
        },
      },
    };
  };
  const cue = (type: string, source: string | null) => ({
    type, at: new Date("2026-08-19T05:06:00Z"), payload: { a: 1 },
    session_id: "bs_a", source, source_ref: "bs_a|1|2|-",
  });

  it("a turn takes the NAMED target", async () => {
    const f = fake();
    await insertScratchCue(f.client as never, "rd_scratch_x", cue("stt_turn", "replay"));
    expect(f.seen[0]!.text).toBe(SQL_CUE_INSERT_TURN);
    // same parameters, same order — nothing about the caller changed
    expect(f.seen[0]!.values.slice(1)).toEqual(["rd_scratch_x", "stt_turn", JSON.stringify({ a: 1 }), "2026-08-19T05:06:00.000Z", "bs_a", "replay", "bs_a|1|2|-"]);
  });

  it("a mark and a warehouse row keep the shared statement", async () => {
    const f = fake();
    await insertScratchCue(f.client as never, "rd_scratch_x", cue("consult_mark", "replay"));
    await insertScratchCue(f.client as never, "rd_scratch_x", cue("pqm_called", "warehouse"));
    expect(f.seen.map((c) => c.text)).toEqual([SQL_CUE_INSERT_SCRATCH, SQL_CUE_INSERT_SCRATCH]);
  });

  it("no row and no error is already_existed on BOTH statements — that is what makes a re-run safe", async () => {
    for (const type of ["stt_turn", "consult_mark"]) {
      const f = fake();
      f.setRows([]);
      const out = await insertScratchCue(f.client as never, "rd_scratch_x", cue(type, "replay"));
      expect(out).toMatchObject({ id: null, created_at: null, already_existed: true });
    }
  });

  it("a THROW is not swallowed into already_existed — it is the caller's `dropped`", async () => {
    const f = fake();
    f.setThrow(new Error("duplicate key value violates unique constraint"));
    await expect(insertScratchCue(f.client as never, "rd_scratch_x", cue("stt_turn", "replay"))).rejects.toThrow(/duplicate key/);
  });
});
