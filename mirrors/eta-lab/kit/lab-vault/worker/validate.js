// Key grammar and provenance validation for the lab vault. Pure functions, no Worker APIs,
// so node --test can drive them. Spec: SCHEMA.md.

const PRODUCERS = ["hist-bulk", "hist-miner", "vj", "production-export", "stt-parity"];
const RUN_ID = `(?:${PRODUCERS.join("|")})-(?:\\d{8}T\\d{4}-[0-9a-f]{7,40}|backfill-\\d{8})`;
const SEG = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const DATE = "\\d{4}-\\d{2}-\\d{2}";

const KEY_RUNS = new RegExp(`^runs/(${RUN_ID})/${SEG}/${DATE}/${SEG}\\.json$`);
const KEY_MANIFEST = new RegExp(`^manifests/(${RUN_ID})(\\.start)?\\.json$`);
const KEY_INDEX = /^index\/(?:windows-\d{8}\.(?:jsonl|parquet)|search-\d{8}\.jsonl)$/;

// Returns {kind, runId} for a valid key, or null. Any traversal-ish input is a null.
export function parseKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 512) return null;
  if (/[^A-Za-z0-9._\/-]/.test(key)) return null; // rules out %, \, spaces, control chars, unicode
  if (key.startsWith("/") || key.includes("//") || key.split("/").some((s) => s === "." || s === ".." || s.includes(".."))) return null;
  let m;
  if ((m = KEY_RUNS.exec(key))) return { kind: "run", runId: m[1] };
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

// Full provenance check, used for non-backfill runs and for backfill files that claim complete.
function fullProblems(p, isManifest) {
  const bad = [];
  const notRun = Array.isArray(p.not_run) ? p.not_run : [];
  if (p.not_run !== undefined && (!Array.isArray(p.not_run) || notRun.some((n) => !["stack", "guards", "diarizer"].includes(n)))) bad.push("not_run must be a subset of stack|guards|diarizer");
  if (typeof p.created_at !== "string" || !ISO.test(p.created_at)) bad.push("created_at must be ISO-8601 with offset");
  if (!notRun.includes("stack")) {
    for (const path of STACK_PATHS) if (!present(get(p.stack, path))) bad.push(`stack.${path.join(".")} missing`);
  }
  if (!notRun.includes("guards")) {
    for (const k of GUARD_KEYS) if (!present(get(p.guards, [k]))) bad.push(`guards.${k} missing`);
  }
  if (!("diarizer" in p)) bad.push("diarizer key missing (null + not_run is allowed)");
  else if (p.diarizer === null) { if (!notRun.includes("diarizer")) bad.push("diarizer null requires not_run:[diarizer]"); }
  else if (!present(p.diarizer.name) || !present(p.diarizer.version)) bad.push("diarizer.name/version missing");
  if (typeof p.stack_versions_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.stack_versions_sha256)) bad.push("stack_versions_sha256 must be 64 hex");
  if (!isManifest) {
    if (!Array.isArray(p.source_audio_keys) || p.source_audio_keys.length === 0 || p.source_audio_keys.some((k) => typeof k !== "string" || !k)) bad.push("source_audio_keys must be a non-empty list of keys");
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
  if (p.run_id !== runId) bad.push("provenance.run_id must equal the run_id in the key");
  const producer = runId.replace(/-(\d{8}T\d{4}-[0-9a-f]+|backfill-\d{8})$/, "");
  if (p.producer !== producer) bad.push("provenance.producer must equal the producer in the key");
  if (typeof p.provenance_complete !== "boolean") bad.push("provenance_complete must be boolean");
  const backfill = runId.includes("-backfill-");
  if (!backfill) {
    if (p.provenance_complete !== true) bad.push("provenance_complete must be true for a non-backfill run");
    bad.push(...fullProblems(p, kind === "manifest"));
  } else if (p.provenance_complete === true) {
    bad.push(...fullProblems(p, kind === "manifest"));
  }
  return bad;
}
