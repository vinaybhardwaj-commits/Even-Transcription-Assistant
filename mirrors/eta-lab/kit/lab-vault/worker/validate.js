// Key grammar and provenance validation for the lab vault. Pure functions, no Worker APIs,
// so node --test can drive them. Spec: SCHEMA.md.

const PRODUCERS = ["hist-bulk", "hist-miner", "vj", "production-export", "stt-parity"];
const RUN_ID = `(?:${PRODUCERS.join("|")})-(?:\\d{8}T\\d{4}-[0-9a-f]{7,40}|backfill-\\d{8})`;
const SEG = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const DATE = "\\d{4}-\\d{2}-\\d{2}";

const KEY_RUNS = new RegExp(`^runs/(${RUN_ID})/${SEG}/${DATE}/${SEG}\\.json$`);
const KEY_MANIFEST = new RegExp(`^manifests/(${RUN_ID})(\\.start)?\\.json$`);
const KEY_ADDENDUM = new RegExp(`^manifests/(${RUN_ID})\\.addendum\\.json$`);
const KEY_INDEX = /^index\/(?:windows-\d{8}\.(?:jsonl|parquet)|search-\d{8}\.jsonl|chunks-\d{8}\.jsonl)$/;

// Returns {kind, runId} for a valid key, or null. Any traversal-ish input is a null.
export function parseKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 512) return null;
  if (/[^A-Za-z0-9._\/-]/.test(key)) return null; // rules out %, \, spaces, control chars, unicode
  if (key.startsWith("/") || key.includes("//") || key.split("/").some((s) => s === "." || s === ".." || s.includes(".."))) return null;
  let m;
  if ((m = KEY_RUNS.exec(key))) return { kind: "run", runId: m[1] };
  if ((m = KEY_ADDENDUM.exec(key))) return { kind: "addendum", runId: m[1] };
  if ((m = KEY_MANIFEST.exec(key))) return { kind: "manifest", runId: m[1] };
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
