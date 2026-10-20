/**
 * lib/spine/artefact.ts — validation of the artefact REF a done report may carry (S6). Pure.
 */
import type { ArtefactReport } from "./jobs";

const ART_TOKEN_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const KEY_RE = /^[A-Za-z0-9_.\/-]{1,200}$/;
const noIdRun = (s: string) => !/[0-9]{8}/.test(s);
/** The lanes the box writes (clip_lanes.py LANES: layer.engine -> version form, closed). Versions: acoustics v<n>, nemotron the first 8 hex of the model revision, koyal box-t4-koyal-<n>. */
export const TRACK_LANES: Readonly<Record<string, RegExp>> = {
  "acoustics.room_profile_acoustics": /^v[0-9]{1,3}$/,
  "diar.nemotron": /^(v[0-9]{1,3}|[0-9a-f]{8})$/,
  "stt.koyal": /^box-t4-koyal-[0-9]{1,3}$/,
};
export const CUTTER_FILE = "consult.flac";
const TRACK_RE = /^([a-z]+\.[a-z_]+?)__([A-Za-z0-9-]+)__([0-9a-f]{8})\.json$/;
/** object_key (F6b): exactly `consult.flac`, or `tracks/{layer}.{engine}__{version}__{cfg8}.json` with layer.engine from the closed lane list, the version in that lane's form and cfg8 8 hex.
 *  Everything else is refused: no directories, no free file names, no free parts. */
const keyClean = (k: string): boolean => {
  if (k === CUTTER_FILE) return true;
  const parts = k.split("/");
  if (parts.length !== 2 || parts[0] !== "tracks") return false;
  const m = TRACK_RE.exec(parts[1]!);
  if (!m) return false;
  const ver = Object.prototype.hasOwnProperty.call(TRACK_LANES, m[1]!) ? TRACK_LANES[m[1]!] : undefined;
  return !!ver && ver.test(m[2]!);
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

