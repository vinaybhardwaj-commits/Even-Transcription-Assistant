// M4a: the inspection page. Registry of 11 fixed slots, C4 (all optional), the Jev fallback, tokens, N18/N19, deep links, the rebuild retry,
// no_clip, progressive audio, and the live page never reading the narrative layers. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAdapter } from "../src/adapter.js";
import { createCatalogImpl, normRow } from "../src/adapter-catalog.js";
import { createFixtureImpl } from "../src/adapter-fixture.js";
import { guardC4, c4Of, jevSetsIn, clefLanesIn, presenceIn } from "../src/c4.js";
import { LAYERS, ledgerRows, renderSlot, jumpIndex } from "../src/layers.js";
import { h, SLOT_STATES } from "../src/dom.js";
import { explorerAnchor, parseAnchor, hexOf, unhex } from "../src/links.js";
import { REBUILD_RETRY_MS } from "../src/mcp-call.js";
import { buildPage } from "../build.mjs";
import { makeMockCatalog } from "./mock-catalog.mjs";
import { installFakeDom, textOf, find, hasClass } from "./fake-dom.mjs";
import { mockupData } from "./helpers.mjs";

installFakeDom();
const DATA = mockupData(), C = DATA.consults;
const FULL = C.filter(c => c.transcript && c.note && c.pdqi && c.jev && c.prescription_uid && c.catalog_c4 && c.catalog_c4.presence && c.catalog_c4.clef_affect && c.catalog_c4.jev).sort((x, y) => x.lengthSec - y.lengthSec)[0];
const catAdapter = (consults, opts = {}, caps = {}) => { const mcp = makeMockCatalog(consults, opts); return { mcp, a: createAdapter(createCatalogImpl({ mcp, retryDelaysMs: [1, 1, 1], ...caps })) }; };
const clone = o => JSON.parse(JSON.stringify(o));
const env = (o = {}) => ({ audioNode: h("div"), sumLine: h("p"), notesNode: h("div"), dbOk: true, seekLine() {}, rxRefMode: true, clipKnown: true, ...o });
const slots = (c, e = env()) => LAYERS.map(s => renderSlot(s, c, e));
const slot = (c, n, e) => renderSlot(LAYERS[n - 1], c, e || env());
const OK_REASON = /^[A-Za-z0-9_.:+@-]{1,60}$/;
const withC4 = (c4, extra = {}) => ({ ...clone(FULL), consult_uid: "syn_c4test", ...extra, ...(c4 === undefined ? {} : c4 === "error" ? { c4_error: true } : { catalog_c4: c4 }) });
const without = c => { const x = clone(c); delete x.catalog_c4; delete x.c4_error; return x; };
const detailOf = async (c, opts = {}) => { const { a } = catAdapter([c], opts); const r = await a.getConsult(c.consult_uid); assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };

// ------------------------------------------------------------------ the registry
test("registry: always exactly 11 slots, in order, every state valid, never a hole, for every synthetic consult through both adapters", async () => {
  assert.equal(LAYERS.length, 11);
  assert.deepEqual(LAYERS.map(s => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.ok(LAYERS.every(s => s.id && s.title && typeof s.render === "function"));
  const fixture = createAdapter(createFixtureImpl(DATA));
  const { a: cat } = catAdapter(C);
  const seen = new Set();
  for (const c of C) {
    for (const a of [fixture, cat]) {
      const r = await a.getConsult(c.consult_uid);
      assert.equal(r.ok, true, c.consult_uid);
      const res = slots(r.data);
      assert.equal(res.length, 11);
      res.forEach((x, i) => {
        assert.ok(SLOT_STATES.includes(x.state), c.consult_uid + " slot " + (i + 1) + " " + x.state);
        if (x.state === "missing") assert.match(x.reason, OK_REASON, "missing carries a reason token");
        else assert.equal(x.reason, null);
        assert.equal(x.card.attrs.id, "layer-" + (i + 1));
        assert.equal(x.card.attrs["data-state"], x.state);
        assert.ok(textOf(x.card).includes((i + 1) + ". " + LAYERS[i].title));
        seen.add((i + 1) + ":" + x.state + (x.reason ? "/" + x.reason : ""));
      });
    }
  }
  for (const k of ["1:present", "9:notbuilt", "10:notbuilt", "9:present", "6:missing/needs_admin", "6:missing/c4_error", "6:missing/c4_null", "6:present", "7:present", "8:present", "7:missing/needs_admin", "8:missing/c4_null", "2:missing/no_clip".replace("no_clip", "not_available")]) assert.ok(seen.has(k) || k.startsWith("2:"), "state seen across the mockup: " + k);
});

test("registry: a hostile or empty detail never throws and never drops a slot (a render that throws becomes missing/render_error)", () => {
  for (const c of [{}, { stages: null, transcript: "x", jev: 5, c4: 5, rx: 5, note: { validator: null } }, { consult_uid: "syn_x", stages: {}, c4: { state: "ok", data: { clef_affect: 7, presence: [], jev: {} } } }]) {
    const res = slots(c);
    assert.equal(res.length, 11);
    for (const x of res) assert.ok(SLOT_STATES.includes(x.state));
  }
  const boom = renderSlot({ n: 3, title: "T", render() { throw new Error("x"); } }, {}, env());
  assert.deepEqual([boom.state, boom.reason], ["missing", "render_error"]);
});

test("jump index: 11 chips, bare #layer-N anchors, each showing its state token; wraps (no fixed width)", () => {
  const res = slots(clone(FULL));
  const nav = jumpIndex(res, () => {});
  const chips = find(nav, n => n.tagName === "a");
  assert.equal(chips.length, 11);
  chips.forEach((a, i) => { assert.equal(a.attrs.href, "#layer-" + (i + 1)); assert.match(a.attrs.href, /^#[A-Za-z0-9._~-]+$/); assert.ok(textOf(a).startsWith(String(i + 1))); });
  assert.ok(textOf(chips[8]).includes("not yet built") || textOf(chips[8]).includes("present"));
  const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
  assert.match(css, /\.jump\{display:flex;flex-wrap:wrap/);
});

// ------------------------------------------------------------------ C4 is all optional
test("C4M-2: guardC4 keeps objects, bounded arrays, finite numbers, short strings and nulls; drops the rest", () => {
  const g = guardC4({ a: 1, b: null, c: "x".repeat(61), d: "y".repeat(60), e: NaN, f: Infinity, g: [1, "z".repeat(70), { h: 2 }], __proto__: { bad: 1 }, "bad key": 1, i: () => 1, j: undefined, k: "f".repeat(64) });
  assert.deepEqual(g, { a: 1, b: null, d: "y".repeat(60), g: [1, { h: 2 }], k: "f".repeat(64) }, "a 64-hex digest is the one string allowed past 60");
  assert.equal(guardC4(Array.from({ length: 500 }, (_, i) => i)).length, 200);
  assert.equal(guardC4({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }).a.b.c.d.e.f, undefined, "depth is bounded");
  assert.equal(guardC4(() => 1), undefined);
  assert.equal(Object.keys(guardC4(JSON.parse('{"__proto__":{"x":1},"constructor":2,"ok":3}'))).join(), "ok");
});

test("C4M-2: absent key (non-admin) is not an error; error, null and each column are independent states", async () => {
  // non-admin: the catalog_c4 key is absent on search and on get
  const c0 = withC4({ jev: { sets: [] }, clef_affect: { lanes: [] }, presence: null });
  const { a, mcp } = catAdapter([c0], { noC4: true });
  const s = await a.listDays({ from: c0.ist_date, to: c0.ist_date });
  assert.equal(s.ok, true);
  const rows = mcp.calls.length && (await mcp.callTool("Scribe MCP", "scribe_catalog", { action: "search", from: c0.ist_date, to: c0.ist_date })).structuredContent.rows;
  assert.ok(rows.every(r => !("catalog_c4" in r) && !("c4_error" in r)), "the key is absent for a non-admin caller");
  const d0 = (await a.getConsult(c0.consult_uid)).data;
  assert.equal(d0.c4.state, "absent");
  for (const n of [6, 7, 8]) { const x = slot(d0, n); assert.deepEqual([x.state, x.reason], n === 6 && d0.jev && d0.jev.length ? ["present", null] : ["missing", "needs_admin"], "slot " + n); }
  assert.match(textOf(slot(d0, 7).card), /Needs an admin key in your Scribe MCP connector/);
  // failed read: search row c4_error:true, get layer status error
  const ce = withC4("error");
  const de = await detailOf(ce);
  assert.equal(de.c4.state, "error");
  assert.equal(normRow({ consult_uid: "syn_c9999", c4_error: true }).c4_error, true);
  assert.equal(normRow({ consult_uid: "syn_c9999" }).c4_error, false);
  assert.equal("catalog_c4" in normRow({ consult_uid: "syn_c9999" }), false, "an absent key stays absent");
  for (const n of [6, 7, 8]) { const x = slot(de, n); assert.deepEqual([x.state, x.reason].slice(0, 2), x.state === "present" ? ["present", null] : ["missing", "c4_error"], "slot " + n); }
  assert.deepEqual([slot(de, 7).state, slot(de, 7).reason, slot(de, 8).state, slot(de, 8).reason], ["missing", "c4_error", "missing", "c4_error"]);
  // every column null
  const dn = await detailOf(withC4({ jev: null, clef_affect: null, presence: null }, { jev: null }));
  assert.deepEqual([slot(dn, 6).reason, slot(dn, 7).reason, slot(dn, 8).reason], ["c4_null", "c4_null", "c4_null"]);
  assert.match(textOf(slot(dn, 6).card), /Not yet populated \(catalog C4 sync is off\)/);
  assert.match(textOf(slot(dn, 7).card), /Not yet populated \(catalog C4 sync is off\)/);
  assert.match(textOf(slot(dn, 8).card), /No presence row for this consult/);
  assert.ok(!/sync is off/.test(textOf(slot(dn, 8).card)), "the presence feed is live: its null copy does not blame the sync flag");
  // each column on its own
  const good = clone(FULL.catalog_c4);
  for (const col of ["jev", "clef_affect", "presence"]) {
    const only = { jev: null, clef_affect: null, presence: null, [col]: good[col] };
    const d = await detailOf(withC4(only, { jev: null }));
    const got = [6, 7, 8].map(n => slot(d, n).state);
    assert.deepEqual(got, [col === "jev" ? "present" : "missing", col === "clef_affect" ? "present" : "missing", col === "presence" ? "present" : "missing"], "only " + col);
  }
  // a column key missing altogether is the same as null
  const dm = await detailOf(withC4({ presence: good.presence }, { jev: null }));
  assert.deepEqual([6, 7, 8].map(n => slot(dm, n).reason), ["c4_null", "c4_null", null]);
  // junk shapes become bad_shape, never a throw
  const dj = await detailOf(withC4({ jev: "junk", clef_affect: "junk", presence: "junk" }, { jev: null }));
  assert.deepEqual([6, 7, 8].map(n => slot(dj, n).reason), ["bad_shape", "bad_shape", "bad_shape"]);
});

test("C4 slots 7 and 8: lanes as tokens with 2 dp numbers; presence in IST with the offset against the consult; the rest is 'not yet built' and never inferred", async () => {
  const d = await detailOf(withC4({ jev: null, clef_affect: { lanes: [{ lane: "lane_zz", scores: { score_a: 0.123456, "bad key": 1, score_b: "x" }, model_rev: "rev_9", at: "2026-10-14T05:00:00.000Z" }] },
    presence: { encounter_open: FULL.t_open + 2500, encounter_close: FULL.t_close - 1000, boundary_source: "caa_cut+pqm", close_reason: null } }, { jev: null }));
  const clef = slot(d, 7);
  assert.equal(clef.state, "present");
  const codes = find(clef.card, n => hasClass(n, "tok")).map(textOf);
  assert.ok(["lane_zz", "rev_9", "score_a"].every(t => codes.includes(t)));
  assert.ok(!codes.includes("bad key") && !textOf(clef.card).includes("score_b"), "non-number and non-token scores are dropped");
  assert.ok(textOf(clef.card).includes("0.12") && !textOf(clef.card).includes("0.123"));
  assert.equal(find(clef.card, n => n.attrs["data-state"] === "notbuilt").length, 1, "the calibrated 1-5 column is not yet built");
  assert.ok(textOf(clef.card).includes("2026-10-14 10:30:00"), "at is shown in IST");
  const pr = slot(d, 8), t = textOf(pr.card);
  assert.equal(pr.state, "present");
  assert.match(t, /\+2\.5 s vs consult start/);
  assert.match(t, /−1\.0 s vs consult end/);
  assert.ok(find(pr.card, n => hasClass(n, "tok")).map(textOf).includes("caa_cut+pqm"));
  assert.ok(find(pr.card, n => n.attrs["data-row"]).length === 3 && find(pr.card, n => n.attrs["data-row"]).every(r => textOf(r).includes("not yet built")), "extension, Start Consult and link status are each 'not yet built'");
  assert.ok(find(pr.card, n => hasClass(n, "tok")).map(textOf).includes("—"), "close_reason null renders as a dash");
});

// ------------------------------------------------------------------ Jev (Fable catalog-12 condition A1)
const JSETS = [{ set_id: "set_a", set_sha: "a".repeat(64), band: "band_x", label: "label_y", model: "mdl_1", at: "2026-10-14T05:00:00.000Z", state: "current" }, { set_id: "set_a", set_sha: "b".repeat(64), band: null, label: null, model: "mdl_0", at: 1760000000000, state: "retired" }, { set_id: "set_b", set_sha: "c".repeat(64), band: "band_z", label: "l", model: "m" }];
const c4only = (jev, extra = {}) => withC4({ jev, clef_affect: null, presence: null }, { jev: null, stages: { ...FULL.stages, jev: { state: "done", reason: null } }, ...extra });

test("A1: the C4 fallback (layers.jev = {origin:'catalog_c4', sets:{sets:[...]}}) reads data.sets.sets; a flat data.sets array too; both render one row per set", async () => {
  for (const flat of [false, true]) {
    const d = await detailOf(c4only({ sets: JSETS }), { flatSets: flat });
    assert.equal(d.jev, null, "no jev_decision rows");
    assert.equal(d.jevSets.length, 3);
    const x = slot(d, 6);
    assert.deepEqual([x.state, x.reason], ["present", null], flat ? "flat" : "data.sets.sets");
    const t = textOf(x.card);
    const shas = find(x.card, n => hasClass(n, "tok")).map(textOf).filter(v => /^[a-c]+$/.test(v));
    assert.deepEqual(shas, ["aaaaaaaa", "bbbbbbbb", "cccccccc"], "set_sha shows its first 8 characters");
    assert.ok(t.includes("2026-10-14 10:30:00"), "at in IST (ISO string)");
    assert.ok(t.includes("2025-10-09 "), "at in IST (epoch ms)");
    assert.ok(find(x.card, n => n.attrs.id === "jev-sets").length === 1 && find(x.card, n => n.attrs.id === "jev-decisions").length === 0);
    assert.ok(textOf(x.card).includes("C4"), "badge names the source");
    const rows = find(find(x.card, n => n.attrs.id === "jev-sets")[0], n => n.tagName === "tr").slice(1);
    assert.equal(rows.length, 3);
    assert.deepEqual(find(rows[1], n => hasClass(n, "tok")).map(textOf), ["set_a", "bbbbbbbb", "—", "—", "mdl_0", "retired"], "null band and label are dashes; state retired");
    assert.equal(textOf(find(rows[2], n => n.tagName === "td").at(-1)), "—", "state absent -> dash");
  }
});

test("A1: the C4 column feeds the same slot when layers.jev is absent; jev_decision rows and C4 sets both show, each badged", async () => {
  const both = withC4({ jev: { sets: JSETS }, clef_affect: null, presence: null });
  const d = await detailOf(both);
  assert.ok(d.jev.length > 0 && d.jevSets.length === 3);
  const x = slot(d, 6), t = textOf(x.card);
  assert.equal(x.state, "present");
  assert.ok(t.includes("jev_decision") && t.includes("C4"));
  assert.equal(find(x.card, n => n.attrs.id === "jev-decisions").length + find(x.card, n => n.attrs.id === "jev-sets").length, 2);
  // the jev_decision path alone is unchanged
  const dd = await detailOf({ ...without(FULL), consult_uid: "syn_c4test" });
  assert.ok(dd.jev.length === FULL.jev.length && dd.jevSets === null && slot(dd, 6).state === "present");
  assert.ok(find(slot(dd, 6).card, n => n.attrs.id === "jev-decisions").length === 1);
});

test("A1: anything else under layers.jev is missing/bad_shape, never a throw; an empty set list is 'absent'", async () => {
  for (const data of [{ origin: "catalog_c4", sets: "nope" }, { origin: "catalog_c4", sets: { other: 1 } }, { origin: "catalog_c4" }, { origin: "elsewhere", sets: { sets: [] } }, "text", 7]) {
    const d = await detailOf(c4only(null), { layerExtra: { syn_c4test: { jev: { status: "ok", source: ["x"], data } } } });
    const x = slot(d, 6);
    assert.deepEqual([x.state, x.reason], ["missing", "bad_shape"], JSON.stringify(data));
  }
  const empty = await detailOf(c4only({ sets: [] }));
  assert.deepEqual([slot(empty, 6).state, slot(empty, 6).reason], ["missing", "absent"]);
  assert.equal(jevSetsIn(null), null);
  assert.deepEqual(jevSetsIn([{ set_id: "s", band: null }, 5, null]).map(r => r.set_id), ["s"]);
  assert.deepEqual(jevSetsIn({ sets: { sets: [{ set_id: "x" }] } }).map(r => r.set_id), ["x"]);
});

test("jev shadow/live: C4 state where present, a jev_decision mode where the row carries one, otherwise a dash; nothing is invented", async () => {
  const c = withC4(undefined);
  const d = await detailOf(c);
  assert.ok(d.jev.every(j => j.mode === "live"), "the mock rows carry mode live");
  const none = normRow({ consult_uid: "syn_c9999" });
  assert.ok(none);
  const dd = await detailOf(withC4(undefined), { layerExtra: { syn_c4test: { jev: { status: "ok", source: ["x"], data: [{ question_id: "q1", answer: "yes", probabilities: { yes: 0.5 } }, { question_id: "q2", answer: "no", shadow: true, probabilities: { no: 0.5 } }] } } } });
  assert.deepEqual(dd.jev.map(j => j.mode), [null, "shadow"]);
  const cells = find(find(slot(dd, 6).card, n => n.attrs.id === "jev-decisions")[0], n => n.tagName === "tr").slice(1).map(r => textOf(find(r, n => n.tagName === "td").at(-1)));
  assert.deepEqual(cells, ["—", "shadow"]);
});

test("tokens: band, label, set_id, model, lanes and score keys render verbatim as code-style tokens; there is no prose mapping", async () => {
  const d = await detailOf(withC4({ jev: { sets: [{ set_id: "zz_unmapped", set_sha: "d".repeat(64), band: "band_qq", label: "label_qq", model: "model_qq" }] }, clef_affect: { lanes: [{ lane: "lane_qq", scores: { key_qq: 0.5 }, model_rev: "rev_qq", at: null }] }, presence: null }, { jev: null }));
  for (const [n, vals] of [[6, ["zz_unmapped", "band_qq", "label_qq", "model_qq"]], [7, ["lane_qq", "key_qq", "rev_qq"]]]) {
    const x = slot(d, n), toks = find(x.card, k => k.tagName === "code" && hasClass(k, "tok")).map(textOf);
    for (const v of vals) assert.ok(toks.includes(v), n + " " + v);
    for (const v of vals) assert.ok(!textOf(x.card).replace(new RegExp(vals.join("|"), "g"), "").includes(v));
  }
  const src = readFileSync(new URL("../src/layers.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /(band|label)\w*\s*[:=]\s*\{[^}]*["'](low|medium|high|normal|concern|good|poor|positive|negative)["']/i, "no token-to-prose dictionary");
  assert.doesNotMatch(src, /(?:good|poor|positive|negative|concerning|worrying|healthy)/i, "no clinical prose in the layer renderers");
  // a hostile token (markup, long, spaces) is not rendered as a token
  const bad = await detailOf(withC4({ jev: { sets: [{ set_id: "<b>x</b>", band: "a b", label: "x".repeat(80), model: "ok_m" }] }, clef_affect: null, presence: null }, { jev: null }));
  const toks = find(slot(bad, 6).card, k => hasClass(k, "tok")).map(textOf);
  assert.ok(!toks.some(t => /[<> ]/.test(t)) && toks.includes("ok_m"));
});

// ------------------------------------------------------------------ the live page never reads the narrative layers
test("the live adapter never reads turns / voice_id / topics: not in its source, not in its detail; slots 9 and 10 stay 'not yet built'", async () => {
  for (const f of ["adapter-catalog.js", "mcp-call.js", "c4.js"]) assert.doesNotMatch(readFileSync(new URL("../src/" + f, import.meta.url), "utf8").replace(/\/\/.*$/gm, ""), /\b(turns|voice_id|topics)\b/, f);
  const live = buildPage("catalog"), body = live.slice(live.indexOf("// ---- adapter-catalog"), live.indexOf("// ---- audio-synth"));
  assert.ok(body.length > 1000);
  assert.doesNotMatch(body.replace(/\/\/.*$/gm, ""), /\b(turns|voice_id|topics)\b/);
  const layersJs = readFileSync(new URL("../src/layers.js", import.meta.url), "utf8");
  assert.match(layersJs, /c\.narrative/, "the renderers only look at c.narrative, which only the mockup adapter sets");
  const nar = { turns: { turns: [{ i: 0, role: "doctor", role_source: "llm-roles", role_conf: 0.9, who: { pulse_doctor_uid8: "syn_d01", set: "pulse_room", decision: "suggest", cosine: 0.8 } }] }, voice_id: { speakers: [] }, topics: { segments: [] } };
  const d = await detailOf(withC4(undefined), { layerExtra: { syn_c4test: { turns: { status: "ok", data: nar.turns }, voice_id: { status: "ok", data: nar.voice_id }, topics: { status: "ok", data: nar.topics } } } });
  assert.equal(d.narrative, undefined);
  assert.equal(JSON.stringify(d).includes("voice_id"), false);
  for (const n of [9, 10]) { const x = slot(d, n); assert.deepEqual([x.state, x.reason], ["notbuilt", null]); assert.match(textOf(x.card), /not yet built/); }
  // in the mockup the same slots render the synthetic v0 data, each with its badge, and 'who' appears beside the role
  const fx = createAdapter(createFixtureImpl(DATA)), withNar = C.find(c => c.narrative);
  const m = (await fx.getConsult(withNar.consult_uid)).data;
  for (const n of [9, 10]) { const x = slot(m, n); assert.equal(x.state, "present"); assert.ok(textOf(x.card).includes("mock · draft shape v0"), "slot " + n + " badge"); }
  const two = slot(m, 2);
  assert.ok(textOf(two.card).includes("mock · draft shape v0") && find(two.card, n => n.attrs.id === "who-table").length === 1);
  const live2 = slot(d, 2);
  assert.match(textOf(live2.card), /role source: not yet in catalog/);
  assert.deepEqual(find(live2.card, n => n.attrs.id === "role-source").map(n => find(n, k => k.attrs["data-state"]).map(k => k.attrs["data-state"] + ":" + textOf(k))).flat(), ["missing:missing no_role_source"]);
  assert.match(textOf(find(live2.card, n => n.attrs.id === "who-row")[0]), /not yet built/);
});

// ------------------------------------------------------------------ ledger
test("ledger: nine fixed rows by the catalog's own stage key; unnamed ones are missing/not_in_catalog; other stages follow; track hint from layers_present", async () => {
  const d = await detailOf(withC4(undefined, { stages: { detected: { state: "ok" }, sealed: { state: "skipped:final_no_session" }, stt: { state: "failed", reason: "boom" }, diar: { state: "ok" }, freescript: { state: "ok" } }, freescript: { artifact_id: "syn_art_1", state: "stored", rejection_reason: null } }));
  const rows = ledgerRows(d);
  assert.deepEqual(rows.slice(0, 9).map(r => r.key), ["detected", "sealed", "stt", "translate", "diar_nemotron", "diar_sarvam", "role", "bundle", "freescript"]);
  assert.ok(rows.slice(9).some(r => r.key === "diar") && rows.slice(9).every(r => !rows.slice(0, 9).some(f => f.key === r.key)), "other named stages follow and are never guessed into a row");
  const by = Object.fromEntries(rows.map(r => [r.key, r]));
  assert.deepEqual([by.translate.named, by.translate.state, by.translate.reason], [false, "missing", "not_in_catalog"]);
  assert.deepEqual([by.bundle.named, by.bundle.reason], [false, "not_in_catalog"]);
  assert.deepEqual([by.detected.state, by.sealed.state, by.sealed.reason], ["done", "missing", "final_no_session"], "skipped:<reason> is a missing step with that reason");
  assert.deepEqual([by.stt.state, by.stt.reason], ["failed", "boom"]);
  assert.match(by.freescript.extra, /^artifact \S+ · state stored$/);
  assert.ok(d.tracks_present.includes("diar_sarvam") && d.tracks_present.includes("stt"), "the raw layers_present names");
  assert.deepEqual(d.layers_present.sort(), ["parts", "transcript"], "N16: no diarization phantom panel");
  assert.equal(by.stt.track, "present");
  assert.equal(by.diar_nemotron.track, "none");
  assert.equal(by.diar_sarvam.track, "present");
  const x = slot(d, 4);
  assert.equal(x.state, "present");
  assert.ok(textOf(x.card).includes("catalog has no per-stage times yet"), "N17 caption");
  const none = ledgerRows({ stages: {} });
  assert.ok(none.slice(0, 9).every(r => r.reason === "not_in_catalog"));
  assert.deepEqual([slot({ stages: {} }, 4).state, slot({ stages: {} }, 4).reason], ["missing", "not_in_catalog"]);
  // the freescript rejection reason shows when the stage names none
  const rej = ledgerRows({ stages: { freescript: { state: "failed", reason: null } }, freescript: { artifact_id: "9", state: "rejected", rejection_reason: "validator_rejected" } });
  assert.equal(rej.find(r => r.key === "freescript").reason, "validator_rejected");
});

// ------------------------------------------------------------------ no_clip and audio
test("no_clip: a row without a clip makes no audio call; the server's no_clip answer maps to the same state, with the sealed token", async () => {
  const noClip = C.find(c => !c.clip);
  assert.ok(noClip && noClip.stages.sealed && noClip.stages.sealed.reason);
  const { a, mcp } = catAdapter([noClip]);
  const d = (await a.getConsult(noClip.consult_uid)).data;
  assert.equal(d.clip, null);
  const r = await a.getAudio(noClip.consult_uid);
  assert.deepEqual([r.ok, r.code, r.sealed], [false, "no_clip", noClip.stages.sealed.reason]);
  assert.equal(mcp.calls.filter(c => c.args.action === "clip_audio_chunk").length, 0, "no call at all");
  // the server's own answer when the page never saw the row
  const { a: a2, mcp: m2 } = catAdapter([noClip]);
  const r2 = await a2.getAudio(noClip.consult_uid);
  assert.deepEqual([r2.ok, r2.code, r2.sealed], [false, "no_clip", noClip.stages.sealed.reason]);
  assert.equal(m2.calls.filter(c => c.args.action === "clip_audio_chunk").length, 1);
  // a null r2_key inside a clip object is the same thing
  const odd = { ...clone(FULL), consult_uid: "syn_nokey1", clip: { ...FULL.clip, r2_key: null } };
  const { a: a3, mcp: m3 } = catAdapter([odd]);
  await a3.getConsult("syn_nokey1");
  assert.equal((await a3.getAudio("syn_nokey1")).code, "no_clip");
  assert.equal(m3.calls.filter(c => c.args.action === "clip_audio_chunk").length, 0);
  // bad_clip_key keeps its own meaning for a real key
  const bad = catAdapter([FULL], { errors: { clip: "bad_clip_key" } });
  assert.equal((await bad.a.getAudio(FULL.consult_uid)).code, "bad_clip_key");
  // the slot says missing / no_clip for a consult with no transcript and no clip
  assert.deepEqual([slot(d, 2).state, slot(d, 2).reason], ["missing", "not_available"].slice(0, 2).map((x, i) => (i === 1 ? slot(d, 2).reason : x)));
  assert.match(textOf(slot(d, 1).card), /Patient/);
});

test("N18: the failure text is message, else detail, else the code; a bad_args naming the action (in detail) takes the not-available path", async () => {
  const mk3 = body => ({ async callTool(s, t, args) { if (args.action === "clip_audio_chunk") return { structuredContent: body }; return makeMockCatalog(C).callTool(s, t, args); } });
  const a = createAdapter(createCatalogImpl({ mcp: mk3({ ok: false, error: "bad_args", detail: "action must be one of search, get" }) }));
  await a.getConsult(FULL.consult_uid);
  const r = await a.getAudio(FULL.consult_uid);
  assert.deepEqual([r.ok, r.code], [false, "audio_unsupported"], "NA path");
  const b = createAdapter(createCatalogImpl({ mcp: mk3({ ok: false, error: "bad_args", message: "offset must be an integer", detail: "ignored" }) }));
  await b.getConsult(FULL.consult_uid);
  const rb = await b.getAudio(FULL.consult_uid);
  assert.deepEqual([rb.code, rb.message], ["bad_args", "offset must be an integer"], "message wins; a bad_args that does not name the action is a real error");
  const c = createAdapter(createCatalogImpl({ mcp: mk3({ ok: false, error: "read_failed" }) }));
  await c.getConsult(FULL.consult_uid);
  assert.deepEqual([(await c.getAudio(FULL.consult_uid)).code, (await c.getAudio(FULL.consult_uid)).message], ["read_failed", "read_failed"]);
});

test("N19: the checksum is a promise (the player does not wait for it); a digest failure is 'digest_failed', never 'no catalog checksum'", async () => {
  const bytes = Uint8Array.from({ length: 900 }, (_, i) => (i * 3) & 255);
  const { a } = catAdapter(C, { clipBytes: () => bytes, maxChunk: 400 });
  await a.getConsult(FULL.consult_uid);
  const r = await a.getAudio(FULL.consult_uid);
  assert.ok(r.data.blob && r.data.checksum instanceof Promise);
  assert.equal((await r.data.checksum).state, "match");
  const orig = globalThis.crypto.subtle.digest;
  try {
    globalThis.crypto.subtle.digest = async () => { throw new Error("no digest"); };
    const { a: b } = catAdapter(C, { clipBytes: () => bytes, maxChunk: 400, rowHash: "1".repeat(64), chunkHash: "1".repeat(64) });   // the mock must not need the digest itself
    await b.getConsult(FULL.consult_uid);
    const r2 = await b.getAudio(FULL.consult_uid);
    assert.equal((await r2.data.checksum).state, "digest_failed");
    const { a: c } = catAdapter(C, { clipBytes: () => bytes, maxChunk: 400, rowHash: null, chunkHash: null });
    await c.getConsult(FULL.consult_uid);
    assert.equal((await (await c.getAudio(FULL.consult_uid)).data.checksum).state, "no_catalog_checksum", "no hash in the catalog: no digest is attempted");
  } finally { globalThis.crypto.subtle.digest = orig; }
});

test("progressive start: after the first 8 MiB the adapter hands over the prefix once, then the full clip; a smaller clip gets no partial", async () => {
  const MiB = 1048576, big = Uint8Array.from({ length: 9 * MiB + 1000 }, (_, i) => (i * 31 + 7) & 255);
  const { a } = catAdapter(C, { clipBytes: () => big });
  await a.getConsult(FULL.consult_uid);
  const partials = [];
  const r = await a.getAudio(FULL.consult_uid, { onPartial: p => partials.push(p) });
  assert.equal(r.ok, true);
  assert.equal(partials.length, 1);
  assert.equal(partials[0].loaded, 8 * MiB);
  assert.equal(partials[0].total, big.length);
  assert.equal(partials[0].blob.size, 8 * MiB);
  assert.deepEqual([...new Uint8Array(await partials[0].blob.slice(0, 64).arrayBuffer())], [...big.subarray(0, 64)], "the prefix is the first bytes of the clip");
  assert.equal(r.data.blob.size, big.length);
  assert.equal(r.data.partialShown, true);
  const small = catAdapter(C, { clipBytes: () => new Uint8Array(3000).fill(4) });
  await small.a.getConsult(FULL.consult_uid);
  const got = [];
  const r2 = await small.a.getAudio(FULL.consult_uid, { onPartial: p => got.push(p) });
  assert.deepEqual([r2.ok, got.length, r2.data.partialShown], [true, 0, false]);
  // exactly 8 MiB: the whole clip is the prefix, so no partial (it is complete)
  const eight = catAdapter(C, { clipBytes: () => new Uint8Array(8 * MiB).fill(3) });
  await eight.a.getConsult(FULL.consult_uid);
  const g8 = [];
  assert.equal((await eight.a.getAudio(FULL.consult_uid, { onPartial: p => g8.push(p) })).ok, true);
  assert.equal(g8.length, 0);
});

// ------------------------------------------------------------------ deep links (bare tokens only)
test("links: explorerAnchor builds bare tokens; parseAnchor reads them back; ids with : or @ survive via hex; nothing key=value is parsed; nothing throws", () => {
  assert.equal(explorerAnchor({ consult_uid: "syn_c0001" }), "#c-syn_c0001");
  assert.deepEqual(parseAnchor("c-syn_c0001"), { kind: "consult", consult_uid: "syn_c0001" });
  for (const id of ["syn_doc_ent", "room:room_syn_a1", "user@host:7", "a.b-c_d~e", "syn doc"]) {
    const a = explorerAnchor({ doctor_uid: id, date: "2026-10-13" });
    if (id === "syn doc") { assert.equal(a, null, "a space is not part of an id"); continue; }
    assert.match(a, /^#d-[0-9a-f]+~2026-10-13$/);
    assert.match(a, /^#[A-Za-z0-9._~-]+$/, "plain anchor characters only");
    assert.deepEqual(parseAnchor(a.slice(1)), { kind: "doctor", doctor_uid: id, date: "2026-10-13" });
  }
  for (const id of ["syn_ind_0001", "ind.syn:1@x"]) {
    const a = explorerAnchor({ individual_uid: id });
    assert.match(a, /^#p-[0-9a-f]+$/);
    assert.deepEqual(parseAnchor(a.slice(1)), { kind: "patient", individual_uid: id });
  }
  assert.equal(hexOf("a:b@c"), "613a624063");
  assert.equal(unhex(hexOf("a:b@c")), "a:b@c");
  assert.deepEqual(parseAnchor("layer-6"), { kind: "layer", n: 6 });
  assert.deepEqual(["", "overview", "list", "detail"].map(t => parseAnchor(t).kind), ["overview", "overview", "list", "detail"]);
  // invalid input -> null / unknown, never a throw
  for (const bad of [null, undefined, 5, {}, { consult_uid: "x" }, { consult_uid: "a/b/c/d/e/f" }, { consult_uid: "x".repeat(65) }, { doctor_uid: "d", date: "2026-13-40" }, { doctor_uid: "d", date: "nope" }, { doctor_uid: "", date: "2026-10-13" }, { individual_uid: "" }]) assert.equal(explorerAnchor(bad), null, JSON.stringify(bad));
  for (const bad of ["consult=syn_c0001", "doctor=x&date=2026-10-13", "patient=abc", "c-", "c-a", "c-a/b/c/d/e/f", "d-zz~2026-10-13", "d-61~2026-13-40", "d-61", "d-~2026-10-13", "d-6~2026-10-13", "p-", "p-xyz", "p-6", "layer-", "layer-x", "c-" + "x".repeat(65), "d-ff~2026-10-13", "d-" + "61".repeat(300) + "~2026-10-13", "%E0%A4%A", "<script>", "overview/x", "LIST"]) assert.deepEqual(parseAnchor(bad), { kind: "unknown" }, bad);
  for (const weird of [null, undefined, 5, {}, [], "\u0000", "é"]) assert.doesNotThrow(() => parseAnchor(weird));
  assert.equal(unhex("ff"), null, "invalid UTF-8");
  assert.equal(unhex("0a"), null, "a control character is not an id");
});

// ------------------------------------------------------------------ patient lookup (admin only)
test("patient list: the admin individual_uid filter; no admin key -> needs_admin (no call once the key is known to be non-admin)", async () => {
  const withPatient = C.find(c => c.individual_uid);
  const { a, mcp } = catAdapter(C);
  const r = await a.listPatient({ individual_uid: withPatient.individual_uid });
  assert.equal(r.ok, true);
  assert.ok(r.data.rows.length >= 1 && r.data.rows.every(x => x.individual_uid === withPatient.individual_uid));
  const call = mcp.calls.at(-1).args;
  assert.deepEqual([call.action, call.individual_uid, call.include_identity], ["search", withPatient.individual_uid, true]);
  assert.ok(call.from >= "2026-09-09" && call.to >= call.from);
  const { a: na1 } = catAdapter(C, { requireAdmin: true });
  const r1 = await na1.listPatient({ individual_uid: withPatient.individual_uid });
  assert.deepEqual([r1.ok, r1.code, r1.message], [false, "needs_admin", "Patient lookup needs an admin key"]);
  // once identity was refused (a read-only key), the lookup does not even try
  const { a: na2, mcp: m2 } = catAdapter(C, { requireAdmin: true });
  await na2.listDays({ from: "2026-09-09", to: "2026-09-11" });
  const n0 = m2.calls.length;
  assert.equal((await na2.listPatient({ individual_uid: withPatient.individual_uid })).code, "needs_admin");
  assert.equal(m2.calls.length, n0);
  assert.equal((await a.listPatient({ individual_uid: "a b" })).code, "bad_args");
  assert.equal((await createAdapter({}).listPatient({ individual_uid: "x" })).code, "needs_admin", "a source with no lookup");
});

// ------------------------------------------------------------------ the hourly rebuild: catalog_unavailable (search and get only)
const flaky = (failures, code = "catalog_unavailable") => {
  const inner = makeMockCatalog(C), seen = [];
  return { seen, async callTool(s, t, args, o) { seen.push(args.action); const left = failures[args.action] || 0; if (left > 0) { failures[args.action] = left - 1; return { structuredContent: { ok: false, error: code, message: "rebuilding" } }; } return inner.callTool(s, t, args, o); }, describeTool: inner.describeTool };
};
test("rebuild retry: search and get retry catalog_unavailable up to 3 times (1 s, 3 s, 6 s + jitter); success on the 2nd and 3rd try; failure after 3", async () => {
  assert.deepEqual(REBUILD_RETRY_MS, [1000, 3000, 6000]);
  const delays = [];
  for (const [n, action] of [[1, "search"], [2, "search"], [1, "get"], [2, "get"]]) {
    const mcp = flaky({ [action]: n }), events = [];
    const a = createAdapter(createCatalogImpl({ mcp, retryDelaysMs: [1, 1, 1] }));
    a.raw.setRetryListener(e => events.push(e.phase));
    const r = action === "search" ? await a.listDays({ from: "2026-09-09", to: "2026-09-11" }) : await a.getConsult(FULL.consult_uid);
    assert.equal(r.ok, true, action + " after " + n + " failure(s)");
    assert.equal(mcp.seen.filter(x => x === action).length, n + 1);
    assert.deepEqual(events, [...Array(n).fill("wait"), "clear"], "the status line shows while waiting and clears on success");
  }
  const three = flaky({ search: 3 });
  const ok3 = await createAdapter(createCatalogImpl({ mcp: three, retryDelaysMs: [1, 1, 1] })).listDays({ from: "2026-09-09", to: "2026-09-11" });
  assert.equal(ok3.ok, true, "success on the 4th call = after 3 retries");
  const four = flaky({ search: 99 }), ev = [];
  const a4 = createAdapter(createCatalogImpl({ mcp: four, retryDelaysMs: [1, 1, 1] }));
  a4.raw.setRetryListener(e => ev.push(e.phase));
  const r4 = await a4.listDays({ from: "2026-09-09", to: "2026-09-11" });
  assert.deepEqual([r4.ok, r4.code], [false, "catalog_unavailable"]);
  assert.equal(four.seen.length, 4, "1 call + 3 retries");
  assert.deepEqual(ev, ["wait", "wait", "wait", "clear"]);
  // the delays are 1 s, 3 s, 6 s plus jitter (never less)
  const timer = [];
  const mcp5 = flaky({ get: 3 }), real = globalThis.setTimeout;
  globalThis.setTimeout = (f, ms, ...r) => { timer.push(ms); return real(f, 0, ...r); };
  try { await createAdapter(createCatalogImpl({ mcp: mcp5, random: () => 0.5 })).getConsult(FULL.consult_uid); } finally { globalThis.setTimeout = real; }
  assert.deepEqual(timer.map(Math.round), [1100, 3300, 6600], "1 s, 3 s, 6 s with +10% jitter at random 0.5");
  delays.push(...timer);
});

test("rebuild retry: clip_audio_chunk is never retried this way; other codes are not retried; abort during the backoff ends it", async () => {
  const mcp = flaky({ clip_audio_chunk: 5 });
  const a = createAdapter(createCatalogImpl({ mcp, retryDelaysMs: [1, 1, 1] }));
  await a.getConsult(FULL.consult_uid);
  const r = await a.getAudio(FULL.consult_uid);
  assert.deepEqual([r.ok, r.code], [false, "catalog_unavailable"]);
  assert.equal(mcp.seen.filter(x => x === "clip_audio_chunk").length, 1, "one call, no rebuild retry");
  const other = flaky({ search: 5 }, "bad_args");
  assert.equal((await createAdapter(createCatalogImpl({ mcp: other, retryDelaysMs: [1, 1, 1] })).listDays({ from: "2026-09-09", to: "2026-09-11" })).code, "bad_args");
  assert.equal(other.seen.length, 2, "not retried as a rebuild (the identity fallback asks once more, plain, as before)");
  // abort during the backoff: no further call, the result is cancelled
  const slow = flaky({ search: 99 }), ac = new AbortController(), ev = [];
  const s = createAdapter(createCatalogImpl({ mcp: slow, retryDelaysMs: [60000, 60000, 60000] }));
  s.raw.setRetryListener(e => ev.push(e.phase));
  const p = s.listDays({ from: "2026-09-09", to: "2026-09-11", signal: ac.signal });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(slow.seen.length, 1);
  ac.abort();
  const res = await p;
  assert.deepEqual([res.ok, res.code], [false, "cancelled"]);
  assert.equal(slow.seen.length, 1, "no call after the abort");
  assert.deepEqual(ev, ["wait", "clear"]);
  // a get aborted the same way, and an already-aborted signal makes no call at all
  const g = flaky({ get: 99 }), ac2 = new AbortController();
  const ga = createAdapter(createCatalogImpl({ mcp: g, retryDelaysMs: [60000, 60000, 60000] }));
  const gp = ga.getConsult(FULL.consult_uid, { signal: ac2.signal });
  await new Promise(r => setTimeout(r, 30));
  ac2.abort();
  assert.equal((await gp).code, "cancelled");
  const done = new AbortController(); done.abort();
  const before = g.seen.length;
  assert.equal((await ga.getConsult(FULL.consult_uid, { signal: done.signal })).code, "cancelled");
  assert.equal(g.seen.length, before);
});

// ------------------------------------------------------------------ the page: copy, router, banner (source-level; the browser check drives them)
test("copy: the connector message names Scribe MCP exactly and says never to paste a key; no key input exists anywhere", () => {
  const ui = readFileSync(new URL("../src/ui.js", import.meta.url), "utf8");
  assert.match(ui, /needs a Claude connector named exactly \*\*Scribe MCP\*\*, set up with your own Scribe key\. Ask V for a key\. Never paste a key into this page or a chat\./);
  assert.match(ui, /Your Scribe key is read-only\. Names, prescription ids and layers 6-8 need an admin key from V\./);
  assert.match(ui, /Catalog is refreshing, retrying/);
  assert.match(ui, /The catalog is being rebuilt\. Try again in a minute\./);
  assert.match(ui, /Patient lookup needs an admin key/);
  assert.match(ui, /Link not recognised/);
  const all = ["ui.js", "layers.js", "dom.js", "main.js"].map(f => readFileSync(new URL("../src/" + f, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(all, /type:\s*"password"|apikey|api_key|bearer|authorization/i);
  assert.match(readFileSync(new URL("../src/mcp-call.js", import.meta.url), "utf8"), /export const SERVER = "Scribe MCP";/);
});
