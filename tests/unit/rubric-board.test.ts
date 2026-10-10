/**
 * S7-1B — doctor / room boards over stored rubric results. sql and the warehouse are FAKES: nothing here touches a database, Metabase or a model.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

type Row = Record<string, unknown>;
const statements: Array<{ text: string; values: unknown[] }> = [];
let resultRows: Row[] = [];
let blindCount = 0;
let windowRows: Row[] = [];
vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    statements.push({ text, values });
    if (/count\(\*\)/.test(text) && /FROM rubric_result/.test(text)) return [{ n: blindCount }];
    if (/FROM rubric_result/.test(text)) return resultRows;
    if (/FROM eta_encounter_windows/.test(text)) return windowRows;
    return [];
  },
}));
let override: Record<string, unknown> | null = null;
vi.mock("@/lib/rubrics/registry", async (orig) => {
  const m = (await orig()) as { getRubric: (id: string) => unknown };
  return { ...m, getRubric: (id: string) => (override ?? m.getRubric(id)) };
});
const REC = await import("@/lib/rubrics/evr/record");
const { buildBoard } = await import("@/lib/rubrics/board");
const { BLIND_ROOM_DAYS } = await import("@/lib/rubrics/blind-room-days");
const { findBanned } = await import("@/lib/rubrics/engines/evr");
const S = await import("@/lib/mcp/surface");

const UID = (n: number) => `PrescUid${String(n).padStart(2, "0")}AaaaaaaaaaaaaZ`.slice(0, 24).padEnd(24, "A");
const { FORMER_BLIND_PAIRS } = await import("../support/former-blind-pairs");
const [BD, BR] = FORMER_BLIND_PAIRS[0]!;
const warehouse: string[] = [];
const EVEN = "docEvenAaaaaaaaaaaaaaaaaaa", ODD = "docOddAaaaaaaaaaaaaaaaaaaa"; // opaque doctor ids
const mk = (n: number, o: Row = {}): Row => ({ unit_key: `k${n}`, unit_kind: "consult", version: "0.1.0", room_id: "r1", ist_date: "2026-10-05", score: { label: "discrepancy report", severity: "none", n_findings: 0 }, findings: [], ...o });
const win = (n: number): Row => ({ consult_key: `k${n}`, warehouse_prescription_uid: UID(n) });
const ARGS = { rubric_id: "encounter_vs_record", from: "2026-10-01", to: "2026-10-08", lab: true };

beforeEach(() => {
  statements.length = 0; warehouse.length = 0; resultRows = []; windowRows = []; blindCount = 0; override = null;
  REC.setMetabaseForTests(async (q) => { warehouse.push(q); return [...q.matchAll(/'([A-Za-z0-9]{20,40})'/g)].map((m) => ({ rec_uid: m[1], doctor_uid: DOCTOR_OF(m[1]!) })); });
});
const DOCTOR_OF = (rec: string): string | null => (rec === UID(9) ? null : Number(rec.slice(8, 10)) % 2 === 0 ? EVEN : ODD);

describe("guards", () => {
  it("a draft rubric without lab:true is refused rubric_not_production with ZERO queries (database and warehouse)", async () => {
    expect(await buildBoard({ ...ARGS, lab: false })).toMatchObject({ ok: false, error: "rubric_not_production" });
    expect(statements).toEqual([]);
    expect(warehouse).toEqual([]);
  });
  it("by=doctor needs a consult rubric: refused for a room-hour rubric, 0 queries; bad dates and a range over 92 days are refused", async () => {
    expect(await buildBoard({ rubric_id: "room_mic_quality", from: "2026-10-01", to: "2026-10-08", lab: true, by: "doctor" })).toMatchObject({ ok: false, error: "board_by_doctor_needs_consult" });
    expect(statements).toEqual([]);
    expect(await buildBoard({ ...ARGS, from: "2026-10-09", to: "2026-10-01" })).toMatchObject({ ok: false, error: "bad_date" });
    expect(await buildBoard({ ...ARGS, from: "2026-01-01", to: "2026-10-01" })).toMatchObject({ ok: false, error: "range_too_long" });
    expect(await buildBoard({ ...ARGS, from: "2026-07-01", to: "2026-09-30" })).toMatchObject({ ok: true }); // 92 days exactly
  });
  it("a filter naming a formerly held-out (room, day) is served (queried), like the same room on another day (rule lifted 10 Oct 2026)", async () => {
    expect(BLIND_ROOM_DAYS).toHaveLength(0);
    expect(await buildBoard({ ...ARGS, from: BD, to: BD, room: BR })).toMatchObject({ ok: true });
    expect(statements.some((s) => /FROM rubric_result/.test(s.text))).toBe(true);
    expect(await buildBoard({ ...ARGS, from: "2026-10-01", to: "2026-10-01", room: BR })).toMatchObject({ ok: true });
  });
  it("the NOT EXISTS exclusion stays in the query but is passed EMPTY arrays (the former 14 pairs are not excluded); the count is reported in board_meta.n_blind_excluded", async () => {
    blindCount = 3;
    resultRows = [mk(1)];
    const out = await buildBoard({ ...ARGS, by: "room" });
    const q = statements.find((s) => /FROM rubric_result/.test(s.text) && !/count\(\*\)/.test(s.text))!;
    expect(q.text).toMatch(/NOT EXISTS[\s\S]*unnest[\s\S]*b\.d = rubric_result\.ist_date AND b\.r2 = rubric_result\.room_id[\s\S]*unit_kind = 'room_hour'[\s\S]*split_part/);
    expect(q.text.indexOf("NOT EXISTS")).toBeLessThan(q.text.indexOf("LIMIT"));
    expect(q.values).toContainEqual([]);
    for (const [d, r] of FORMER_BLIND_PAIRS) expect(q.values.some((v) => Array.isArray(v) && ((v as unknown[]).includes(d) || (v as unknown[]).includes(r)))).toBe(false);
    expect(out).toMatchObject({ ok: true, board_meta: { n_blind_excluded: 3 } });
  });
});

describe("the board", () => {
  it("by=doctor: ONE read-only warehouse SELECT per board call (uids validated), groups by the opaque doctor id, unattributed counted and never dropped, no ranking", async () => {
    resultRows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => mk(n, { score: { label: "discrepancy report", severity: n % 3 === 0 ? "obvious" : "none", n_findings: n % 3 === 0 ? 1 : 0 }, findings: n % 3 === 0 ? ["obvious:in_record_not_said:drug"] : [] }));
    windowRows = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(win); // k10 has no window: unresolved
    const out = await buildBoard({ ...ARGS, by: "doctor", min_n: 3 });
    expect(warehouse).toHaveLength(1);
    expect(warehouse[0]).toMatch(/^SELECT /);
    expect(warehouse[0]).toMatch(/type = 'EMR_2_GENERATED' AND p\.is_draft = false/);
    expect(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i.test(warehouse[0]!)).toBe(false);
    expect(warehouse[0]).toContain(UID(9)); // k9 is asked for (its record names no doctor) and lands in the unattributed bucket with k10 (no window)
    if (!out.ok) throw new Error("expected ok");
    expect(out.board_meta).toMatchObject({ rubric_id: "encounter_vs_record", by: "doctor", lab: true, n_rows: 10, n_unattributed: 2, status: "draft", note: "not for decisions", label: "discrepancy report" });
    const ids = out.groups.map((g) => g.group);
    expect(ids).toEqual([...ids].sort()); // sorted by the opaque id, never by severity
    const un = out.groups.find((g) => g.group === "unattributed")!;
    expect(un).toMatchObject({ n_units: 2, unattributed: true });
    expect(un.levels).toBeUndefined(); // counted, no distributions
    const even = out.groups.find((g) => g.group === EVEN)!;
    expect(even).toMatchObject({ n_units: 4 });
    const sev = (even.levels as Record<string, Record<string, number>>).severity!;
    expect(Object.keys(sev)).toEqual(["material", "minor", "none", "obvious"]); // all four, zero-filled, alphabetical (not ranked)
    expect(JSON.stringify(out)).not.toMatch(/name|Dr |doctor_name/i);
  });
  it("min_n hides the distributions of a small group (n only, below_min_n) and the floor is 3 whatever is asked", async () => {
    resultRows = [1, 2, 3, 4].map((n) => mk(n, { room_id: n <= 3 ? "r1" : "r2" }));
    const out = await buildBoard({ ...ARGS, by: "room", min_n: 1 });
    if (!out.ok) throw new Error("x");
    expect(out.board_meta.min_n).toBe(3);
    expect(out.groups.find((g) => g.group === "r2")).toEqual({ group: "r2", version: "0.1.0", n_units: 1, below_min_n: true });
    expect(out.groups.find((g) => g.group === "r1")).toMatchObject({ n_units: 3, levels: expect.any(Object) });
    const out5 = await buildBoard({ ...ARGS, by: "room" });
    if (!out5.ok) throw new Error("x");
    expect(out5.board_meta.min_n).toBe(5);
    expect(out5.groups.every((g) => g.below_min_n === true)).toBe(true);
  });
  it("versions are never mixed: the same group on two rubric versions is two groups; the meta lists the versions seen", async () => {
    resultRows = [1, 2, 3].map((n) => mk(n, { version: "0.1.0" })).concat([4, 5, 6].map((n) => mk(n, { version: "0.2.0" })));
    const out = await buildBoard({ ...ARGS, by: "room", min_n: 3 });
    if (!out.ok) throw new Error("x");
    expect(out.groups.map((g) => [g.group, g.version, g.n_units])).toEqual([["r1", "0.1.0", 3], ["r1", "0.2.0", 3]]);
    expect(out.board_meta.versions).toEqual(["0.1.0", "0.2.0"]);
  });
  it("numeric fields give median / p10 / p90, enum fields a count per level, arrays a count per element, findings a count per code; labels, keys and attempts are skipped", async () => {
    resultRows = [1, 2, 3, 4, 5].map((n) => mk(n, { score: { label: "x", severity: "none", n_findings: n, ratio: n / 10, uptake_codes: n % 2 ? ["accept"] : ["accept", "hedge"], evidence_key: "k", attempts: 1, prompt_version: "1" }, findings: ["minor:said_not_in_record:drug"] }));
    const out = await buildBoard({ ...ARGS, by: "room" });
    if (!out.ok) throw new Error("x");
    const g = out.groups[0]!;
    expect((g.numeric as Record<string, unknown>).ratio).toEqual({ n: 5, median: 0.3, p10: 0.14, p90: 0.46 });
    expect((g.levels as Record<string, Record<string, number>>).uptake_codes).toEqual({ accept: 5, hedge: 2 });
    expect(g.findings).toEqual({ "minor:said_not_in_record:drug": 5 });
    expect(Object.keys(g.levels as object)).not.toEqual(expect.arrayContaining(["label", "evidence_key", "attempts", "prompt_version"]));
  });
  it("a production rubric with lab:false is allowed and carries no draft note; a board over too many rows or signed records is refused", async () => {
    override = { ...(JSON.parse(readFileSync("rubrics/talk_time/rubric.json", "utf8")) as object), status: "production" };
    resultRows = [mk(1, { unit_kind: "window" })];
    const out = await buildBoard({ rubric_id: "talk_time", from: "2026-10-01", to: "2026-10-08", lab: false });
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.board_meta.note).toBeUndefined();
    override = null;
    resultRows = Array.from({ length: 5001 }, (_, i) => mk(i));
    expect(await buildBoard({ ...ARGS, by: "room" })).toMatchObject({ ok: false, error: "board_too_large" });
  });
  it("V1 — more than 1500 signed records is board_too_large with ZERO warehouse calls; exactly 1500 still makes the one SELECT", async () => {
    const MAX = REC.BOARD_MAX_UIDS;
    expect(MAX).toBe(1500);
    resultRows = Array.from({ length: MAX + 1 }, (_, i) => mk(i + 1));
    windowRows = Array.from({ length: MAX + 1 }, (_, i) => win(i + 1));
    expect(await buildBoard({ ...ARGS, by: "doctor", min_n: 3 })).toMatchObject({ ok: false, error: "board_too_large" });
    expect(warehouse).toEqual([]); // refused before the warehouse is asked
    resultRows = resultRows.slice(0, MAX);
    windowRows = windowRows.slice(0, MAX);
    const ok = await buildBoard({ ...ARGS, by: "doctor", min_n: 3 });
    expect(ok.ok).toBe(true);
    expect(warehouse).toHaveLength(1);
  });
  it("the board never fetches evidence (no lab-store read) and reads no transcript text", () => {
    const src = readFileSync("lib/rubrics/board.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(/readEvidence|labStore|include_text|payload|transcript/.test(src)).toBe(false);
  });
});

describe("the warehouse SELECT", () => {
  it("validates every uid, caps the count, is a SELECT with the two measured filters and selects ids only (no name column)", () => {
    const q = REC.doctorsSql([UID(1), UID(2)]);
    expect(q).toMatch(/^SELECT p\.uid AS rec_uid, p\.doctor_uid AS doctor_uid/);
    expect(q).toContain("p.type = 'EMR_2_GENERATED' AND p.is_draft = false");
    expect(q).not.toMatch(/name|doctors d|JOIN/i);
    for (const bad of ["short", `${UID(1)}'; DROP TABLE x; --`, "x".repeat(41)]) expect(() => REC.doctorsSql([bad]), bad).toThrow(/bad_prescription_uid/);
    expect(() => REC.doctorsSql([])).toThrow(/bad_uid_count/);
    expect(() => REC.doctorsSql(Array.from({ length: REC.BOARD_MAX_UIDS + 1 }, (_, i) => `A${String(i).padStart(24, "0")}`))).toThrow(/bad_uid_count/);
  });
});

describe("wording", () => {
  it("no accusing word in any board output, the board module, or the tool description / schema; an injected word is caught", async () => {
    resultRows = [1, 2, 3, 4, 5].map((n) => mk(n));
    windowRows = [1, 2, 3, 4, 5].map(win);
    const out = await buildBoard({ ...ARGS, by: "doctor" });
    const tool = S.CALLABLE_TOOLS.get("scribe_rubric")!;
    const texts = [JSON.stringify(out), readFileSync("lib/rubrics/board.ts", "utf8").replace(/BANNED[^\n]*/g, ""), tool.description, JSON.stringify(tool.inputSchema)];
    for (const t of texts) expect(findBanned(t), t.slice(0, 40)).toEqual([]);
    for (const t of texts) expect(findBanned(`${t} fraud`)).toEqual(["fraud"]);
    expect(tool.description).toMatch(/board/);
    expect(tool.description).toMatch(/no ranking, no verdict/);
  });
});
