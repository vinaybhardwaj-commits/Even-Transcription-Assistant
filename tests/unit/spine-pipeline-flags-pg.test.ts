/**
 * Spine S4 R2 (refute F1): the ambiguous count must see what S2's mergeSignals really persists. S2's own M7 fixture goes through a fake writer
 * into spine_encounter.flags on a REAL postgres:16 (migration 0173), and readPipeline's SQL must show it. Synthetic ids only; no text.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { mergeSignals } from "@/lib/spine/merge";
import { ENCOUNTERS_SQL, readPipeline } from "@/lib/spine/pipeline-view";
import type { Proxy, SpineSignal } from "@/lib/spine/types";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-spine-s4-flags");

describe("REQUIRED PROOF — spine pipeline flags run against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/spine-pipeline-flags-pg.test.ts needs Docker for postgres:16. Run it on c3 / the lab box, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const T0 = Date.parse("2026-10-19T04:00:00Z");
const MIN = 60_000;
let rev = 0;
const sig = (proxy: Proxy, key: string, o: number, c: number | null, attrs: Record<string, unknown> = {}): SpineSignal =>
  ({ proxy, source_key: key, source_rev: ++rev, room_id: "room_a", t_open: T0 + o * MIN, t_close: c === null ? null : T0 + c * MIN, attrs });
const pulse = (key: string, o: number, c: number, uid: string) => sig("pulse", key, o, c, { consult_uid: uid, consult_key: `${uid}@m1`, close_reason: "endConsult" });

const d = HAVE_DOCKER ? describe : describe.skip;
d("pipeline view flag counts on postgres:16", () => {
  const db = (text: string, params: unknown[]) => {
    const parts = text.split(/\$\d+/);
    return pg.sql(Object.assign([...parts], { raw: [...parts] }) as unknown as TemplateStringsArray, ...params);
  };
  const lit = (v: string | null) => (v === null ? "NULL" : `'${v}'`);
  const write = (r: ReturnType<typeof mergeSignals>) => {
    for (const e of r.encounters) {
      pg.exec(`INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, merged_into, anchor_proxy, boundary_rev, merge_version, reason, flags)
        VALUES ('${e.encounter_id}', '${e.ist_date}', '${e.room_id}', to_timestamp(${e.t_open / 1000}), to_timestamp(${e.t_close / 1000}), '${e.status}', ${lit(e.merged_into)}, '${e.anchor_proxy}', ${e.boundary_rev}, '${e.merge_version}', '${e.reason}', ARRAY[${e.flags.map((f) => `'${f}'`).join(",")}]::text[]);`);
    }
  };

  beforeAll(() => {
    pg.start();
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    pg.exec(readFileSync("db/migrations/0173_spine.sql", "utf8"));
  });
  afterAll(() => { pg.stop(); });

  it("S2's M7 fixture (a weak signal meeting two encounters) shows ambiguous = 1, not 0", async () => {
    const r = mergeSignals([pulse("p1", 0, 10, "uid_test_01"), pulse("p2", 10, 20, "uid_test_02"), sig("acoustic", "a1", 3, 15)], "mv1", { encounters: [], links: [] }, T0 + 10 * 3_600_000);
    expect(r.encounters.filter((e) => e.flags.includes("ambiguous"))).toHaveLength(1);
    write(r);
    const v = await readPipeline("2026-10-19", new Date(T0 + 10 * 3_600_000), db as never);
    expect(v.rooms.room_a.encounters.ambiguous).toBe(1);
    expect(v.rooms.room_a.encounters.confirmed + v.rooms.room_a.encounters.candidate).toBe(r.encounters.length);
  });

  it("every flag has its own count, via @> (the GIN-served form)", async () => {
    pg.exec(`INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, status, merge_version, flags) VALUES
      ('enc_testbbbbbbbbbbbb','2026-10-19','room_b',now(),'candidate','mv1',ARRAY['multi_machine','pulse_overlap']),
      ('enc_testcccccccccccc','2026-10-19','room_b',now(),'candidate','mv1',ARRAY['clamped','clamp_failed','covered_by_pulse']),
      ('enc_testdddddddddddd','2026-10-19','room_b',now(),'candidate','mv1','{}');`);
    const v = await readPipeline("2026-10-19", new Date(), db as never);
    expect(v.rooms.room_b.encounters).toMatchObject({ candidate: 3, ambiguous: 0, multi_machine: 1, pulse_overlap: 1, clamped: 1, clamp_failed: 1, covered_by_pulse: 1 });
    expect(ENCOUNTERS_SQL).toContain("flags @> ARRAY['ambiguous']");
    expect(ENCOUNTERS_SQL).not.toMatch(/ANY\(flags\)|ILIKE/);
  });
});
