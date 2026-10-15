// Generates the SYNTHETIC tool-shaped payloads that the mock Scribe MCP serves (adapter-current tests, live-build browser check).
// Run: node scripts/gen-tool-fixtures.mjs   Every id here is invented. The mockup dataset comes from gen-fixtures.mjs.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "synthetic");
const IST = 5.5 * 3600000;
const ms = (date, hhmm) => { const [h, m] = hhmm.split(":").map(Number); return Date.parse(date + "T00:00:00Z") - IST + (h * 60 + m) * 60000; };

const DOCS = {
  syn_d001: { name: "Dr Test Alpha", spec: "Synthetic Cardiology" },
  syn_d002: { name: "Dr Test Beta", spec: "Synthetic Orthopaedics" },
};
// stages: s=stt, d=diar, f=freescript, v=validator ok?, r=rubrics, j=jev, c=cdmss, x=prescription
const SEED = [
  { uid: "syn_c001", doc: "syn_d001", date: "2026-09-09", room: "room_syn01", at: "09:30", len: 540, pat: "Patient Synthetic One", s: 1, d: 1, f: 1, v: 1, r: 1, j: 1, c: 1, x: 1 },
  { uid: "syn_c002", doc: "syn_d001", date: "2026-09-09", room: "room_syn01", at: "10:05", len: 300, pat: "Patient Synthetic Two", s: 1, d: 1, f: 1, v: 1, r: 1, j: 0, c: 0, x: 0 },
  { uid: "syn_c003", doc: "syn_d001", date: "2026-09-10", room: "room_syn01", at: "09:40", len: 420, pat: "Patient Synthetic Three", s: 1, d: 1, f: 1, v: 0, r: 1, j: 1, c: 1, x: 0 },
  { uid: "syn_c004", doc: "syn_d002", date: "2026-09-10", room: "room_syn02", at: "11:15", len: 660, pat: "Patient Synthetic Four", s: 1, d: 0, f: 0, v: 0, r: 0, j: 0, c: 0, x: 0 },
  { uid: "syn_c005", doc: "syn_d002", date: "2026-09-11", room: "room_syn02", at: "14:00", len: 480, pat: "Patient Synthetic Five", s: 1, d: 1, f: 1, v: 1, r: 1, j: 1, c: 1, x: 1 },
  { uid: "syn_c006", doc: "syn_d001", date: "2026-09-11", room: "room_syn01", at: "10:20", len: 360, pat: "Patient Synthetic Six", s: 1, d: 1, f: 1, v: 1, r: 1, j: 1, c: 1, x: 1 },
];

// ---- tool-shaped payloads (names and transcripts are deliberately absent, like the real tools)
const reb = [], fs = [], rub = [], jev = [];
const rb = (c, layer, status, extra = {}) => ({ id: reb.length + 1, window_id: "consult-" + c.uid, ist_date: c.date, room_id: c.room, t0_ms: ms(c.date, c.at), t1_ms: ms(c.date, c.at) + c.len * 1000, layer, engine: "syn-engine", model: "syn-" + layer + "-1", version: "1.0", config_hash: "synhash", shadow: false, status, reason: null, machine: "syn-box", started_at: c.date + "T04:10:00Z", finished_at: c.date + "T04:11:00Z", ...extra });
for (const c of SEED) {
  if (c.s) reb.push(rb(c, "stt", "ok"));
  reb.push(rb(c, "diar", c.d ? "ok" : "failed", c.d ? {} : { reason: "synthetic: no speakers found" }));
  if (c.s) reb.push(rb(c, "stt", "ok", { shadow: true, engine: "syn-shadow" }));
  if (c.f) {
    const doc = c.uid === "syn_c004" ? null : c.doc;
    fs.push({
      run_id: fs.length + 1, consult_uid: c.uid, prescription_uid: c.x ? "syn_rx_" + c.uid.slice(-3) : null, schema_version: "syn", room_slug: c.room, room_id: null, ist_date: c.date, doctor_uid8: doc,
      validator: { ok: !!c.v, errors: c.v ? [] : ["syn_error_1"] }, completion_required: c.v ? [] : [{ kind: "missing", detail: "synthetic", prompt: "p", item_id: "i" }],
      artifact: { note_text: "Synthetic note for " + c.uid, generator: { model: "syn-llm-1", version: "2.0" }, encounter: { room: c.room, doctor: { specialty: doc ? DOCS[doc].spec : null, pulse_doctor_uid: doc }, languages: ["en"], transcript: null, window_start: null, window_end: null },
        pulse_link: { consult_uid: c.uid, link_status: "x", individual_uid: c.x ? "syn_p" + c.uid.slice(-3) : null, prescription_uid: c.x ? "syn_rx_" + c.uid.slice(-3) : null }, provenance: [], unknown_future_key: { a: 1 } },
      generator: { model: "syn-llm-1" }, cost_usd: 0.01, created_at: c.date + "T04:20:00Z", state: "stored",
    });
  }
  if (c.r) {
    rub.push({ rubric_id: "pdqi9", version: "v1", unit_kind: "consult", unit_key: c.uid + "@syn-box", room_id: c.room, ist_date: c.date, run_id: 1, status: "ok", score: { overall: 4.1 }, findings: [], lab: true, created_at: c.date + "T05:00:00Z", evidence_key: null });
    rub.push({ rubric_id: "syn_rubric_a", version: "v2", unit_kind: "consult", unit_key: c.uid + "@syn-box", room_id: c.room, ist_date: c.date, run_id: 2, status: "ok", score: { pass: true }, findings: ["synthetic finding"], lab: true, created_at: c.date + "T05:00:00Z", evidence_key: null });
  }
  if (c.j) { jev.push({ subject_type: "consult", subject_id: c.uid, question_id: "syn_q_followup", answer: "yes", probability: 0.82 }); jev.push({ subject_type: "consult", subject_id: c.uid, question_id: "syn_q_urgent", answer: "no", probability: 0.07, future_key: 1 }); }
}
// a row before the floor, which every layer must drop
const pre = { uid: "syn_c900", date: "2026-09-08", room: "room_syn01", at: "09:00", len: 100 };
reb.push(rb(pre, "stt", "ok"));
const out = (n, v) => writeFileSync(join(root, "tools", n), JSON.stringify(v, null, 1) + "\n");
out("reb_index.json", { rows: reb }); out("freescript.json", { rows: fs }); out("rubric.json", { results: rub }); out("jev_decisions.json", { decisions: jev });
console.log("reb", reb.length, "fs", fs.length, "rub", rub.length, "jev", jev.length);
