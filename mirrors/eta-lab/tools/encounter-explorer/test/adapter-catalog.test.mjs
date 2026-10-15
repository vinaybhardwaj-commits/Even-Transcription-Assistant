import test from "node:test";
import assert from "node:assert/strict";
import { createAdapter } from "../src/adapter.js";
import { createCatalogImpl, CATALOG_TOOLS, CATALOG_ACTIONS, normRow, jevProbability, validCatalogUid, catalogState } from "../src/adapter-catalog.js";
import { hasRx } from "../src/util.js";
import { makeMockCatalog } from "./mock-catalog.mjs";
import { mockupData } from "./helpers.mjs";

const C = mockupData().consults;
const FULL = C.find(c => c.transcript && c.note && c.pdqi && c.jev && c.prescription_uid && c.lengthSec < 400);
const NORX = C.find(c => c.transcript && !c.prescription_uid);
const mk = (opts = {}, caps = {}) => { const mcp = makeMockCatalog(C, opts); return { mcp, a: createAdapter(createCatalogImpl({ mcp, ...caps })) }; };
const Q = { from: "2026-09-09", to: "2026-10-13" };
const actions = mcp => mcp.calls.map(c => c.args.action);

test("listDays: overview from search, paginated by next_cursor, identity asked for, floor held", async () => {
  const { a, mcp } = mk({ pageSize: 37 });
  const r = await a.listDays({ from: "2026-09-01", to: "2026-10-13" });
  assert.equal(r.ok, true);
  assert.equal(r.data.cells.reduce((n, c) => n + c.consults, 0), C.length);
  assert.equal(r.data.dates[0], "2026-09-09");
  const s = mcp.calls.filter(c => c.args.action === "search");
  assert.ok(s.length >= Math.ceil(C.length / 37));
  assert.equal(s[0].args.cursor, undefined);
  assert.equal(s[1].args.cursor, "37");
  assert.ok(s.every(c => c.args.from >= "2026-09-09" && c.args.limit <= 200 && c.args.include_identity === true && !("has_prescription" in c.args)));
  assert.equal(r.data.generatedAt, "2026-10-14T05:00:00.000Z");
  assert.equal(r.data.truncated, false);
  assert.equal(r.storedAt, 1760000000000);
  assert.equal(r.data.doctors.length, 4);
  assert.ok(r.data.doctors.every(d => d.doctorName), "names arrive with include_identity");
});

test("search window: nothing before 2026-09-09 ever reaches the tool", async () => {
  const { a, mcp } = mk();
  assert.deepEqual((await a.listDays({ from: "2026-08-01", to: "2026-09-08" })).data.cells, []);
  assert.equal(mcp.calls.length, 0);
  assert.deepEqual((await a.listConsults({ doctorId: FULL.doctor_uid, date: "2026-09-08" })).data, []);
});

test("has-prescription filter: sent as has_prescription, server filtered, 31-day window enforced before any call", async () => {
  const { a, mcp } = mk();
  assert.equal(a.features.hasRxFilter, true);
  assert.equal(a.features.hasRxMaxDays, 31);
  const r = await a.listDays({ from: "2026-09-09", to: "2026-10-09", hasRx: true });   // 31 days
  assert.equal(r.ok, true);
  const n = C.filter(c => c.ist_date <= "2026-10-09" && c.prescription_uid).length;
  assert.equal(r.data.cells.reduce((s, c) => s + c.consults, 0), n);
  assert.ok(mcp.calls.every(c => c.args.has_prescription === true));
  const before = mcp.calls.length;
  const wide = await a.listDays({ from: "2026-09-09", to: "2026-10-13", hasRx: true });   // 35 days
  assert.deepEqual([wide.ok, wide.code], [false, "bad_args"]);
  assert.match(wide.message, /at most 31 days/);
  assert.equal(mcp.calls.length, before, "refused locally, no call");
});

test("has-prescription: identity_rows 0 means 'not joined yet', never 'no Rx'", async () => {
  const { a } = mk({ noJoin: true });
  const r = await a.listDays({ from: "2026-09-09", to: "2026-09-20", hasRx: true });
  assert.equal(r.ok, true);
  assert.equal(r.data.identityRows, 0);
  assert.deepEqual(r.data.cells, []);
  const plain = await a.listConsults({ doctorId: FULL.doctor_uid, date: FULL.ist_date });
  assert.ok(plain.data.every(c => c.has_prescription === null), "no joined row = unknown");
  assert.ok(plain.data.every(c => hasRx(c) === false));
});

test("a catalog that refuses has_prescription: the filter is switched off, flagged, and the list is unfiltered", async () => {
  const { a, mcp } = mk({ rxUnsupported: true });
  const r = await a.listDays({ from: "2026-09-09", to: "2026-09-20", hasRx: true });
  assert.equal(r.ok, true);
  assert.equal(r.data.rxFilterIgnored, true);
  assert.equal(a.features.hasRxFilter, false);
  assert.equal(r.data.cells.reduce((s, c) => s + c.consults, 0), C.filter(c => c.ist_date <= "2026-09-20").length);
  const n = mcp.calls.length;
  await a.listDays({ from: "2026-09-09", to: "2026-09-20", hasRx: true });
  assert.ok(mcp.calls.slice(n).every(c => !("has_prescription" in c.args)), "not asked again");
});

test("identity needs an admin token (C2): refused once, then plain reads; names hidden, flagged; has_prescription still works", async () => {
  const { a, mcp } = mk({ requireAdmin: true });
  const r = await a.listDays({ from: "2026-09-09", to: "2026-09-20" });
  assert.equal(r.ok, true);
  assert.equal(r.data.identityDegraded, true);
  assert.ok(r.data.doctors.every(d => d.doctorName === null));
  assert.equal(a.features.names, false);
  const s = mcp.calls.filter(c => c.args.action === "search");
  assert.equal(s[0].args.include_identity, true);
  assert.ok(s.slice(1).every(c => !("include_identity" in c.args)), "never asked again");
  const d = (await a.getConsult(FULL.consult_uid)).data;
  assert.equal(d.identityDegraded, false, "get after the refusal is sent plain and works");
  assert.equal(d.patient_name, null);
  assert.equal(d.transcript.length, FULL.transcript.length);
  const rx = await a.listDays({ from: "2026-09-09", to: "2026-09-20", hasRx: true });
  assert.equal(rx.ok, true);
  assert.ok(rx.data.cells.length > 0);
});

test("identity_unavailable on a search falls back to a plain read too", async () => {
  const inner = makeMockCatalog(C);
  const mcp = { calls: [], async callTool(s, t, args, o) { this.calls.push(args); if (args.include_identity) return { structuredContent: { ok: false, error: "identity_unavailable" } }; return inner.callTool(s, t, args, o); } };
  const a = createAdapter(createCatalogImpl({ mcp }));
  const r = await a.listDays({ from: "2026-09-09", to: "2026-09-20" });
  assert.equal(r.ok, true);
  assert.equal(r.data.identityDegraded, true);
});

test("search with no dates is the catalog's last 30 days: shown, not hidden", async () => {
  const inner = makeMockCatalog(C);
  const mcp = { async callTool(s, t, args, o) { const r = await inner.callTool(s, t, args, o); r.structuredContent.default_window = true; return r; } };
  const r = await createAdapter(createCatalogImpl({ mcp })).listDays({ from: "2026-09-09", to: "2026-09-12" });
  assert.equal(r.data.defaultWindow, true);
  const { a } = mk();
  const dr = await a.defaultRange();
  assert.equal(Date.parse(dr.to) - Date.parse(dr.from), 29 * 86400000);
});

test("a repeated cursor stops the paging and flags truncation", async () => {
  const { a, mcp } = mk({ pageSize: 10, loopCursor: true });
  const r = await a.listDays(Q);
  assert.equal(r.ok, true);
  assert.equal(r.data.truncated, true);
  assert.ok(mcp.calls.length <= 3, "calls " + mcp.calls.length);
});

test("blind room-days: search omits them and reports the count; get and audio refuse", async () => {
  const blind = [FULL.room_id + "|" + FULL.ist_date];
  const { a } = mk({ blind });
  const r = await a.listDays(Q);
  const n = C.filter(c => !blind.includes(c.room_id + "|" + c.ist_date)).length;
  assert.equal(r.data.cells.reduce((s, c) => s + c.consults, 0), n);
  assert.equal(r.data.blindExcluded, C.length - n);
  assert.deepEqual([(await a.getConsult(FULL.consult_uid)).code], ["blind_room_day"]);
  assert.deepEqual([(await a.getAudio(FULL.consult_uid)).code], ["blind_room_day"]);
});

// Non-name tokens: the repo rule bans name-shaped literals on person fields in test files.
const SYN_DOC = "syn-doctor-01";
const SYN_PAT = "syn-patient-01";

test("rows are normalised: catalog names, layers_present mapped onto panels, run-id artifact, identity, junk tolerated", () => {
  assert.equal(normRow(null), null);
  assert.equal(normRow({}), null);
  assert.equal(normRow({ consult_uid: 5 }), null);
  const n = normRow({ consult_uid: "syn_c9999", stages: { stt: { state: "ok" }, diar: { state: "failed", reason: "x" }, odd: "weird", jev: { state: "not_available" }, rx: { state: "absent" } }, clip: { minutes: 5.5 }, layers: { stt: { status: "ok", r2_key: "k" }, role: 5 },
    layers_present: ["stt", "translate", "role", "parts", "diar_sarvam", 5], freescript: { artifact_id: 4, state: "ok" }, has_prescription: true,
    identity: { doctor_name: SYN_DOC, patient_name: SYN_PAT, individual_uid: "syn_ind_x", prescription_uid: "syn_rx_x", presc_state: "signed" }, allowance: "x", t_open: "x", unknown_future: 1 });
  assert.deepEqual(n.stages, { stt: { state: "done", reason: null }, diar: { state: "failed", reason: "x" }, odd: { state: "pending", reason: null }, jev: { state: "na", reason: null }, rx: { state: "missing", reason: null } });
  assert.equal(n.first_gap, "diar:x");
  assert.equal(n.lengthSec, 330);
  assert.equal(n.allowance, null);
  assert.equal(n.t_open, null);
  assert.equal(n.layers.role, null);
  assert.deepEqual(n.layers_present, ["transcript", "parts"]);
  assert.equal(n.freescript.artifact_id, "4");
  assert.deepEqual([n.doctor_name, n.patient_name, n.individual_uid, n.prescription_uid], [SYN_DOC, SYN_PAT, "syn_ind_x", "syn_rx_x"]);
  assert.equal(n.prescription.presc_state, "signed");
  assert.equal(n.has_prescription, true);
  assert.equal(normRow({ consult_uid: "syn_c9998" }).has_prescription, null);
  assert.equal(catalogState("unheard-of"), "pending");
});

test("get: panels from layers; include_text and include_identity are requested; the catalog never supplies prescription content", async () => {
  const { a, mcp } = mk();
  const r = await a.getConsult(FULL.consult_uid);
  assert.equal(r.ok, true);
  assert.deepEqual(mcp.calls.at(-1).args, { action: "get", consult_uid: FULL.consult_uid, include_text: true, include_identity: true });
  const d = r.data;
  assert.equal(d.consult_uid, FULL.consult_uid);
  assert.equal(d.transcript.length, FULL.transcript.length);
  assert.equal(d.transcript[0].text, FULL.transcript[0].text);
  assert.equal(d.note.noteText, FULL.note.noteText);
  assert.equal(d.note.validator.ok, FULL.note.validator.ok);
  assert.equal(d.pdqi.id, "pdqi9");
  assert.equal(Object.keys(d.pdqi.score.items).length, 9);
  assert.equal(d.freescript.artifact_id.length > 0, true);
  assert.equal(d.doctor_name, FULL.doctor_name);
  assert.equal(d.patient_name, FULL.patient_name);
  assert.equal(d.rx.prescriptionUid, FULL.prescription_uid);
  assert.equal(d.rx.prescState, "signed");
  assert.equal(d.rx.hasPrescription, true);
  assert.equal(d.rx.signedText, null, "no signed Rx content from the catalog");
  assert.equal(d.rx.link, `https://pulse.even.in/prescription?prescription_uid=${FULL.prescription_uid}&individual_uid=${FULL.individual_uid}`);
  assert.equal(d.rx.linkFromTool, true);
  assert.deepEqual(d.layerStatus.cdmss, { status: "not_available", source: "consult-audit S5 (pending)", code: null });
  assert.equal(d.cdmss, null);
  assert.match(d.layerStatus.transcript.source, /stt cfg8; .*translate cfg8; .*manifest\.json/, "source arrays are joined");
  assert.equal(d.layers.stt.status, "ok");
});

test("Rx: pulse_url from the tool is used verbatim and never rebuilt; the link is built only when the tool sent none and both ids exist", async () => {
  const uid = FULL.consult_uid;
  const url = "https://pulse.even.in/prescription?prescription_uid=FROM_TOOL&individual_uid=ALSO_TOOL";
  const layers = { [uid]: { rx: { status: "ok", source: ["encounter_catalog"], data: { prescription_uid: "syn_rx_t", presc_state: "signed", has_prescription: true, pulse_url: url } } } };
  const { a } = mk({ layers });
  const d = (await a.getConsult(uid)).data;
  assert.equal(d.rx.link, url);
  assert.equal(d.rx.linkFromTool, true);
  const none = { [uid]: { rx: { status: "ok", source: ["encounter_catalog"], data: { prescription_uid: "syn_rx_t", presc_state: "signed", has_prescription: true, pulse_url: null } }, identity: { status: "absent", source: ["encounter_catalog"], data: null } } };
  const { a: b } = mk({ layers: none });
  const built = (await b.getConsult(uid)).data;
  assert.equal(built.rx.linkFromTool, false);
  assert.equal(built.rx.link, `https://pulse.even.in/prescription?prescription_uid=syn_rx_t&individual_uid=${FULL.individual_uid}`);
  const g = (await a.getConsult(NORX.consult_uid)).data;
  assert.equal(g.rx, null);
  assert.equal(g.layerStatus.rx.status, "absent");
  const blob = { [uid]: { rx: { status: "ok", source: ["x"], data: { prescription_uid: "syn_rx_t", prescription: { medicines: ["Synthetic"] } } } } };
  assert.equal((await mk({ layers: blob }).a.getConsult(uid)).data.rx.signedText, null, "content is ignored even when a tool sends it");
});

test("transcript: clip offsets in seconds, consult span, degraded tracks, clamping, epoch fallback", async () => {
  const uid = FULL.consult_uid, dur = FULL.lengthSec * 1000;
  const seg = (i, t0, t1, extra) => ({ i, t0_ms: t0, t1_ms: t1, speaker: "s", role: "doctor", lang: "en", text_native: "t" + i, text_en: "e" + i, ...extra });
  const data = { clock: "ms_from_clip_start", duration_ms: dur, n_segments: 3, manifest_t0_ms: FULL.t_open - 3000, consult_span_ms: { t0: 3000, t1: dur - 3000 }, n_clamped: 2, degraded: ["translate:clock_mismatch"],
    segments: [seg(2, 90500, 99999999), seg(0, 0, 4000), seg(1, 12345, 20000)] };
  const { a } = mk({ layers: { [uid]: { transcript: { status: "ok", source: ["x"], data } } } });
  const d = (await a.getConsult(uid)).data;
  assert.deepEqual(d.transcript.map(l => l.t0), [0, 12.345, 90.5], "sorted, ms -> s");
  assert.equal(d.transcript[2].t1, dur / 1000, "t1 clamped to the clip duration");
  assert.deepEqual(d.transcriptMeta, { span: { t0: 3, t1: (dur - 3000) / 1000 }, degraded: ["translate:clock_mismatch"], nClamped: 2, manifestT0Ms: FULL.t_open - 3000, durationS: dur / 1000 });
  const noSpan = { clock: "ms_from_clip_start", duration_ms: dur, segments: [seg(0, 0, 1000)] };
  const { a: b } = mk({ layers: { [uid]: { transcript: { status: "ok", source: ["x"], data: noSpan } } } });
  assert.equal((await b.getConsult(uid)).data.transcriptMeta.span, null);
  const epoch = { clock: "epoch_ms", duration_ms: dur, segments: [seg(0, FULL.t_open + 30000, FULL.t_open + 35000)] };
  const { a: c } = mk({ layers: { [uid]: { transcript: { status: "ok", source: ["x"], data: epoch } } } });
  assert.equal((await c.getConsult(uid)).data.transcript[0].t0, 30);
  const junk = { clock: "ms_from_clip_start", segments: [null, { i: 1 }, seg(2, "x", 1), seg(3, 1000, 500)] };
  const { a: e } = mk({ layers: { [uid]: { transcript: { status: "ok", source: ["x"], data: junk } } } });
  const jt = (await e.getConsult(uid)).data.transcript;
  assert.equal(jt.length, 1);
  assert.equal(jt[0].t1 >= jt[0].t0, true);
});

test("layer errors clock_mismatch and no_clock keep their code and only break their own panel; parts carry n_clamped", async () => {
  const uid = FULL.consult_uid;
  const layers = { [uid]: { transcript: { status: "error", source: ["reb/x"], error: "clock_mismatch", data: null }, parts: { status: "error", source: ["reb/p"], error: "no_clock", data: null } } };
  const { a } = mk({ layers });
  const d = (await a.getConsult(uid)).data;
  assert.deepEqual(d.layerStatus.transcript, { status: "error", source: "reb/x", code: "clock_mismatch" });
  assert.deepEqual(d.layerStatus.parts, { status: "error", source: "reb/p", code: "no_clock" });
  assert.equal(d.transcript, null);
  assert.ok(d.note && d.pdqi, "other panels still arrive");
  const ok = { [uid]: { parts: { status: "ok", source: ["p"], data: [{ part: "history", t0_ms: 1000, t1_ms: 2000, score: 1, confidence: 0.5, source: "clef" }], n_clamped: 3 } } };
  const p = (await mk({ layers: ok }).a.getConsult(uid)).data;
  assert.equal(p.partsClamped, 3);
  assert.deepEqual(p.parts[0], { part: "history", t0: 1, t1: 2, score: 1, confidence: 0.5, source: "clef" });
});

test("jev: calibrated_p when stored, else the raw probability; mock rows flagged; scale tolerated", async () => {
  assert.deepEqual(jevProbability({ calibrated_p: 0.4, probabilities: { yes: 0.9 } }), { p: 0.4, kind: "calibrated" });
  assert.deepEqual(jevProbability({ answer: "no", probabilities: { yes: 0.9, no: 0.1 } }), { p: 0.1, kind: "raw" });
  assert.deepEqual(jevProbability({ probabilities: { yes: 0.25, no: 0.75 } }), { p: 0.25, kind: "raw" });
  assert.deepEqual(jevProbability({ probabilities: { a: 0.2, b: 0.7 } }), { p: 0.7, kind: "raw" });
  assert.deepEqual(jevProbability({ calibrated_p: 57 }), { p: 0.57, kind: "calibrated" });
  assert.deepEqual(jevProbability({ calibrated_p: 300, probabilities: null }), { p: null, kind: null });
  assert.deepEqual(jevProbability({ p_yes: 0.5 }), { p: 0.5, kind: "raw" });
  assert.deepEqual(jevProbability({}), { p: null, kind: null });
  const { a } = mk({ mockJev: true });
  const j = (await a.getConsult(FULL.consult_uid)).data.jev;
  assert.equal(j.length, FULL.jev.length);
  assert.ok(j.every(x => x.mock === true));
  assert.deepEqual(j.map(x => x.probabilityKind), j.map((_, i) => (i % 2 === 0 ? "calibrated" : "raw")));
});

test("ledger (N14): a layer's own time where it has one, otherwise blank; the catalog build time is never a step time", async () => {
  const { a } = mk();
  const d = (await a.getConsult(FULL.consult_uid)).data;
  assert.ok(d.ledger.length > 8);
  assert.ok(d.ledger.filter(l => !l.step.startsWith("layer: ")).every(l => l.at === null), "stage rows have no time");
  const byStep = Object.fromEntries(d.ledger.map(l => [l.step, l]));
  assert.equal(byStep["layer: rubric"].at, "2026-10-14T04:30:00.000Z", "latest rubric created_at");
  assert.equal(byStep["layer: jev"].at, "2026-10-14T05:00:00.000Z");
  assert.equal(byStep["layer: transcript"].at, null);
  assert.ok(d.ledger.every(l => l.at !== d.generated_at));
  assert.match(byStep["layer: transcript"].reason, /source: /);
});

test("include_text off: transcript and note text fall back to designed not-available states", async () => {
  const { a, mcp } = mk({}, { includeText: false });
  const d = (await a.getConsult(FULL.consult_uid)).data;
  assert.equal(mcp.calls.at(-1).args.include_text, false);
  assert.equal(d.transcript, null);
  assert.equal(d.layerStatus.transcript.status, "not_available");
  assert.match(d.layerStatus.transcript.source, /text not included/);
  assert.equal(d.note.noteText, null);
});

test("every layer status: ok / absent / not_available / error, and one bad layer never fails the call", async () => {
  const gap = C.find(c => !c.transcript);
  const { a } = mk();
  const g = (await a.getConsult(gap.consult_uid)).data;
  assert.equal(g.layerStatus.transcript.status, "absent");
  assert.equal(g.transcript, null);
  assert.equal(g.note, null);
  assert.equal(g.pdqi, null);
  const jf = C.find(c => c.stages.jev.state === "failed" && c.jev === null);
  const j = (await a.getConsult(jf.consult_uid)).data;
  assert.deepEqual(j.layerStatus.jev, { status: "error", source: "jev_decision (subject_type=consult)", code: "db_error:08006" });
  assert.equal(j.jev, null);
  const bad = { [FULL.consult_uid]: { transcript: { status: "error", source: ["reb/x"], error: "key_not_readable", data: null }, rubric: { status: "weird", source: ["s"] }, freescript: { status: "not_available", source: ["s"] }, parts: "x" } };
  const d = (await mk({ layers: bad }).a.getConsult(FULL.consult_uid)).data;
  assert.deepEqual(d.layerStatus.transcript, { status: "error", source: "reb/x", code: "key_not_readable" });
  assert.equal(d.layerStatus.rubric.status, "error");
  assert.equal(d.layerStatus.freescript.status, "not_available");
  assert.equal(d.layerStatus.parts.status, "not_available", "a layer that is not an object is treated as missing");
  assert.equal(d.pdqi, null);
});

test("error codes arrive as result codes, including when the runtime REJECTS tool_error with the envelope (S10)", async () => {
  for (const code of ["bad_args", "catalog_unavailable", "blind_room_day", "identity_unavailable"]) {
    for (const rejectEnvelopes of [false, true]) {
      const { a } = mk({ errors: { search: code }, rejectEnvelopes });
      const r = await a.listDays(Q);
      assert.deepEqual([r.ok, r.code], [false, code], code + " rejectEnvelopes=" + rejectEnvelopes);
    }
  }
  for (const rejectEnvelopes of [false, true]) {
    const { a } = mk({ rejectEnvelopes });
    assert.equal((await a.getConsult("syn_c9999")).code, "not_found", "rejectEnvelopes=" + rejectEnvelopes);
    assert.equal((await a.getConsult("abc")).code, "not_found");
    const au = await mk({ errors: { clip: "bad_clip_key" }, rejectEnvelopes }).a.getAudio(FULL.consult_uid);
    assert.equal(au.code, "bad_clip_key");
  }
  const odd = { async callTool() { throw { code: "tool_error", message: "boom", result: { structuredContent: { ok: false, error: "something_new" } } }; } };
  assert.equal((await createAdapter(createCatalogImpl({ mcp: odd })).listDays(Q)).code, "tool_error", "unknown envelope codes stay tool_error");
});

test("audio: sequential chunks assemble into one Blob with the bytes in order, progress reported, content type kept", async () => {
  const bytes = Uint8Array.from({ length: 3500 }, (_, i) => (i * 13 + 5) & 255);
  const mcp = makeMockCatalog(C, { clipBytes: () => bytes, maxChunk: 1000, contentType: "audio/wav" });
  const a = createAdapter(createCatalogImpl({ mcp }));
  const seen = [];
  const r = await a.getAudio(FULL.consult_uid, { onProgress: p => seen.push(p) });
  assert.equal(r.ok, true);
  assert.equal(r.data.url, undefined, "never a URL");
  assert.equal(r.data.blob.size, 3500);
  assert.equal(r.data.blob.type, "audio/wav");
  assert.deepEqual([...new Uint8Array(await r.data.blob.arrayBuffer())], [...bytes]);
  assert.deepEqual(seen.map(p => p.loaded), [1000, 2000, 3000, 3500]);
  assert.ok(seen.every(p => p.total === 3500));
  const chunks = mcp.calls.filter(c => c.args.action === "clip_audio_chunk");
  assert.deepEqual(chunks.map(c => c.args.offset), [0, 1000, 2000, 3000], "the next offset is what was actually returned");
  assert.ok(chunks.every(c => Object.keys(c.args).sort().join() === "action,consult_uid,length,offset" && c.args.length === 524288), "Fable C4: chunks are at most 512 KiB");
  assert.ok(chunks.every(c => c.options && c.options.cache === false), "chunks bypass the page cache");
  assert.match(r.data.audio_sha256, /^[0-9a-f]{64}$/);
  assert.equal(r.data.checksum.state, "match");
});

test("audio: a default-size clip is a single chunk; clip_audio_url is never called", async () => {
  const { a, mcp } = mk();
  const r = await a.getAudio(FULL.consult_uid);
  assert.equal(r.ok, true);
  assert.equal(r.data.blob.size, 2500 + FULL.lengthSec);
  assert.equal(mcp.calls.filter(c => c.args.action === "clip_audio_chunk").length, 1);
  assert.ok(!actions(mcp).includes("clip_audio_url"));
  assert.equal(await a.getAudioUrl(FULL.consult_uid), null, "no URL path exists");
});

test("audio: abortable between and during chunks", async () => {
  const bytes = new Uint8Array(5000).fill(7);
  const mcp = makeMockCatalog(C, { clipBytes: () => bytes, maxChunk: 1000, slowMs: 30 });
  const a = createAdapter(createCatalogImpl({ mcp }));
  const ac = new AbortController();
  const p = a.getAudio(FULL.consult_uid, { signal: ac.signal, onProgress: x => { if (x.loaded >= 2000) ac.abort(); } });
  const r = await p;
  assert.deepEqual([r.ok, r.code], [false, "cancelled"]);
  assert.ok(mcp.calls.filter(c => c.args.action === "clip_audio_chunk").length <= 4, "no calls after the abort");
  const pre = new AbortController(); pre.abort();
  const before = mcp.calls.length;
  assert.equal((await a.getAudio(FULL.consult_uid, { signal: pre.signal })).code, "cancelled");
  assert.equal(mcp.calls.length, before);
});

test("M2e: the assembled clip's sha256 is compared with row.clip.audio_sha256 (a chunk audio_sha256 wins if present); signature_sha256 is never used; never blocks playback", async () => {
  const bytes = Uint8Array.from({ length: 1500 }, (_, i) => (i * 7) & 255);
  const mk2 = o => createAdapter(createCatalogImpl({ mcp: makeMockCatalog(C, { clipBytes: () => bytes, maxChunk: 500, ...o }) }));
  const via = async (o, getFirst = true) => { const a = mk2(o); if (getFirst) await a.getConsult(FULL.consult_uid); const r = await a.getAudio(FULL.consult_uid); assert.equal(r.ok, true); assert.equal(r.data.blob.size, 1500); return r.data.checksum.state; };
  assert.equal(await via({ chunkHash: null }), "match", "row hash from get");
  assert.equal(await via({ chunkHash: null, rowHash: "0".repeat(64) }), "mismatch");
  assert.equal(await via({ chunkHash: null, rowHash: null }), "no_catalog_checksum");
  assert.equal(await via({ chunkHash: null, rowHash: "not-a-hash" }), "no_catalog_checksum");
  assert.equal(await via({ chunkHash: null }, false), "no_catalog_checksum", "row never read: nothing to compare with");
  assert.equal(await via({ rowHash: "0".repeat(64) }), "match", "the chunk's audio_sha256 is preferred over the row's");
  assert.equal(await via({ chunkHash: "0".repeat(64), rowHash: null }), "mismatch");
  // signature_sha256 (the cut-signature hash) must never be the comparison value, even when it is the only 64-hex value around
  const r = await mk2({ chunkHash: null, rowHash: null }).getAudio(FULL.consult_uid);
  assert.equal(r.data.checksum.state, "no_catalog_checksum");
  assert.equal(r.data.signature_sha256, undefined);
});

test("audio: bad_range, read_failed and clip_not_found are real errors (never the NA state), also on a later chunk", async () => {
  for (const code of ["bad_range", "read_failed", "clip_not_found"]) {
    const first = makeMockCatalog(C, { errors: { clip: code } });
    const a = createAdapter(createCatalogImpl({ mcp: first }));
    assert.deepEqual([(await a.getAudio(FULL.consult_uid)).code], [code]);
    assert.equal((await a.getAudio(FULL.consult_uid)).code, code, "asked again, not remembered as unsupported");
    const inner = makeMockCatalog(C, { clipBytes: () => new Uint8Array(3000).fill(2), maxChunk: 1000 });
    let n = 0;
    const late = { describeTool: inner.describeTool, async callTool(s, t, args, o) { if (++n === 2) return { structuredContent: { ok: false, error: code, total_bytes: 3000 } }; return inner.callTool(s, t, args, o); } };
    assert.equal((await createAdapter(createCatalogImpl({ mcp: late })).getAudio(FULL.consult_uid)).code, code);
  }
});

test("audio: a size cap (the first chunk reports the total) and a chunk cap bound the work", async () => {
  const big = makeMockCatalog(C, { totalBytes: 65 * 1048576, clipBytes: () => new Uint8Array(1048576).fill(1) });
  const r = await createAdapter(createCatalogImpl({ mcp: big })).getAudio(FULL.consult_uid);
  assert.deepEqual([r.ok, r.code], [false, "audio_too_large"]);
  assert.equal(big.calls.filter(c => c.args.action === "clip_audio_chunk").length, 1, "stopped after the first chunk");
  const tiny = makeMockCatalog(C, { clipBytes: () => new Uint8Array(200).fill(1), maxChunk: 1 });
  const r2 = await createAdapter(createCatalogImpl({ mcp: tiny })).getAudio(FULL.consult_uid);
  assert.deepEqual([r2.ok, r2.code], [false, "audio_too_large"]);
  assert.ok(tiny.calls.filter(c => c.args.action === "clip_audio_chunk").length <= 128);
});

test("audio feature check: the first call answering bad_args or rejecting also means 'not available yet'", async () => {
  for (const reply of [{ ok: false, error: "bad_args", message: "unknown action clip_audio_chunk" }, { ok: false, error: "unknown_action" }]) {
    const mcp = { async callTool() { return { structuredContent: reply }; } };
    const r = await createAdapter(createCatalogImpl({ mcp })).getAudio(FULL.consult_uid);
    assert.deepEqual([r.ok, r.code], [false, "audio_unsupported"], JSON.stringify(reply));
  }
  for (const code of ["not_in_manifest", "tool_error", "bad_request"]) {
    const rej = { async callTool() { throw { code, message: "x" }; } };
    const a = createAdapter(createCatalogImpl({ mcp: rej }));
    assert.equal((await a.getAudio(FULL.consult_uid)).code, code, code + " is a real error, never NA");
    assert.equal((await a.getAudio(FULL.consult_uid)).code, code, "and it is not remembered as unsupported");
  }
  const generic = { async callTool() { return { structuredContent: { ok: false, error: "bad_args", detail: "offset is an integer >= 0" } }; } };
  assert.equal((await createAdapter(createCatalogImpl({ mcp: generic })).getAudio(FULL.consult_uid)).code, "bad_args", "bad_args that does not name the action is real");
  const nf = { async callTool() { return { structuredContent: { ok: false, error: "not_found" } }; } };
  assert.equal((await createAdapter(createCatalogImpl({ mcp: nf })).getAudio(FULL.consult_uid)).code, "not_found", "other codes are real errors, not 'unsupported'");
});

test("audio feature check: describeTool without the chunk action -> unsupported, no chunk call; the first real call decides when there is no describeTool", async () => {
  const noAct = makeMockCatalog(C, { noChunk: true });
  const a = createAdapter(createCatalogImpl({ mcp: noAct }));
  const r = await a.getAudio(FULL.consult_uid);
  assert.deepEqual([r.ok, r.code], [false, "audio_unsupported"]);
  assert.equal(noAct.calls.length, 0, "decided from the schema alone");
  const blind = makeMockCatalog(C, { noChunk: true, noDescribe: true });
  const b = createAdapter(createCatalogImpl({ mcp: blind }));
  assert.equal((await b.getAudio(FULL.consult_uid)).code, "audio_unsupported");
  assert.equal(blind.calls.length, 1, "one probe");
  assert.equal((await b.getAudio(FULL.consult_uid)).code, "audio_unsupported");
  assert.equal(blind.calls.length, 1, "remembered");
  const yes = makeMockCatalog(C, { noDescribe: true });
  assert.equal((await createAdapter(createCatalogImpl({ mcp: yes })).getAudio(FULL.consult_uid)).ok, true);
});

test("audio: damaged or inconsistent chunks are refused; bad_range and other tool codes pass through", async () => {
  const bad = makeMockCatalog(C, { corrupt: true });
  assert.equal((await createAdapter(createCatalogImpl({ mcp: bad })).getAudio(FULL.consult_uid)).code, "bad_chunk");
  const inner = makeMockCatalog(C, { clipBytes: () => new Uint8Array(3000).fill(2), maxChunk: 1000 });
  let n = 0;
  const shifty = { describeTool: inner.describeTool, async callTool(s, t, args, o) { const r = await inner.callTool(s, t, args, o); if (++n === 2) r.structuredContent.total_bytes = 9999; return r; } };
  assert.equal((await createAdapter(createCatalogImpl({ mcp: shifty })).getAudio(FULL.consult_uid)).code, "bad_chunk");
  const stuck = { describeTool: inner.describeTool, async callTool() { return { structuredContent: { ok: true, offset: 0, length: 0, total_bytes: 10, base64: "", done: false } }; } };
  assert.equal((await createAdapter(createCatalogImpl({ mcp: stuck })).getAudio(FULL.consult_uid)).code, "bad_chunk");
  const rng = { describeTool: inner.describeTool, async callTool() { return { structuredContent: { ok: false, error: "bad_range", total_bytes: 3 } }; } };
  assert.equal((await createAdapter(createCatalogImpl({ mcp: rng })).getAudio(FULL.consult_uid)).code, "bad_range");
  assert.equal((await mk().a.getAudio("abc")).code, "not_found");
});

test("only the declared tool and actions are called; the uid is validated first", async () => {
  const { a, mcp } = mk();
  await a.listDays(Q); await a.getConsult(FULL.consult_uid); await a.getAudio(FULL.consult_uid); await a.getConsult("x/y"); await a.getAudio("x/y");
  assert.deepEqual(CATALOG_TOOLS, ["scribe_catalog"]);
  assert.deepEqual(CATALOG_ACTIONS, ["search", "get", "clip_audio_chunk"]);
  for (const c of mcp.calls) { assert.equal(c.server, "Scribe MCP"); assert.equal(c.tool, "scribe_catalog"); assert.ok(CATALOG_ACTIONS.includes(c.args.action), c.args.action); }
  assert.ok(!mcp.calls.some(c => JSON.stringify(c.args).includes("x/y")));
  assert.equal(validCatalogUid("syn_c0001"), true);
  for (const bad of ["abc", "a/b", "", null, "x".repeat(65), "a b c d e f"]) assert.equal(validCatalogUid(bad), false, String(bad));
});

test("a transport failure is a result; mcp null is 'not connected'; a retryable failure is retried once", async () => {
  const { a } = mk({ failWith: "needs_reauth" });
  assert.equal((await a.listDays(Q)).code, "needs_reauth");
  assert.equal((await createAdapter(createCatalogImpl({ mcp: null })).listDays(Q)).code, "server_not_connected");
  let n = 0;
  const flaky = { async callTool() { n++; throw { code: "server_unavailable", message: "x", retryable: true, retryAfterMs: 1 }; } };
  assert.equal((await createAdapter(createCatalogImpl({ mcp: flaky })).listDays({ from: "2026-09-09", to: "2026-09-09" })).ok, false);
  assert.equal(n, 2);
});

test("M2d S12: once describeTool confirmed the chunk action, unknown_action / bad_args / tool_error on any call are real errors, never NA", async () => {
  const inner = makeMockCatalog(C, {});
  for (const reply of [{ ok: false, error: "unknown_action" }, { ok: false, error: "bad_args", detail: "unknown action clip_audio_chunk" }]) {
    const mcp = { describeTool: inner.describeTool, async callTool() { return { structuredContent: reply }; } };
    const a = createAdapter(createCatalogImpl({ mcp }));
    const r = await a.getAudio(FULL.consult_uid);
    assert.notEqual(r.code, "audio_unsupported", JSON.stringify(reply));
    assert.notEqual((await a.getAudio(NORX.consult_uid)).code, "audio_unsupported", "and not on the next consult");
  }
});

test("M2d S13: ANY non-retryable rejection of an include_identity call retries once plain, then identity is off (no message text needed)", async () => {
  const inner = makeMockCatalog(C, {});
  const mcp = { calls: [], describeTool: inner.describeTool, async callTool(s, t, args, o) { this.calls.push(args); if (args.include_identity) throw { code: "upstream_error", message: "Upstream MCP error", retryable: false }; return inner.callTool(s, t, args, o); } };
  const a = createAdapter(createCatalogImpl({ mcp }));
  const r = await a.listDays(Q);
  assert.equal(r.ok, true);
  assert.equal(r.data.identityDegraded, true);
  const n = mcp.calls.length;
  assert.equal(mcp.calls.filter(c => c.include_identity).length, 1, "asked once");
  assert.ok(mcp.calls.slice(1).every(c => !c.include_identity));
  await a.getConsult(FULL.consult_uid);
  assert.ok(mcp.calls.slice(n).every(c => !c.include_identity), "never asked again");
  // a real failure that also fails plain is reported as it is and does not switch identity off
  const down = { calls: [], async callTool(s, t, args) { this.calls.push(args); throw { code: "blind_room_day", message: "x", retryable: false }; } };
  const d = createAdapter(createCatalogImpl({ mcp: down }));
  assert.equal((await d.getConsult(FULL.consult_uid)).code, "blind_room_day");
  assert.equal(down.calls.length, 2);
  assert.equal((await d.getConsult(FULL.consult_uid)).code, "blind_room_day");
  assert.equal(down.calls.filter(c => c.include_identity).length, 2, "identity stays on after a plain read also failed");
});

test("M2d S14: rx.has_prescription true without an id is kept as hasPrescription (the UI says 'on file')", async () => {
  const { a } = mk({ requireAdmin: true });
  const d = (await a.getConsult(FULL.consult_uid)).data;
  assert.equal(d.rx.hasPrescription, true);
  assert.equal(d.rx.prescriptionUid, null);
  assert.equal(d.rx.link, null);
});

test("M2d S15: pulse_url is accepted only on https://pulse.even.in/; anything else is built from the ids or dropped", async () => {
  const uid = FULL.consult_uid;
  for (const bad of ["javascript:alert(1)", "https://evil.example/prescription?x=1", "http://pulse.even.in/p", "https://pulse.even.in.evil.example/p", "//pulse.even.in/p"]) {
    const layers = { [uid]: { rx: { status: "ok", source: ["encounter_catalog"], data: { prescription_uid: "syn_rx_t", presc_state: "signed", has_prescription: true, pulse_url: bad } }, identity: { status: "absent", source: ["encounter_catalog"], data: null } } };
    const d = (await mk({ layers }).a.getConsult(uid)).data;
    assert.equal(d.rx.linkFromTool, false, bad);
    assert.ok(d.rx.link === null || d.rx.link.startsWith("https://pulse.even.in/"), bad);
  }
});

test("M2d N15: a chunk longer than the requested length is refused", async () => {
  const inner = makeMockCatalog(C, { clipBytes: () => new Uint8Array(2000000).fill(3) });
  const fat = { describeTool: inner.describeTool, async callTool() { return { structuredContent: { ok: true, offset: 0, length: 600000, total_bytes: 600000, base64: Buffer.alloc(600000, 3).toString("base64"), done: true } }; } };
  assert.equal((await createAdapter(createCatalogImpl({ mcp: fat })).getAudio(FULL.consult_uid)).code, "bad_chunk");
});

test("M2d B1: rxState is three-valued; null (not joined) is never 'no'", async () => {
  const { rxState } = await import("../src/util.js");
  assert.equal(rxState({ has_prescription: true }), "yes");
  assert.equal(rxState({ has_prescription: false }), "no");
  assert.equal(rxState({ has_prescription: null }), "unknown");
  assert.equal(rxState({ has_prescription: null, prescription_uid: "x" }), "yes");
  assert.equal(rxState({}), "no", "sources without the notion (current tools, mockup) keep yes/no");
  const { a } = mk({ noJoin: true });
  const l = (await a.listConsults({ doctorId: (await a.listDays(Q)).data.doctors[0].doctorId, date: "2026-10-13" }));
  assert.ok(l.ok);
});
