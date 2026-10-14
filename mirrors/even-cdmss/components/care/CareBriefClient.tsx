'use client';

// Streams /api/ccb/brief/stream and shows a live heartbeat (the search-bar/progress UX) while
// the episode is assembled, result PDFs read, corpus retrieved, and the brief grounded — then
// renders the two-layer CcbBriefView. Reuses the shared NDJSON consumer.
import { useEffect, useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { consumeNdjson } from '@/lib/ndjson-client';
import CcbBriefView from './CcbBriefView';
import type { CcbEnvelope } from '@/lib/ccb-brief-core';

const STEPS: { key: string; label: string }[] = [
  { key: 'fetching', label: 'Assembling the episode' },
  { key: 'reading', label: 'Reading result documents' },
  { key: 'retrieving', label: 'Retrieving evidence' },
  { key: 'generating', label: 'Building the brief' },
  { key: 'finalizing', label: 'Finalizing' },
];

export default function CareBriefClient({ uid, fresh = false }: { uid: string; fresh?: boolean }) {
  const [stage, setStage] = useState<string>('fetching');
  const [msg, setMsg] = useState<string>('Starting…');
  const [env, setEnv] = useState<CcbEnvelope | null>(null);
  const [error, setError] = useState<string>('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; started.current = true;
    (async () => {
      try {
        const resp = await fetch(`/api/ccb/brief/stream?uid=${encodeURIComponent(uid)}${fresh ? '&fresh=1' : ''}`);
        if (!resp.ok) { setError(`Request failed (${resp.status})`); return; }
        await consumeNdjson(resp, (ev) => {
          if (ev.type === 'progress') { setStage(ev.stage); setMsg(ev.msg); }
          else if (ev.type === 'result') { setEnv(ev.data as CcbEnvelope); }
          else if (ev.type === 'error') { setError(ev.message); }
        });
      } catch (e) { setError(String((e as Error).message)); }
    })();
  }, [uid, fresh]);

  if (error) return <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-[13px] text-red-700">Couldn’t build the brief: {error}</div>;
  if (env) return <CcbBriefView env={env} />;

  const activeIdx = Math.max(0, STEPS.findIndex((s) => s.key === stage));
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-center gap-2 text-[13px] font-medium text-slate-700">
        <Search className="h-4 w-4 text-teal-600 animate-pulse" /> {msg}
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-teal-500 transition-all duration-500" style={{ width: `${((activeIdx + 1) / STEPS.length) * 100}%` }} />
      </div>
      <ol className="mt-3 space-y-1">
        {STEPS.map((s, i) => (
          <li key={s.key} className={`flex items-center gap-2 text-[12px] ${i < activeIdx ? 'text-slate-400' : i === activeIdx ? 'text-slate-800' : 'text-slate-300'}`}>
            {i === activeIdx ? <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-600" /> : <span className={`h-1.5 w-1.5 rounded-full ${i < activeIdx ? 'bg-teal-400' : 'bg-slate-200'}`} />}
            {s.label}
          </li>
        ))}
      </ol>
    </div>
  );
}
