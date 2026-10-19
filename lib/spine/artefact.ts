/**
 * lib/spine/artefact.ts — validation of the artefact REF a done report may carry (S6). Pure.
 */
import type { ArtefactReport } from "./jobs";

const ART_TOKEN_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const KEY_RE = /^[A-Za-z0-9_.\/-]{1,200}$/;
const noIdRun = (s: string) => !/[0-9]{8}/.test(s);
const ID_WORDS = new Set(["patient", "name", "phone", "uhid", "mrn", "aadhaar", "email", "doctor", "room", "uid", "enc"]);
const noIdWord = (s: string) => !s.toLowerCase().split(/[^a-z0-9]+/).some((t) => ID_WORDS.has(t));
const noDate = (s: string) => !/\d{4}-\d{2}-\d{2}/.test(s);
const fullyClean = (s: string) => noIdRun(s) && noIdWord(s) && noDate(s);
/** The lanes the box writes (clip_lanes.py LANES: layer.engine), closed. The cutter's own artefact is `consult.flac`. */
export const TRACK_LANES: readonly string[] = ["acoustics.room_profile_acoustics", "diar.nemotron", "stt.koyal", "stt.medasr"];
export const CUTTER_FILE = "consult.flac";
const TRACK_RE = new RegExp(`^(${TRACK_LANES.map((l) => l.replace(/\./g, "\\.")).join("|")})__([A-Za-z0-9.-]{1,40})__([0-9a-f]{8})\\.json$`);
/** object_key (F6): a path whose file name is the closed REAL track shape `{layer}.{engine}__{version}__{cfg8}.json` (writer.track_filename) or `consult.flac` keeps only a word and date screen on
 *  the file name (the version is a box-generated revision and cfg8 is hex, so either may hold a digit run by chance). Every other part (directories, any free file name) gets the full
 *  identity-word, date and 8-digit screens. */
const keyClean = (k: string): boolean => {
  const parts = k.split("/");
  const file = parts.pop() ?? "";
  if (!parts.every((p) => p !== "" && fullyClean(p))) return false;
  if (file === CUTTER_FILE) return true;
  const m = TRACK_RE.exec(file);
  return m ? noIdWord(m[2]!) && noDate(m[2]!) : fullyClean(file);
};

/** An artefact REF: tokens only, no `..`; engine and bucket carry no 8-digit run (version / object_key are box-generated and may hold a hex revision). null = invalid. */
export function parseArtefact(a: unknown): ArtefactReport | null {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const x = a as Record<string, unknown>;
  const tok = (v: unknown) => typeof v === "string" && ART_TOKEN_RE.test(v) && noIdRun(v);
  if (!tok(x.engine) || typeof x.version !== "string" || !ART_TOKEN_RE.test(x.version)) return null;
  if (typeof x.cfg8 !== "string" || !/^[0-9a-f]{8}$/.test(x.cfg8)) return null;
  if (typeof x.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(x.sha256)) return null;
  if (x.store !== "r2" && x.store !== "neon" && x.store !== "box") return null;
  if (x.status !== "ok" && x.status !== "empty" && x.status !== "failed" && x.status !== "skipped") return null;
  for (const k of ["bucket", "object_key"] as const) {
    const v = x[k];
    if (v != null && !(typeof v === "string" && (k === "bucket" ? ART_TOKEN_RE : KEY_RE).test(v) && !v.includes("..") && (k === "object_key" ? keyClean(v) : noIdRun(v)))) return null;
  }
  return { engine: x.engine as string, version: x.version as string, cfg8: x.cfg8, store: x.store, status: x.status, sha256: x.sha256, bucket: (x.bucket as string | null | undefined) ?? null, object_key: (x.object_key as string | null | undefined) ?? null };
}

