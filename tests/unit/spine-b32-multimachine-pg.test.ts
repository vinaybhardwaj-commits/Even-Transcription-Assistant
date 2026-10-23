/**
 * spine-b32-multimachine-pg.test.ts — pins main's behaviour for B32 (fable ruling, 23 Oct, option A; tests + docs only, merge.ts untouched):
 * the same consult_uid on two machines (two consult_keys) is TWO encounters, both flagged multi_machine, and a rerun over the same day writes nothing.
 * postgres:16 with migrations 0173 + 0176. Append-only: states are made by inserting signal rows (a re-ingest is a new revision), never by deleting any. Synthetic ids only.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => {
  const run = (text: string, params: unknown[]) => {
    const order: number[] = [];
    const parts = text.split(/\$(\d+)/);
    const strings: string[] = [];
    for (let i = 0; i < parts.length; i += 2) { strings.push(parts[i]); if (i + 1 < parts.length) order.push(Number(parts[i + 1]) - 1); }
    return H.tag!(Object.assign(strings, { raw: strings }) as unknown as TemplateStringsArray, ...order.map((n) => params[n]));
  };
  const sql = (a: unknown, ...rest: unknown[]) => (typeof a === "string" ? run(a, rest[0] as unknown[]) : H.tag!(a as TemplateStringsArray, ...rest));
  return { sql };
});

import { runSpineMerge as runMerge } from "@/lib/spine/merge-store";

const HAVE_DOCKER = dockerAvailable();
const pg = pgContainer("eta-spine-b32mm");
const UP = readFileSync("db/migrations/0173_spine.sql", "utf8") + "\n" + readFileSync("db/migrations/0176_spine_encounter_single_proxy.sql", "utf8");
const NOW = Date.parse("2026-10-18T08:00:00Z");
const ROOM = "room_abcd2345";
const iso = (h: number, m = 0) => `2026-10-18T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
const UID = "uidtestaaaaaaaaaaaaaaaaa";
type Ran = { mode: string; days: number; failed_days: number; encounters: number; enc_inserted: number; enc_updated: number; links_written: number; links_moved: number; assigned: number };
const runSpineMerge = runMerge as unknown as (now: number) => Promise<Ran>;
const q = async (text: string): Promise<Array<Record<string, unknown>>> => (await H.tag!(Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray)) as Array<Record<string, unknown>>;
const num = async (text: string) => Number(Object.values((await q(text))[0]!)[0]);
const pulse = (machine: string, open: string, close: string, o: { rev?: number; received?: string } = {}) => {
  const key = `${UID}@${machine}`;
  pg.exec(`INSERT INTO spine_signal (proxy, source_key, source_rev, room_id, t_open, t_close, observed_at, received_at, attrs)
    VALUES ('pulse', '${key}', ${o.rev ?? 1}, '${ROOM}', '${open}', '${close}', '${open}', '${o.received ?? iso(6)}', '${JSON.stringify({ ids: { consult_key: key, consult_uid: UID }, close_reason: "endConsult" })}');`);
};

const d = HAVE_DOCKER ? describe : describe.skip;
d("B32: the same consult_uid on two machines (postgres:16)", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    pg.exec(UP);
    pg.exec("INSERT INTO spine_config (key, value) VALUES ('merge', '\"shadow\"');");
  }, 120000);
  afterAll(() => { pg.stop(); });

  it("two consult_keys, one consult_uid -> two encounters, both multi_machine, each with its own signal; a re-ingest of the same signals writes 0 rows", async () => {
    pulse("mach_a", iso(4), iso(4, 10)); pulse("mach_b", iso(4, 30), iso(4, 45));
    const c1 = await runSpineMerge(NOW);
    expect(c1).toMatchObject({ mode: "shadow", days: 1, failed_days: 0, encounters: 2, enc_inserted: 2, enc_updated: 0 });
    const e = await q("SELECT encounter_id, status, reason, flags::text AS flags FROM spine_encounter ORDER BY t_open");
    expect(e).toHaveLength(2);
    expect(e.map((x) => [x.status, x.reason])).toEqual([["confirmed", "pulse"], ["confirmed", "pulse"]]);
    for (const x of e) expect(String(x.flags)).toContain("multi_machine");
    expect(await num("SELECT count(DISTINCT encounter_id) FROM spine_signal")).toBe(2);
    expect(await num("SELECT count(*) FROM spine_signal WHERE encounter_id IS NULL")).toBe(0);
    expect(await num(`SELECT count(*) FROM spine_link WHERE active AND key_kind = 'consult_key'`)).toBe(2);

    // Append-only rerun: the same two signals arrive again as revision 2 (production's re-ingest path). The day is merged again and must change nothing.
    const before = await q("SELECT encounter_id, updated_at, flags::text AS flags FROM spine_encounter ORDER BY 1");
    const links = await num("SELECT count(*) FROM spine_link");
    pulse("mach_a", iso(4), iso(4, 10), { rev: 2, received: iso(7) }); pulse("mach_b", iso(4, 30), iso(4, 45), { rev: 2, received: iso(7) });
    const c2 = await runSpineMerge(NOW);
    expect(c2).toMatchObject({ days: 1, encounters: 2, enc_inserted: 0, enc_updated: 0, links_written: 0, links_moved: 0, failed_days: 0 });
    expect(await q("SELECT encounter_id, updated_at, flags::text AS flags FROM spine_encounter ORDER BY 1")).toEqual(before);
    expect(await num("SELECT count(*) FROM spine_link")).toBe(links);
    expect(await num("SELECT count(*) FROM spine_encounter")).toBe(2);
  });
});
