/**
 * Slice C1 step 1 — the (room,'default') safety net, and the resolver behaviour it exists for.
 *
 * The migration is asserted on its EFFECT where that can be reached without a database: the
 * resolver's fallback is real code and is tested against a fake `sql`, so "deleting a room row now
 * falls back instead of failing" is proved rather than asserted about a file. The file itself is
 * checked only for the two things a behavioural test genuinely cannot see — that it is idempotent
 * and that it points at today's engine, not tomorrow's.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const MIGRATION = "db/migrations/0083_stt_routing_room_default.sql";

// The resolver reads three things; the fake answers from a table it is handed, so a test can
// delete a row and watch what resolveRouting does about it.
type Row = { stage: string; bucket: string; engine: string };
const ROWS: { table: Row[]; enabled: Record<string, boolean> } = { table: [], enabled: {} };

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join("?");
    if (q.includes("FROM stt_routing")) {
      const stage = String(vals[0]);
      const bucket = q.includes("'default'") ? "default" : String(vals[1]);
      const hit = ROWS.table.find((r) => r.stage === stage && r.bucket === bucket);
      return hit ? [{ engine_id: hit.engine }] : [];
    }
    if (q.includes("FROM stt_engine")) {
      const id = String(vals[0]);
      return id in ROWS.enabled ? [{ enabled: ROWS.enabled[id] }] : [];
    }
    return [];
  },
}));

describe("C1 step 1 — the room stage stops being a single point of failure", () => {
  beforeEach(() => {
    ROWS.table = [
      { stage: "room", bucket: "english", engine: "sarvam" },
      { stage: "room", bucket: "indic", engine: "sarvam" },
    ];
    ROWS.enabled = { sarvam: true, route: true };
  });

  it("WITHOUT the default row, deleting a room row fails every window — the defect", async () => {
    const { resolveRouting } = await import("@/lib/stt/routing");
    ROWS.table = ROWS.table.filter((r) => r.bucket !== "indic");
    expect(await resolveRouting("room", "indic"), "null is what the drain turns into no_engine").toBeNull();
  });

  it("WITH it, the same deletion falls back to the default engine", async () => {
    const { resolveRouting } = await import("@/lib/stt/routing");
    ROWS.table.push({ stage: "room", bucket: "default", engine: "sarvam" });
    ROWS.table = ROWS.table.filter((r) => r.bucket !== "indic");
    expect(await resolveRouting("room", "indic")).toBe("sarvam");
  });

  it("'auto' takes the fallback too — the other way an operator rolls back", async () => {
    const { resolveRouting } = await import("@/lib/stt/routing");
    ROWS.table.push({ stage: "room", bucket: "default", engine: "sarvam" });
    const indic = ROWS.table.find((r) => r.bucket === "indic")!;
    indic.engine = "auto";
    expect(await resolveRouting("room", "indic")).toBe("sarvam");
  });

  it("the migration is idempotent and points at TODAY's engine", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    // Idempotence cannot be observed without a database; the conflict target is named explicitly
    // so a re-run is a no-op on the real primary key rather than on whatever Postgres picks.
    expect(sql).toMatch(/ON CONFLICT \(stage, language_bucket\) DO NOTHING/);
    expect(sql).toMatch(/VALUES \('room', 'default', 'sarvam'\)/);
    // A default pointing at the new engine would make the safety net a second way to SWITCH.
    expect(sql, "the net must catch the system where it stands").not.toMatch(/'route'\)/);
  });
});
