/**
 * lib/stt/tuning-fork.ts — the nightly drift canary (Build 1 §D, PRD §2 "Tuning fork").
 *
 * ONE PERMANENTLY FROZEN ~90 s CLIP, run through local Whisper every night. Its transcript hash
 * is the drift detector: if the hash changes, the transcriber changed underneath us, and every
 * measurement taken since the last matching run was made with a different instrument.
 *
 * WHY A HASH AND NOT A WER. A WER against the fork would need a gold reference, and the whole
 * programme starts gold-less (PRD §1.4). A hash needs nothing but the fork's own first answer,
 * so this works on day one and keeps working while the gold set is still being argued about. It
 * cannot say the transcript got WORSE — only that it CHANGED, which is the question a canary is
 * for.
 *
 * WHY IT IS FREE. Local Whisper on the Mini, one ~90 s clip a night. No paid engine is involved
 * and no operator has to trigger it, which is why the PRD could say yes to it without touching
 * the "paid runs are operator-triggered" rule.
 *
 * THE CLIP MAY NOT EXIST YET. Freezing it is an operator action (§6 E2) and this build ships
 * before it. An absent clip is a CLEAN NO-OP with a log line — not an error, not an alarm, and
 * emphatically not a stored reference of the empty string, which would make the first real clip
 * look like drift the day it arrives.
 */

import { createHash } from "node:crypto";

/** The frozen clip's R2 key. A change of clip is a NEW FORK WITH A NEW ID (PRD §2), never an
 *  overwrite of this key — overwriting would silently re-baseline the instrument. */
export const TUNING_FORK_R2_KEY = "probe/tuning-fork-v1";

/** The fork's own id, carried on every row so a v2 fork's rows can never be compared to v1's. */
export const TUNING_FORK_ID = "tuning-fork-v1";

export const ALARM_KIND_REFERENCE = "TUNING_FORK_REFERENCE";
export const ALARM_KIND_DRIFT = "TUNING_FORK_DRIFT";

/**
 * PURE — the text a hash is taken over.
 *
 * Lowercase, strip everything that is not a letter, a NUMBER or a COMBINING MARK, collapse
 * whitespace. This is
 * deliberately the same rule as `normalizeForWer` in wer.ts, restated here rather than imported:
 * wer.ts internals are UNTOUCHED by this build's file contract, and a canary that breaks because
 * somebody legitimately retuned the scoring normaliser would be a false alarm about the
 * transcriber. The two rules are allowed to drift apart; this one is pinned to the fork.
 *
 * WHY NORMALISE AT ALL. Punctuation and capitalisation are the least stable things whisper.cpp
 * emits and the least interesting for drift. A canary that fires on a comma would be silenced
 * within a week, and a silenced canary is worse than none.
 */
export function normalizeForkText(s: string | null | undefined): string {
  if (typeof s !== "string") return "";
  return s
    .toLowerCase()
    // \p{M} IS LOAD-BEARING AND WAS MISSING. Devanagari vowel signs (ो, ी, ्) are combining
    // MARKS, not letters, so a class of letters-and-numbers alone silently strips them: "रोगी को
    // दर्द है" normalised to "र ग क दर द ह". That is not a cosmetic loss — it deletes the
    // difference between words, so an Indic fork clip would hash the same after a real
    // transcription change and the canary would sit silent through the drift it exists to catch.
    // Caught by the test that reads a Devanagari string back unchanged.
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** PURE — the fork's fingerprint. */
export function forkHash(transcript: string | null | undefined): string {
  return createHash("sha256").update(normalizeForkText(transcript), "utf8").digest("hex");
}

export type ForkOutcome =
  /** No clip at R2 yet — the operator has not frozen one. Clean no-op. */
  | { kind: "absent" }
  /** First run: the reference is now stored and there is nothing to compare against yet. */
  | { kind: "reference_stored"; sha256: string }
  /** The hash matches the stored reference. The instrument has not moved. */
  | { kind: "match"; sha256: string }
  /** The hash does not match. An alarm row was written. */
  | { kind: "drift"; sha256: string; reference_sha256: string }
  /**
   * The clip exists but could not be transcribed. NOT DRIFT — a dead transcriber is a different
   * fact from a changed one, and raising DRIFT for an outage would make the alarm mean two
   * things and therefore nothing. Reported, never alarmed.
   */
  | { kind: "unavailable"; error: string };

/**
 * The fork step, with its I/O injected so the whole decision tree is testable without R2, a
 * database or a Mac Mini.
 *
 * ORDER, AND WHY. Existence is checked BEFORE transcription so an absent clip costs no
 * inference. The reference is read BEFORE the alarm is written so a first run cannot alarm
 * against itself.
 */
export async function runTuningFork(io: {
  /** Bytes of the frozen clip, or null when there is no such object. */
  fetchClip: () => Promise<Uint8Array | null>;
  /** Local Whisper. */
  transcribe: (audio: Buffer) => Promise<{ ok: boolean; transcript?: string; error?: string }>;
  /** The OLDEST stored reference hash, or null on the very first run. */
  readReference: () => Promise<string | null>;
  /** Append a row to stt_canary_alarm. */
  writeAlarm: (kind: string, detail: Record<string, unknown>) => Promise<void>;
  log?: (msg: string) => void;
}): Promise<ForkOutcome> {
  const log = io.log ?? (() => {});

  const bytes = await io.fetchClip();
  if (!bytes || bytes.length === 0) {
    // The one line the spec asks for. No row, no alarm, no reference.
    log(`[tuning-fork] no clip at ${TUNING_FORK_R2_KEY} — nothing to compare, skipping (this is normal until the fork is frozen, PRD §6 E2)`);
    return { kind: "absent" };
  }

  const r = await io.transcribe(Buffer.from(bytes));
  if (!r.ok) {
    const error = r.error ?? "whisper_failed";
    log(`[tuning-fork] clip present but Whisper did not answer: ${error} — reported, NOT alarmed (an outage is not drift)`);
    return { kind: "unavailable", error };
  }

  const sha256 = forkHash(r.transcript ?? "");
  const reference = await io.readReference();

  if (reference === null) {
    await io.writeAlarm(ALARM_KIND_REFERENCE, {
      fork_id: TUNING_FORK_ID,
      r2_key: TUNING_FORK_R2_KEY,
      sha256,
      text_length: normalizeForkText(r.transcript ?? "").length,
    });
    log(`[tuning-fork] first run — reference stored (${sha256.slice(0, 12)}…)`);
    return { kind: "reference_stored", sha256 };
  }

  if (reference === sha256) {
    // A match writes NOTHING. A nightly "all is well" row would bury the alarms it exists to
    // surface under three hundred rows of nothing happening a year.
    log(`[tuning-fork] match (${sha256.slice(0, 12)}…)`);
    return { kind: "match", sha256 };
  }

  await io.writeAlarm(ALARM_KIND_DRIFT, {
    fork_id: TUNING_FORK_ID,
    r2_key: TUNING_FORK_R2_KEY,
    sha256,
    reference_sha256: reference,
    text_length: normalizeForkText(r.transcript ?? "").length,
  });
  log(`[tuning-fork] DRIFT — ${reference.slice(0, 12)}… → ${sha256.slice(0, 12)}…`);
  return { kind: "drift", sha256, reference_sha256: reference };
}
