'use client';

import { useState, useEffect } from 'react';
import { Info, X, ChevronDown, ChevronUp } from 'lucide-react';

type Props = {
  storageKey: string;
  title: string;
  body?: string;
  bullets: string[];
  defaultOpen?: boolean;
};

// Clarity: a slim, quiet, collapsed-by-default help line. Was a heavy sky-blue
// block that ate the top third of every page. Same props/API as before.
export default function HelpCard({ storageKey, title, body, bullets, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [dismissed, setDismissed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const d = localStorage.getItem(`help.${storageKey}.dismissed`);
    if (d === '1') setDismissed(true);
    const o = localStorage.getItem(`help.${storageKey}.open`);
    if (o === '1') setOpen(true);
    if (o === '0') setOpen(false);
    setHydrated(true);
  }, [storageKey]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (typeof window !== 'undefined') localStorage.setItem(`help.${storageKey}.open`, next ? '1' : '0');
  }
  function dismiss() {
    setDismissed(true);
    if (typeof window !== 'undefined') localStorage.setItem(`help.${storageKey}.dismissed`, '1');
  }

  if (!hydrated || dismissed) return null;

  return (
    <div className="mb-5 overflow-hidden rounded-xl border border-slate-200 bg-paper text-sm">
      <button onClick={toggle} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <Info className="h-4 w-4 shrink-0 text-brand" />
        <span className="flex-1 text-[13px] font-medium text-slate-700">{title}</span>
        {open ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
        <button
          onClick={(e) => { e.stopPropagation(); dismiss(); }}
          aria-label="Dismiss help"
          className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </button>
      {open && (
        <div className="border-t border-slate-100 bg-brand-faint/40">
          {body && (
            <p className="px-9 pt-3 leading-relaxed text-slate-600">{body}</p>
          )}
          <ul className="ml-9 list-disc space-y-1 py-3 pr-5 text-[13px] leading-relaxed text-slate-600">
            {bullets.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
