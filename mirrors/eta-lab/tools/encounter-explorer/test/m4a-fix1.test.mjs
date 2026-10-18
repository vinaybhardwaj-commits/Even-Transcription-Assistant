// M4a FIX1: S17 (junk C4 timestamps), S18 (seal reason token), N20-N23, N25, N28. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAdapter } from "../src/adapter.js";
import { createCatalogImpl, normRow } from "../src/adapter-catalog.js";
import { sealedReason } from "../src/util.js";
import { LAYERS, renderSlot, jumpIndex } from "../src/layers.js";
import { h } from "../src/dom.js";
import { makeMockCatalog } from "./mock-catalog.mjs";
import { installFakeDom, textOf, find } from "./fake-dom.mjs";
import { mockupData } from "./helpers.mjs";

installFakeDom();
const C = mockupData().consults;
const FULL = C.filter(c => c.transcript && c.note && c.pdqi && c.jev && c.prescription_uid && c.catalog_c4 && c.catalog_c4.presence && c.catalog_c4.clef_affect && c.catalog_c4.jev).sort((x, y) => x.lengthSec - y.lengthSec)[0];
const clone = o => JSON.parse(JSON.stringify(o));
const env = (o = {}) => ({ audioNode: h("div"), sumLine: h("p"), notesNode: h("div"), dbOk: true, seekLine() {}, rxRefMode: true, clipKnown: true, ...o });
const slot = (c, n, e) => renderSlot(LAYERS[n - 1], c, e || env());
const mk = (consults, opts = {}, caps = {}) => { const mcp = makeMockCatalog(consults, opts); return { mcp, a: createAdapter(createCatalogImpl({ mcp, retryDelaysMs: [1, 1, 1], ...caps })) }; };
const jevLayer = data => ({ status: "ok", source: ["encounter_catalog.jev (C4)"], data });
const noJev = () => { const c = clone(FULL); delete c.jev; delete c.catalog_c4.jev; return c; };   // no jev_decision rows: the C4 fallback shape applies

// ---------------------------------------------------------------- S17
test("S17: a junk C4 timestamp (out of Date range, bad ISO, NaN) renders the consult; the slot shows a dash for that time", async () => {
  for (const at of [1e20, -9e15, "2026-13-45T00:00:00Z", NaN, "not a time", Infinity]) {
    const row = { set_id: "set_a", set_sha: "a".repeat(64), band: "band_a", label: "label_a", model: "mdl_0", at, state: "current" };
    const c = noJev();
    for (const via of ["layer", "column"]) {
      const c2 = clone(c), absent = { status: "absent", source: ["jev_decision"], data: null };
      if (via === "column") c2.catalog_c4 = { ...c2.catalog_c4, jev: { sets: [row] } };
      const { a } = mk([c2], { layers: { [c2.consult_uid]: { jev: via === "layer" ? jevLayer({ origin: "catalog_c4", sets: { sets: [row] } }) : absent } } });
      const r = await a.getConsult(c2.consult_uid);
      assert.equal(r.ok, true, String(at) + " " + via + " " + JSON.stringify(r).slice(0, 120));
      const s6 = slot(r.data, 6);
      assert.equal(s6.state, "present", String(at) + " " + via);
      const tds = find(find(s6.card, n => n.attrs.id === "jev-sets")[0], n => n.tagName === "td").map(textOf);
      assert.equal(tds.at(-2), "—", "the time cell is a dash for " + String(at) + " " + via);
      assert.equal(r.data.transcript.length > 0, true, "the transcript survives");
    }
  }
  // clef lanes with the same junk: slot-local, never the consult
  const c = clone(FULL); c.catalog_c4 = { ...c.catalog_c4, clef_affect: { lanes: [{ lane: "l1", scores: { a: 0.5 }, model_rev: "r1", at: 1e20 }] } };
  const { a } = mk([c]);
  const r = await a.getConsult(c.consult_uid);
  assert.equal(r.ok, true);
  assert.equal(slot(r.data, 7).state, "present");
});

test("S17: a derivation that throws degrades that layer only: slot 6 is missing/bad_shape and the other 10 slots are fine", async () => {
  const c = noJev();
  const bomb = { toJSON() { return {}; }, origin: "catalog_c4", get sets() { throw new Error("boom"); } };   // toJSON: the mock serialises the envelope
  const { a } = mk([c], { layers: { [c.consult_uid]: { jev: jevLayer(bomb) } } });
  const r = await a.getConsult(c.consult_uid);
  assert.equal(r.ok, true, "the consult does not fail");
  const out = LAYERS.map(s => renderSlot(s, r.data, env()));
  assert.deepEqual([out[5].state, out[5].reason], ["missing", "bad_shape"]);
  for (const i of [0, 1, 2, 3, 4, 6, 7, 8, 9, 10]) assert.notEqual(out[i].reason, "render_error", "slot " + (i + 1));
  assert.equal(out[6].state, "present"); assert.equal(out[7].state, "present"); assert.equal(out[2].state, "present");
});

// ---------------------------------------------------------------- S18
const sealedConsult = (rowFields, uid = "syn_sealed1") => { const c = clone(FULL); c.consult_uid = uid; c.clip = null; c.stages = { ...c.stages }; delete c.stages.sealed; return { ...c, ...rowFields }; };
test("S18: the server's own shape clip:{r2_key:null, sealed} gives the seal token, shown as-is (not stripped)", async () => {
  const c = sealedConsult({ clip: { r2_key: null, sealed: "skipped:final_no_session" } });
  assert.equal(c.stages.sealed, undefined, "no sealed stage: the token can only come from the clip");
  const { a, mcp } = mk([c]);
  const d = (await a.getConsult(c.consult_uid)).data;
  assert.equal(d.clip.sealed, "skipped:final_no_session");
  assert.equal(sealedReason(d), "skipped:final_no_session");
  const r = await a.getAudio(c.consult_uid);
  assert.deepEqual([r.ok, r.code, r.sealed], [false, "no_clip", "skipped:final_no_session"]);
  assert.equal(mcp.calls.filter(x => x.args.action === "clip_audio_chunk").length, 0, "still no call");
});
test("S18: a top-level row.sealed wins over clip.sealed, which wins over the sealed stage; bad tokens are dropped", () => {
  const base = { consult_uid: "syn_sealed2", stages: { sealed: { state: "skipped", reason: "stage_reason" } } };
  const top = normRow({ ...base, sealed: "skipped:no_session", clip: { r2_key: null, sealed: "skipped:silent_audio" } });
  assert.equal(top.sealed, "skipped:no_session");
  assert.equal(sealedReason(top), "skipped:no_session");
  const viaClip = normRow({ ...base, clip: { r2_key: null, sealed: "skipped:silent_audio" } });
  assert.equal(sealedReason(viaClip), "skipped:silent_audio");
  assert.equal(sealedReason(normRow(base)), "stage_reason", "the stage reason is the last resort");
  for (const bad of ["<b>x</b>", "UPPER", "a b", "x".repeat(65), "", 5, null, {}]) assert.equal(normRow({ ...base, sealed: bad, clip: { r2_key: null, sealed: bad } }).sealed, null, String(bad));
});
test("S18: the token reaches the page through the adapter for a top-level sealed field too", async () => {
  const c = sealedConsult({ clip: null }, "syn_sealed3");
  const inner = makeMockCatalog([c]);
  const mcp = { describeTool: inner.describeTool, async callTool(s, t, args, o) { const res = await inner.callTool(s, t, args, o); const sc = res.structuredContent; if (sc && sc.row) sc.row.sealed = "skipped:deferred_long"; if (sc && sc.rows) sc.rows.forEach(r => { r.sealed = "skipped:deferred_long"; }); return res; } };
  const a = createAdapter(createCatalogImpl({ mcp }));
  const d = (await a.getConsult(c.consult_uid)).data;
  assert.equal(d.sealed, "skipped:deferred_long");
  const r = await a.getAudio(c.consult_uid);
  assert.deepEqual([r.code, r.sealed], ["no_clip", "skipped:deferred_long"]);
});

// ---------------------------------------------------------------- N20
test("N20: slot 2's head state and its jump chip read missing/no_clip when the row has no clip (synchronous check), even with a transcript", async () => {
  const c = sealedConsult({ clip: { r2_key: null, sealed: "skipped:no_session" } }, "syn_noclip2");
  const { a } = mk([c]);
  const d = (await a.getConsult(c.consult_uid)).data;
  assert.ok(d.transcript && d.transcript.length, "the transcript is there");
  const results = LAYERS.map(s => renderSlot(s, d, env()));
  assert.deepEqual([results[1].state, results[1].reason], ["missing", "no_clip"]);
  const chip = find(jumpIndex(results, () => {}), n => n.tagName === "a").find(n => String(n.attrs["data-n"]) === "2");
  assert.equal(chip.attrs["data-state"], "missing"); assert.ok(textOf(chip).includes("no_clip"));
  // with a clip, or when the source does not know clips (clipKnown false), it stays present
  const { a: b } = mk([FULL]);
  const d2 = (await b.getConsult(FULL.consult_uid)).data;
  assert.equal(slot(d2, 2).state, "present");
  assert.equal(slot(d, 2, env({ clipKnown: false })).state, "present");
});

// ---------------------------------------------------------------- N21
test("N21: a tool_error rejection carrying {error:'no_clip', sealed} keeps sealed", async () => {
  const { a } = mk([sealedConsult({ clip: { r2_key: "x" } }, "syn_noclip3")], { rejectEnvelopes: true });   // the page believes there is a key, the server answers no_clip
  const c = sealedConsult({ clip: { r2_key: "k/x" } }, "syn_noclip4");
  const inner = makeMockCatalog([sealedConsult({ clip: null }, "syn_noclip4")], { rejectEnvelopes: true });
  const b = createAdapter(createCatalogImpl({ mcp: inner }));
  const r = await b.getAudio(c.consult_uid);   // the page never saw the row: the server's answer arrives as a rejection
  assert.deepEqual([r.ok, r.code], [false, "no_clip"]);
  assert.equal(a !== null, true);
  const inner2 = { async callTool() { throw { code: "tool_error", message: "x", result: { structuredContent: { ok: false, error: "no_clip", sealed: "skipped:no_session" } } }; }, describeTool: async () => ({ inputSchema: { properties: { action: { enum: ["clip_audio_chunk"] } } } }) };
  const r2 = await createAdapter(createCatalogImpl({ mcp: inner2 })).getAudio("syn_noclip5");
  assert.deepEqual([r2.code, r2.sealed], ["no_clip", "skipped:no_session"]);
});

// ---------------------------------------------------------------- N22
test("N22: a REJECTED catalog_unavailable with retryable:true makes 1 + 3 calls in total, not 5", async () => {
  let n = 0;
  const mcp = { async callTool() { n++; throw { code: "catalog_unavailable", message: "rebuilding", retryable: true }; } };
  const a = createAdapter(createCatalogImpl({ mcp, retryDelaysMs: [1, 1, 1] }));
  const r = await a.listDays({ from: "2026-09-09", to: "2026-09-11" });
  assert.equal(r.ok, false); assert.equal(r.code, "catalog_unavailable");
  assert.equal(n, 4, "1 + 3");
  n = 0;
  const r2 = await a.getConsult("syn_whatever1");
  assert.equal(r2.code, "catalog_unavailable"); assert.equal(n, 4, "get too");
  // other retryable codes keep their single generic retry
  n = 0;
  const mcp2 = { async callTool() { n++; throw { code: "transient", message: "x", retryable: true, retryAfterMs: 1 }; } };
  await createAdapter(createCatalogImpl({ mcp: mcp2, retryDelaysMs: [1, 1, 1] })).getConsult("syn_whatever1");
  assert.equal(n, 2);
});

// ---------------------------------------------------------------- N23
test("N23: listPatient remembers its own needs_admin (a revisit makes no call)", async () => {
  const p = C.find(c => c.individual_uid).individual_uid;
  const { a, mcp } = mk(C, { requireAdmin: true });
  assert.equal((await a.listPatient({ individual_uid: p })).code, "needs_admin");
  const n0 = mcp.calls.length;
  assert.ok(n0 >= 1);
  assert.equal((await a.listPatient({ individual_uid: p })).code, "needs_admin");
  assert.equal(mcp.calls.length, n0, "no second call");
});
test("N23: the admin refusal matches its codes and /admin/i, not a bare 'needed'", async () => {
  const run = async body => { let n = 0; const mcp = { async callTool() { n++; return { structuredContent: body }; } }; const a = createAdapter(createCatalogImpl({ mcp })); return { r: await a.listPatient({ individual_uid: "IND-1" }), n: () => n }; };
  for (const body of [{ ok: false, error: "admin_required" }, { ok: false, error: "identity_unavailable", message: "no" }, { ok: false, error: "bad_args", message: "scope_or_tool_unavailable" }, { ok: false, error: "bad_args", message: "needs an Admin scope" }]) {
    assert.equal((await run(body)).r.code, "needs_admin", JSON.stringify(body));
  }
  const bad = await run({ ok: false, error: "bad_args", message: "from is needed" });
  assert.equal(bad.r.code, "bad_args", "an unrelated bad_args is not an admin refusal");
  const bad2 = await run({ ok: false, error: "bad_args", detail: "limit is needed" });
  assert.equal(bad2.r.code, "bad_args");
});

// ---------------------------------------------------------------- N25
test("N25: #layer-N for N out of range stays on the consult (source check; the router returns after the jump attempt)", () => {
  const ui = readFileSync(new URL("../src/ui.js", import.meta.url), "utf8");
  assert.match(ui, /p\.kind === "layer" && S\.view === "detail"\) \{ jumpTo\(p\.n\); return; \}/);
});

// ---------------------------------------------------------------- N28
test("N28: the checksum starts after getAudio has returned (nothing is concatenated before the player exists) and still matches", async () => {
  const bytes = Uint8Array.from({ length: 1500 }, (_, i) => (i * 5 + 1) & 255);
  const { a } = mk(C, { clipBytes: () => bytes, maxChunk: 400 });
  await a.getConsult(FULL.consult_uid);
  const orig = Blob.prototype.arrayBuffer; let reads = 0;
  Blob.prototype.arrayBuffer = function (...x) { reads++; return orig.apply(this, x); };
  try {
    const r = await a.getAudio(FULL.consult_uid);
    assert.equal(reads, 0, "no read of the whole clip before return");
    assert.equal((await r.data.checksum).state, "match");
    assert.equal(reads, 1, "one read, afterwards");
    assert.equal(r.data.blob.size, 1500);
  } finally { Blob.prototype.arrayBuffer = orig; }
});
