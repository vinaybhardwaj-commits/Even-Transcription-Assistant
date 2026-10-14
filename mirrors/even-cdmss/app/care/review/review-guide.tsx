'use client';

/**
 * Review Mode — floating reviewer guide (PDF-context PRD §2.5). Round "?" button fixed bottom-right
 * (reviewing phase only) opens a right-side slide-in accordion FAQ. Self-contained: no fetches, no
 * new deps. Copy is HARDCODED VERBATIM from §2.5 (seven <details>, first open). `?` opens it (handled
 * by the parent's single key handler), Esc/✕/backdrop close it; while open the parent suspends the
 * review keys (open-state is lifted into review-session — this component never handles review keys,
 * only its own Escape-to-close).
 */
import { useEffect } from 'react';

/** All apostrophes/quotes live inside brace-expression strings, so no JSX unescaped-entity risk. */
export default function ReviewGuide({ open, onOpen, onClose }: { open: boolean; onOpen: () => void; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      {/* floating trigger */}
      <button type="button" onClick={onOpen} aria-label="Open reviewer guide (?)" title="How to review (?)"
        className="fixed bottom-5 right-5 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-slate-800 text-[20px] font-semibold text-white shadow-lg hover:bg-slate-900">
        ?
      </button>

      {open && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Review Mode guide">
          {/* backdrop */}
          <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} />
          {/* right-side slide-in panel */}
          <aside className="absolute right-0 top-0 flex h-full w-full max-w-[480px] flex-col bg-white shadow-2xl" style={{ fontFamily: 'system-ui, sans-serif' }}>
            <header className="flex items-start justify-between border-b border-slate-100 px-5 py-4">
              <div>
                <h2 className="text-[15px] font-semibold text-slate-900">{'Review Mode — how to review'}</h2>
                <p className="mt-0.5 text-[11.5px] text-slate-500">{'Press ? anytime · Esc closes · your labels are the gold standard'}</p>
              </div>
              <button type="button" onClick={onClose} aria-label="Close guide" className="ml-3 shrink-0 rounded-md px-2 py-1 text-[16px] text-slate-400 hover:bg-slate-100 hover:text-slate-700">✕</button>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-4 text-[13px] leading-relaxed text-slate-700">
              {/* 1 */}
              <details open className="border-b border-slate-100 py-2">
                <summary className="cursor-pointer text-[13.5px] font-semibold text-slate-900">{'What is this module for?'}</summary>
                <div className="mt-2 space-y-2">
                  <p>{'The audit engine reads every OPD note and raises findings — dosing gaps, low-value care, interaction alerts, documentation issues. Review Mode is where a clinician judges those findings, one per screen.'}</p>
                  <p className="rounded-lg bg-sky-50 px-3 py-2 text-[12.5px] text-sky-900">
                    {'Every tap you make is recorded as a permanent clinical label. Your labels do three things: measure how often the engine is right (its precision), correct it where it is wrong, and train Even'}{'’'}{'s own audit model. Nothing here scores the treating doctor — you are reviewing the '}<strong>{'engine'}{'’'}{'s'}</strong>{' work, on the note as written.'}
                  </p>
                </div>
              </details>

              {/* 2 */}
              <details className="border-b border-slate-100 py-2">
                <summary className="cursor-pointer text-[13.5px] font-semibold text-slate-900">{'The four verdicts (keys 1–4)'}</summary>
                <div className="mt-2 space-y-2">
                  <p><strong>{'True positive: '}</strong>{'The finding is correct and clinically fair for '}<strong>{'this'}</strong>{' note. The issue it describes is really there.'}</p>
                  <p><strong>{'Nitpick: '}</strong>{'Technically correct, but trivial — it would not meaningfully change care or documentation practice. Nitpicks count '}<strong>{'against'}</strong>{' engine precision, so don'}{'’'}{'t use this as a soft '}{'‘'}{'true'}{'’'}{'.'}</p>
                  <p><strong>{'False: '}</strong>{'The finding is wrong — the engine misread the drug, the context, or the note. A short reason is asked for: state the clinical fact that contradicts the finding. False reasons are the single most valuable text you write here; they drive engine fixes directly.'}</p>
                  <p><strong>{'Contested: '}</strong>{'Genuine clinical disagreement — a reasonable clinician could defend either side. Not an error, not clearly right. Contested items are excluded from precision and reviewed separately.'}</p>
                  <p className="rounded-lg bg-sky-50 px-3 py-2 text-[12.5px] text-sky-900">{'Unsure between False and Contested? Ask: '}{'‘'}{'would most peers agree the engine is wrong?'}{'’'}{' Yes → False. Split room → Contested.'}</p>
                </div>
              </details>

              {/* 3 */}
              <details className="border-b border-slate-100 py-2">
                <summary className="cursor-pointer text-[13.5px] font-semibold text-slate-900">{'Impact tag (key i, after a True positive)'}</summary>
                <div className="mt-2 space-y-2">
                  <p>{'Optional second tap on true positives only: '}<strong>{'Changes management'}</strong>{' — acting on this finding would alter what the doctor does (drug, dose, referral, follow-up). '}<strong>{'Chart hygiene'}</strong>{' — real, but affects documentation quality rather than the care itself. This separates '}{'‘'}{'the engine is right'}{'’'}{' from '}{'‘'}{'the engine matters'}{'’'}{' — the effectiveness axis of the programme.'}</p>
                </div>
              </details>

              {/* 4 */}
              <details className="border-b border-slate-100 py-2">
                <summary className="cursor-pointer text-[13.5px] font-semibold text-slate-900">{'Flagging what the audit missed (key m)'}</summary>
                <div className="mt-2 space-y-2">
                  <p>{'If the note (or prescription alongside) has a problem the engine did '}<strong>{'not'}</strong>{' raise, press '}<strong>{'m'}</strong>{', pick a category (1–7) and describe it in one line. Categories: documentation · note quality · appropriateness / low-value · prescribing safety · continuity · coding · other.'}</p>
                  <p className="rounded-lg bg-sky-50 px-3 py-2 text-[12.5px] text-sky-900">{'Missed findings are how the engine grows new checks — be specific: '}{'‘'}{'no weight recorded for a paediatric dose'}{'’'}{' beats '}{'‘'}{'dosing incomplete'}{'’'}{'.'}</p>
                </div>
              </details>

              {/* 5 */}
              <details className="border-b border-slate-100 py-2">
                <summary className="cursor-pointer text-[13.5px] font-semibold text-slate-900">{'Reviewing method — the discipline'}</summary>
                <ul className="mt-2 list-disc space-y-1.5 pl-5">
                  <li><strong>{'Judge the note as written'}</strong>{', not what the doctor probably meant. If it isn'}{'’'}{'t documented, it isn'}{'’'}{'t there.'}</li>
                  <li><strong>{'Use the prescription panel'}</strong>{' — most dosing and formulary calls can'}{'’'}{'t be judged from the finding text alone.'}</li>
                  <li><strong>{'Label independently.'}</strong>{' Some findings are shown to every reviewer on purpose (to measure agreement). Don'}{'’'}{'t confer before labelling.'}</li>
                  <li><strong>{'Skip honestly (key s)'}</strong>{' — if you can'}{'’'}{'t judge it, skip it. A skipped finding returns later; a guessed label pollutes the gold set.'}</li>
                  <li><strong>{'Be strict but fair.'}</strong>{' The bar you set here becomes the bar the engine — and the future Even model — must beat.'}</li>
                </ul>
              </details>

              {/* 6 */}
              <details className="border-b border-slate-100 py-2">
                <summary className="cursor-pointer text-[13.5px] font-semibold text-slate-900">{'Writing good reasons & notes'}</summary>
                <div className="mt-2 space-y-2">
                  <p>{'One or two sentences, clinical and specific. State the fact, not the feeling:'}</p>
                  <p><span className="font-medium text-emerald-700">{'Good: '}</span>{'Combination brand includes PPI — separate gastroprotection not required.'}</p>
                  <p><span className="font-medium text-emerald-700">{'Good: '}</span>{'Chronic T2DM on continued metformin; renal screen documented 2 wks prior in history.'}</p>
                  <p><span className="font-medium text-rose-600">{'Weak: '}</span>{'Seems fine to me.'}{' / '}{'Engine is being pedantic.'}</p>
                  <p className="text-[12.5px] text-slate-500">{'Your reason is read verbatim when the finding cluster is adjudicated — write it for the clinician who reviews it next.'}</p>
                </div>
              </details>

              {/* 7 */}
              <details className="py-2">
                <summary className="cursor-pointer text-[13.5px] font-semibold text-slate-900">{'All keyboard shortcuts'}</summary>
                <table className="mt-2 w-full text-[12.5px]">
                  <tbody>
                    {[
                      ['1–4', 'verdicts'], ['i', 'impact (after TP)'], ['m', 'missed'], ['s', 'skip (requeue)'],
                      ['⏎', 'next'], ['space', 'prescription panel'], ['?', 'this guide'], ['Esc', 'close/cancel'],
                    ].map(([k, v]) => (
                      <tr key={k} className="border-b border-slate-50 last:border-0">
                        <td className="w-20 py-1"><kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">{k}</kbd></td>
                        <td className="py-1 text-slate-600">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
