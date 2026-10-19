/**
 * lib/spine/artefact.ts — validation of the artefact REF a done report may carry (S6). Pure.
 */
import type { ArtefactReport } from "./jobs";

const ART_TOKEN_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const KEY_RE = /^[A-Za-z0-9_.\/-]{1,200}$/;
const noIdRun = (s: string) => !/[0-9]{8}/.test(s);
const ID_WORDS = new Set(["patient", "name", "phone", "uhid", "mrn", "aadhaar", "email", "doctor", "room", "uid", "enc"]);
const noIdWord = (s: string) => !s.toLowerCase().split(/[^a-z0-9]+/).some((t) => ID_WORDS.has(t));
/** object_key (F6): no 8-digit run and no identity word, in the directories and the lane part of the file name. A track file is `<layer>.<engine>__<version>__<cfg8>.json`; its box-generated
 *  version / cfg8 parts are validated elsewhere and may hold a digit run by chance (cfg8 is hex), so they are exempt from the digit screen. */
const keyClean = (k: string): boolean => {
  const i = k.lastIndexOf("/");
  const lane = k.slice(i + 1).split("__")[0] ?? "";
  return noIdRun(k.slice(0, i + 1) + lane) && noIdWord(k) && !/\d{4}-\d{2}-\d{2}/.test(k);
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

