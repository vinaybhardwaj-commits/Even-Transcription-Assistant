// Deterministic generator for the MOCKUP dataset (fixtures/synthetic/mockup.json). Fixed seed; every person, id and clinical detail is invented.
// Run: node scripts/gen-fixtures.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = process.env.GEN_OUT || join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "synthetic", "mockup.json");
const SEED = 20261014;
let _s = SEED;
const rnd = () => { _s = (_s + 0x6d2b79f5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = a => a[Math.floor(rnd() * a.length)];
const chance = p => rnd() < p;
const IST = 5.5 * 3600000;
const utc = (date, hh, mm) => Date.parse(date + "T00:00:00Z") - IST + (hh * 60 + mm) * 60000;
const pad = (n, w) => String(n).padStart(w, "0");

const DATES = ["2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-30", "2026-10-01", "2026-10-12", "2026-10-13"];
const DOCTORS = [
  { uid: "syn_doc_ent", name: "Dr Synthetic ENT", spec: "ENT", room: "room_syn_a1", lang: ["hi", "en"] },
  { uid: "syn_doc_surg", name: "Dr Synthetic Surgery", spec: "General Surgery", room: "room_syn_b2", lang: ["kn", "en"] },
  { uid: "syn_doc_gyn", name: "Dr Synthetic Gynaecology", spec: "Gynaecology", room: "room_syn_c3", lang: ["kn", "hi", "en"] },
  { uid: "syn_doc_orth", name: "Dr Synthetic Orthopaedics", spec: "Orthopaedics", room: "room_syn_d4", lang: ["hi", "en"] },
];
// the patient name is a numbered placeholder; the two pick() calls below stay only so the seeded sequence (and so every other value) is unchanged
const FIRST = Array(16).fill("x"), LAST = Array(8).fill("x");

// [english, hindi, kannada]
const T = (en, hi, kn) => ({ en, hi, kn });
const GENERIC = [
  [T("What brings you in today?", "आज आप किस वजह से आए हैं?", "ಇವತ್ತು ಏನು ತೊಂದರೆ ಇದೆ?"), T("I have had this problem for three days.", "मुझे यह तकलीफ़ तीन दिन से है।", "ನನಗೆ ಮೂರು ದಿನದಿಂದ ಈ ತೊಂದರೆ ಇದೆ.")],
  [T("Are you taking any medicine right now?", "क्या आप अभी कोई दवा ले रहे हैं?", "ನೀವು ಈಗ ಯಾವುದಾದರೂ ಔಷಧ ತೆಗೆದುಕೊಳ್ಳುತ್ತಿದ್ದೀರಾ?"), T("Only a tablet for sugar in the morning.", "सिर्फ़ सुबह शुगर की एक गोली।", "ಬೆಳಿಗ್ಗೆ ಸಕ್ಕರೆಗೆ ಒಂದು ಮಾತ್ರೆ ಮಾತ್ರ.")],
  [T("Any allergy to medicines?", "किसी दवा से एलर्जी है?", "ಯಾವುದಾದರೂ ಔಷಧಕ್ಕೆ ಅಲರ್ಜಿ ಇದೆಯಾ?"), T("No, none that I know of.", "नहीं, मुझे नहीं पता।", "ಇಲ್ಲ, ನನಗೆ ಗೊತ್ತಿಲ್ಲ.")],
];
const CLOSE = [T("Take this medicine after food and come back in one week.", "यह दवा खाने के बाद लें और एक हफ़्ते में दोबारा आइए।", "ಈ ಔಷಧವನ್ನು ಊಟದ ನಂತರ ತೆಗೆದುಕೊಳ್ಳಿ, ಒಂದು ವಾರದಲ್ಲಿ ಮತ್ತೆ ಬನ್ನಿ."), T("Okay doctor, thank you.", "ठीक है डॉक्टर, धन्यवाद।", "ಸರಿ ಡಾಕ್ಟರ್, ಧನ್ಯವಾದ.")];
const ATTENDANT = [T("He has not been eating well since morning.", "सुबह से इन्होंने ठीक से खाना नहीं खाया।", "ಬೆಳಿಗ್ಗೆಯಿಂದ ಅವರು ಸರಿಯಾಗಿ ಊಟ ಮಾಡಿಲ್ಲ."), T("She was also awake all night with the pain.", "ये रात भर दर्द की वजह से जागी रहीं।", "ನೋವಿನಿಂದ ರಾತ್ರಿ ಪೂರ್ತಿ ಅವರು ನಿದ್ದೆ ಮಾಡಿಲ್ಲ.")];
const SPEC = {
  ENT: [
    [T("Is the ear pain on one side?", "क्या कान का दर्द एक तरफ़ है?", "ಕಿವಿ ನೋವು ಒಂದು ಕಡೆ ಇದೆಯಾ?"), T("Yes, the right ear, and it hurts when I swallow.", "हाँ, दाएँ कान में, और निगलते समय दर्द होता है।", "ಹೌದು, ಬಲ ಕಿವಿ, ನುಂಗುವಾಗ ನೋವಾಗುತ್ತದೆ.")],
    [T("Any fever or discharge from the ear?", "बुखार या कान से पानी आता है?", "ಜ್ವರ ಅಥವಾ ಕಿವಿಯಿಂದ ನೀರು ಬರುತ್ತಾ?"), T("A little fever last night, no discharge.", "कल रात थोड़ा बुखार था, पानी नहीं आया।", "ನಿನ್ನೆ ರಾತ್ರಿ ಸ್ವಲ್ಪ ಜ್ವರ ಇತ್ತು, ನೀರು ಬಂದಿಲ್ಲ.")],
    [T("Let me look at the throat.", "मैं गला देख लेता हूँ।", "ನಾನು ಗಂಟಲು ನೋಡುತ್ತೇನೆ."), T("Sure, doctor.", "जी, डॉक्टर।", "ಸರಿ, ಡಾಕ್ಟರ್.")],
  ],
  Gynaecology: [
    [T("When was your last period?", "आख़िरी माहवारी कब हुई थी?", "ಕೊನೆಯ ಮುಟ್ಟು ಯಾವಾಗ ಆಯಿತು?"), T("About three weeks ago, it was heavy.", "करीब तीन हफ़्ते पहले, ज़्यादा ब्लीडिंग थी।", "ಸುಮಾರು ಮೂರು ವಾರದ ಹಿಂದೆ, ಜಾಸ್ತಿ ರಕ್ತಸ್ರಾವ ಇತ್ತು.")],
    [T("Any pain in the lower abdomen?", "पेट के निचले हिस्से में दर्द है?", "ಕೆಳ ಹೊಟ್ಟೆಯಲ್ಲಿ ನೋವು ಇದೆಯಾ?"), T("Yes, a dull pain since two days.", "हाँ, दो दिन से हल्का दर्द है।", "ಹೌದು, ಎರಡು ದಿನದಿಂದ ಸ್ವಲ್ಪ ನೋವು ಇದೆ.")],
    [T("We will do a scan today.", "आज हम स्कैन करेंगे।", "ಇವತ್ತು ನಾವು ಸ್ಕ್ಯಾನ್ ಮಾಡುತ್ತೇವೆ."), T("Is it safe, doctor?", "क्या यह सुरक्षित है, डॉक्टर?", "ಇದು ಸುರಕ್ಷಿತವೇ ಡಾಕ್ಟರ್?")],
  ],
  "General Surgery": [
    [T("Where exactly is the swelling?", "सूजन ठीक कहाँ है?", "ಊತ ಎಲ್ಲಿದೆ?"), T("Here on the right side of the stomach.", "यहाँ पेट के दाईं तरफ़।", "ಇಲ್ಲಿ ಹೊಟ್ಟೆಯ ಬಲಭಾಗದಲ್ಲಿ.")],
    [T("Does it increase when you cough?", "खाँसने पर बढ़ती है?", "ಕೆಮ್ಮಿದಾಗ ಜಾಸ್ತಿ ಆಗುತ್ತದೆಯಾ?"), T("Yes, and it comes and goes.", "हाँ, और यह आती-जाती रहती है।", "ಹೌದು, ಬಂದು ಹೋಗುತ್ತದೆ.")],
    [T("This may need a small operation.", "इसके लिए छोटा ऑपरेशन करना पड़ सकता है।", "ಇದಕ್ಕೆ ಸಣ್ಣ ಆಪರೇಷನ್ ಬೇಕಾಗಬಹುದು."), T("How many days will I stay?", "कितने दिन रुकना पड़ेगा?", "ಎಷ್ಟು ದಿನ ಇರಬೇಕಾಗುತ್ತದೆ?")],
  ],
  Orthopaedics: [
    [T("Which knee is paining?", "कौन सा घुटना दर्द कर रहा है?", "ಯಾವ ಮೊಣಕಾಲು ನೋವು?"), T("The left one, mostly on the stairs.", "बायाँ वाला, ज़्यादातर सीढ़ियों पर।", "ಎಡಗಡೆಯದು, ಹೆಚ್ಚಾಗಿ ಮೆಟ್ಟಿಲು ಹತ್ತುವಾಗ.")],
    [T("Any swelling or injury before this?", "पहले कोई सूजन या चोट लगी थी?", "ಇದಕ್ಕಿಂತ ಮೊದಲು ಯಾವುದೇ ಊತ ಅಥವಾ ಗಾಯ ಆಗಿತ್ತಾ?"), T("I slipped in the bathroom last month.", "पिछले महीने बाथरूम में फिसल गया था।", "ಕಳೆದ ತಿಂಗಳು ಬಾತ್‌ರೂಮ್‌ನಲ್ಲಿ ಜಾರಿ ಬಿದ್ದೆ.")],
    [T("We will take an X-ray of the knee.", "हम घुटने का एक्स-रे लेंगे।", "ಮೊಣಕಾಲಿನ ಎಕ್ಸ್-ರೇ ತೆಗೆಯುತ್ತೇವೆ."), T("Should I walk with a stick?", "क्या मैं छड़ी लेकर चलूँ?", "ನಾನು ಕೋಲು ಹಿಡಿದು ನಡೆಯಬೇಕಾ?")],
  ],
};
const NOTE = {
  ENT: [["right ear pain with sore throat for 3 days", "Mild fever last night; no ear discharge.", "Right tympanic membrane congested; throat mildly inflamed.", "Acute otitis media with pharyngitis (synthetic)", "Oral antibiotic, antihistamine at night, review in 1 week."]],
  Gynaecology: [["heavy menstrual bleeding with lower abdominal pain", "Last period about 3 weeks ago, heavy; dull pain for 2 days.", "Abdomen soft, mild lower tenderness.", "Menorrhagia, cause to be assessed (synthetic)", "Pelvic scan today, tranexamic acid, iron and folic acid, review with report."]],
  "General Surgery": [["swelling on the right side of the abdomen", "Swelling increases on coughing, comes and goes.", "Reducible swelling, no signs of obstruction.", "Probable inguinal hernia (synthetic)", "Surgical counselling, pre-operative work-up, review in 1 week."]],
  Orthopaedics: [["left knee pain on climbing stairs", "Slipped in the bathroom last month; no swelling since.", "Mild joint-line tenderness, full range of movement.", "Early osteoarthritis of left knee (synthetic)", "X-ray left knee, analgesic for 5 days, calcium and vitamin D, review with X-ray."]],
};
const RX = {
  ENT: ["Tab Amoxicillin-Clavulanate 625 mg, 1-0-1 for 5 days", "Tab Cetirizine 10 mg, 0-0-1 for 5 days", "Tab Paracetamol 500 mg, SOS up to 3 a day"],
  Gynaecology: ["Tab Tranexamic acid 500 mg, 1-1-1 for 3 days", "Tab Iron-folic acid, 1-0-0 for 30 days", "Pelvic ultrasound today"],
  "General Surgery": ["Tab Pantoprazole 40 mg, 1-0-0 for 14 days", "Tab Paracetamol 500 mg, SOS up to 3 a day", "Abdominal binder when walking"],
  Orthopaedics: ["Tab Etoricoxib 60 mg, 0-1-0 for 5 days", "Tab Calcium with vitamin D3, 1-0-0 for 30 days", "Diclofenac gel, apply twice daily"],
};
const PDQI = ["up_to_date", "accurate", "thorough", "useful", "organized", "comprehensible", "succinct", "synthesized", "internally_consistent"];
const JEVQ = ["follow_up_advised", "red_flag_discussed", "rx_matches_plan", "allergy_asked", "language_switch_detected"];

function transcriptFor(doc, lang, dur) {
  const pairs = [...GENERIC.slice(0, 1), ...SPEC[doc.spec].slice(0, 2), GENERIC[1 + ri(0, 1)], SPEC[doc.spec][2]];
  const seq = []; // [role, T]
  for (const [d, p] of pairs) { seq.push(["doctor", d], ["patient", p]); if (chance(0.3)) seq.push(["attendant", pick(ATTENDANT)]); }
  seq.push(["doctor", CLOSE[0]], ["patient", CLOSE[1]]);
  const n = seq.length, span = Math.max(30, dur - 20), step = span / n, lines = [];
  seq.forEach(([role, tt], i) => {
    const t0 = Math.round(i * step + rnd() * step * 0.3), len = Math.max(3, Math.min(Math.round(step) - 1, 3 + Math.round(tt.en.length / 9)));
    const mix = lang !== "en" && chance(0.75), native = mix ? tt[lang] : tt.en;
    lines.push({ id: "l" + i, t0, t1: t0 + len, speaker: "spk_syn_" + (role === "doctor" ? "a" : role === "patient" ? "b" : "c"), role, lang: mix ? lang : "en", text: native, textEn: tt.en });
  });
  return lines;
}

const consults = [];
let seq = 0;
for (const date of DATES) {
  for (const doc of DOCTORS) {
    const n = ri(2, 8);
    let clock = ri(9 * 60, 9 * 60 + 40);
    for (let k = 0; k < n; k++) {
      seq++;
      const uid = "syn_c" + pad(seq, 4), len = ri(180, 840), t_open = utc(date, 0, clock), t_close = t_open + len * 1000;
      clock += Math.ceil(len / 60) + ri(4, 15);
      // pipeline level: 0 clipped only .. 5 Rx linked
      const level = pick([0, 1, 2, 3, 3, 4, 4, 5, 5, 5, 5, 5, 5]);
      const sp = doc.spec, lang = pick(doc.lang), special = seq % 29 === 0 ? "stt" : seq % 17 === 0 ? "diar" : seq % 11 === 0 ? "jev" : seq % 13 === 0 && level >= 3 ? "validator" : null;
      pick(FIRST); pick(LAST);
      const patient = "Synthetic Patient " + pad(seq, 4), ind = "syn_ind_" + pad(seq, 4), rxUid = "syn_rx_" + pad(seq, 4);
      const lv = special === "stt" ? 0 : level;
      const st = (done, failReason) => failReason ? { state: "failed", reason: failReason } : { state: done ? "done" : "missing", reason: null };
      const diarFail = special === "diar" && lv >= 2 ? "sarvam diarization timed out after 300 s" : null;
      const jevFail = special === "jev" && lv >= 4 ? "jev parts: model returned invalid JSON" : null;
      const valFail = special === "validator" && lv >= 3;
      const cdmssOn = lv >= 4 && !chance(0.25);
      const sttFail = special === "stt" ? "no speech found by VAD in clip (low SNR)" : null;
      const stages = {
        stt: sttFail ? { state: "failed", reason: sttFail } : st(lv >= 1), diar: st(lv >= 2 && !diarFail, diarFail), freescript: st(lv >= 3), validator: lv >= 3 ? (valFail ? { state: "failed", reason: "2 validator errors" } : { state: "done", reason: null }) : { state: "missing", reason: null },
        rubrics: st(lv >= 4), jev: st(lv >= 4 && !jevFail, jevFail), cdmss: st(cdmssOn), rx: st(lv >= 5),
      };
      let first_gap = null;
      for (const key of ["stt", "diar", "freescript", "validator", "rubrics", "jev", "cdmss", "rx"]) if (stages[key].state !== "done") { first_gap = key + ":" + (stages[key].reason || stages[key].state); break; }
      const hasT = lv >= 1;
      const transcript = hasT ? transcriptFor(doc, lang, Math.min(len, 900)) : null;
      const base = utc(date, 0, 0) + 12 * 3600000;   // catalog generated_at: noon IST that day
      const iso = off => new Date(t_close + off * 1000).toISOString();
      const ledger = [{ step: "cut", at: iso(30), model: pick(["syn-cutter", "syn-caa"]), version: "3.2", outcome: "ok", reason: null }];
      if (hasT || sttFail) ledger.push({ step: "stt", at: iso(150), model: "syn-sarvam-saaras", version: "2.5", outcome: sttFail ? "failed" : "ok", reason: sttFail });
      if (hasT) ledger.push({ step: "translate", at: iso(170), model: "syn-translate-1", version: "1.1", outcome: "ok", reason: null });
      if (lv >= 2 || diarFail) ledger.push({ step: "diarize", at: iso(260), model: "syn-diar-sarvam", version: "1.0", outcome: diarFail ? "failed" : "ok", reason: diarFail });
      if (lv >= 2 && !diarFail) ledger.push({ step: "roles", at: iso(300), model: "syn-role-tracker", version: "1.4", outcome: "ok", reason: null });
      if (lv >= 4 || jevFail) ledger.push({ step: "jev parts", at: iso(420), model: "syn-jev-parts", version: "0.9", outcome: jevFail ? "failed" : "ok", reason: jevFail });
      if (lv >= 3) ledger.push({ step: "freescript", at: iso(600), model: "syn-llm-large", version: "2.1", outcome: "stored", reason: null });
      if (lv >= 3) ledger.push({ step: "validator", at: iso(610), model: "syn-validator", version: "1.6", outcome: valFail ? "failed" : "ok", reason: valFail ? "2 validator errors" : null });
      const note = lv >= 3 ? (() => { const [cc, hx, ex, as, pl] = NOTE[sp][0]; return {
        noteText: `Chief complaint: ${cc}\nHistory: ${hx}\nExamination: ${ex}\nAssessment: ${as}\nPlan: ${pl}`,
        validator: { ok: !valFail, errors: valFail ? ["missing_section: allergies", "dose_unit_mismatch: plan item 2"] : [] },
        completionRequired: valFail ? [{ kind: "missing", detail: "allergy history not recorded", prompt: "Confirm any drug allergy with the patient" }] : (chance(0.2) ? [{ kind: "ambiguous", detail: "follow-up interval unclear", prompt: "Confirm follow-up in 1 or 2 weeks" }] : []),
        model: "syn-llm-large", version: "2.1" }; })() : null;
      const pItems = {}; let sum = 0;
      for (const it of PDQI) { const v = rnd() < 0.25 ? ri(1, 3) : ri(3, 5); pItems[it] = v; sum += v; }
      const pdqi = lv >= 4 ? { id: "pdqi9", version: "v1", status: "ok", score: { overall: Math.round(sum / 9 * 100) / 100, items: pItems }, findings: [] } : null;
      const rubrics = lv >= 4 ? [
        { id: "syn_med_reconciliation", version: "v2", status: "ok", score: { pass: chance(0.8), points: ri(4, 8), max: 8 }, findings: chance(0.4) ? ["one medicine in the plan is not in the transcript"] : [] },
        { id: "syn_followup_clarity", version: "v1", status: "ok", score: { pass: chance(0.85), points: ri(2, 5), max: 5 }, findings: [] },
      ] : [];
      const jev = lv >= 4 && !jevFail ? JEVQ.map(q => ({ question: q, answer: chance(0.75) ? "yes" : chance(0.5) ? "no" : "unclear", probability: Math.round(rnd() * 100) / 100, raw: {} })) : null;
      const cdmss = cdmssOn ? (chance(0.5) ? [] : [{ severity: pick(["info", "warn", "info"]), finding: pick(["Dose within usual adult range", "Duplicate analgesic class not found", "Antibiotic course length is on the short side", "Interaction check: none found"]), detail: "synthetic CDMSS check " + pad(seq, 4) }]) : null;
      const rx = lv >= 3 ? { prescriptionUid: lv >= 5 ? rxUid : null, individualUid: lv >= 5 ? ind : null, signedText: lv >= 5 ? RX[sp].join("\n") : null, link: null } : null;
      const headline = [];
      if (note) headline.push({ label: "validator", value: valFail ? "2 err" : "ok" });
      if (pdqi) headline.push({ label: "PDQI-9", value: pdqi.score.overall.toFixed(1) });
      if (rubrics.length) headline.push({ label: "rubrics", value: rubrics.filter(r => r.score.pass).length + "/" + rubrics.length });
      const minutes = Math.round(len / 6) / 10;
      const layer = (ok, extra) => (ok ? { r2_key: "syn/layers/" + uid + "/" + extra, status: "ok" } : null);
      consults.push({
        consult_uid: uid, ist_date: date, doctor_uid: doc.uid, room_id: doc.room, t_open, t_close, source: chance(0.7) ? "cutter" : "caa",
        clip: { r2_key: "syn/clips/" + uid + ".opus", r2_status: "ok", signature_sha256: "syn_sig_" + uid, audio_sha256: null, bytes: Math.round(len * 3200), minutes },
        layers: { stt: layer(hasT, "stt"), translate: layer(hasT, "translate"), diar_sarvam: layer(lv >= 2 && !diarFail, "diar_sarvam"), diar_nemotron: null, role: layer(lv >= 2 && !diarFail, "role"), parts: layer(lv >= 4 && !jevFail, "parts") },
        freescript: lv >= 3 ? { artifact_id: "syn_art_" + uid, state: "stored" } : null,
        stages, first_gap, allowance: { earned_min: Math.round(minutes * 1.5 * 10) / 10, spent_min: Math.round(minutes * 10) / 10 },
        prescription: lv >= 5 ? { prescription_uid: rxUid, presc_state: "signed" } : null,
        doctor_name: doc.name, patient_name: patient, individual_uid: lv >= 5 ? ind : null, prescription_uid: lv >= 5 ? rxUid : null,
        catalog_version: 1, generated_at: new Date(base).toISOString(),
        specialty: sp, headline, lengthSec: len,
        transcript, ledger, note, pdqi, rubrics, jev, cdmss, rx,
      });
    }
  }
}
writeFileSync(out, JSON.stringify({ defaultRange: { from: "2026-09-09", to: "2026-10-13" }, consults }) + "\n");
const bytes = Buffer.byteLength(JSON.stringify({ consults }));
console.log("consults", consults.length, "bytes", bytes);
