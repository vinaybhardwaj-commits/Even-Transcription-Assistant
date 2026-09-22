/**
 * lib/mic-health.ts — is a microphone actually working? (Build 2 §2.3 and §2.4, D32/D36/D37)
 *
 * PURE. No I/O, no clock, no database. The caller hands in the pieces it already has. This file is
 * imported by the window writer, by the operator page's aggregation and by the room page, so it
 * must stay safe in a browser bundle.
 *
 * WHY THIS FILE EXISTS, and it is the worst thing found on 24 August.
 *
 * Cardiology's false "main microphone lost" fired at 12:25. From that moment the window writer
 * bound EVERY REMAINING WINDOW OF THE DAY to the spare microphone — sixteen of twenty — and never
 * switched back, because nothing clears that flag. The main microphone recorded perfectly
 * throughout. Cardiology's spare happened to be healthy, so the audio behind those windows is
 * real. ON A RIG WITH NO SPARE, OR ONE WRITING NEAR-SILENCE, the same fault would have handed four
 * hours of consultation to an empty microphone and returned nothing, with no error anywhere.
 *
 * So the rules below never trust a flag:
 *
 *   D37  The main microphone is dead only when the DEVICE IS REPORTED GONE, or when two
 *        consecutive full-length pieces come back tiny WHILE THE METER HEARD SOUND. Both are
 *        evidence. THE SILENCE WATCHDOG IS NOT AN INPUT TO THIS DECISION AT ALL — it produced two
 *        false alarms in one morning and bound sixteen windows to a spare.
 *
 *   D36  A piece is called faulty on size only when the level meter heard sound during it. A quiet
 *        room making small pieces is quiet, not broken. This is the only version of the size rule
 *        that cannot cry wolf on a slow afternoon, and it is why the meter and the size rule ship
 *        together.
 *
 *   D32  A room with one microphone is NORMAL, not degraded. Nothing here may assume a spare
 *        exists, and the absence of one is never a fault.
 *
 * SIZE IS RELATIVE, NEVER ABSOLUTE. Measured per five minutes on 24 August: 4.83 MB on the Home
 * Office rig, 8.2 MB on both clinic rigs, and 70 KB for the Home Office spare — a ratio of 68 to 1
 * between a working microphone and a dead one, and a ratio of 1.7 to 1 between two working ones on
 * different rigs. An absolute floor is therefore wrong on at least one rig in each direction. Each
 * microphone is judged against A BASELINE LEARNED FROM THAT ROOM'S OWN RECENT PIECES ON THAT SAME
 * MICROPHONE — a rule that needs only one microphone to work, which is the normal case.
 */

// ---------------------------------------------------------------------------
// Thresholds — settled, and every one of them lives here only
// ---------------------------------------------------------------------------

/**
 * How far below its own baseline a piece has to fall to count as tiny.
 *
 * A tenth. The observed failure was 68 to 1 and the observed spread between two HEALTHY rigs was
 * 1.7 to 1, so anywhere between about a third and a fiftieth separates them; a tenth sits in the
 * middle of that gap on a log scale. Deliberately nowhere near the healthy spread: a rig that
 * simply records quieter than another must never trip this.
 */
export const TINY_FRACTION = 0.1;

/**
 * How many consecutive tiny pieces before the microphone is called dead (D37).
 *
 * TWO, not one. A single small piece has innocent explanations — a rotation landing on a pause, a
 * browser hiccup, a piece cut short by a reload. Two in a row on a room the meter says is making
 * noise does not.
 */
export const TINY_RUN_TO_DIE = 2;

/**
 * The meter reading at or below which "the room was making noise" is not established.
 *
 * The same digital-zero threshold the silence watchdog uses (SILENCE_RMS in lib/bench-dual.ts),
 * repeated here as its own named constant rather than imported, because this module must stay
 * import-free for the browser bundles that pull it in — and because the two are the same number
 * for different reasons and either may move without the other.
 */
export const HEARD_SOUND_RMS = 0.0015;

/**
 * How many recent pieces the baseline is learned from.
 *
 * Enough to survive one odd piece, short enough to follow a room that changed microphone or
 * settings mid-day. At a five-minute rotation this is the last hour or so.
 */
export const BASELINE_PIECES = 12;

/** A piece shorter than this is not full-length and is never judged on size. */
export const FULL_LENGTH_FRACTION = 0.8;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The subset of a chunk row this module needs. A structural subset of the real row. */
export type MicPiece = {
  idx: number;
  source: "primary" | "backup";
  duration_ms: number;
  size_bytes: number | null;
  /** D36 — what the meter heard while this piece was recorded. NULL = not measured, NEVER silent. */
  peak_level?: number | null;
  avg_level?: number | null;
};

export type SizeVerdict = "ok" | "tiny" | "unknown";

export type MicHealth = {
  /** The learned baseline, in bytes per millisecond. Null when there is not enough evidence. */
  baseline_bytes_per_ms: number | null;
  /** Verdict on the newest judgeable piece. */
  newest: SizeVerdict;
  /** How many consecutive judgeable pieces at the end of the run came back tiny. */
  tiny_run: number;
  /** D37 — two consecutive tiny pieces WHILE THE METER HEARD SOUND. */
  proven_dead_by_size: boolean;
  /** How many pieces the baseline was learned from. */
  baseline_pieces: number;
};

/**
 * A number, or null — AND NULL/UNDEFINED ARE NULL, not zero.
 *
 * `Number(null)` is 0, which is the sort of coercion that turns "we did not measure this" into
 * "this measured zero". Both mistakes it would cause here are the ones this whole file exists to
 * prevent: a piece with no `size_bytes` would compute a rate of zero and be called TINY, and a
 * piece with no level would report that the meter heard silence rather than that there was no
 * meter. Absence is not a measurement.
 */
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * PURE — did the meter hear sound during this piece? (D36)
 *
 * THREE ANSWERS, NEVER TWO. `null` means the piece carries no level at all — an older kiosk, a
 * browser that refused an AudioContext, a piece recorded before this build. That is an absence of
 * evidence and it must never read as silence: every caller below treats null as "cannot judge"
 * and declines to call anything faulty, which is the direction that cannot invent a fault.
 */
export function heardSound(piece: MicPiece): boolean | null {
  const peak = num(piece.peak_level);
  const avg = num(piece.avg_level);
  if (peak === null && avg === null) return null;
  return Math.max(peak ?? 0, avg ?? 0) > HEARD_SOUND_RMS;
}

/**
 * PURE — bytes per millisecond for one piece, or null where it cannot be computed.
 *
 * A RATE, not a size, so a short piece and a long one are comparable. Without this, the last piece
 * of every rotation would look tiny purely for being short.
 */
export function rateOf(piece: MicPiece): number | null {
  const bytes = num(piece.size_bytes);
  const ms = num(piece.duration_ms);
  if (bytes === null || ms === null || ms <= 0) return null;
  return bytes / ms;
}

/**
 * PURE — the baseline for one microphone, learned from that room's own recent pieces on it.
 *
 * THE MEDIAN, not the mean. One 70 KB piece in a run of twelve drags a mean down by enough to make
 * the next healthy piece look marginal; the median ignores it entirely. That matters because the
 * whole point of the baseline is to keep working while a microphone is failing.
 *
 * THE PIECES BEING JUDGED ARE NOT EXCLUDED and they do not need to be: a median over twelve
 * survives two bad values by construction, which is exactly the run length D37 acts on.
 */
export function learnBaseline(pieces: readonly MicPiece[]): { rate: number | null; n: number } {
  const rates = pieces
    .slice(-BASELINE_PIECES)
    .map(rateOf)
    .filter((r): r is number => r !== null && r > 0)
    .sort((a, b) => a - b);
  if (rates.length === 0) return { rate: null, n: 0 };
  const mid = Math.floor(rates.length / 2);
  const rate = rates.length % 2 === 1 ? rates[mid]! : (rates[mid - 1]! + rates[mid]!) / 2;
  return { rate, n: rates.length };
}

/**
 * PURE — the health of ONE microphone in ONE session.
 *
 * `pieces` are that microphone's pieces in recording order. `isLastOfSession` marks the flush
 * piece, which is EXEMPT: a flush is legitimately 27 KB because it holds whatever was in the
 * recorder when somebody pressed stop, and judging it would raise a fault at the end of every
 * ordinary day — which is precisely the shape of the four alarms this build exists to remove.
 */
export function micHealth(pieces: readonly MicPiece[], opts: { lastIdxOfSession?: number | null } = {}): MicHealth {
  const lastIdx = opts.lastIdxOfSession ?? null;
  const { rate: baseline, n } = learnBaseline(pieces);
  if (baseline === null || baseline <= 0) {
    return { baseline_bytes_per_ms: null, newest: "unknown", tiny_run: 0, proven_dead_by_size: false, baseline_pieces: n };
  }

  // The longest duration seen is what "full length" means for this room — the rotation period is
  // a fact about the rig, not a number to hard-code.
  const longest = pieces.reduce((a, p) => Math.max(a, num(p.duration_ms) ?? 0), 0);

  const judgeable = pieces.filter((p) => {
    if (lastIdx !== null && p.idx === lastIdx) return false; // the flush piece is exempt
    const ms = num(p.duration_ms);
    if (ms === null || longest <= 0) return false;
    return ms >= longest * FULL_LENGTH_FRACTION; // only full-length pieces are judged
  });

  const verdictOf = (p: MicPiece): SizeVerdict => {
    const r = rateOf(p);
    if (r === null) return "unknown";
    return r < baseline * TINY_FRACTION ? "tiny" : "ok";
  };

  // The run of tiny pieces at the END of the list — a microphone that failed and stayed failed.
  // An `unknown` breaks the run rather than extending it: a piece we cannot measure is not
  // evidence of a fault.
  let tinyRun = 0;
  for (let i = judgeable.length - 1; i >= 0; i--) {
    if (verdictOf(judgeable[i]!) === "tiny") tinyRun++;
    else break;
  }

  // D37 — dead by size needs TWO consecutive tiny full-length pieces AND the meter to have heard
  // sound during them. `heardSound` returning null (no level recorded) is NOT sound: a piece with
  // no ear cannot convict a microphone, so a kiosk that never sends levels can never trip this.
  const tail = judgeable.slice(-tinyRun);
  const provenDead =
    tinyRun >= TINY_RUN_TO_DIE && tail.slice(-TINY_RUN_TO_DIE).every((p) => heardSound(p) === true);

  return {
    baseline_bytes_per_ms: baseline,
    newest: judgeable.length ? verdictOf(judgeable[judgeable.length - 1]!) : "unknown",
    tiny_run: tinyRun,
    proven_dead_by_size: provenDead,
    baseline_pieces: n,
  };
}

// ---------------------------------------------------------------------------
// THE BINDING RULE (§2.4, D33/D37)
// ---------------------------------------------------------------------------

/** Why a window was bound where it was. Reported so a person can always see the reason. */
export type BindReason =
  | "default_main"
  | "main_dead_spare_healthy"
  /** The main is gone, the spare has pieces and none of them is PROVEN tiny — but they carry no
   *  measurements, so "healthy" is unproven rather than established. See the asymmetry below. */
  | "main_dead_spare_unmeasured"
  | "main_dead_no_healthy_spare"
  | "no_spare_lane";

export type BindDecision = {
  source: "primary" | "backup";
  reason: BindReason;
  /** True only where a second device genuinely recorded something for this session. */
  spare_exists: boolean;
  main_proven_dead: boolean;
  spare_proven_healthy: boolean;
};

/**
 * PURE — which microphone answers a window. THE RULE THAT REPLACES THE FLAG.
 *
 * 1. Every window binds to the MAIN microphone by default.
 * 2. It may bind to a spare ONLY when the main is proven dead AND the spare is proven healthy —
 *    proven by piece size and continuity, never by a flag.
 * 3. D37 defines dead: the device was REPORTED GONE, or two consecutive full-length pieces came
 *    back tiny while the meter heard sound. THE SILENCE WATCHDOG IS NOT AN INPUT.
 * 4. A room with no second device HAS NO SPARE LANE. There is nothing to bind to and nothing to
 *    say about it.
 * 5. The absence of a spare is not a fault.
 *
 * WHAT IT REFUSES TO DO, and this is the whole fix: a `mic_primary_lost` event on its own — the
 * thing that bound sixteen of Cardiology's twenty windows to a spare on a day its main microphone
 * was recording perfectly — moves nothing. `deviceReportedGone` is passed by the caller from the
 * one loss reason that means the hardware actually vanished, and even that is not enough on its
 * own: the spare still has to be proven healthy, or the audio stays on the main where it is.
 */
export function decideBinding(input: {
  /** Pieces recorded on the main microphone, in order. */
  mainPieces: readonly MicPiece[];
  /** Pieces recorded on the spare, in order. Empty means the rig has no spare lane. */
  sparePieces: readonly MicPiece[];
  /**
   * Did the recording report the DEVICE as gone — track ended, or enumerateDevices no longer
   * lists it? This is the hardware half of D37. A silence trip is NOT this and must never be
   * passed here; the caller filters those out by reason.
   */
  deviceReportedGone: boolean;
  lastMainIdx?: number | null;
  lastSpareIdx?: number | null;
}): BindDecision {
  const spareExists = input.sparePieces.length > 0;
  const mainHealth = micHealth(input.mainPieces, { lastIdxOfSession: input.lastMainIdx ?? null });
  const mainDead = Boolean(input.deviceReportedGone) || mainHealth.proven_dead_by_size;

  // 4 — no second device, no spare lane. Nothing to decide and nothing to say.
  if (!spareExists) {
    return {
      source: "primary",
      reason: mainDead ? "main_dead_no_healthy_spare" : "no_spare_lane",
      spare_exists: false,
      main_proven_dead: mainDead,
      spare_proven_healthy: false,
    };
  }

  // 1 — the default, and the only branch most rooms ever take.
  if (!mainDead) {
    return { source: "primary", reason: "default_main", spare_exists: true, main_proven_dead: false, spare_proven_healthy: false };
  }

  // 2 — the main is proven dead. Now: is the spare fit to answer?
  //
  // THE ASYMMETRY HERE IS DELIBERATE, and it is the one place this file does not read D33
  // literally. D33 says a window binds to a spare only when the spare is "proven healthy". Read
  // strictly, a spare whose pieces carry no measurements — every piece recorded before this build,
  // and any piece from a browser that refused an AudioContext — is not proven anything, so the
  // window would stay on a microphone already proven DEAD and resolve to silence. That discards
  // the only recording of those minutes to satisfy a word.
  //
  // THE ARCHIVE WINS. Once the main is proven dead the spare is the only tape there is, so it is
  // refused only when it is PROVEN BAD — the Home Office spare's 70 KB against 4.8 MB for the same
  // five minutes. A spare that cannot be measured is used, and the reason recorded says the
  // health was unproven rather than claiming it was established.
  //
  // Note the safety direction is opposite on the two microphones, which is what makes the pair
  // safe: convicting the MAIN needs positive proof (two tiny pieces the meter heard sound
  // through), while refusing the SPARE needs positive proof too. Absence of evidence never moves
  // a window off a working microphone, and never throws away the only copy of a conversation.
  const spareHealth = micHealth(input.sparePieces, { lastIdxOfSession: input.lastSpareIdx ?? null });

  // THE RATIO BETWEEN THE TWO MICROPHONES, used HERE AND ONLY HERE.
  //
  // A spare judged against its OWN baseline cannot be caught when it is uniformly dead: the Home
  // Office spare wrote 70 KB for every piece, so measured against itself it looks perfectly
  // consistent, and "consistent" is exactly what a microphone recording nothing looks like. The
  // main's baseline is the second opinion that catches it — 4.83 MB against 70 KB, sixty-eight to
  // one — and this is the one place a second microphone is available to provide it.
  //
  // NEVER THE PRIMARY SIGNAL, and never used on the main microphone. Most rooms have one
  // microphone (D32), so a rule that needed two would not work where it is most needed; the main
  // is judged against its own history alone, and the ratio only ever refuses a spare.
  const mainBaseline = micHealth(input.mainPieces, { lastIdxOfSession: input.lastMainIdx ?? null }).baseline_bytes_per_ms;
  const spareBaseline = spareHealth.baseline_bytes_per_ms;
  const tinyAgainstMain =
    mainBaseline !== null && spareBaseline !== null && spareBaseline < mainBaseline * TINY_FRACTION;

  const spareProvenTiny = spareHealth.newest === "tiny" || spareHealth.tiny_run > 0 || tinyAgainstMain;
  const spareProvenHealthy = spareHealth.newest === "ok" && spareHealth.tiny_run === 0 && !tinyAgainstMain;

  if (spareProvenTiny) {
    return { source: "primary", reason: "main_dead_no_healthy_spare", spare_exists: true, main_proven_dead: true, spare_proven_healthy: false };
  }
  return {
    source: "backup",
    reason: spareProvenHealthy ? "main_dead_spare_healthy" : "main_dead_spare_unmeasured",
    spare_exists: true,
    main_proven_dead: true,
    spare_proven_healthy: spareProvenHealthy,
  };
}

/**
 * The loss reasons that mean the DEVICE ITSELF went away, as opposed to the room going quiet.
 *
 * `track_ended` is the browser saying the track died. `silence_device_missing` is the watchdog
 * having tripped AND enumerateDevices then confirming the device is no longer listed — the
 * confirmation is the evidence, not the trip.
 *
 * `silence` is deliberately absent and its absence is D37 in one line: a silence trip on a
 * present device is not evidence that anything is broken, and treating it as such cost Cardiology
 * four hours of transcription.
 */
export const DEVICE_GONE_REASONS: ReadonlySet<string> = new Set([
  "track_ended",
  "silence_device_missing",
  "device_missing",
  "device_missing_on_resume",
]);

/** PURE — did any loss event in this session report the DEVICE as gone? Flags alone never count. */
export function deviceReportedGone(events: ReadonlyArray<{ kind: string; payload?: unknown }>): boolean {
  for (const e of events) {
    if (e.kind !== "mic_primary_lost") continue;
    const p = e.payload;
    const reason =
      typeof p === "object" && p !== null && !Array.isArray(p)
        ? (p as Record<string, unknown>).reason
        : null;
    if (typeof reason === "string" && DEVICE_GONE_REASONS.has(reason)) return true;
  }
  return false;
}

export type ActiveMicAlert = "device_missing" | "digital_silence" | "encoder_stalled";

/**
 * The unresolved microphone fact at the end of an event stream.
 *
 * A restore clears every earlier loss. A bare historical loss must not keep a room red after the
 * microphone recovered, which is why callers pass events in time order instead of asking whether
 * a loss ever happened. Unknown reasons remain unknown rather than acquiring a new UI meaning.
 */
export function activeMicAlert(
  events: ReadonlyArray<{ kind: string; payload?: unknown }>,
): ActiveMicAlert | null {
  let activeReason: string | null = null;
  for (const event of events) {
    if (event.kind === "mic_primary_restored") {
      activeReason = null;
      continue;
    }
    if (event.kind !== "mic_primary_lost") continue;
    const payload =
      typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
        : null;
    activeReason = typeof payload?.reason === "string" ? payload.reason.toLowerCase() : null;
  }
  if (!activeReason) return null;
  if (DEVICE_GONE_REASONS.has(activeReason)) return "device_missing";
  if (activeReason.includes("encoder") && activeReason.includes("stall")) return "encoder_stalled";
  if (activeReason === "silence" || activeReason.includes("digital_silence")) return "digital_silence";
  return null;
}
