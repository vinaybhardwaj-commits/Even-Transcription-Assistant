// Key grammar and provenance validation for the lab vault. Pure functions, no Worker APIs,
// so node --test can drive them. Spec: SCHEMA.md.

const PRODUCERS = ["hist-bulk", "hist-miner", "vj", "production-export", "stt-parity"];
const RUN_ID = `(?:${PRODUCERS.join("|")})-(?:\\d{8}T\\d{4}-[0-9a-f]{7,40}|backfill-\\d{8})`;
const SEG = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const DATE = "\\d{4}-\\d{2}-\\d{2}";

const KEY_RUNS = new RegExp(`^runs/(${RUN_ID})/${SEG}/${DATE}/${SEG}\\.json$`);
const KEY_MANIFEST = new RegExp(`^manifests/(${RUN_ID})(\\.start)?\\.json$`);
const KEY_ADDENDUM = new RegExp(`^manifests/(${RUN_ID})\\.addendum\\.json$`);
// annotations/<kind>/<room_id>/<ist_date>/<YYYYMMDDHHMM>-<producer>.json : additive overlays on the immutable records
// (translations, readability flags, re-transcriptions); a new file per batch, never an edit.
const ANNOT_KINDS = ["translation", "readability", "retranscription", "correction", "selftest", "speaker"];   // r341: four kinds (correction folds in the old corrections/ idea); r375: + selftest (r369 spans) and speaker (337e labels)
export const CORRECTION_STATUSES = ["near_silence", "undetermined", "transcribed_unconfirmed"];   // what an owner may correct a NO_SIGNAL (exact-zero) mark to
const KEY_ANNOT = new RegExp(`^annotations/(${ANNOT_KINDS.join("|")})/(${SEG})/(${DATE})/(\\d{12})-([a-z][a-z0-9-]{1,39})\\.json$`);
// tapes/<room_id>/<ist_date>/<name>.webm|.opus : the room tape chunks (audio, patient data), a durable second copy of what is in eta-audio (r373).
// Write-once like everything else; never readable through any route of the viewer (it has none for this prefix).
const KEY_TAPE = new RegExp(`^tapes/(${SEG})/(${DATE})/(${SEG})\\.(webm|opus)$`);
export const TAPE_MAX_BYTES = 32 * 1024 * 1024;
const KEY_INDEX = /^index\/(?:windows-\d{8}\.(?:jsonl|parquet)|search-\d{8}\.jsonl|chunks-\d{8}\.jsonl|view-\d{12}\.jsonl)$/;

// Returns {kind, runId} for a valid key, or null. Any traversal-ish input is a null.
export function parseKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 512) return null;
  if (/[^A-Za-z0-9._\/-]/.test(key)) return null; // rules out %, \, spaces, control chars, unicode
  if (key.startsWith("/") || key.includes("//") || key.split("/").some((s) => s === "." || s === ".." || s.includes(".."))) return null;
  let m;
  if ((m = KEY_RUNS.exec(key))) return { kind: "run", runId: m[1] };
  if ((m = KEY_ANNOT.exec(key))) return { kind: "annotation", runId: null, annotKind: m[1], room: m[2], date: m[3], producer: m[5] };
  if ((m = KEY_ADDENDUM.exec(key))) return { kind: "addendum", runId: m[1] };
  if ((m = KEY_MANIFEST.exec(key))) return { kind: "manifest", runId: m[1] };
  if ((m = KEY_TAPE.exec(key))) return { kind: "tape", runId: null, room: m[1], date: m[2], ext: m[4] };
  if (KEY_INDEX.test(key)) return { kind: "index", runId: null };
  return null;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const STACK_PATHS = [
  ["whisper", "model"], ["whisper", "flags"],
  ["indic_conformer", "model_id"], ["indic_conformer", "git_head"],
  ["sravaani", "version"],
  ["router", "commit"], ["router", "config_sha256"],
];
const GUARD_KEYS = ["shim_anti_loop", "english_hallucination_guard", "transcript_guard", "loop_guard_number_rule"];

const present = (v) => v !== null && v !== undefined && v !== "";
const get = (o, path) => path.reduce((a, k) => (a && typeof a === "object" ? a[k] : undefined), o);

const textIn = (arr) => Array.isArray(arr) ? arr.some((x) => typeof x === "string" ? x.trim() : x && typeof x === "object" && [x.text, x.text_en, x.transcript].some((t) => typeof t === "string" && t.trim())) : arr != null && typeof arr === "object" && Object.keys(arr).length > 0;
const hasText = (d) => textIn(d.segments) || textIn(d.turns) || [d.transcript_native, d.transcript_en, d.transcript_native_collapsed].some((t) => typeof t === "string" && t.trim() !== "");

// Full provenance check, used for non-backfill runs and for backfill files that claim complete.
function fullProblems(p, isManifest, doc) {
  const bad = [];
  const notRun = Array.isArray(p.not_run) ? p.not_run : [];
  if (p.not_run !== undefined && (!Array.isArray(p.not_run) || notRun.some((n) => !["stack", "guards", "diarizer"].includes(n)))) bad.push("not_run must be a subset of stack|guards|diarizer");
  if (typeof p.created_at !== "string" || !ISO.test(p.created_at)) bad.push("created_at must be ISO-8601 with offset");
  // A flagged record (provenance_complete false + a reason + a non-empty `missing` list naming the gap) may carry a stack or guards block
  // that is ENTIRELY null (e.g. a Mini window while its stack file was unreadable). A partly filled block, or any complete record, is still enforced.
  const flagged = p.provenance_complete === false && typeof p.incomplete_reason === "string" && p.incomplete_reason.trim() !== "" &&
    Array.isArray(p.missing) && p.missing.length > 0 && p.missing.every((m) => typeof m === "string" && m.trim() !== "");
  const allNull = (o) => o === null || o === undefined || (typeof o === "object" && Object.values(o).every(allNull)) || o === "";
  // the ruling-196 marker sits inside the stack copy but is not stack content: ignore it when asking "is the whole block unknown?"
  const stackWithoutMarker = (() => { const c = JSON.parse(JSON.stringify(p.stack ?? null)); if (c?.whisper?.flags) delete c.whisper.flags.temperature_fallback; return c; })();
  // The flag must name what is absent: an excused block must be mentioned in `missing` (by its name, or via "stack_versions": stack and
  // guards both come from that published document, and the real Mini record says exactly "no published stack_versions for ...").
  const names = (blk) => flagged && p.missing.some((m) => { const t = m.toLowerCase(); return t.includes(blk) || t.includes("stack_versions"); });
  if (!notRun.includes("stack") && !(flagged && allNull(stackWithoutMarker) && names("stack"))) {
    for (const path of STACK_PATHS) if (!present(get(p.stack, path))) bad.push(`stack.${path.join(".")} missing`);
  }
  if (!notRun.includes("guards") && !(flagged && allNull(p.guards) && names("guards"))) {
    for (const k of GUARD_KEYS) if (!present(get(p.guards, [k]))) bad.push(`guards.${k} missing`);
  }
  if (!("diarizer" in p)) bad.push("diarizer key missing (null + not_run is allowed)");
  else if (p.diarizer === null) { if (!notRun.includes("diarizer")) bad.push("diarizer null requires not_run:[diarizer]"); }
  else if (!present(p.diarizer.name) || !present(p.diarizer.version)) bad.push("diarizer.name/version missing");
  if (typeof p.stack_versions_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.stack_versions_sha256)) bad.push("stack_versions_sha256 must be 64 hex");
  if (!isManifest) {
    // Empty is allowed only for a window the record itself says used no audio: cut.n_chunks === 0, ok === false,
    // and no text anywhere (segments, turns, transcript_native, transcript_en): a record cannot claim a transcript with no audio.
    const noAudio = doc?.cut?.n_chunks === 0 && doc.ok === false && !hasText(doc);
    if (!Array.isArray(p.source_audio_keys) || (p.source_audio_keys.length === 0 && !noAudio) || p.source_audio_keys.some((k) => typeof k !== "string" || !k)) bad.push("source_audio_keys must be a non-empty list of keys (empty only when cut.n_chunks is 0)");
  }
  return bad;
}

// Body rules for annotations/ (SCHEMA.md): an object with schema "eta-lab-annotation/1", kind equal to the key's, provenance.producer equal to the
// key's producer, items = a list of {k: window key "<run_id>/<room>/<date>/<window>", i: non-negative integer, ...} (at most 500,000 items),
// and `sources` = {<k>: sha256 of the run record runs/<k>.json} for EVERY distinct k in items (ruling 341: each file is bound to the source record
// sha; index.js compares each one to the stored object). Every k must be a valid run key in the same room and IST date as the file's key.
// kind=correction: items are {k, status, reason?} (window-level: i optional) with status in CORRECTION_STATUSES.
export const MAX_SOURCES = 400;
export function annotationProblems(bodyText, parsed) {
  let doc;
  try { doc = JSON.parse(bodyText); } catch { return ["body is not valid JSON"]; }
  const bad = [];
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return ["body must be a JSON object"];
  if (doc.schema !== "eta-lab-annotation/1") bad.push('schema must be "eta-lab-annotation/1"');
  if (doc.kind !== parsed.annotKind) bad.push("kind must equal the kind in the key");
  if (!doc.provenance || typeof doc.provenance !== "object" || doc.provenance.producer !== parsed.producer) bad.push("provenance.producer must equal the producer in the key");
  const correction = parsed.annotKind === "correction";
  if (!Array.isArray(doc.items) || doc.items.length === 0 || doc.items.length > 500000) { bad.push("items must be a non-empty list (max 500000)"); return bad; }
  if (parsed.annotKind === "selftest") return [...bad, ...selftestProblems(doc, parsed)];
  if (doc.items.some((x) => !x || typeof x !== "object" || typeof x.k !== "string" || !x.k || x.k.length > 300 || (correction ? (x.i !== undefined && !(Number.isInteger(x.i) && x.i >= 0)) : !(Number.isInteger(x.i) && x.i >= 0)))) bad.push(correction ? "every item needs k (string); i, if present, an integer >= 0" : "every item needs k (string) and i (integer >= 0)");
  if (correction && doc.items.some((x) => x && typeof x === "object" && (!CORRECTION_STATUSES.includes(x.status) || (x.reason !== undefined && (typeof x.reason !== "string" || x.reason.length > 300))))) bad.push(`every correction item needs status in ${CORRECTION_STATUSES.join("|")} (reason, if present, a string of at most 300 characters)`);
  if (parsed.annotKind === "speaker") { const w = doc.items.map(speakerItemProblem).find(Boolean); if (w) bad.push(w); }
  if (bad.length) return bad;
  const ks = new Set(doc.items.map((x) => x.k));
  const src = doc.sources;
  if (src === null || typeof src !== "object" || Array.isArray(src)) return [...bad, "sources object missing: {<k>: sha256 of the run record} for every k in items"];
  if (ks.size > MAX_SOURCES) return [...bad, `items refer to ${ks.size} distinct windows; at most ${MAX_SOURCES} per file, split the file`];
  for (const k of ks) {
    const rk = parseKey(`runs/${k}.json`);
    if (!rk || rk.kind !== "run") { bad.push("k is not a run window key <run_id>/<room>/<date>/<window>"); break; }
    const [, room, date] = k.split("/");
    if (room !== parsed.room || date !== parsed.date) { bad.push("k must be in the same room and IST date as the file's key"); break; }
    if (typeof src[k] !== "string" || !/^[0-9a-f]{64}$/.test(src[k])) { bad.push("sources[k] must be the 64-hex sha256 of the run record, for every k in items"); break; }
  }
  if (Object.keys(src).some((k) => !ks.has(k))) bad.push("sources lists a window that no item refers to");
  return bad;
}
// kind=speaker (r375, diar-lab's 337e labels; shape agreed with diar-lab #2175 and refuter-2 #2172). Item {k, i, speaker, conf?, seq?, mixed?, speech_s?}:
// speaker = 'A'..'Z' or 'S<n>' (a letter is WINDOW-LOCAL: 'A' in one window is not 'A' in another; consumers must never join letters across windows)
// or '?' = unlabeled (under 1.0 s of diarized speech; then no conf/seq/mixed); conf = purity 0..1; mixed = boolean (a second speaker holds a large share);
// seq = the speaker letters in time order inside the segment, 1..6, present only when mixed is true; speech_s = diarized speech seconds >= 0. No other field, no text.
const LETTER = /^(?:[A-Z]|S[0-9]{1,3})$/;
function speakerItemProblem(x) {
  const bad = "speaker items are {k, i, speaker ('A'..'Z', 'S<n>' or '?'), conf? (0..1), seq? (1..6 letters, only when mixed is true), mixed? (boolean), speech_s? (>= 0)}, nothing else; '?' takes no conf/seq/mixed";
  if (Object.keys(x).some((k) => !["k", "i", "speaker", "conf", "seq", "mixed", "speech_s"].includes(k))) return bad;
  if (typeof x.speaker !== "string" || !(x.speaker === "?" || LETTER.test(x.speaker))) return bad;
  if (x.speaker === "?" && ("conf" in x || "seq" in x || "mixed" in x)) return bad;
  if ("conf" in x && !(typeof x.conf === "number" && x.conf >= 0 && x.conf <= 1)) return bad;
  if ("mixed" in x && typeof x.mixed !== "boolean") return bad;
  if ("speech_s" in x && !(typeof x.speech_s === "number" && x.speech_s >= 0 && Number.isFinite(x.speech_s))) return bad;
  if ("seq" in x && !(x.mixed === true && Array.isArray(x.seq) && x.seq.length >= 1 && x.seq.length <= 6 && x.seq.every((l) => typeof l === "string" && LETTER.test(l)))) return bad;
  return null;
}
// kind=selftest (r369 item 4): the exact tape intervals of a room's mic self-test runs, so every consumer can drop what overlaps them.
// Not tied to a run record (the interval is in tape time, whichever windows cover it), so there is no `k`/`sources`; the binding is
// `source_sha256` = sha256 of the self-test run log line(s) the intervals come from. Items {run_id, t0, t1} with ISO times (offset required),
// t0 < t1, at most 1 hour long, and t0's IST date equal to the date in the key; a canary text is never stored here.
const ISO_OFF = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
function selftestProblems(doc, parsed) {
  const bad = [];
  if (typeof doc.source_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(doc.source_sha256)) bad.push("source_sha256 (64 lower-case hex, the sha256 of the self-test run log the intervals come from) is required");
  if (doc.items.length > 500) bad.push("at most 500 intervals per file");
  for (const x of doc.items.slice(0, 500)) {
    const ok = x && typeof x === "object" && typeof x.run_id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(x.run_id) && ISO_OFF.test(x.t0 ?? "") && ISO_OFF.test(x.t1 ?? "");
    if (!ok) { bad.push("every interval needs run_id (short id) and t0, t1 as ISO times with an offset"); break; }
    const a = Date.parse(x.t0), b = Date.parse(x.t1);
    if (!(a < b) || b - a > 3600000) { bad.push("t0 must be before t1, at most one hour apart"); break; }
    const ist = new Date(a + 19800000).toISOString().slice(0, 10);
    if (ist !== parsed.date) { bad.push("t0's IST date must equal the date in the key"); break; }
    if (Object.keys(x).some((k) => !["run_id", "t0", "t1", "note"].includes(k)) || (x.note !== undefined && (typeof x.note !== "string" || x.note.length > 200))) { bad.push("intervals hold only run_id, t0, t1 and an optional short note"); break; }
  }
  return bad;
}
export const annotationSources = (bodyText) => JSON.parse(bodyText).sources ?? {};

// Audio body rules for tapes/: an EBML/WebM header (1A 45 DF A3) or an Ogg page ("OggS", for .opus), and not more than TAPE_MAX_BYTES.
export function tapeProblems(bytes, parsed) {
  const b = bytes, webm = b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3, ogg = b.length > 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53;
  const bad = [];
  if (b.length > TAPE_MAX_BYTES) bad.push(`tape chunks are at most ${TAPE_MAX_BYTES} bytes`);
  if (parsed.ext === "webm" ? !webm : !(ogg || webm)) bad.push(parsed.ext === "webm" ? "body is not a WebM file (EBML header missing)" : "body is not an Ogg/WebM audio file");
  return bad;
}

// Returns a list of problems ([] = accept). `runId` is the run_id parsed from the key.
export function provenanceProblems(bodyText, runId, kind) {
  let doc;
  try { doc = JSON.parse(bodyText); } catch { return ["body is not valid JSON"]; }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return ["body must be a JSON object"];
  if (doc.schema !== "eta-lab-result/1") return ['schema must be "eta-lab-result/1"'];
  const p = doc.provenance;
  if (p === null || typeof p !== "object" || Array.isArray(p)) return ["provenance object missing"];
  const bad = [];
  if (kind === "addendum") {  // an immutable note about a finished run; never edits the run's own files
    if (p.run_id !== runId) bad.push("provenance.run_id must equal the run_id in the key");
    if (p.producer !== runId.replace(/-(\d{8}T\d{4}-[0-9a-f]+|backfill-\d{8})$/, "")) bad.push("provenance.producer must equal the producer in the key");
    const a = doc.addendum;
    if (a === null || typeof a !== "object" || Array.isArray(a) || typeof a.reason !== "string" || !a.reason.trim()) bad.push("addendum object with a reason is required");
    // optional convention: addendum.no_signal = {rule, window_ids:[...]} marks windows whose recording was digital silence (recording fault)
    if (a && typeof a === "object" && "no_signal" in a) {
      const n = a.no_signal;
      if (n === null || typeof n !== "object" || Array.isArray(n) || typeof n.rule !== "string" || !n.rule.trim() || !Array.isArray(n.window_ids) || n.window_ids.length === 0 || n.window_ids.length > 20000 || n.window_ids.some((w) => typeof w !== "string" || !w || w.length > 200)) bad.push("addendum.no_signal needs a rule string and a non-empty window_ids list of strings");
    }
    return bad;
  }
  if (p.run_id !== runId) bad.push("provenance.run_id must equal the run_id in the key");
  const producer = runId.replace(/-(\d{8}T\d{4}-[0-9a-f]+|backfill-\d{8})$/, "");
  if (p.producer !== producer) bad.push("provenance.producer must equal the producer in the key");
  if (typeof p.provenance_complete !== "boolean") bad.push("provenance_complete must be boolean");
  if (kind === "run" && doc.segments != null && !Array.isArray(doc.segments)) bad.push("segments must be an array (or null) when present");  // null is what the writers emit for a no-audio window
  const backfill = runId.includes("-backfill-");
  if (!backfill) {
    // Every required field is enforced either way. false is allowed only with a stated reason (e.g. a live stack-drift cross-check),
    // so a real transcript is saved and flagged instead of being left unsaved; the viewer shows it as "partial provenance".
    if (p.provenance_complete === false && !(typeof p.incomplete_reason === "string" && p.incomplete_reason.trim())) bad.push("provenance_complete false needs a non-empty provenance.incomplete_reason");
    bad.push(...fullProblems(p, kind === "manifest", doc));
  } else if (p.provenance_complete === true) {
    bad.push(...fullProblems(p, kind === "manifest", doc));
  }
  return bad;
}
