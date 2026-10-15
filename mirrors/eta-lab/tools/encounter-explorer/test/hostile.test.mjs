// Fixes from refute round 1 (B1, S1-S6, nits): one test per finding. Synthetic payloads only.
import test from "node:test";
import assert from "node:assert/strict";
import { createAdapter } from "../src/adapter.js";
import { createCurrentImpl, createNotes, validUid } from "../src/adapter-current.js";
import { istTimeOf, toEpochMs } from "../src/util.js";
import { makeMockMcp } from "./mock-scribe.mjs";
import { payloads } from "./helpers.mjs";

const day = "2026-09-09";
const mk = (P, opts) => { const mcp = makeMockMcp(P, opts); return { mcp, a: createAdapter(createCurrentImpl({ mcp })) }; };
const row = (o) => ({ id: 9000 + Math.floor(Math.random() * 1e6), window_id: "consult-syn_h1", ist_date: day, room_id: "room_syn01", layer: "stt", status: "ok", shadow: false, ...o });

test("B1: t0_ms beyond the Date range never throws; the time is simply unknown", async () => {
  assert.equal(istTimeOf(9e15), null);
  assert.equal(istTimeOf(NaN), null);
  assert.equal(istTimeOf(undefined), null);
  for (const bad of [9e15, 1e300, Infinity, NaN, -5, 1e12, "x", null]) assert.equal(toEpochMs(bad, day), null, String(bad));
  assert.equal(toEpochMs(5 * 3600000, day), Date.parse(day + "T00:00:00Z") - 19800000 + 5 * 3600000);
  const P = payloads(); P.reb.rows.push(row({ t0_ms: 9e15, t1_ms: 9.1e15 }));
  const { a } = mk(P);
  const l = await a.listConsults({ doctorId: "room:room_syn01", date: day });
  assert.equal(l.ok, true);
  const h1 = l.data.find(c => c.consult_uid === "syn_h1");
  assert.deepEqual([h1.t_open, h1.t_close, h1.lengthSec], [null, null, null]);
  assert.equal((await a.getConsult("syn_h1")).ok, true);
});

test("S2: a repeated or backwards cursor stops the paging, and duplicate rows count once", async () => {
  const P = payloads();
  const base = P.reb.rows.filter(r => r.ist_date === day);
  let calls = 0;
  const mcp = { async callTool(s, t, args) {
    if (t !== "scribe_reb_index") return makeMockMcp(P).callTool(s, t, args);
    calls++;
    return { structuredContent: { ok: true, rows: base, next_cursor: 7 } };   // same page and same cursor, forever
  } };
  const a = createAdapter(createCurrentImpl({ mcp }));
  const r = await a.listDays({ from: day, to: day });
  assert.equal(r.ok, true);
  assert.ok(calls <= 3, "paging stopped, calls " + calls);
  assert.equal(r.data.truncated, true);
  const c = (await a.getConsult("syn_c001")).data;
  assert.equal(c.ledger.filter(l => l.step.startsWith("stt") && !l.step.includes("shadow")).length, 1, "rows de-duplicated by id");
  const back = { async callTool(s, t, args) { if (t !== "scribe_reb_index") return makeMockMcp(P).callTool(s, t, args); calls += 100; return { structuredContent: { ok: true, rows: [], next_cursor: (args.cursor ?? 10) - 1 } }; } };
  const before = calls;
  await createAdapter(createCurrentImpl({ mcp: back })).listDays({ from: day, to: day });
  assert.ok(calls - before <= 200, "backwards cursor stops");
});

test("S5: only plain uids reach a db path or the tools", async () => {
  assert.ok(validUid("syn_c001") && validUid("A-b_9"));
  for (const bad of ["a/b", "syn_x/notes/syn_y", "", "a b", "..", "a.b", null, 5]) assert.equal(validUid(bad), false, String(bad));
  const writes = [];
  const db = { doc: p => ({ get: async () => ({ exists: false }), set: async d => { writes.push(p); } }) };
  const notes = createNotes(db, async () => "u1");
  await assert.rejects(() => notes.set("syn_x/notes/syn_y", "t"), { code: "bad_request" });
  await assert.rejects(() => notes.get("a/b"), { code: "bad_request" });
  assert.deepEqual(writes, []);
  await notes.set("syn_c001", "ok");
  assert.deepEqual(writes, ["notes/syn_c001"]);
  const P = payloads(); P.reb.rows.push(row({ window_id: "consult-syn_x/notes/syn_y" })); P.fs.rows.push({ consult_uid: "a/b", ist_date: day, validator: { ok: true } });
  const { a, mcp } = mk(P);
  const l = (await a.listConsults({ doctorId: "room:room_syn01", date: day })).data;
  assert.ok(l.every(c => validUid(c.consult_uid)));
  const g = await a.getConsult("a/b");
  assert.deepEqual([g.ok, g.code], [false, "not_found"]);
  assert.ok(mcp.calls.every(c => !JSON.stringify(c.args).includes("a/b")), "bad uid never sent to a tool");
});

test("N1/N3/N4: foreign-day reb rows dropped, jev scales and objects tolerated, string shadow is not shadow", async () => {
  const P = payloads();
  P.reb.rows.push(row({ window_id: "consult-syn_pre", ist_date: "2026-09-08" }), row({ window_id: "consult-syn_str", shadow: "false", ist_date: day }));
  P.reb.rows.push({ ...row({ window_id: "consult-syn_c001" }), ist_date: "2026-09-10" });
  P.jev.decisions.push({ subject_type: "consult", subject_id: "syn_c001", question_id: { a: 1 }, answer: { b: 2 }, probability: 57 }, { subject_type: "consult", subject_id: "syn_c001", question_id: "q", answer: "x", probability: 300 });
  const { a } = mk(P);
  const l = (await a.listConsults({ doctorId: "room:room_syn01", date: day })).data;
  assert.ok(!l.some(c => c.consult_uid === "syn_pre"));
  assert.equal(l.find(c => c.consult_uid === "syn_str").stages.stt.state, "done");
  const c1 = (await a.getConsult("syn_c001")).data;
  const odd = c1.jev.find(j => j.question.startsWith("{"));
  assert.equal(odd.probability, 0.57);
  assert.equal(c1.jev.find(j => j.question === "q").probability, null);
  assert.equal(c1.jevError, null);
});

test("S3: a failed jev read keeps its error code for the UI", async () => {
  const P = payloads();
  const inner = makeMockMcp(P);
  const mcp = { async callTool(s, t, args, o) { if (t === "scribe_jev_decisions") throw { code: "approval_required", message: "x" }; return inner.callTool(s, t, args, o); } };
  const c = (await createAdapter(createCurrentImpl({ mcp })).getConsult("syn_c001")).data;
  assert.equal(c.jev, null);
  assert.equal(c.jevError, "approval_required");
});

test("N12: a pending retry is cancelled when the operation has already returned", async () => {
  const P = payloads(), inner = makeMockMcp(P);
  const seen = [];
  const mcp = { async callTool(s, t, args, o) {
    seen.push(t);
    if (t === "scribe_rubric") throw { code: "server_unavailable", message: "x", retryable: true, retryAfterMs: 400 };   // will sleep, then must NOT retry
    if (t === "scribe_freescript") { await new Promise(r => setTimeout(r, 20)); throw { code: "needs_reauth", message: "x" }; }   // settles the operation first
    return inner.callTool(s, t, args, o);
  } };
  const r = await createAdapter(createCurrentImpl({ mcp })).listDays({ from: day, to: day });
  assert.equal(r.ok, false);
  const n = seen.length;
  await new Promise(r => setTimeout(r, 900));
  assert.equal(seen.length, n, "no call fires after the operation returned");
  assert.equal(seen.filter(t => t === "scribe_rubric").length, 1);
});
