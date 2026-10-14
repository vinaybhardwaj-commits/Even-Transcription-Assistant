// Shared server-safe chrome for the IPD EPISODE audit surface (PRD §10). No 'use client' —
// everything here renders on the server, mirroring app/admin/ipd-audit/ui.tsx.
//
// ONE SEMANTIC RULE THIS FILE KEEPS. The episode engine produces a DIVERGENCE INDEX, not a
// care-value band. It deliberately does not import the A–E band palette (`bandColor` /
// `opd-audit-ui`) for its own number: borrowing another engine's colour vocabulary would make two
// different measurements look like one. The only band on this surface is the DISCHARGE ENGINE's,
// rendered as its own labelled chip.
import Link from 'next/link';

/** The verbatim label PRD §10 item 5 requires above the commentary block. */
export const OUTCOME_AWARE_NOTICE = 'This commentary was written with knowledge of the patient outcome. The scores above were not.';

/** The verbatim empty-findings copy (PRD §10). */
export const NO_DIVERGENCE_COPY = 'No divergence found against the expected course.';

/**
 * ⚠️ A NUMBER IS ONLY SHOWN WHEN THERE IS ONE TO SHOW.
 *
 * `divergence_index` counts down from 100, so an episode where no expectation was ever formed
 * scores 100 — identical to an admission that ran perfectly. That is the most dangerous output
 * this engine can produce, because a clinician reading 100 has no way to tell the two apart. When
 * `scoring_status` is anything but 'ok', this renders "not scorable" and says why, instead of a
 * figure someone might act on.
 */
/**
 * ⚠️ THE BAND IS WHAT IS REPORTED. THE NUMBER IS NOT SHOWN HERE, AND THAT IS A MEASUREMENT
 * DECISION, NOT A PRESENTATION ONE. `divergence_index` has a measured repeat-run spread on
 * identical input — five consecutive runs of one admission scored 40, 37, 36, 41, 36 — so a figure
 * on this row would claim a precision the engine cannot support, and two episodes five points
 * apart would look ranked when they are not distinguishable. The index is stored, and available on
 * drill-in labelled as internal with its spread stated.
 *
 * A number is also shown when there is NO number: `scoring_status` other than `ok` renders "not
 * scorable" and the reason, so an unscorable episode can never acquire a reassuring band.
 */
/**
 * ROUND 15 ITEM 1 — THE COUNTS TRAVEL WITH THE BAND, ALWAYS.
 *
 * The index is a RATE now (penalty over the worst this episode could have scored), and a rate on
 * its own is not enough to triage a worklist: two episodes can band identically while one holds
 * four findings and the other forty. The band says how this admission compares; these say how much
 * there is to read. V's instruction is that a clinician needs both and neither alone, so they are
 * rendered by the SAME component as the band rather than left to each surface to remember.
 */
export function DivergenceCounts({ penalty, evaluated, divergent }: {
  penalty: number | null; evaluated: number | null; divergent: number | null;
}) {
  if (penalty == null && evaluated == null && divergent == null) return null;
  return (
    <span className="inline-flex items-baseline gap-1 text-[10.5px] text-slate-500"
      title="The band is a rate — penalty over the worst this episode could have scored. These are the absolute figures it divides: how many divergent findings there are, out of how many expectations this engine could actually evaluate, and the penalty they carry.">
      <span className="tabular-nums font-medium text-slate-600">{divergent ?? 0}</span>
      <span>divergent of</span>
      <span className="tabular-nums font-medium text-slate-600">{evaluated ?? 0}</span>
      <span>evaluated · penalty</span>
      <span className="tabular-nums font-medium text-slate-600">{penalty ?? 0}</span>
    </span>
  );
}

export function DivergenceChip({ band, uncertain, status }: {
  band: string | null; uncertain?: boolean; status?: string | null;
}) {
  const st = status ?? 'ok';
  if (st !== 'ok' || !band) {
    const why = st === 'no_expectations' ? 'no checkpoint produced an expected course, so nothing could be measured'
      : st === 'incomplete_checkpoints' ? 'a checkpoint failed or produced no entries — part of the expected course is missing, so there is nothing to score against'
      : st === 'all_capped' ? 'every finding was capped — nothing survived at full weight'
      : 'no band was stored for this episode';
    return (
      <span className="inline-flex items-baseline gap-1" title={why}>
        <span className="text-[13px] font-semibold text-amber-700">not scorable</span>
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
          {st === 'ok' ? 'no band' : st.replace(/_/g, ' ')}
        </span>
      </span>
    );
  }
  const tone = band === 'substantial divergence' ? 'text-red-800'
    : band === 'moderate divergence' ? 'text-amber-800'
    : band === 'minor divergence' ? 'text-slate-700' : 'text-emerald-800';
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5"
      title="Reported as a band because the underlying index moves between runs on identical input — by a measured amount, which the band is wider than">
      <span className={`text-[13.5px] font-semibold ${tone}`}>{band}</span>
      {uncertain ? (
        <span className="text-[10.5px] font-medium text-amber-700"
          title="This episode's own penalty, moved by the repeat-run spread measured on identical input, would put it in a different band — so a re-run could land it either side of this line. Computed from this episode's figures, not from a fixed window: the same wobble matters less on an admission with more expectations to divide it across.">
          (near boundary)
        </span>
      ) : null}
    </span>
  );
}

/**
 * The raw index, on drill-in only, labelled for what it is. Never on the list.
 */
export function InternalIndex({ index, uncertain, penalty, evaluated }: {
  index: number | null; uncertain?: boolean; penalty?: number | null; evaluated?: number | null;
}) {
  if (index == null) return null;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5 text-[11px] text-slate-400">
      <span className="font-medium uppercase tracking-wide">Internal index</span>
      <span className="font-semibold tabular-nums text-slate-500">{index}</span>
      {/* ROUND 15: the arithmetic is shown, not asserted — a rate whose terms are hidden is a
          number a reader has to take on trust, and this one is new. */}
      {penalty != null && evaluated ? (
        <span className="tabular-nums text-slate-500">
          = 100 − 100 × {penalty} / (8 × {evaluated})
        </span>
      ) : null}
      {/* ⚠️ NO FIXED NUMBER HERE, DELIBERATELY (round 15). The spread was measured in PENALTY
          points, and as a rate it is worth a different number of index points on every episode —
          about one on a 51-expectation admission, less on a longer one. Quoting "±5" against the
          rate would overstate the noise fourfold; quoting any single figure would be wrong for
          every episode but one. What is true on all of them is the SHAPE of the claim. */}
      <span>
        moves between runs on identical input — not a per-case ranking
        {uncertain ? ', and this episode sits close enough to a band threshold that a re-run could cross it' : ''}
      </span>
    </span>
  );
}

/**
 * The sibling engine's score, ALWAYS labelled as its own (decision 14). A missing row is stated
 * plainly rather than shown as a zero — "not audited" and "scored zero" are different facts.
 */
export function DischargeEngineScore({ cvi, band }: { cvi: number | null; band: string | null }) {
  if (cvi == null) return <span className="text-[11.5px] text-slate-400">not audited by discharge engine</span>;
  return (
    <span className="inline-flex items-baseline gap-1" title="produced by the sibling ipd-discharge-audit/0.2 engine, not by this one">
      <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Discharge engine score</span>
      <span className="text-[13px] font-semibold tabular-nums text-slate-700">{cvi}{band ? ` · ${band}` : ''}</span>
    </span>
  );
}

export function EpisodeTabs({ active }: { active: 'episodes' }) {
  const tab = (href: string, key: string, label: string) => (
    <Link href={href} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${active === key ? 'bg-brand text-white' : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200'}`}>{label}</Link>
  );
  return (
    <div className="mt-4 flex items-center gap-2">
      {tab('/admin/ipd-audit', 'overview', 'Discharge audit')}
      {tab('/admin/ipd-audit/episodes', 'episodes', 'Episode audits')}
    </div>
  );
}

/** The admin unlock wall, mirroring the IPD surface's inline Locked idiom. */
export function Locked({ configured, bad }: { configured: boolean; bad?: boolean }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">IPD Episode Audit</h1>
      <p className="mt-2 text-sm text-slate-500">
        {configured ? 'This surface is access-controlled. Enter the admin token to continue.' : 'ADMIN_TOKEN is not configured on this deployment.'}
      </p>
      {bad && <p className="mt-2 text-xs text-red-600">That token didn’t match — try again.</p>}
      {configured && (
        <form method="POST" action="/api/admin/unlock" className="mt-5 flex justify-center gap-2">
          <input type="hidden" name="next" value="/admin/ipd-audit/episodes" />
          <input name="token" type="password" placeholder="Admin token" className="w-56 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <button className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white">Unlock</button>
        </form>
      )}
    </div>
  );
}

export function fmtDay(v: unknown): string {
  if (v == null) return '—';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtStamp(v: unknown): string {
  if (v == null) return 'time not recorded';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
