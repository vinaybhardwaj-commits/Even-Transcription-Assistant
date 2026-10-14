/**
 * lib/stewardship-ops-core.ts — the consult-ops pane's PURE half
 * (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, A4 / A7–A10; spec §4 D-ops-*).
 *
 * No DB, no clock, no next/*. Everything here takes what it needs as an argument.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE THREE RULES THIS FILE EXISTS TO MAKE STRUCTURAL, rather than to write down and hope.
 *
 * 1. OPS IS NOT A RANK (D-ops-not-rank). Wait, no-show, Rx-share, CSAT and TC adherence are not
 *    skill artefacts. They never sort the named-clinician leaderboard, never join NQI / CVI / open
 *    dangerous in a composite, and never write `physician_standing`. `sortBoardRows` lives in
 *    lib/stewardship-danger-core.ts and takes three fields; nothing in this file is one of them, and
 *    nothing here exports a comparator.
 *
 * 2. EVERY METRIC CARRIES ITS DENOMINATOR (acceptance #20). A rate is a `Rate`, and a `Rate` cannot
 *    be constructed without an `of`. `rate()` returns null for a zero denominator rather than a
 *    zero, because "0% of nothing" and "0% of four hundred" are different statements and only one of
 *    them is about a clinician.
 *
 * 3. A DECK-BASIS FIGURE NEVER TRAVELS ALONE (A7 / A8 / A10, the deck-basis rule). It is modelled as
 *    a FIELD OF its primary, not as a sibling: `TwoBasis` has `primary` and `deck`, so there is no
 *    shape in which a deck number can be read without the primary having been read first. It sorts
 *    nothing and feeds nothing.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE THREE GRAINS STAY THREE (D-ops-grain). A calendar BOOKING is not a Chart CONSULT is not an
 * audited NOTE. They have three different denominators and this file never lets one stand in for
 * another: `OpsRow` carries all three counts and every rate names which one it is over.
 */

// ── identity (D-ops-identity) ─────────────────────────────────────────────────────────────

/**
 * One `doctors` e-mail as db13 groups it: how many uids claim it, and (when exactly one does) that
 * uid. Ops keys on `employee_email` / `doctor_email`; stewardship keys on `doctors.uid`. The join
 * exists only when the e-mail is UNIQUE on `doctors`.
 */
export interface EmailMapRow { email: string; nUids: number; uid: string | null }

export interface EmailMap {
  /** lower-cased e-mail → the single `doctors.uid` that claims it. */
  unique: Map<string, string>;
  /** e-mails claimed by more than one uid. MEASURED: three pairs — Mahendra Jain, Srikanth K N,
   *  Vinit Oswal. They are known offenders, not a hypothetical. */
  duplicate: Set<string>;
}

/**
 * PURE — fail-closed by construction. A duplicate e-mail is put in `duplicate` and left OUT of
 * `unique`, so no lookup through this map can pick a winner. The stewardship board keys on
 * `doctors.uid`; an ops row that cannot reach one stays an ops row with no clinician, shown under
 * its own e-mail with a banner, never merged onto somebody.
 */
export function buildEmailMap(rows: readonly EmailMapRow[]): EmailMap {
  const unique = new Map<string, string>();
  const duplicate = new Set<string>();
  for (const r of rows ?? []) {
    const email = String(r?.email ?? '').trim().toLowerCase();
    if (!email) continue;
    const n = Number(r?.nUids ?? 0);
    const uid = String(r?.uid ?? '').trim();
    if (n === 1 && uid) unique.set(email, uid);
    else if (n > 1) { duplicate.add(email); unique.delete(email); }
  }
  return { unique, duplicate };
}

export type OpsJoinReason = 'joined' | 'duplicate_email' | 'no_doctor_row';

export function resolveOpsEmail(email: string, map: EmailMap): { uid: string | null; reason: OpsJoinReason } {
  const e = String(email ?? '').trim().toLowerCase();
  if (!e) return { uid: null, reason: 'no_doctor_row' };
  if (map.duplicate.has(e)) return { uid: null, reason: 'duplicate_email' };
  const uid = map.unique.get(e);
  return uid ? { uid, reason: 'joined' } : { uid: null, reason: 'no_doctor_row' };
}

// ── rates that cannot lose their denominator (acceptance #20) ─────────────────────────────

export interface Rate {
  /** The numerator. */
  n: number;
  /** The denominator. Always shown; a rate without one is not shown at all. */
  of: number;
  /** n/of as a percentage, or null when `of` is zero. NEVER 0 for an empty denominator. */
  pct: number | null;
}

export function rate(n: number, of: number): Rate {
  const num = Number.isFinite(n) ? n : 0;
  const den = Number.isFinite(of) ? of : 0;
  return { n: num, of: den, pct: den > 0 ? Math.round((100 * num) / den) : null };
}

/** How a rate is written when it is shown. The denominator is not optional here either. */
export function rateLabel(r: Rate | null | undefined): string {
  if (!r) return '—';
  return r.pct == null ? `— of ${r.of}` : `${r.pct}% (${r.n}/${r.of})`;
}

/**
 * A7 / A8 / A10 — a figure and its deck-basis replica, in ONE object. The deck value is a FIELD OF
 * the primary, which is what makes "never appears without its primary beside it" a fact about the
 * type rather than a rule about the JSX.
 */
export interface TwoBasis<T> {
  primary: T;
  /** The card's replica, computed live from the same tables. Reference only. */
  deck: T | null;
  /** Why the two differ, in the reader's language. Rendered with the deck figure, always. */
  deckNote: string;
}

export const DECK_NOTES = Object.freeze({
  rx: 'deck basis: the slide’s dpipe-join replica, over the same denominator. Its numerator is a strict subset of the primary’s — a prescription id found in the pipeline is by definition a prescription id that is present — so it reads EQUAL OR LOWER, never higher. Measured across the window: equal for 142 of 148 clinicians, lower for 6, higher for none. It is a reconciliation figure, not a second measurement.',
  csat: 'deck basis: the slide’s figure, which scores an unrated consult as zero. Zero is not a rating and this number is deflated by roughly the share of unrated consults.',
  tc: 'deck basis: the slide’s replica, which counts only patients on gmail addresses. It drops about 8% of otherwise measurable consults and biases the sample by e-mail domain.',
});

// ── the row (D-ops-grain — three grains, three denominators) ──────────────────────────────

export interface OpsRow {
  email: string;
  /** The `doctors.uid` this row joined to, or null with a named reason (D-ops-identity). */
  doctorUid: string | null;
  joinReason: OpsJoinReason;
  /** Display name, from the directory, ONLY when the e-mail resolved. Never a guess. */
  doctorName: string | null;

  // ── grain 1: calendar bookings ──
  booked: number;
  cancelled: number;
  patientNoShow: number;
  /** A9 — a new metric, labelled as such. Not a reconstruction of anything in card 8747. */
  doctorNoShow: number;
  rescheduled: number;
  /** Bookings that were neither cancelled, no-showed by either party, nor rescheduled. */
  completed: number;
  teleconsults: number;

  // ── grain 2: Chart CONSULTATION with a Pulse write ──
  chartConsults: number;

  // ── grain 3: canonical audited notes (the stewardship board's own denominator) ──
  auditedNotes: number;

  // ── the rates, each over a named denominator ──
  cancelRate: Rate;
  patientNoShowRate: Rate;
  doctorNoShowRate: Rate;
  tcShare: Rate;
  /** A7 — Rx present over COMPLETED consults, with the card's replica beside it. */
  rxShare: TwoBasis<Rate>;
  /** A8 — mean over RATED rows only, with n rated and the response rate. */
  csat: TwoBasis<{ mean: number | null; rated: Rate }>;
  /** A10 — schedule adherence, with telemetry coverage stated. */
  tcAdherence: TwoBasis<{ onTime: Rate; coverage: Rate }>;
  /** Wait, per the 28 Aug method. Median minutes over SAME-DAY hopped consults only. */
  wait: {
    medianMin: number | null;
    /** Consults whose token and call happened on one IST day — the only ones a wait means. */
    sameDay: Rate;
    /** Dropped because the check-in stamp was a previous-day booking copied forward. */
    previousDayStamps: number;
    /** Same-day waits over three hours: reported, never averaged in silently. */
    overThreeHours: number;
  };
}

/** A10's primary label — relabelled per the decision, because the old one claimed a patient-wait
 *  meaning the clock cannot support. */
export const TC_ADHERENCE_LABEL = 'TC schedule adherence (≤180s from scheduled start)';
export const TC_ADHERENCE_NOTE =
  'The clock runs from the SCHEDULED slot, not from the patient arriving: a doctor who joins on time to an empty room is on time, and one who joins four minutes after a patient who arrived ten minutes late is late. It measures schedule adherence, not waiting.';

/** The three grains, named on the surface so a reader cannot mistake one for another. */
export const GRAIN_NOTE =
  'Three grains, three denominators: a calendar BOOKING is not a Chart CONSULT is not an audited NOTE. A clinician with bookings and no audited notes appears here with an audited-note denominator of zero; a note with no Chart consult never invents a wait.';

/** The banner for a row whose e-mail could not reach exactly one `doctors.uid`. */
export const OPS_UNJOINED_BANNER =
  'This clinician’s ops e-mail does not resolve to exactly one clinician record, so these numbers are shown under the e-mail and are not attributed to anyone on the board above.';

export const OPS_NOT_A_RANK =
  'Operational measures. They are not skill artefacts: they never sort the board above, never join note-quality or the Care-Value Index in a combined index, and never write a stewardship standing.';

// ── assembly ──────────────────────────────────────────────────────────────────────────────

/** What each of the five db13 reads contributes, per e-mail. All optional: a failed read means that
 *  column is unknown, and unknown renders as an em-dash, never as a zero. */
export interface OpsInputs {
  calendar?: {
    booked: number; cancelled: number; patientNoShow: number; doctorNoShow: number;
    rescheduled: number; completed: number; teleconsults: number; rxPresent: number;
    rxPresentDeck: number;
  };
  csat?: { nRx: number; withFeedbackRow: number; nRated: number; meanRated: number | null; meanDeck: number | null };
  tc?: { measurable: number; onTime: number; measurableDeck: number; onTimeDeck: number };
  wait?: { chartConsults: number; sameDay: number; previousDayStamps: number; medianMin: number | null; overThreeHours: number };
  auditedNotes?: number;
}

const ZERO_RATE: Rate = Object.freeze({ n: 0, of: 0, pct: null });

/**
 * PURE — one ops row from whatever the reads returned. Absence is preserved as absence: a missing
 * input produces a zero-denominator rate, which renders as an em-dash, not as a zero percent.
 */
export function buildOpsRow(
  email: string,
  inputs: OpsInputs,
  map: EmailMap,
  nameOf: (uid: string) => string | undefined,
): OpsRow {
  const { uid, reason } = resolveOpsEmail(email, map);
  const c = inputs.calendar;
  const f = inputs.csat;
  const t = inputs.tc;
  const w = inputs.wait;

  const completed = c?.completed ?? 0;
  const booked = c?.booked ?? 0;

  return {
    email,
    doctorUid: uid,
    joinReason: reason,
    doctorName: uid ? (nameOf(uid) ?? null) : null,

    booked,
    cancelled: c?.cancelled ?? 0,
    patientNoShow: c?.patientNoShow ?? 0,
    doctorNoShow: c?.doctorNoShow ?? 0,
    rescheduled: c?.rescheduled ?? 0,
    completed,
    teleconsults: c?.teleconsults ?? 0,
    chartConsults: w?.chartConsults ?? 0,
    auditedNotes: inputs.auditedNotes ?? 0,

    cancelRate: c ? rate(c.cancelled, c.booked) : ZERO_RATE,
    patientNoShowRate: c ? rate(c.patientNoShow, c.booked) : ZERO_RATE,
    doctorNoShowRate: c ? rate(c.doctorNoShow, c.booked) : ZERO_RATE,
    tcShare: c ? rate(c.teleconsults, c.booked) : ZERO_RATE,

    // A7 — primary over COMPLETED consults; the replica is the card's dpipe join over the SAME
    // denominator. The replica's numerator is a strict subset of the primary's, so `deck <= primary`
    // always; a deck figure that exceeded its primary would mean the pipeline held a prescription
    // the event did not, which is not a thing that can be true.
    rxShare: {
      primary: c ? rate(c.rxPresent, completed) : ZERO_RATE,
      deck: c ? rate(c.rxPresentDeck, completed) : null,
      deckNote: DECK_NOTES.rx,
    },

    // A8 — the mean is over RATED rows only, and it never travels without n rated.
    csat: {
      primary: { mean: f?.meanRated ?? null, rated: f ? rate(f.nRated, f.nRx) : ZERO_RATE },
      deck: f ? { mean: f.meanDeck, rated: rate(f.withFeedbackRow, f.nRx) } : null,
      deckNote: DECK_NOTES.csat,
    },

    // A10 — adherence over the MEASURABLE denominator, with telemetry coverage stated beside it.
    tcAdherence: {
      primary: {
        onTime: t ? rate(t.onTime, t.measurable) : ZERO_RATE,
        coverage: t && c ? rate(t.measurable, c.teleconsults) : ZERO_RATE,
      },
      deck: t ? { onTime: rate(t.onTimeDeck, t.measurableDeck), coverage: t && c ? rate(t.measurableDeck, c.teleconsults) : ZERO_RATE } : null,
      deckNote: DECK_NOTES.tc,
    },

    wait: {
      medianMin: w?.medianMin ?? null,
      sameDay: w ? rate(w.sameDay, w.chartConsults) : ZERO_RATE,
      previousDayStamps: w?.previousDayStamps ?? 0,
      overThreeHours: w?.overThreeHours ?? 0,
    },
  };
}

/**
 * The pane's own ordering: by booking VOLUME, descending. Deliberately not by any rate, and
 * deliberately not exported as a comparator anyone could hand to the board — D-ops-not-rank means
 * this list's order must never become a judgement. Volume is a fact about how busy a clinic was.
 */
export function orderOpsRows(rows: readonly OpsRow[]): OpsRow[] {
  return [...rows].sort((a, b) => b.booked - a.booked || a.email.localeCompare(b.email));
}
