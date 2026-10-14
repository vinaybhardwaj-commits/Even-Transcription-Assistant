'use client';
import { useEffect, useState } from 'react';
import { initProgress, applySaved, type ProgressState } from '@/lib/opd-feedback-ux-core';

// Feature B (PRD §1B) — ambient "am I done here?" counter in the case-page sidebar. Seeded
// server-side from the current-state feedback the page already loads (triagedRefs = the finding_refs
// already triaged; total = findings with a finding_ref), then incremented live off the
// 'opd-feedback-saved' CustomEvent that FindingTriage / MissedFindingCapture dispatch. No polling,
// no fetch — server seed + event stream only; dedupe-by-findingRef lives in the pure core.
export function TriageProgress({ total, triagedRefs, missed }: { total: number; triagedRefs: string[]; missed: number }) {
  const [state, setState] = useState<ProgressState>(() => initProgress({ total, triagedRefs, missed }));

  useEffect(() => {
    const h = (e: Event) => {
      const detail = (e as CustomEvent).detail as { findingRef?: string; verdict?: string; scope?: string } | undefined;
      setState((s) => applySaved(s, detail || {}));
    };
    window.addEventListener('opd-feedback-saved', h);
    return () => window.removeEventListener('opd-feedback-saved', h);
  }, []);

  if (state.total === 0 && state.missed === 0) return null;
  const done = state.total > 0 && state.triaged >= state.total;
  return (
    <div className={`mt-2 border-t border-slate-100 pt-2 text-[11px] font-medium ${done ? 'text-emerald-600' : 'text-slate-500'}`}>
      {state.total > 0 && <>{done && <span className="mr-0.5">✓</span>}Triaged {state.triaged}/{state.total}</>}
      {state.missed > 0 && <span className={state.total > 0 ? 'text-slate-400' : ''}>{state.total > 0 ? ' · ' : ''}{state.missed} missed flag{state.missed > 1 ? 's' : ''}</span>}
    </div>
  );
}
