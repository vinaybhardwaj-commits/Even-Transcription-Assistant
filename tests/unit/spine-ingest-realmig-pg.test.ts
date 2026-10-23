/**
 * spine-ingest-realmig-pg.test.ts — Spine S1 R2: the ingest against ALL real migrations on postgres:16 (ported from the Opus refute, oref). Synthetic ids, no text.
 * Proves: acoustic = acoustic runs only (latest per room-day, run_id in attrs.ids); the timeline LIMIT keeps the newest; concurrent changes are never lost as duplicates;
 * a delete + reinsert of eta_encounter_windows keeps the rev; no doctor identity is copied.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({
  sql: (text: string, params: unknown[]) => {
    const parts = text.split(/\$\d+/);
    return H.tag!(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...params);
  },
}));
import { ingestSpineSignals, storeSignals, readIngestMode } from "@/lib/spine/ingest-store";
import { readHypothesesSince } from "@/lib/encounter-hypotheses";

const HAVE_DOCKER = dockerAvailable();
const pg = pgContainer("eta-spine-s1-realmig");
const NOW = Date.parse("2026-10-18T06:00:00Z");
const T0 = Date.parse("2026-10-18T04:00:00.123Z");
const q = async (t: string) => (await H.tag!(Object.assign([t], { raw: [t] }) as unknown as TemplateStringsArray)) as Array<Record<string, unknown>>;
const n = async (where: string) => Number((await q(`SELECT count(*)::int AS c FROM spine_signal WHERE ${where}`))[0].c);
const d = HAVE_DOCKER || process.env.ETA_ALLOW_SKIP_E2E === "1" ? (HAVE_DOCKER ? describe : describe.skip) : describe;

d("spine ingest on the real migrations", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
    const hyp = (id: string, run: string, closedBy: string) => `('${id}', '${run}', 'rd_abcd2345', ${T0}, ${T0 + 600000}, 1, 0, 0, 0, 0, '${closedBy}', 1)`;
    pg.exec(`
      INSERT INTO room (id, slug, name, pin_hash) VALUES ('room_abcd2345', 'room-test-a', 'Room Test A', 'x');
      INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_abcd2345', 'room_abcd2345', '2026-10-18');
      INSERT INTO eta_encounter_windows (consult_key, consult_uid, machine, room_id, doctor_uid, display_name, attribution, t_open, t_close, close_reason, quality, resolver_version, warehouse_doctor_name, consulting_doctor_name)
        VALUES ('uidtestaaaaaaaaaaaaaaaaaaa@mach_test', 'uidtestaaaaaaaaaaaaaaaaaaa', 'mach_test', 'room_abcd2345', 'doc_test_01', 'Doc Test Display', 'rows', '2026-10-18T04:00:00.123Z', '2026-10-18T04:10:00.456Z', 'endConsult', 'clean', 'rv_test', 'WH Doc Test', 'CD Doc Test');
      INSERT INTO encounter_hypothesis_run (id, room_day_id, smoother_version, gate_version, probes_total, probes_speech, probes_non_speech, probes_unjudged, n_hypotheses, source, created_at)
        VALUES ('hr_test_old', 'rd_abcd2345', 'sv', 'gv', 1, 1, 0, 0, 1, 'acoustic', '2026-10-18T03:00:00Z'),
               ('hr_test_ac', 'rd_abcd2345', 'sv', 'gv', 1, 1, 0, 0, 1, 'acoustic', '2026-10-18T04:00:00Z'),
               ('hr_test_fu', 'rd_abcd2345', 'sv', 'gv', 1, 1, 0, 0, 1, 'fused', '2026-10-18T05:00:00Z'),
               ('hr_test_tl', 'rd_abcd2345', 'sv', 'gv', 1, 1, 0, 0, 1, 'timeline', '2026-10-18T05:30:00Z');
      INSERT INTO encounter_hypothesis (id, run_id, room_day_id, start_ms, end_ms, speech_probes, non_speech_probes, unjudged_ms, longest_unjudged_run_ms, dead_mic_ms, closed_by, merged_from)
        VALUES ${hyp("eh_dddddddddddd", "hr_test_old", "non_speech")}, ${hyp("eh_acacacacacac", "hr_test_ac", "non_speech")}, ${hyp("eh_ffffffffffff", "hr_test_fu", "content_boundary")}, ${hyp("eh_tttttttttttt", "hr_test_tl", "non_speech")};
      INSERT INTO encounter_timeline_shadow_run (id, room_day_id, model, question_set_sha, prompt_version, calibration_sha, gate_version, fusion_version, params)
        VALUES ('tr_test_01', 'rd_abcd2345', 'm', 'q', 'p', 'c', 'g', 'f', '{}');
      INSERT INTO encounter_timeline_shadow (id, run_id, room_day_id, consult_key, start_ms, end_ms, reason_codes, closed_by, jev_used, cache_hit, cache_key, features)
        VALUES ('tl_test_01', 'tr_test_01', 'rd_abcd2345', 'uidtestaaaaaaaaaaaaaaaaaaa@mach_test', ${T0}, ${T0 + 590000}, ARRAY['patient_left'], 'patient_left', false, false, 'ck', '[]');
      INSERT INTO spine_config (key, value) VALUES ('ingest', '"shadow"') ON CONFLICT (key) DO NOTHING;
    `);
  }, 300_000);
  afterAll(() => pg.stop());

  it("runs on the real columns; copies no doctor identity; a second pass inserts nothing (ms-bearing times)", async () => {
    const r = await ingestSpineSignals(NOW);
    expect(r).toMatchObject({ mode: "shadow", read: { pulse: 1, timeline: 1 } });
    expect(JSON.stringify(await q("SELECT * FROM spine_signal"))).not.toMatch(/doc_test_01|Doc Test/);
    expect(await ingestSpineSignals(NOW)).toMatchObject({ inserted: { pulse: 0, acoustic: 0, timeline: 0 } });
  });
  it("acoustic is acoustic only: the latest acoustic run per room-day, not older, fused or timeline runs; run_id is in attrs.ids", async () => {
    const rows = await q("SELECT source_key, attrs FROM spine_signal WHERE proxy = 'acoustic' ORDER BY 1");
    expect(rows.map((x) => x.source_key)).toEqual([expect.stringMatching(/^rd_abcd2345:[0-9a-z]{4,6}$/)]);   // R3 F1: stable key, not the hypothesis id
    expect((rows[0].attrs as { ids: Record<string, string> }).ids).toMatchObject({ hypothesis_id: "eh_acacacacacac", run_id: "hr_test_ac" });
  });
  it("a recompute of eta_encounter_windows (delete + reinsert) keeps the rev", async () => {
    pg.exec(`DELETE FROM eta_encounter_windows; INSERT INTO eta_encounter_windows (consult_key, consult_uid, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version)
      VALUES ('uidtestaaaaaaaaaaaaaaaaaaa@mach_test', 'uidtestaaaaaaaaaaaaaaaaaaa', 'mach_test', 'room_abcd2345', 'rows', '2026-10-18T04:00:00.123Z', '2026-10-18T04:10:00.456Z', 'endConsult', 'clean', 'rv_test2');`);
    expect(await ingestSpineSignals(NOW)).toMatchObject({ inserted: { pulse: 0 } });
    expect(await n("proxy = 'pulse'")).toBe(1);
  });
  it("the timeline LIMIT keeps the newest consult_keys, not the alphabetical first", async () => {
    pg.exec(`UPDATE encounter_timeline_shadow SET created_at = '2026-10-18T05:00:00Z' WHERE id = 'tl_test_01';
      INSERT INTO encounter_timeline_shadow (id, run_id, room_day_id, consult_key, start_ms, end_ms, reason_codes, closed_by, jev_used, cache_hit, cache_key, features, created_at)
      VALUES ('tl_test_zz', 'tr_test_01', 'rd_abcd2345', 'zzz_test@mach_test', ${T0}, ${T0 + 1000}, ARRAY['patient_left'], 'patient_left', false, false, 'ck', '[]', '2026-10-18T05:59:00Z');`);
    const sqlText = readFileSync("lib/spine/ingest-store.ts", "utf8").match(/timeline: \{[\s\S]*?sql: `([\s\S]*?)`,/)![1].replace("${READ_LIMIT}", "1");
    const rows = await q(sqlText.replace("$1::bigint", `'${NOW - 72 * 3_600_000}'::bigint`));
    expect(rows.map((r) => r.consult_key)).toEqual(["zzz_test@mach_test"]);
  });
  it("RACE: 8 concurrent identical new posts store exactly one row", async () => {
    const s = { proxy: "pqm" as const, source_key: "pqm_race_01", room_id: "room_abcd2345", t_open: "2026-10-18T04:00:00.000Z", t_close: "2026-10-18T04:10:00.000Z", observed_at: "2026-10-18T04:20:00.000Z", attrs: {} };
    const res = await Promise.all(Array.from({ length: 8 }, () => storeSignals([s])));
    expect(res.reduce((a, r) => a + r.inserted, 0)).toBe(1);
    expect(await n("source_key = 'pqm_race_01'")).toBe(1);
  });
  it("RACE: two concurrent different changes are both stored (or one is counted as conflict), never a duplicate", async () => {
    const base = { proxy: "pqm" as const, source_key: "pqm_race_01", room_id: "room_abcd2345", t_open: "2026-10-18T04:00:00.000Z", observed_at: "2026-10-18T04:20:00.000Z", attrs: {} };
    const before = await n("source_key = 'pqm_race_01'");
    const res = await Promise.all([storeSignals([{ ...base, t_close: "2026-10-18T04:11:00.000Z" }]), storeSignals([{ ...base, t_close: "2026-10-18T04:12:00.000Z" }])]);
    const stored = (await n("source_key = 'pqm_race_01'")) - before;
    expect(res.reduce((a, r) => a + r.duplicate, 0)).toBe(0);
    expect(stored).toBe(res.reduce((a, r) => a + r.inserted, 0));
    expect(stored === 2 || (stored === 1 && res.reduce((a, r) => a + r.conflict, 0) === 1)).toBe(true);
  });
  it("kill_switch: true kills, a jsonb string \"false\" is malformed (killed), a missing table is off", async () => {
    pg.exec(`INSERT INTO spine_config (key, value) VALUES ('kill_switch', '"false"');`);
    expect(await readIngestMode()).toBe("off");
    pg.exec(`INSERT INTO spine_config (key, value) VALUES ('kill_switch', 'false') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`);
    expect(await readIngestMode()).toBe("shadow");
    pg.exec(`INSERT INTO spine_config (key, value) VALUES ('kill_switch', 'true') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`);
    expect(await readIngestMode()).toBe("off");
    pg.exec(`ALTER TABLE spine_config RENAME TO spine_config_x;`);
    expect(await readIngestMode()).toBe("off");
    pg.exec(`ALTER TABLE spine_config_x RENAME TO spine_config;`);
  });
  it("R3 F4: two acoustic runs with ONE created_at -> the greater id wins (stable); a smoother_version argument filters like readLatestAcousticRun, none = no filter", async () => {
    const hyp = (id: string, run: string) => `('${id}', '${run}', 'rd_bcdefghj', ${T0}, ${T0 + 600000}, 1, 0, 0, 0, 0, 'non_speech', 1)`;
    pg.exec(`
      INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_bcdefghj', 'room_abcd2345', '2026-10-17');
      INSERT INTO encounter_hypothesis_run (id, room_day_id, smoother_version, gate_version, probes_total, probes_speech, probes_non_speech, probes_unjudged, n_hypotheses, source, created_at)
        VALUES ('hr_tie_a', 'rd_bcdefghj', 'sv1', 'gv', 1, 1, 0, 0, 1, 'acoustic', '2026-10-18T04:00:00Z'),
               ('hr_tie_b', 'rd_bcdefghj', 'sv2', 'gv', 1, 1, 0, 0, 1, 'acoustic', '2026-10-18T04:00:00Z');
      INSERT INTO encounter_hypothesis (id, run_id, room_day_id, start_ms, end_ms, speech_probes, non_speech_probes, unjudged_ms, longest_unjudged_run_ms, dead_mic_ms, closed_by, merged_from)
        VALUES ${hyp("eh_tiebreakaaaa", "hr_tie_a")}, ${hyp("eh_tiebreakbbbb", "hr_tie_b")};
    `);
    const ids = async (v?: string) => (await readHypothesesSince(T0 - 1000, 100, v)).filter((r) => r.room_day_id === "rd_bcdefghj").map((r) => r.run_id);
    for (let i = 0; i < 3; i++) expect(await ids()).toEqual(["hr_tie_b"]);
    expect(await ids("sv1")).toEqual(["hr_tie_a"]);
    expect(await ids("sv2")).toEqual(["hr_tie_b"]);
    expect(await ids("nope")).toEqual([]);
    expect(await readHypothesesSince(T0 - 1000, 100, "bad version!")).toEqual([]);
  });
});
