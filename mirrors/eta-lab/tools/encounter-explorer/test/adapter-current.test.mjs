import test from "node:test";
import assert from "node:assert/strict";
import { createAdapter } from "../src/adapter.js";
import { createCurrentImpl, TOOLS } from "../src/adapter-current.js";
import { unwrap } from "../src/mcp-call.js";
import { makeMockMcp } from "./mock-scribe.mjs";
import { payloads } from "./helpers.mjs";

const mk = (opts, caps = {}) => { const mcp = makeMockMcp(payloads(), opts); return { mcp, a: createAdapter(createCurrentImpl({ mcp, ...caps })) }; };
const Q = { from: "2026-09-09", to: "2026-09-11" };

test("listDays groups consults by doctor-day and measures completeness", async () => {
  const { a } = mk();
  const r = await a.listDays(Q);
  assert.equal(r.ok, true);
  const d = r.data;
  assert.deepEqual(d.dates, ["2026-09-09", "2026-09-10", "2026-09-11"]);
  const cell = d.cells.find(c => c.doctorId === "syn_d001" && c.date === "2026-09-09");
  assert.equal(cell.consults, 2);
  assert.ok(cell.completeness > 0 && cell.completeness <= 1);
  // c004 has no freescript row, so no doctor: it falls back to its room
  assert.ok(d.cells.find(c => c.doctorId === "room:room_syn02" && c.date === "2026-09-10"));
  assert.equal(r.storedAt, 1760000000000);
});

test("2026-09-09 floor: earlier dates never reach the tools", async () => {
  const { a, mcp } = mk();
  const r = await a.listDays({ from: "2026-09-01", to: "2026-09-10" });
  assert.equal(r.data.dates[0], "2026-09-09");
  assert.ok(mcp.calls.every(c => !c.args.ist_date || c.args.ist_date >= "2026-09-09"));
  assert.ok(mcp.calls.every(c => !c.args.from || c.args.from >= "2026-09-09"));
  const before = mcp.calls.length;
  const none = await a.listDays({ from: "2026-08-01", to: "2026-09-08" });
  assert.deepEqual(none.data.cells, []);
  assert.equal(mcp.calls.length, before);
  assert.deepEqual((await a.listConsults({ doctorId: "syn_d001", date: "2026-09-08" })).data, []);
});

test("reb_index pagination follows next_cursor", async () => {
  const { a, mcp } = mk({ pageSize: 2 });
  const r = await a.listConsults({ doctorId: "syn_d001", date: "2026-09-09" });
  assert.equal(r.data.length, 2);
  const reb = mcp.calls.filter(c => c.tool === "scribe_reb_index" && c.args.ist_date === "2026-09-09");
  assert.ok(reb.length > 1);
  assert.equal(reb[0].args.cursor, undefined);
  assert.equal(reb[1].args.cursor, 2);
});

test("rubric results match by unit_key prefix before @", async () => {
  const { a } = mk();
  const c = (await a.getConsult("syn_c001")).data;
  assert.equal(c.pdqi.id, "pdqi9");
  assert.deepEqual(c.rubrics.map(r => r.id), ["syn_rubric_a"]);
  assert.equal(c.stages.rubrics.state, "done");
  const none = (await a.getConsult("syn_c004")).data;
  assert.equal(none.pdqi, null);
  assert.equal(none.stages.rubrics.state, "missing");
});

test("detail: ledger, validator, jev, rx link, missing sources stay null", async () => {
  const { a } = mk();
  const c = (await a.getConsult("syn_c001")).data;
  assert.equal(c.transcript, null);
  assert.equal(c.cdmss, null);
  assert.equal(c.doctor_name, null);
  assert.equal(c.rx.link, "https://pulse.even.in/prescription?prescription_uid=syn_rx_001&individual_uid=syn_p001");
  assert.equal(c.rx.signedText, null);
  assert.equal(c.note.validator.ok, true);
  assert.equal(c.jev.length, 2);
  assert.equal(c.jev[0].probability, 0.82);
  assert.ok(c.ledger.some(l => l.step.includes("shadow")));
  assert.ok(c.ledger.some(l => l.step === "freescript" && l.model === "syn-llm-1"));
  const bad = (await a.getConsult("syn_c003")).data;
  assert.equal(bad.note.validator.ok, false);
  assert.equal(bad.stages.validator.state, "failed");
  assert.equal(bad.rx.link, null);
  assert.equal(bad.rx.prescriptionUid, null);
});

test("summaries carry the catalog row field names; stages is a map of {state, reason}", async () => {
  const { a } = mk();
  const c = (await a.getConsult("syn_c004")).data;
  for (const k of ["consult_uid", "ist_date", "doctor_uid", "room_id", "t_open", "t_close", "source", "clip", "layers", "freescript", "stages", "first_gap", "allowance", "prescription", "doctor_name", "patient_name", "individual_uid", "prescription_uid", "catalog_version", "generated_at"]) assert.ok(k in c, k);
  assert.equal(c.consult_uid, "syn_c004");
  assert.equal(c.ist_date, "2026-09-10");
  assert.equal(c.doctor_uid, null);
  assert.equal(typeof c.t_open, "number");
  assert.deepEqual(c.stages.diar, { state: "failed", reason: "synthetic: no speakers found" });
  assert.equal(c.first_gap, "diar:synthetic: no speakers found");
  assert.deepEqual(c.stages.jev, { state: "missing", reason: null });   // detail read the decision log: zero rows
  assert.deepEqual(c.stages.cdmss, { state: "na", reason: null });      // no live source: unknown, never a gap
  const full = (await a.getConsult("syn_c001")).data;
  assert.equal(full.first_gap, null);
  const day = (await a.listConsults({ doctorId: "syn_d001", date: "2026-09-09" })).data;
  assert.deepEqual(day[0].stages.jev, { state: "na", reason: null });   // the list does not read decisions
  assert.equal(full.prescription.prescription_uid, "syn_rx_001");
  assert.equal(full.prescription_uid, "syn_rx_001");
  assert.equal(full.individual_uid, "syn_p001");
});

test("consult without any source rows is not_found, not a throw", async () => {
  const { a } = mk();
  const r = await a.getConsult("syn_nope");
  assert.equal(r.ok, false);
  assert.equal(r.code, "not_found");
});

test("filters: room, specialty, hasRx", async () => {
  const { a } = mk();
  const rx = (await a.listDays({ ...Q, hasRx: true })).data;
  assert.ok(rx.cells.every(c => c.hasRx));
  const room = (await a.listDays({ ...Q, room: "room_syn02" })).data;
  assert.equal(room.cells.length, 2);
  assert.deepEqual(room.doctors.map(d => d.doctorId).sort(), ["room:room_syn02", "syn_d002"]);
  const sp = (await a.listDays({ ...Q, specialty: "Synthetic Cardiology" })).data;
  assert.ok(sp.cells.length > 0 && sp.cells.every(c => c.doctorId === "syn_d001"));
  assert.ok(sp.rooms.includes("room_syn02"), "options come from unfiltered data");
});

test("defensive parsing: nulls, missing fields, unknown keys, junk rows", async () => {
  const P = payloads();
  P.reb.rows.push({ window_id: null }, null, 5, { window_id: "consult-syn_c777", ist_date: "2026-09-10", layer: "stt", status: null, t0_ms: "x", t1_ms: null, room_id: null });
  P.fs.rows.push({ consult_uid: "syn_c778", ist_date: "2026-09-10", validator: null, completion_required: null, artifact: { encounter: null, pulse_link: null, note_text: 3 } });
  P.rub.results.push({ unit_key: null }, { rubric_id: "x", unit_key: "syn_c777" });
  const mcp = makeMockMcp(P);
  const a = createAdapter(createCurrentImpl({ mcp }));
  const day = await a.listConsults({ doctorId: "room:room_syn02", date: "2026-09-10" });
  assert.equal(day.ok, true);
  const odd = (await a.getConsult("syn_c778")).data;
  assert.equal(odd.note.validator.ok, null);
  assert.equal(odd.note.noteText, null);
  assert.equal(odd.lengthSec, null);
  assert.equal(odd.rx.link, null);
  const c777 = (await a.getConsult("syn_c777")).data;
  assert.equal(c777.lengthSec, null);
  assert.equal(c777.stages.stt.state, "pending");
});

test("tool failures become results, mcp null is 'not connected'", async () => {
  const { a } = mk({ failWith: "needs_reauth" });
  const r = await a.listDays(Q);
  assert.deepEqual([r.ok, r.code], [false, "needs_reauth"]);
  const none = createAdapter(createCurrentImpl({ mcp: null }));
  assert.equal((await none.listDays(Q)).code, "server_not_connected");
});

test("S1: a retryable error is retried at most once per operation, not per call", async () => {
  let n = 0;
  const flaky = { async callTool() { n++; throw { code: "server_unavailable", message: "x", retryable: true, retryAfterMs: 1 }; } };
  const f = createAdapter(createCurrentImpl({ mcp: flaky }));
  const r = await f.listDays({ from: "2026-09-09", to: "2026-09-11" });
  assert.equal(r.ok, false);
  assert.ok(n <= 9 + 1, "calls " + n);   // 3 days x 3 tools start in parallel; the shared budget allows ONE retry in all
  let m = 0;
  const once = { async callTool() { if (++m === 1) throw { code: "rate_limited", message: "x", retryable: true, retryAfterMs: 1 }; return { structuredContent: { ok: true, rows: [], next_cursor: null, results: [] } }; } };
  assert.equal((await createAdapter(createCurrentImpl({ mcp: once })).listDays({ from: "2026-09-09", to: "2026-09-09" })).ok, true);
  let k = 0;
  const hard = { async callTool() { k++; throw { code: "needs_reauth", message: "x", retryable: false }; } };
  assert.equal((await createAdapter(createCurrentImpl({ mcp: hard })).listDays({ from: "2026-09-09", to: "2026-09-09" })).code, "needs_reauth");
  assert.ok(k <= 3, "no retry for a non-retryable code, calls " + k);
});

test("only read actions are ever sent", async () => {
  const { a, mcp } = mk();
  await a.listDays(Q); await a.getConsult("syn_c001");
  for (const c of mcp.calls) {
    assert.equal(c.server, "Scribe MCP");
    assert.ok(TOOLS.includes(c.tool));
    if (c.tool === "scribe_freescript") assert.equal(c.args.action, "read");
    if (c.tool === "scribe_rubric") assert.equal(c.args.action, "results");
  }
});

test("unwrap prefers structuredContent, then payload, then JSON text", () => {
  assert.deepEqual(unwrap({ structuredContent: { a: 1 }, content: [] }), { a: 1 });
  assert.deepEqual(unwrap({ payload: { b: 2 } }), { b: 2 });
  assert.deepEqual(unwrap({ content: [{ type: "text", text: '{"c":3}' }] }), { c: 3 });
  assert.equal(unwrap({ content: [{ type: "text", text: "nope" }] }), null);
  assert.equal(unwrap(null), null);
});

test("notes: db doc path, fields, ids only; no db is an error result", async () => {
  const store = new Map();
  const db = { doc: p => ({ get: async () => ({ exists: store.has(p), data: () => store.get(p) }), set: async d => { store.set(p, d); } }) };
  const { a } = mk({}, { db, userId: async () => "u_syn_1" });
  assert.equal((await a.notes.get("syn_c001")).data, null);
  assert.equal((await a.notes.set("syn_c001", "hello")).ok, true);
  const doc = store.get("notes/syn_c001");
  assert.deepEqual(Object.keys(doc).sort(), ["text", "updated_at", "updated_by"]);
  assert.equal(doc.updated_by, "u_syn_1");
  assert.equal((await a.notes.get("syn_c001")).data.text, "hello");
  const { a: nodb } = mk();
  assert.equal((await nodb.notes.set("x", "y")).ok, false);
});
