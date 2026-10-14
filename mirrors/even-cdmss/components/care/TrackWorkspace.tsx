'use client';

// CCB v2 — TRACK workspace. Additive to the member dossier: assign a member to a track, monitor
// several active tracks at once (tabs), see the track's panels + auto-evaluated expectations, and
// archive / transfer when done. Lifecycle state = /api/care/assignment; the track layer read =
// /api/care/workspace. Deterministic (no LLM). Matches the Clarity design system.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, Archive, ArrowRightLeft, RotateCcw, CheckCircle2, XCircle, AlertTriangle, Circle, ArrowRight } from 'lucide-react';

type TrackKey = 'fever' | 'posthosp' | 'aihs' | 'referral' | 'radiology' | 'postipd' | 'engagement' | 'unknown';
type ExpStatus = 'met' | 'gap' | 'watch' | 'manual';
interface Expectation { id: string; label: string; status: ExpStatus; detail: string }
interface FollowupItem { name: string; type: string | null; booked: boolean; completed: boolean }
interface Assignment { id: string; individual_uid: string; track: TrackKey; status: 'active' | 'archived'; anchor_ref: string | null; opened_at: string; closed_at: string | null; close_reason: string | null }
interface Catalog { key: TrackKey; label: string; short: string; anchor: string; deep: boolean }
interface FeverCtx { latestDay: number | null; latestTemp: number | null; symptoms: string[]; lastFormDate: string | null; recovered: boolean | null; trajectory: { date: string | null; day: number | null; temp: number | null }[]; prescriptionUid: string | null }
interface PosthospCtx { items: FollowupItem[]; nextFollowup: string | null; nextFollowupNote: string | null; prescriptionUrl: string | null }
interface AihsCtx { hba1c: number | null; hba1cDate: string | null; nextFollowup: string | null }
interface Workspace {
  individual_uid: string; auto_track: TrackKey; tracks_with_forms: TrackKey[];
  assignments: Assignment[]; active_tracks: TrackKey[];
  selected: { track: TrackKey; source: string; assignment_id: string | null; context: { fever?: FeverCtx; posthosp?: PosthospCtx; aihs?: AihsCtx }; expectations: Expectation[]; open_count: number; ready_to_archive: { ready: boolean; reason: string | null } };
  track_catalog: Catalog[];
}

const EXP_ICON: Record<ExpStatus, { I: typeof CheckCircle2; cls: string }> = {
  met: { I: CheckCircle2, cls: 'text-teal-600' },
  gap: { I: XCircle, cls: 'text-red-600' },
  watch: { I: AlertTriangle, cls: 'text-amber-600' },
  manual: { I: Circle, cls: 'text-slate-400' },
};
const REASONS: { v: string; label: string }[] = [
  { v: 'recovered', label: 'Recovered' }, { v: 'completed', label: 'Completed' },
  { v: 'no_longer_needed', label: 'No longer needed' }, { v: 'other', label: 'Other' },
];
const labelOf = (cat: Catalog[], k: TrackKey) => cat.find((c) => c.key === k)?.short || k;

export default function TrackWorkspace({ individualUid }: { individualUid: string }) {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const router = useRouter();
  const first = useRef(false);

  const load = useCallback(async (track?: TrackKey) => {
    setError('');
    try {
      const q = new URLSearchParams({ individual_uid: individualUid });
      if (track) q.set('track', track);
      const r = await fetch(`/api/care/workspace?${q.toString()}`);
      const j = await r.json();
      if (!r.ok || !j.ok) { setError(j.error || `Request failed (${r.status})`); return; }
      setWs(j.workspace as Workspace);
    } catch (e) { setError(String((e as Error).message)); }
  }, [individualUid]);

  useEffect(() => { if (first.current) return; first.current = true; void load(); }, [load]);

  async function mutate(payload: Record<string, unknown>, keepTrack?: TrackKey) {
    setBusy(true);
    try {
      const r = await fetch('/api/care/assignment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const j = await r.json();
      if (!r.ok || !j.ok) { setError(j.error || `Action failed (${r.status})`); }
      else { await load(keepTrack); }
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); setShowAssign(false); setShowArchive(false); setShowTransfer(false); }
  }

  if (error) return <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-[13px] text-red-700">Track workspace: {error}</div>;
  if (!ws) return (
    <div className="mt-6 flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-5 text-[13px] text-slate-600">
      <Loader2 className="h-4 w-4 animate-spin text-teal-600" /> Loading care tracks…
    </div>
  );

  const sel = ws.selected;
  const cat = ws.track_catalog;
  const selActive = ws.active_tracks.includes(sel.track);
  const tabTracks: TrackKey[] = Array.from(new Set<TrackKey>([...ws.active_tracks, ...(selActive ? [] : [sel.track])]));
  const deepCatalog = cat.filter((c) => c.deep);
  const archived = ws.assignments.filter((a) => a.status === 'archived');
  const transferTargets = deepCatalog.filter((c) => c.key !== sel.track && !ws.active_tracks.includes(c.key));

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] font-medium uppercase tracking-wide text-slate-400">Care tracks</div>
        <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[10.5px] font-medium text-teal-800">
          Suggested: {labelOf(cat, ws.auto_track)}
        </span>
      </div>

      {/* Tab bar of active tracks + assign */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {tabTracks.map((t) => {
          const active = t === sel.track;
          const isActiveAssign = ws.active_tracks.includes(t);
          return (
            <button key={t} onClick={() => load(t)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${active ? 'bg-white text-teal-700 shadow-sm ring-1 ring-slate-200' : 'bg-slate-100 text-slate-600 hover:text-teal-700'}`}>
              {labelOf(cat, t)}
              {!isActiveAssign && <span className="rounded-full bg-amber-100 px-1.5 text-[9.5px] text-amber-800">preview</span>}
            </button>
          );
        })}
        <div className="relative">
          <button onClick={() => setShowAssign((s) => !s)} className="inline-flex items-center gap-1 rounded-lg border border-dashed border-slate-300 px-2.5 py-1.5 text-[12px] text-slate-500 hover:border-teal-400 hover:text-teal-700">
            <Plus className="h-3.5 w-3.5" /> Assign track
          </button>
          {showAssign && (
            <div className="absolute z-10 mt-1 w-60 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
              {deepCatalog.map((c) => {
                const already = ws.active_tracks.includes(c.key);
                const suggested = c.key === ws.auto_track;
                const hasForms = ws.tracks_with_forms.includes(c.key);
                return (
                  <button key={c.key} disabled={already || busy}
                    onClick={() => mutate({ action: 'assign', individual_uid: individualUid, track: c.key, opened_by: 'care' }, c.key)}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[12.5px] ${already ? 'cursor-default text-slate-300' : 'text-slate-700 hover:bg-slate-50'}`}>
                    <span>{c.short}</span>
                    <span className="flex items-center gap-1">
                      {suggested && <span className="rounded-full bg-teal-50 px-1.5 text-[9.5px] text-teal-800">suggested</span>}
                      {hasForms && !suggested && <span className="rounded-full bg-slate-100 px-1.5 text-[9.5px] text-slate-500">has forms</span>}
                      {already && <span className="text-[10px]">active</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Track status strip */}
      <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[14px] font-semibold text-slate-800">{cat.find((c) => c.key === sel.track)?.label || sel.track}</div>
            <div className="mt-0.5 text-[12px] text-slate-500">{cat.find((c) => c.key === sel.track)?.anchor}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {selActive ? (
              <>
                <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[10.5px] font-medium text-teal-800">Active</span>
                <button onClick={() => setShowTransfer((s) => !s)} disabled={busy || !transferTargets.length} className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:border-teal-300 hover:text-teal-700 disabled:opacity-40"><ArrowRightLeft className="h-3 w-3" /> Transfer</button>
                <button onClick={() => setShowArchive((s) => !s)} disabled={busy} className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:border-red-300 hover:text-red-700"><Archive className="h-3 w-3" /> Archive</button>
              </>
            ) : (
              <button onClick={() => mutate({ action: 'assign', individual_uid: individualUid, track: sel.track, opened_by: 'care' }, sel.track)} disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg bg-teal-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-teal-700">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Start tracking
              </button>
            )}
          </div>
        </div>

        {selActive && sel.ready_to_archive.ready && (
          <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-[12px] text-teal-800">
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5" /> Looks complete ({sel.ready_to_archive.reason}) — ready to archive?</span>
            <button onClick={() => mutate({ action: 'archive', id: sel.assignment_id, close_reason: sel.ready_to_archive.reason || 'completed', closed_by: 'care' })} disabled={busy} className="rounded-lg bg-teal-600 px-2.5 py-1 text-[11.5px] font-medium text-white hover:bg-teal-700">Archive</button>
          </div>
        )}

        {showArchive && selActive && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11.5px] text-slate-500">Archive this track — reason:</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {REASONS.map((r) => (
                <button key={r.v} disabled={busy} onClick={() => mutate({ action: 'archive', id: sel.assignment_id, close_reason: r.v, closed_by: 'care' })}
                  className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11.5px] text-slate-600 hover:border-teal-300 hover:text-teal-700">{r.label}</button>
              ))}
            </div>
          </div>
        )}

        {showTransfer && selActive && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11.5px] text-slate-500">Transfer to another track (archives this one, keeps the history chain):</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {transferTargets.map((c) => (
                <button key={c.key} disabled={busy} onClick={() => mutate({ action: 'transfer', id: sel.assignment_id, to_track: c.key, opened_by: 'care' }, c.key)}
                  className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11.5px] text-slate-600 hover:border-teal-300 hover:text-teal-700">{c.short}</button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Two columns: track panel + expectations */}
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[1.5fr_1fr]">
        <div>
          {sel.track === 'fever' && sel.context.fever && <FeverPanel c={sel.context.fever} onNote={(u) => router.push(`/care/${encodeURIComponent(u)}`)} />}
          {sel.track === 'posthosp' && sel.context.posthosp && <PosthospPanel c={sel.context.posthosp} />}
          {sel.track === 'aihs' && sel.context.aihs && <AihsPanel c={sel.context.aihs} />}
          {!['fever', 'posthosp', 'aihs'].includes(sel.track) && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 text-[13px] text-slate-500">This track isn’t built out yet — the deep views are Fever, Post-hospital, and AIHS.</div>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <div className="text-[12px] font-medium uppercase tracking-wide text-slate-400">This call · expectations</div>
            {sel.expectations.length > 0 && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] text-slate-500">{sel.open_count} open</span>}
          </div>
          {sel.expectations.length === 0 && <div className="mt-2 text-[12.5px] text-slate-400">No auto-evaluated expectations for this track.</div>}
          <ol className="mt-1">
            {sel.expectations.map((e) => {
              const { I, cls } = EXP_ICON[e.status];
              return (
                <li key={e.id} className="flex gap-2 border-t border-slate-100 py-2.5 first:border-t-0">
                  <I className={`mt-0.5 h-4 w-4 shrink-0 ${cls}`} />
                  <div>
                    <div className="text-[13px] text-slate-800">{e.label}</div>
                    <div className="text-[11.5px] text-slate-500">{e.detail}</div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      {/* Archived history */}
      {archived.length > 0 && (
        <div className="mt-4">
          <div className="text-[12px] font-medium uppercase tracking-wide text-slate-400">Track history</div>
          <div className="mt-1.5 rounded-xl border border-slate-200 bg-white">
            {archived.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 border-t border-slate-100 px-3 py-2 first:border-t-0">
                <div className="text-[12.5px] text-slate-600">
                  {labelOf(cat, a.track)} <span className="text-slate-400">· {a.close_reason || 'closed'}{a.closed_at ? ` · ${String(a.closed_at).slice(0, 10)}` : ''}</span>
                </div>
                <button onClick={() => mutate({ action: 'reopen', id: a.id }, a.track)} disabled={busy} className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 hover:border-teal-300 hover:text-teal-700"><RotateCcw className="h-3 w-3" /> Reopen</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 text-[11px] leading-relaxed text-slate-400">
        Advisory. Tracks are assigned by a care manager (unassigned pool — anyone can pick up any track); a member can be on several active tracks at once. Expectations are auto-evaluated from the member’s Pulse forms + records — not a clinician assessment. The dossier, conversation brief, and consult pitch above are unchanged.
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-2 text-[12px] font-medium uppercase tracking-wide text-slate-400">{title}</div>
      {children}
    </div>
  );
}
function Pill({ tone, children }: { tone: 'teal' | 'amber' | 'red' | 'slate'; children: React.ReactNode }) {
  const map = { teal: 'bg-teal-50 text-teal-800', amber: 'bg-amber-50 text-amber-800', red: 'bg-red-50 text-red-800', slate: 'bg-slate-100 text-slate-600' };
  return <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${map[tone]}`}>{children}</span>;
}

function FeverPanel({ c, onNote }: { c: FeverCtx; onNote: (u: string) => void }) {
  const temps = c.trajectory.map((p) => p.temp ?? 0);
  const max = Math.max(100, ...temps);
  const min = Math.min(97, ...temps.filter((t) => t > 0));
  return (
    <>
      <Card title="Fever trajectory">
        {c.trajectory.length === 0 ? <div className="text-[12.5px] text-slate-400">No fever touchpoints recorded.</div> : (
          <div className="flex items-end gap-2" style={{ height: 90 }}>
            {c.trajectory.map((p, i) => {
              const h = p.temp ? Math.max(12, Math.round(((p.temp - min) / Math.max(1, max - min)) * 70) + 12) : 12;
              const tone = p.temp && p.temp >= 100.4 ? 'bg-red-200' : p.temp && p.temp >= 99.5 ? 'bg-amber-200' : 'bg-teal-100';
              return (
                <div key={i} className="flex flex-1 flex-col items-center justify-end">
                  <div className="text-[10px] text-slate-500">{p.temp ?? '—'}</div>
                  <div className={`w-full rounded-t ${tone}`} style={{ height: h }} />
                  <div className="mt-1 text-[10px] text-slate-400">{p.day != null ? `D${p.day}` : (p.date ? String(p.date).slice(5) : '—')}</div>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {c.symptoms.map((s, i) => <Pill key={i} tone="slate">{s}</Pill>)}
          {c.latestDay != null && <Pill tone={c.latestDay >= 5 ? 'amber' : 'slate'}>Day {c.latestDay}</Pill>}
          {c.recovered && <Pill tone="teal">Recovered</Pill>}
        </div>
      </Card>
      {c.prescriptionUid && (
        <Card title="Index prescription">
          <button onClick={() => onNote(c.prescriptionUid!)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[12px] text-slate-600 hover:border-teal-300 hover:text-teal-700">
            Open OPD note / conversation brief <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </Card>
      )}
    </>
  );
}

function PosthospPanel({ c }: { c: PosthospCtx }) {
  const done = c.items.filter((i) => i.completed).length;
  return (
    <Card title={`Prescribed follow-through · ${done}/${c.items.length} done`}>
      {c.items.length === 0 ? <div className="text-[12.5px] text-slate-400">No prescribed follow-up items on file.</div> : (
        <ol>
          {c.items.map((it, i) => (
            <li key={i} className="flex items-center justify-between gap-2 border-t border-slate-100 py-2 first:border-t-0">
              <span className="text-[13px] text-slate-800">{it.name}{it.type ? <span className="text-slate-400"> · {it.type.toLowerCase()}</span> : null}</span>
              {it.completed ? <Pill tone="teal">completed</Pill> : it.booked ? <Pill tone="amber">booked · pending</Pill> : <Pill tone="red">not booked</Pill>}
            </li>
          ))}
        </ol>
      )}
      {c.nextFollowup ? <div className="mt-2 text-[12px] text-slate-500">Next follow-up: {String(c.nextFollowup).slice(0, 10)}</div>
        : c.nextFollowupNote ? <div className="mt-2 text-[12px] text-slate-500">No follow-up needed — {c.nextFollowupNote.trim()}</div> : null}
    </Card>
  );
}

function AihsPanel({ c }: { c: AihsCtx }) {
  return (
    <Card title="Chronic care · holistic">
      <div className="text-[12.5px] text-slate-600">
        {c.hba1cDate ? <>Latest HbA1c report: <b>{String(c.hba1cDate).slice(0, 10)}</b>{c.hba1c != null ? ` (${c.hba1c}%)` : ' — value inside the report'}.</> : 'No HbA1c report found.'}
      </div>
      {c.nextFollowup && <div className="mt-1 text-[12.5px] text-slate-600">Next review: {String(c.nextFollowup).slice(0, 10)}</div>}
      <div className="mt-2 text-[11.5px] text-slate-400">Whole-person history (all prescriptions, diagnostics, complications) is in the dossier above. Marker-trend + complication-screen automation land in a later pass.</div>
    </Card>
  );
}
