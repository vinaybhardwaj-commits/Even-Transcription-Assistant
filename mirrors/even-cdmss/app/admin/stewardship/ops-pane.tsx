/**
 * app/admin/stewardship/ops-pane.tsx — the consult-ops pane, the room's SECOND pane
 * (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, A4 / A7–A10; spec §4 D-ops-*).
 *
 * Same routes, same gate, same room. Not a new surface and not a clinician homepage.
 *
 * WHAT THIS PANE IS FORBIDDEN TO DO, and does not: sort the board above, contribute to a composite,
 * write a stewardship standing, or show a rate without its denominator. The first three are
 * properties of the code (nothing here is imported by the board's sort, and `physician_standing`
 * does not exist yet); the fourth is a property of the TYPE — a `Rate` cannot be built without an
 * `of`, and a deck-basis figure is a FIELD OF its primary, so neither can be rendered alone.
 */
import {
  rateLabel, GRAIN_NOTE, OPS_NOT_A_RANK, OPS_UNJOINED_BANNER, TC_ADHERENCE_LABEL, TC_ADHERENCE_NOTE,
  type OpsRow, type Rate,
} from '@/lib/stewardship-ops-core';
import type { OpsPane as OpsPaneData } from '@/lib/stewardship-ops';

const pct = (r: Rate) => rateLabel(r);

/** A cell that shows the primary and, beneath it, the deck-basis replica — never one without the
 *  other, and never the replica without the sentence that says why it differs. */
function TwoBasisCell({ primary, deck, note }: { primary: string; deck: string | null; note: string }) {
  return (
    <div className="text-right">
      <div className="text-slate-700">{primary}</div>
      {deck != null && (
        <div className="mt-0.5 text-[10.5px] text-slate-400" title={note}>deck {deck}</div>
      )}
    </div>
  );
}

export default function OpsPane({ data, scope }: { data: OpsPaneData; scope: string }) {
  const anyFailed = data.failed.length > 0;

  return (
    <div className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-serif text-[15px] font-semibold text-slate-900">Consult ops · {scope}</h2>
        <span className="text-[11px] text-slate-500">last {data.windowDays} IST days · live · card 8747 is not fetched</span>
      </div>
      <p className="mt-0.5 max-w-4xl text-[11.5px] text-slate-500">{OPS_NOT_A_RANK}</p>
      <p className="mt-1 max-w-4xl text-[11.5px] text-slate-500">{GRAIN_NOTE}</p>

      {anyFailed && (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
          Could not read: {data.failed.join(', ')}. Those columns are shown as unknown, not as zero.
        </p>
      )}
      {data.unjoined > 0 && (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
          {data.unjoined} row(s) here are not attributed to a clinician on the board above. {OPS_UNJOINED_BANNER}
          {data.duplicateEmails.length > 0 && ` ${data.duplicateEmails.length} e-mail(s) are shared by two clinician records and resolve to neither.`}
        </p>
      )}

      {data.rows.length === 0
        ? <p className="mt-3 text-[12px] text-slate-500">No consult activity in the window{anyFailed ? ' that could be read' : ''}.</p>
        : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[10.5px] uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2 font-medium">Clinician</th>
                  <th className="px-3 py-2 text-right font-medium" title="grain 1 — calendar bookings, every status">Booked</th>
                  <th className="px-3 py-2 text-right font-medium" title="grain 2 — Chart CONSULTATION rows with a Pulse write">Chart consults</th>
                  <th className="px-3 py-2 text-right font-medium" title="grain 3 — canonical audited notes, the board's own denominator">Audited notes</th>
                  <th className="px-3 py-2 text-right font-medium" title="median minutes from token open to being called, same IST day only">Real wait</th>
                  <th className="px-3 py-2 text-right font-medium">Cancelled</th>
                  <th className="px-3 py-2 text-right font-medium" title="status = NO_SHOW">Patient no-show</th>
                  <th className="px-3 py-2 text-right font-medium" title="status = DOCTOR_NO_SHOW — a NEW metric, not in card 8747">Doctor no-show <span className="normal-case text-slate-300">(new)</span></th>
                  <th className="px-3 py-2 text-right font-medium" title="teleconsults, identified by a resolved Meet URL">TC share</th>
                  <th className="px-3 py-2 text-right font-medium" title="prescription present, over completed consults">Rx present</th>
                  <th className="px-3 py-2 text-right font-medium" title="mean over RATED consults only, with the response rate beneath">CSAT</th>
                  <th className="px-3 py-2 text-right font-medium" title={TC_ADHERENCE_NOTE}>{TC_ADHERENCE_LABEL}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r: OpsRow) => (
                  <tr key={r.email} className="border-b border-slate-100 last:border-0 align-top hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800">{r.doctorName || r.email}</div>
                      {!r.doctorUid && (
                        <div className="text-[10.5px] text-amber-700">
                          {r.joinReason === 'duplicate_email' ? 'e-mail shared by two clinician records — unjoined' : 'no clinician record for this e-mail — unjoined'}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-600">{r.booked}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{r.chartConsults}</td>
                    <td className={`px-3 py-2 text-right ${r.auditedNotes === 0 ? 'text-slate-400' : 'text-slate-600'}`}>{r.auditedNotes}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="text-slate-700">{r.wait.medianMin == null ? '—' : `${r.wait.medianMin} min`}</div>
                      <div className="mt-0.5 text-[10.5px] text-slate-400" title="consults whose token and call fell on one IST day — the only ones a wait means">
                        {pct(r.wait.sameDay)} same-day
                      </div>
                      {r.wait.previousDayStamps > 0 && (
                        <div className="text-[10.5px] text-slate-400" title="a previous-day booking stamp copied onto check-in — lead time, not waiting">
                          {r.wait.previousDayStamps} prev-day stamp(s)
                        </div>
                      )}
                      {r.wait.overThreeHours > 0 && (
                        <div className="text-[10.5px] text-amber-700" title="same-day but over three hours: arrived early and sat, or left and came back — Chart cannot tell">
                          {r.wait.overThreeHours} over 3h
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-600">{pct(r.cancelRate)}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{pct(r.patientNoShowRate)}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{pct(r.doctorNoShowRate)}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{pct(r.tcShare)}</td>
                    <td className="px-3 py-2">
                      <TwoBasisCell primary={pct(r.rxShare.primary)} deck={r.rxShare.deck ? pct(r.rxShare.deck) : null} note={r.rxShare.deckNote} />
                    </td>
                    <td className="px-3 py-2">
                      <TwoBasisCell
                        primary={r.csat.primary.mean == null ? `— (${r.csat.primary.rated.n} rated)` : `${r.csat.primary.mean.toFixed(2)} · ${pct(r.csat.primary.rated)} rated`}
                        deck={r.csat.deck ? (r.csat.deck.mean == null ? '—' : r.csat.deck.mean.toFixed(2)) : null}
                        note={r.csat.deckNote}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <TwoBasisCell
                        primary={`${pct(r.tcAdherence.primary.onTime)} · telemetry ${pct(r.tcAdherence.primary.coverage)}`}
                        deck={r.tcAdherence.deck ? pct(r.tcAdherence.deck.onTime) : null}
                        note={r.tcAdherence.deckNote}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      <p className="mt-3 max-w-4xl text-[11px] text-slate-400">
        Real wait = same-IST-day token open → called into consult, per the 28 Aug method. It is not the slot, not days
        from booking, and not check-in to prescription (that mixes waiting with the consult itself). Previous-day
        check-in stamps are dropped from the median and counted separately. {TC_ADHERENCE_NOTE} “deck” figures are the
        existing slides’ replicas, computed live from the same tables for reconciliation only; they sort nothing and
        feed no stewardship standing. Doctor no-show is new work — card 8747 computes no such metric. Cancellation
        attribution reads the last element of the event history, which assumes that history is append-ordered.
      </p>
    </div>
  );
}
