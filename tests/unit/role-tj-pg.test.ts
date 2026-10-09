/**
 * ROLE-TJ on a real postgres:16 (reb_track_index, ALL migrations) with an in-memory lab store: the reader of palimpsest's role.text-judge layer (doctor / patient / attendant by text), built against fixtures.
 * Rules: newest text-judge row decides (skipped / failed -> all unknown); key ownership + sha256 as text tracks; derived_from.stt = the stt track used (translate: the index's stt track); abstain / unknown -> unknown;
 * doctor -> clinician side, patient + attendant -> patient side (attendant flagged); translate maps by >= 50% tape overlap; engine sarvam-doctor-map never read; switch off = today's output.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v), { transaction: async () => [] }) }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-role-tj");
const sha = (b: string) => createHash("sha256").update(b, "utf8").digest("hex");
const UID = "CUidAaaaaaaaaaaaaaaaaaaaaaaaaaaaa1", OTHER_UID = "CUidBbbbbbbbbbbbbbbbbbbbbbbbbbbbb2", ROOM = "r_clean", DATE = "2026-10-05";
const keyOf = (name: string, uid = UID, room = ROOM) => `reb/${DATE}/${room}/_consults/${uid}/tracks/${name}.json`;
const span = { consult_key: "k", consult_uid: UID, room_id: ROOM, t_open_ms: 0, t_close_ms: 100_000, ist_date: DATE, quality: "clean", attribution: "x", windows: [] };

const mem = new Map<string, string>();
const gets: string[] = [];
let n = 0;
/** put a track in the store and the index; `ago` orders finished_at (bigger = older) */
function put(layer: string, engine: string, name: string, doc: unknown, o: { status?: string; ago?: number; key?: string; indexSha?: string; uid?: string } = {}): { sha: string; key: string } {
  const body = JSON.stringify(doc);
  const key = o.key ?? keyOf(name);
  mem.set(key, body);
  const s = o.indexSha ?? sha(body);
  pg.exec(`INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, status, r2_key, sha256, finished_at)
           VALUES ('consult-${o.uid ?? UID}', '${DATE}', '${ROOM}', '${layer}', '${engine}', 'v${++n}', 'abcd1234', '${o.status ?? "ok"}', '${key}', '${s}', now() - interval '${o.ago ?? 0} minutes')`);
  return { sha: s, key };
}
const seg = (t0: number, t1: number, speaker: string, text: string) => ({ t0_ms: t0, t1_ms: t1, speaker, lang: "en-IN", text });
const STT = { layer: "stt", status: "ok", segments: [seg(0, 4000, "SPEAKER_00", "a"), seg(4000, 8000, "SPEAKER_01", "b"), seg(8000, 12000, "SPEAKER_02", "c"), seg(12000, 16000, "SPEAKER_03", "d"), seg(16000, 20000, "SPEAKER_04", "e"), seg(20000, 24000, "SPEAKER_05", "f")] };
const roleDoc = (derived: string | null, speakers: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ layer: "role", engine: "text-judge", status: "ok", extras: { derived_from: { stt: derived } }, speakers, ...over });
const SPK = {
  SPEAKER_00: { role: "doctor", confidence: 0.9, abstain: false }, SPEAKER_01: { role: "patient", confidence: 0.8, abstain: false }, SPEAKER_02: { role: "attendant", confidence: 0.7, abstain: false },
  SPEAKER_03: { role: "doctor", confidence: 0.2, abstain: true }, SPEAKER_04: { role: "unknown", confidence: 0.1, abstain: false },
};
const who = (r: { found: { lines: Array<{ speaker: string; speaker_idx: number | null; attendant?: true }>; turns: Array<{ role: string | null; attendant?: true }> } | null }) => (r.found?.lines ?? []).map((l, i) => `${l.speaker}${l.attendant ? "+att" : ""}/${r.found!.turns[i]!.role ?? "-"}`);
const ALL_UNKNOWN = ["unknown/-", "unknown/-", "unknown/-", "unknown/-", "unknown/-", "unknown/-"];
const WITH_ROLES = ["doctor/clinician", "other/-", "other+att/-", "unknown/-", "unknown/-", "unknown/-"]; // SPEAKER_05 is not in the role row

let read: (opts?: { roleTextJudge?: boolean }) => Promise<Awaited<ReturnType<typeof import("@/lib/room-access/readers/reb-consult").readRebConsult>>>;
beforeAll(async () => {
  if (!HAVE) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); });
beforeEach(async () => {
  if (!HAVE) return;
  pg.exec("DELETE FROM reb_track_index");
  mem.clear(); gets.length = 0;
  const L = await import("@/lib/sarvam-lab");
  L.setLabStoreForTests({ get: async (k) => { gets.push(k); return mem.has(k) ? { body: mem.get(k)!, etag: "e" } : null; }, put: async () => "ok", list: async () => [] });
  const R = await import("@/lib/room-access/readers/reb-consult");
  read = (opts) => R.readRebConsult(span as never, opts);
});
afterEach(async () => { if (HAVE) (await import("@/lib/sarvam-lab")).setLabStoreForTests(null); });

(HAVE ? describe : describe.skip)("ROLE-TJ: stt text track", () => {
  it("the switch is a const, false by default; with it false the role layer is not even queried and the output is today's (a role row present changes nothing)", async () => {
    const R = await import("@/lib/room-access/readers/reb-consult");
    expect(R.ROLE_TEXT_JUDGE_ENABLED).toBe(false);
    const stt = put("stt", "sarvam", "stt", STT);
    const before = await read();
    put("role", "text-judge", "role", roleDoc(stt.sha, SPK));
    const off = await read();
    expect(who(off)).toEqual(ALL_UNKNOWN);
    expect(off).toEqual(before);
    expect(gets.some((k) => k.includes("role"))).toBe(false);
  });

  it("on: doctor -> clinician side; patient and attendant -> patient side (attendant flagged); abstain, role unknown and a speaker not in the row -> unknown", async () => {
    const stt = put("stt", "sarvam", "stt", STT);
    put("role", "text-judge", "role", roleDoc(stt.sha, SPK));
    const r = await read({ roleTextJudge: true });
    expect(who(r)).toEqual(WITH_ROLES);
    expect(r.found!.turns.map((t) => t.speaker_idx)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("the newest text-judge row decides: a newer one with other roles wins over an older ok one; a newer skipped / failed / empty makes everything unknown", async () => {
    const stt = put("stt", "sarvam", "stt", STT);
    put("role", "text-judge", "role-old", roleDoc(stt.sha, { SPEAKER_00: { role: "patient", abstain: false } }), { ago: 30 });
    put("role", "text-judge", "role-new", roleDoc(stt.sha, SPK), { ago: 10 });
    expect(who(await read({ roleTextJudge: true }))).toEqual(WITH_ROLES);
    for (const status of ["skipped", "failed", "empty"]) {
      put("role", "text-judge", `role-${status}`, roleDoc(stt.sha, SPK), { status, ago: 1 });
      expect(who(await read({ roleTextJudge: true })), status).toEqual(ALL_UNKNOWN);
      pg.exec(`DELETE FROM reb_track_index WHERE status = '${status}'`);
    }
  });

  it("derived_from.stt must equal the stt track used; a mismatch (or none) -> all unknown", async () => {
    const stt = put("stt", "sarvam", "stt", STT);
    put("role", "text-judge", "role", roleDoc("0".repeat(64), SPK));
    expect(who(await read({ roleTextJudge: true }))).toEqual(ALL_UNKNOWN);
    pg.exec("DELETE FROM reb_track_index WHERE layer = 'role'");
    put("role", "text-judge", "role2", roleDoc(null, SPK));
    expect(who(await read({ roleTextJudge: true }))).toEqual(ALL_UNKNOWN);
    pg.exec("DELETE FROM reb_track_index WHERE layer = 'role'");
    put("role", "text-judge", "role3", roleDoc(stt.sha.toUpperCase(), SPK));
    expect(who(await read({ roleTextJudge: true }))).toEqual(WITH_ROLES); // sha compare is case-insensitive, like the index check
  });

  it("engine sarvam-doctor-map is never read: a newer ok doctor-map row is ignored (its object is never fetched); alone it yields all unknown", async () => {
    const stt = put("stt", "sarvam", "stt", STT);
    const map = put("role", "sarvam-doctor-map", "role-map", roleDoc(stt.sha, Object.fromEntries(Object.keys(SPK).map((k) => [k, { role: "doctor", confidence: 1, abstain: false }]))), { ago: 0 });
    expect(who(await read({ roleTextJudge: true }))).toEqual(ALL_UNKNOWN);
    put("role", "text-judge", "role", roleDoc(stt.sha, SPK), { ago: 20 });
    expect(who(await read({ roleTextJudge: true }))).toEqual(WITH_ROLES);
    expect(gets).not.toContain(map.key);
  });

  it("key ownership and sha: a role key of another consult or room, a sha mismatch, a doc that is not ok, an unparseable doc, a missing object -> all unknown", async () => {
    const stt = put("stt", "sarvam", "stt", STT);
    const good = roleDoc(stt.sha, SPK);
    const cases: Array<[string, () => void]> = [
      ["other consult key", () => put("role", "text-judge", "r", good, { key: keyOf("r", OTHER_UID) })],
      ["other room key", () => put("role", "text-judge", "r", good, { key: keyOf("r", UID, "r_other") })],
      ["sha mismatch", () => put("role", "text-judge", "r", good, { indexSha: "1".repeat(64) })],
      ["doc status not ok", () => put("role", "text-judge", "r", { ...good, status: "failed" })],
      ["doc engine is not text-judge", () => put("role", "text-judge", "r", { ...good, engine: "sarvam-doctor-map" })],
      ["not json", () => { const k = keyOf("r"); mem.set(k, "{nope"); pg.exec(`INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, status, r2_key, sha256, finished_at) VALUES ('consult-${UID}', '${DATE}', '${ROOM}', 'role', 'text-judge', 'vx', 'c', 'ok', '${k}', '${sha("{nope")}', now())`); }],
      ["object missing", () => pg.exec(`INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, status, r2_key, sha256, finished_at) VALUES ('consult-${UID}', '${DATE}', '${ROOM}', 'role', 'text-judge', 'vy', 'c', 'ok', '${keyOf("gone")}', '${"2".repeat(64)}', now())`)],
    ];
    for (const [name, make] of cases) {
      pg.exec("DELETE FROM reb_track_index WHERE layer = 'role'");
      make();
      expect(who(await read({ roleTextJudge: true })), name).toEqual(ALL_UNKNOWN);
    }
  });

});

(HAVE ? describe : describe.skip)("ROLE-TJ: translate text track maps to the stt speaker by >= 50% tape overlap", () => {
  const TR = (segs: Array<[number, number]>) => ({ layer: "translate", status: "ok", segments: segs.map(([a, b], i) => seg(a, b, "x", `t${i}`)) });
  // stt: A=SPEAKER_00 [0,4000] doctor, B=SPEAKER_01 [4000,8000] patient, C=SPEAKER_02 [8000,12000] attendant
  const segs: Array<[number, number]> = [[0, 3900], [3500, 5000], [3000, 6000], [7000, 11000], [8000, 12000], [30000, 31000]];
  //   -> A 100% doctor; 3500-5000: A 500, B 1000 = 66% B patient; 3000-6000: A 1000, B 2000 = 66% B patient; 7000-11000: B 1000 / C 3000 = C 75% attendant; C 100% attendant; no overlap -> unknown
  const OVERLAP = ["doctor/clinician", "other/-", "other/-", "other+att/-", "other+att/-", "unknown/-"];
  it("maps each translate segment to the stt speaker it overlaps most, if that is >= 50% of the segment, else unknown; derived_from is the index's stt track", async () => {
    const stt = put("stt", "sarvam", "stt", STT);
    put("translate", "sarvam", "tr", TR(segs));
    put("role", "text-judge", "role", roleDoc(stt.sha, SPK));
    expect(who(await read({ roleTextJudge: true }))).toEqual(OVERLAP);
  });
  it("the threshold is 50% of the translate segment: exactly 50% maps; a best overlap of 33% is unknown", async () => {
    const stt = put("stt", "sarvam", "stt", STT);
    put("translate", "sarvam", "tr", TR([[2000, 10_000], [10_000, 22_000]])); // 2000-10000: A 2000, B 4000 (50%), C 2000 -> B patient; 10000-22000: best 4000 / 12000 = 33% -> unknown
    put("role", "text-judge", "role", roleDoc(stt.sha, SPK));
    expect(who(await read({ roleTextJudge: true }))).toEqual(["other/-", "unknown/-"]);
  });
  it("derived_from must be the stt sha of the same clip: a role row derived from another sha -> all unknown; no stt row in the index -> all unknown", async () => {
    const stt = put("stt", "sarvam", "stt", STT);
    put("translate", "sarvam", "tr", TR(segs));
    put("role", "text-judge", "role", roleDoc("3".repeat(64), SPK));
    expect(who(await read({ roleTextJudge: true }))).toEqual(Array(6).fill("unknown/-"));
    pg.exec("DELETE FROM reb_track_index WHERE layer IN ('stt', 'role')");
    put("role", "text-judge", "role2", roleDoc(stt.sha, SPK));
    expect(who(await read({ roleTextJudge: true }))).toEqual(Array(6).fill("unknown/-"));
  });
  it("the stt track of the clip is sha-checked too: a corrupted stt object -> all unknown", async () => {
    const stt = put("stt", "sarvam", "stt", STT, { indexSha: "4".repeat(64) });
    put("translate", "sarvam", "tr", TR(segs));
    put("role", "text-judge", "role", roleDoc(stt.sha, SPK));
    expect(who(await read({ roleTextJudge: true }))).toEqual(Array(6).fill("unknown/-"));
  });
  it("switch off: the translate output is today's (speaker labels only), role row or not", async () => {
    const stt = put("stt", "sarvam", "stt", STT);
    put("translate", "sarvam", "tr", TR(segs));
    const a = await read();
    put("role", "text-judge", "role", roleDoc(stt.sha, SPK));
    expect(await read()).toEqual(a);
    expect(who(a)).toEqual(Array(6).fill("unknown/-"));
  });
});
