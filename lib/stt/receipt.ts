/**
 * lib/stt/receipt.ts — who asked, and what bytes they asked about (Build 2 §B).
 *
 * PRD §2 defines a receipt as the fields that make a paid run auditable: initiator, initiated-via,
 * provider-returned engine version, and the audio key + byte range + sha256. This file owns the
 * three of those that are ours to produce (the fourth belongs to the provider) and the rule that
 * an actor may never be defaulted.
 *
 * ─── WHY A MISSING ACTOR IS A LOUD ERROR AND NOT A FALLBACK ───────────────────────────────
 * The obvious shape is `actor ?? "system"`. It is also the shape that destroys the thing being
 * built. The spend ledger exists to be the audited form of "paid runs happen only by operator
 * action"; a default silently files every run whose plumbing broke under a name that implies
 * nobody was responsible, and the ledger then reports a clean sheet whether or not the rule held.
 *
 * So `system:cron` is a value only an UNATTENDED path may pass, deliberately, and an attended
 * path that arrives with nothing gets a refusal before any paid call is made — not a placeholder.
 */

import { createHash } from "node:crypto";

/** The three doors a run can come through. Mirrors the CHECK on transcription_run.initiated_via. */
export type InitiatedVia = "mcp" | "admin_route" | "cron";

/** The literal every unattended path writes. Not a default — a value a caller must choose. */
export const SYSTEM_ACTOR = "system:cron";

/**
 * Who asked for a run, and through which door. Both required: a type that lets a caller supply
 * one without the other is a type that lets an admin id be filed as a cron run.
 */
export type RunActor = {
  actor: string;
  via: InitiatedVia;
};

const VIA_VALUES: readonly InitiatedVia[] = ["mcp", "admin_route", "cron"];

/**
 * PURE — is this a usable actor?
 *
 * An empty string is NOT usable, and that is the case this function exists for. The admin guards
 * at both HTTP edges do `String(c.admin_id ?? "")`, so a JWT that verifies but carries no
 * admin_id yields "" — a value that is truthy-adjacent enough to slip through a naive check and
 * would be written to the database as a receipt naming nobody.
 */
export function isUsableActor(actor: unknown): actor is string {
  return typeof actor === "string" && actor.trim().length > 0;
}

export function isValidVia(via: unknown): via is InitiatedVia {
  return typeof via === "string" && (VIA_VALUES as readonly string[]).includes(via);
}

/**
 * PURE — validate an actor at a call edge. Returns null when it is fine, or a reason string when
 * the caller must be refused.
 *
 * Used by the drain before it claims a window, so a broken edge costs nothing: no join, no
 * Whisper call, and above all no paid transcription.
 */
export function actorProblem(a: Partial<RunActor> | undefined | null): string | null {
  if (!a) return "actor_missing";
  if (!isUsableActor(a.actor)) return "actor_missing";
  if (!isValidVia(a.via)) return `via_invalid:${String(a.via ?? "")}`;
  // An unattended actor arriving through an attended door, or the reverse, means the plumbing is
  // crossed and the ledger would attribute a person's spend to the cron or vice versa.
  if (a.actor === SYSTEM_ACTOR && a.via !== "cron") return "system_actor_needs_cron_via";
  if (a.actor !== SYSTEM_ACTOR && a.via === "cron") return "cron_via_needs_system_actor";
  return null;
}

/**
 * The fingerprint of the exact bytes handed to an engine.
 *
 * WHOLE-OBJECT SEND, HONESTLY REPORTED. The room drain sends the entire joined clip, so the range
 * is [0, length). Recording it as a range anyway — rather than leaving it null because "it is
 * obviously the whole thing" — means a future partial send is a change of VALUES and not a change
 * of schema, and a reader never has to know which era a row came from to interpret it.
 */
export type AudioReceipt = {
  audio_r2_key: string | null;
  audio_byte_start: number;
  audio_byte_end: number;
  audio_sha256: string;
};

export function audioReceipt(key: string | null, bytes: Uint8Array | Buffer): AudioReceipt {
  return {
    audio_r2_key: key,
    audio_byte_start: 0,
    audio_byte_end: bytes.length,
    audio_sha256: createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
  };
}

/**
 * PURE — the provider-reported engine version, or null.
 *
 * ═══ THE BUILD 2 FLAG THAT MATTERS MOST ═══
 * `SttTranscribeResult` (lib/stt/types.ts) has NO engine-version field, and no adapter carries
 * one. For Sarvam — the only engine on the room path — the model string is something we SEND
 * (`lib/sarvam.ts` L177-178, `saaras:v2.5` / `saarika:v2.5`); the job-status response is never
 * parsed for a model, so there is nothing returned to copy.
 *
 * This function therefore returns null for every engine today, and that is the honest answer.
 * Filling it with the string we posted would be a typed provider label — the exact failure
 * `room-drain.ts` records having shipped twice, where "both times it hid a wrong provider for
 * months". A receipt that says the provider confirmed something it never said is worse than an
 * incomplete receipt, because the incomplete one refuses loudly.
 *
 * CONSEQUENCE, FLAGGED: `receipt_complete` names engine_version_reported, so it stays FALSE for
 * every room run until an adapter reports a version. Every pair therefore also refuses on
 * NO_RECEIPT. Closing this needs `SttTranscribeResult` to carry an optional engineVersion —
 * which Build 3 needs anyway for Gemini, whose spec already says the version is "copied verbatim
 * from the response model field". That edit is OUT of Build 2's file contract, so it is raised
 * here rather than made.
 */
export function providerEngineVersion(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;
  // Read defensively rather than by type: the day an adapter starts reporting one, this picks it
  // up without a change here, and until then it is null on every branch.
  for (const k of ["engineVersion", "engine_version", "modelVersion", "model_version"]) {
    const v = r[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}
