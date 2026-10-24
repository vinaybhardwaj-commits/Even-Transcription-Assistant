/**
 * Data-driven recut ends: the cutter found nothing to cut because of the DATA (no tape session, no tape, a silent or blind window), not because an engine failed.
 * Such a report still backs off and burns its attempt (dying at MAX_ATTEMPTS as before); only the breaker tick is skipped (S7a I1 precedent), so a run of them cannot open the stage breaker.
 *
 * Source of the codes: tools/eta-spine/executors.py _classify_recut. A cutter skip reason R becomes `skip_<R>` (transient: the tape may still arrive), except silent_audio and blind_room_day, which are permanent and bare.
 * The reasons R come from tools/eta-consult-cutter/cutter/run.py (skip_reason=) and cutter/state.py (no_tape_reason); tests/unit/spine-brk.test.ts pins both files against this list.
 * NOT data-driven (keep ticking, as does any unknown code): rc_*, killed, no_summary, cut_error, artefact_missing, timeout, spawn_failed, usage, not_selected, skip_unknown (an unparsed reason).
 * lock_busy and gpu_busy are contention, not data: unchanged here (they tick).
 */
export const DATA_DRIVEN_CODES: readonly string[] = [
  "silent_audio",                 // permanent: the audio will not change
  "blind_room_day",               // permanent: a held-out room-day
  "skip_no_session",              // no_tape_reason: recorder_off
  "skip_no_tape_unexplained",     // no_tape_reason: no overlapping room_audio_state row
  "skip_device_missing",          // no_tape_reason: device_missing
  "skip_power",                   // no_tape_reason: power / usb_power
  "skip_recut_coverage_lower",    // run.py: a re-cut with less tape than the original is refused
];

/** `no_tape_unexplained(<state>)` is sanitised by the runner's _token to `no_tape_unexplained_<state>_`: any state suffix is the same fact. */
const NO_TAPE_UNEXPLAINED_PREFIX = "skip_no_tape_unexplained_";

export function isDataDrivenCode(code: string | null | undefined): boolean {
  if (typeof code !== "string") return false;
  return DATA_DRIVEN_CODES.includes(code) || code.startsWith(NO_TAPE_UNEXPLAINED_PREFIX);
}
