'use client';

// Whole-person dossier for a care-manager call: identity + snapshot tiles + a timeline-first care
// spine (OPD visits, orders, diagnostics, radiology, surgery, HCU, IPD, IP events), newest first.
// Deterministic data from /api/ccb/dossier (no LLM here) — served off the P1 snapshot cache, so a
// repeat open is instant. Result PDFs open directly (GCS URLs are framable; verified on prod).
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, Phone, Hash, ArrowRight, Stethoscope, FlaskConical, Scan, BedDouble,
  ClipboardList, Scissors, HeartPulse, Activity, FileText, RefreshCw,
} from 'lucide-react';

type Kind = 'opd' | 'ipd' | 'diagnostic' | 'radiology' | 'order' | 'surgery' | 'hcu' | 'event';
interface TimelineItem {
  date: string | null;
  kind: Kind;
  title: string;
  subtitle: string | null;
  refUid: string | null;
  docUrl?: string; // absent on pre-v2 snapshots and on rows with no PDF
}
interface Dossier {
  member: { individualUid: string; name: string; gender: string | null; age: number | null; mobile: string | null; uhid: string | null; membershipId: string | null; allergies: string[] };
  snapshot: { opdVisits: number; ipdAdmissions: number; diagnostics: number; radiology: number; lastContact: string | null; medsLastVisit: number | null };
  timeline: TimelineItem[];
  latestEpisodeUid: string | null;
}

/**
 * Dot colour per kind. The four v2 kinds follow the kickoff (order=blue, surgery=pink, hcu=teal,
 * event=slate); `diagnostic` moved blue→indigo so it stays distinguishable from `order`.
 */
const KIND: Record<Kind, { label: string; badge: string; dot: string; icon: typeof Stethoscope }> = {
  opd:        { label: 'OPD visit',   badge: 'bg-teal-50 text-teal-800',     dot: 'bg-teal-500',   icon: Stethoscope },
  order:      { label: 'Order',       badge: 'bg-blue-50 text-blue-800',     dot: 'bg-blue-500',   icon: ClipboardList },
  diagnostic: { label: 'Diagnostic',  badge: 'bg-indigo-50 text-indigo-800', dot: 'bg-indigo-500', icon: FlaskConical },
  radiology:  { label: 'Radiology',   badge: 'bg-violet-50 text-violet-800', dot: 'bg-violet-500', icon: Scan },
  surgery:    { label: 'Surgery',     badge: 'bg-pink-50 text-pink-800',     dot: 'bg-pink-500',   icon: Scissors },
  hcu:        { label: 'Health check',badge: 'bg-teal-50 text-teal-700',     dot: 'bg-teal-400',   icon: HeartPulse },
  ipd:        { label: 'IPD',         badge: 'bg-amber-50 text-amber-800',   dot: 'bg-amber-500',  icon: BedDouble },
  event:      { label: 'IP event',    badge: 'bg-slate-100 text-slate-700',  dot: 'bg-slate-400',  icon: Activity },
};
/** A snapshot written by a future build could carry a kind this client doesn't know. Never crash. */
const UNKNOWN = { label: 'Record', badge: 'bg-slate-100 text-slate-700', dot: 'bg-slate-300', icon: Activity };

const prettyPhone = (m: string | null) => (m ? m.replace(/^(\+91)(\d{5})(\d{5})$/, '$1 $2 $3') : '');
const titleCase = (s: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');

/** 92 → "1m ago"; 7400 → "2h ago". */
function ageLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'just now';
  if (seconds < 60) return 'just now';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-[11.5px] text-slate-400">{label}</div>
      <div className="mt-0.5 text-[17px] font-semibold text-slate-800">{value}</div>
    </div>
  );
}

export default function MemberDossier({ individualUid }: { individualUid: string }) {
  const [d, setD] = useState<Dossier | null>(null);
  const [error, setError] = useState('');
  const [cached, setCached] = useState(false);
  const [stale, setStale] = useState(false);
  const [ageS, setAgeS] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();

  const load = useCallback(async (force: boolean) => {
    if (force) setRefreshing(true);
    setError('');
    try {
      const qs = `individual_uid=${encodeURIComponent(individualUid)}${force ? '&refresh=1' : ''}`;
      const resp = await fetch(`/api/ccb/dossier?${qs}`);
      const j = await resp.json();
      if (!resp.ok || !j.ok) { setError(j.error || `Request failed (${resp.status})`); return; }
      setD(j.dossier as Dossier);
      setCached(!!j.cached);
      setStale(!!j.stale);
      setAgeS(typeof j.snapshot_age_s === 'number' ? j.snapshot_age_s : null);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      if (force) setRefreshing(false);
    }
  }, [individualUid]);

  useEffect(() => { void load(false); }, [load]);

  if (error && !d) return <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-[13px] text-red-700">Couldn’t load the member record: {error}</div>;
  if (!d) return (
    <div className="mt-4 flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-5 text-[13px] text-slate-600">
      <Loader2 className="h-4 w-4 animate-spin text-teal-600" /> Assembling the member record…
    </div>
  );

  const m = d.member;
  const sourceChip = stale
    ? { cls: 'bg-amber-50 text-amber-800', text: `stale · source unreachable${ageS != null ? ` · ${ageLabel(ageS)}` : ''}` }
    : cached
      ? { cls: 'bg-teal-50 text-teal-700', text: `cached · refreshed ${ageS != null ? ageLabel(ageS) : 'recently'}` }
      : { cls: 'bg-slate-100 text-slate-600', text: 'live · from source' };

  return (
    <div className="mt-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[20px] font-semibold text-slate-900">{m.name}</h1>
            {(m.gender || m.age != null) && (
              <span className="text-[13px] text-slate-500">{[titleCase(m.gender), m.age != null ? `${m.age}y` : ''].filter(Boolean).join(' · ')}</span>
            )}
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] text-slate-500">Advisory — not a clinical record</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-slate-500">
            {m.mobile && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{prettyPhone(m.mobile)}</span>}
            {m.uhid && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{m.uhid}</span>}
            {m.membershipId && <span className="inline-flex items-center gap-1"><Hash className="h-3 w-3" />{m.membershipId}</span>}
          </div>
          {m.allergies.length > 0 && (
            <div className="mt-1.5 text-[12px] text-red-700">Allergies: {m.allergies.join(', ')}</div>
          )}
        </div>
        {d.latestEpisodeUid && (
          <button onClick={() => router.push(`/care/${encodeURIComponent(d.latestEpisodeUid!)}`)}
            className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-teal-600 px-3 py-2 text-[12.5px] font-medium text-white hover:bg-teal-700">
            Conversation brief <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="OPD visits" value={d.snapshot.opdVisits} />
        <Stat label="IPD admissions" value={d.snapshot.ipdAdmissions} />
        <Stat label="Diagnostics" value={d.snapshot.diagnostics} />
        <Stat label="Radiology" value={d.snapshot.radiology} />
        <Stat label="Last contact" value={d.snapshot.lastContact || '—'} />
      </div>

      <p className="mt-3 text-[11.5px] text-slate-400">
        Every encounter, order, report and admission on file, newest first. A briefed episode links straight to its
        conversation brief.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium uppercase tracking-wide text-slate-400">Care timeline</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] ${sourceChip.cls}`}>{sourceChip.text}</span>
        <button
          onClick={() => void load(true)}
          disabled={refreshing}
          className="ml-auto inline-flex items-center gap-1 text-[12px] text-teal-700 hover:text-teal-800 disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing…' : 'Refresh from source'}
        </button>
      </div>

      {error && d && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[12px] text-amber-800">
          Refresh failed ({error}) — showing the last good record.
        </div>
      )}

      {d.timeline.length === 0 && <div className="mt-3 text-[13px] text-slate-400">No records found for this member.</div>}

      <ol className="relative mt-3 pl-[22px]">
        {d.timeline.map((t, i) => {
          const K = KIND[t.kind] ?? UNKNOWN;
          const Icon = K.icon;
          const brief = t.kind === 'opd' && !!t.refUid;
          return (
            <li key={`${t.kind}-${t.date ?? 'na'}-${i}`} className="relative mb-3.5">
              <span className={`absolute -left-[22px] top-[7px] h-[13px] w-[13px] rounded-full border-[2.5px] border-white ring-[1.5px] ring-slate-300 ${K.dot}`} />
              <div className="rounded-xl border border-slate-200 bg-white px-3.5 py-3">
                <div className="text-[11.5px] text-slate-400">{t.date || 'undated'}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${K.badge}`}>
                    <Icon className="h-3 w-3" />{K.label}
                  </span>
                  <span className="text-[13.5px] font-medium text-slate-800">{t.title}</span>
                  {brief && (
                    <button
                      onClick={() => router.push(`/care/${encodeURIComponent(t.refUid!)}`)}
                      className="ml-auto inline-flex items-center gap-1 rounded-lg bg-teal-600 px-2.5 py-1 text-[11.5px] font-medium text-white hover:bg-teal-700"
                    >
                      Conversation brief <ArrowRight className="h-3 w-3" />
                    </button>
                  )}
                </div>
                {t.subtitle && <div className="mt-1 text-[12.5px] leading-relaxed text-slate-600">{t.subtitle}</div>}
                {t.docUrl && (
                  <div className="mt-2">
                    <a
                      href={t.docUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11.5px] text-slate-600 hover:bg-slate-100"
                    >
                      <FileText className="h-3 w-3" /> report
                    </a>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <p className="mt-4 text-[11.5px] text-slate-400">
        Advisory; not a clinician assessment. Identifiers shown to the care manager for the call are never sent to any
        model.
      </p>
    </div>
  );
}
