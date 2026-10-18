import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapter } from "../src/adapter.js";
import { createFixtureImpl } from "../src/adapter-fixture.js";
import { audioPlan, synthWav } from "../src/audio-synth.js";
import { docKey, hasRx, completeness } from "../src/util.js";
import { mockupData } from "./helpers.mjs";

const data = mockupData();
const a = () => createAdapter(createFixtureImpl(data));
const C = data.consults;

test("dataset: >=4 doctors with specialties x 10 IST days in range, 2-8 consults per doctor-day", () => {
  const docs = new Map(C.map(c => [c.doctor_uid, c.specialty]));
  assert.ok(docs.size >= 4);
  assert.ok(["ENT", "Gynaecology", "General Surgery", "Orthopaedics"].every(s => [...docs.values()].includes(s)));
  const dates = new Set(C.map(c => c.ist_date));
  assert.equal(dates.size, 10);
  assert.ok([...dates].every(d => d >= "2026-09-09" && d <= "2026-10-13"));
  const per = new Map();
  for (const c of C) per.set(c.doctor_uid + c.ist_date, (per.get(c.doctor_uid + c.ist_date) || 0) + 1);
  assert.equal(per.size, docs.size * 10);
  assert.ok([...per.values()].every(n => n >= 2 && n <= 8));
  assert.ok(new Set(C.map(c => c.room_id)).size >= 3);
});

test("dataset: catalog field names, plausible and varied pipeline state", () => {
  for (const c of C) {
    for (const k of ["consult_uid", "ist_date", "doctor_uid", "room_id", "t_open", "t_close", "source", "clip", "layers", "freescript", "stages", "first_gap", "allowance", "prescription", "doctor_name", "patient_name", "individual_uid", "prescription_uid", "catalog_version", "generated_at"]) assert.ok(k in c, c.consult_uid + " missing " + k);
    assert.ok(["cutter", "caa"].includes(c.source));
    assert.equal(c.catalog_version, 1);
    if (c.clip === null) { assert.ok(c.stages.sealed && c.stages.sealed.reason, "a consult with no clip says why in its sealed stage"); assert.equal(c.transcript, null); }
    else for (const k of ["r2_key", "r2_status", "signature_sha256", "audio_sha256", "bytes", "minutes"]) assert.ok(k in c.clip, k);
    assert.equal(typeof c.first_gap === "string" || c.first_gap === null, true);
    assert.ok(c.t_close > c.t_open);
  }
  const states = s => new Set(C.map(c => c.stages[s].state));
  assert.ok(states("stt").has("done") && states("stt").has("failed") && states("stt").has("missing"));
  assert.ok(states("diar").has("failed") && states("jev").has("failed") && states("validator").has("failed"));
  assert.ok(C.some(c => c.stages.stt.state === "failed" && c.stages.stt.reason));
  const levels = new Set(C.map(c => Math.round(completeness(c.stages) * 8)));
  assert.ok(levels.size >= 5, "overview shades vary");
  assert.ok(C.some(c => c.first_gap && /^[a-z]+:.+/.test(c.first_gap)));
  assert.ok(C.some(c => completeness(c.stages) === 1));
  assert.ok(C.some(c => Object.values(c.stages).every((s, i) => i === 0 ? true : s.state === "missing") && c.transcript === null), "clipped-only consults exist");
});

test("dataset: every panel populated for most consults", () => {
  const n = C.length, frac = f => C.filter(f).length / n;
  assert.ok(frac(c => c.transcript && c.transcript.length >= 8) > 0.7);
  assert.ok(frac(c => c.ledger.length >= 4) > 0.7);
  assert.ok(frac(c => c.note && c.note.noteText) > 0.55);
  assert.ok(frac(c => c.pdqi) > 0.4 && C.filter(c => c.pdqi).every(c => Object.keys(c.pdqi.score.items).length === 9 && Object.values(c.pdqi.score.items).every(v => v >= 1 && v <= 5)));
  assert.ok(frac(c => c.rubrics.length) > 0.4);
  assert.ok(frac(c => c.jev && c.jev.every(j => j.probability >= 0 && j.probability <= 1)) > 0.3);
  assert.ok(C.some(c => c.cdmss && c.cdmss.length) && C.some(c => c.cdmss && c.cdmss.length === 0));
  assert.ok(C.some(c => c.note && c.note.validator.ok === false && c.note.validator.errors.length && c.note.completionRequired.length));
  const lines = C.flatMap(c => c.transcript || []);
  for (const l of ["hi", "kn", "en"]) assert.ok(lines.some(x => x.lang === l), "language " + l);
  assert.ok(["doctor", "patient", "attendant"].every(r => lines.some(x => x.role === r)));
  assert.ok(lines.every(l => l.text && l.textEn && l.t1 > l.t0));
  assert.ok(C.some(c => c.ledger.some(l => l.outcome === "failed" && l.reason)));
  assert.ok(C.some(c => c.rx && c.rx.signedText) && C.some(c => c.rx && !c.rx.signedText));
});

test("fixture adapter implements the full interface and honours the floor", async () => {
  const x = a();
  for (const k of ["listDays", "listConsults", "getConsult", "getAudioUrl", "defaultRange"]) assert.equal(typeof x[k], "function", k);
  const days = (await x.listDays({ from: "2026-09-01", to: "2026-10-13" })).data;
  assert.equal(days.cells.reduce((n, c) => n + c.consults, 0), C.length);
  assert.equal(days.dates[0], "2026-09-09");
  assert.equal((await x.listDays({ from: "2026-08-01", to: "2026-09-08" })).data.cells.length, 0);
  assert.ok(days.rooms.length >= 3 && days.specialties.length === 4);
  const rx = (await x.listDays({ from: "2026-09-09", to: "2026-10-13", hasRx: true })).data;
  assert.equal(rx.cells.reduce((n, c) => n + c.consults, 0), C.filter(hasRx).length);
  const ent = (await x.listDays({ from: "2026-09-09", to: "2026-10-13", specialty: "ENT" })).data;
  assert.equal(ent.doctors.length, 1);
});

test("list is time ordered; detail has every panel and Rx links only with both ids", async () => {
  const x = a(), doc = docKey(C[0]);
  const l = (await x.listConsults({ doctorId: doc, date: C[0].ist_date })).data;
  assert.equal(l.length, C.filter(c => docKey(c) === doc && c.ist_date === C[0].ist_date).length);
  assert.ok(l.every((c, i) => i === 0 || l[i - 1].t_open <= c.t_open));
  assert.equal("transcript" in l[0], false, "list rows are summaries");
  const full = C.find(c => completeness(c.stages) === 1);
  const d = (await x.getConsult(full.consult_uid)).data;
  assert.ok(d.transcript.length && d.ledger.length && d.pdqi && d.jev && d.cdmss && d.note);
  assert.equal(d.rx.link, `https://pulse.even.in/prescription?prescription_uid=${full.prescription_uid}&individual_uid=${full.individual_uid}`);
  const noRx = C.find(c => c.rx && !c.rx.prescriptionUid);
  assert.equal((await x.getConsult(noRx.consult_uid)).data.rx.link, null);
  assert.equal((await x.getConsult("nope")).ok, false);
});

test("notes are not part of the fixture adapter (they are db-backed in main.js)", () => {
  assert.equal(createFixtureImpl(data).notes, undefined);
});

test("synthetic audio: plan is capped at 15 minutes; the WAV is real and as long as planned", async () => {
  const c = C.find(x => x.transcript);
  const p = audioPlan(c.lengthSec, c.transcript);
  assert.equal(p.dur, c.lengthSec);
  assert.equal(audioPlan(5000, c.transcript).dur, 900);
  assert.ok(p.cues.length > 0 && p.cues.every(q => q.t0 < p.dur));
  const blob = await synthWav({ dur: 4, cues: [{ t0: 1, hz: 440 }] });
  assert.equal(blob.size, 44 + 4 * 8000, "8 kHz mono 8-bit");
  const b = new Uint8Array(await blob.arrayBuffer());
  assert.equal(String.fromCharCode(...b.slice(0, 4)), "RIFF");
  const v = new DataView(b.buffer);
  assert.equal(v.getUint8(44 + 100), 128, "silence (unsigned 8-bit midpoint) before the cue");
  assert.equal(v.getUint16(34, true), 8);
  let peak = 0; for (let i = 1.0 * 8000; i < 1.3 * 8000; i++) peak = Math.max(peak, Math.abs(v.getUint8(44 + i) - 128));
  assert.ok(peak > 20, "tone at the cue");
  assert.ok(audioPlan(5000, c.transcript).dur * 8000 <= 7.2e6, "15 minutes is at most 7.2 MB");
  assert.match(await a().getAudioUrl(c.consult_uid), /^blob:/);
  assert.equal(await a().getAudioUrl(C.find(x => !x.transcript).consult_uid), null);
});

test("generator is deterministic: two runs are byte-identical, and equal the generated fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-")), runs = [1, 2].map(i => { const tmp = join(dir, "m" + i + ".json"); execFileSync("node", [new URL("../scripts/gen-fixtures.mjs", import.meta.url).pathname], { env: { ...process.env, GEN_OUT: tmp } }); return readFileSync(tmp, "utf8"); });
  assert.equal(runs[0], runs[1]);
  assert.equal(runs[0], readFileSync(new URL("../fixtures/synthetic/mockup.json", import.meta.url), "utf8"));
});
