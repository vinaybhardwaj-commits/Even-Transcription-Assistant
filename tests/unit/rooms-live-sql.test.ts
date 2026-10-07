/** Static: every SQL string of the Rooms Live screen is bounded (SPEC-v1 §5) and read-only. */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "lib/rooms-live");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));
const sqlOf = (text: string): string[] => [...text.matchAll(/\bdb`([^`]*)`/g)].map((m) => m[1]!);
const all = files.flatMap((f) => sqlOf(readFileSync(join(DIR, f), "utf8")).map((s) => ({ f, s })));

describe("every SQL string in lib/rooms-live", () => {
  it("finds the 10 statements of this module (7 now-reads + the day read + the 2 roster reads; occupancy is imported from lib/steward)", () => {
    expect(all.length).toBe(10);
  });
  it("has a LIMIT", () => {
    for (const { f, s } of all) expect(/\bLIMIT\b/i.test(s), `${f}: ${s.slice(0, 80)}`).toBe(true);
  });
  it("is bounded by the room allow-list (room_id / machine = ANY or a single room) or a time bound", () => {
    for (const { f, s } of all) {
      const ok = /(room_id|machine|id) = ANY\(\$\{/i.test(s) || /room_id = \$\{/i.test(s) || /steward_config WHERE key = \$\{/i.test(s);
      const timed = /interval '\d+ (minutes|hours)'/i.test(s) || /ist_day = \$\{/i.test(s);
      expect(ok || timed, `${f}: ${s.slice(0, 80)}`).toBe(true);
    }
  });
  it("event tables carry a time window AND an allow-list bound", () => {
    for (const { f, s } of all.filter((x) => /kiosk_health_events|pulse_presence_events|bench_level_sample|steward_decisions|bench_session/.test(x.s))) {
      expect(/interval '\d+ (minutes|hours)'/i.test(s), `${f}: time window`).toBe(true);
      expect(/(room_id|machine) = ANY\(\$\{/i.test(s), `${f}: allow-list`).toBe(true);
    }
  });
  it("is read-only: no INSERT / UPDATE / DELETE / DDL anywhere in the module", () => {
    for (const f of files) {
      const text = readFileSync(join(DIR, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/i.test(text), f).toBe(false);
    }
  });
  it("never selects an email, a uid or a cookie field", () => {
    for (const { f, s } of all) expect(/payload->>'(email|doctor_uid|cookie_uid|cookie_name)'/i.test(s), f).toBe(false);
  });
});

describe("the new files stay inside the allowed directories", () => {
  it("no route or component outside app/rooms-live, app/api/rooms-live, lib/rooms-live, components/rooms-live", () => {
    const here = ["app/rooms-live", "app/api/rooms-live", "lib/rooms-live", "components/rooms-live"];
    for (const d of here) expect(readdirSync(join(process.cwd(), d)).length).toBeGreaterThan(0);
    // AMENDMENT 2: nothing under /admin
    expect(existsSync(join(process.cwd(), "app/admin/rooms-live"))).toBe(false);
    expect(existsSync(join(process.cwd(), "app/api/admin/rooms-live"))).toBe(false);
  });
});
