'use client';

/**
 * app/admin/observability/review/page.tsx — WM6: sequential review.
 *
 * A reviewer walks one de-identified case forward, one cut at a time, and records a four-field
 * belief at each — then the same belief again under each perturbation they chose. Nothing here
 * grades anybody: there is no score, no comparison to an outcome, and no doctor-facing surface.
 *
 * ⚠️ A REVEALED CUT CANNOT BE UNSEEN. There is no back button, no edit, and no way to ask for a
 * later cut: this page renders exactly what GET /api/admin/review returns, and that route slices
 * the stored cuts at `revealed_index`. The rule lives on the server; this page cannot widen it.
 *
 * ⚠️ THE PERTURBATION IS TEXT BESIDE THE RECORD, NEVER AN EDIT OF IT. The snapshot rendered under a
 * perturbation is the same object rendered without one — see lib/review/perturbations.ts.
 *
 * ── WHY THIS PAGE IS A CLIENT COMPONENT, AND WHERE ITS ADMIN WALL IS ─────────────────────────────
 *
 * The step form needs a live confidence readout, a conditional field, a per-step timer and a
 * re-fetch after each submit, and the file contract for this build is one page file — which cannot
 * be both a server component and a client one. So the page is a client component, exactly as
 * app/admin/proms-adhoc-review/page.tsx is, and the admin wall is the one on /api/admin/review:
 * every byte of clinical content on this screen arrives from that 401-gated route, and this file
 * renders no data of its own. A locked visitor gets the same sentence the walk page shows.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

const VARIANTS: { id: string; overlay: string }[] = [
  { id: 'fever_39_5', overlay: 'Perturbation: assume a temperature of 39.5 °C was recorded at this visit.' },
  { id: 'ct_done_normal', overlay: 'Perturbation: assume a non-contrast CT head was done at this visit and reported normal.' },
  { id: 'age_plus_30', overlay: 'Perturbation: assume the patient is 30 years older than shown.' },
];

const INVESTIGATION_LABELS: [string, string][] = [
  ['ct_head', 'CT head'], ['mri_brain', 'MRI brain'], ['lumbar_puncture', 'Lumbar puncture'],
  ['blood_tests', 'Blood tests'], ['esr_crp', 'ESR / CRP'], ['none', 'None'], ['other', 'Other'],
];

const ROLE_LABELS: [string, string][] = [
  ['consulting_physician', 'Consulting physician'], ['neurologist', 'Neurologist'],
];

interface BeliefKey { stepIndex: number; variantId: string | null }
interface Cut { date: string; status: string; snapshot?: Snapshot; foldNotes: string[]; foldRefused: { concept: string; slot: string; reason: string }[] }
interface Stats { rows: number; meanSeconds: number | null; maxSeconds: number | null }
interface SessionState {
  id: string; status: 'active' | 'completed' | 'incomplete'; reviewer_role: string;
  variants: string[]; cut_count: number; revealed_index: number; cuts: Cut[];
  recorded: BeliefKey[]; next_required: BeliefKey | null;
  grain_label: string; honesty_chip: string; ipd_fold: string; stats: Stats | null;
}

// ── the snapshot renderer ─────────────────────────────────────────────────────────────────────
// A copy of the World Model walk page's slot idiom, not an import: that page is a server component
// and this build's contract adds one link to it, nothing more. Every slot shows its count, because
// an empty slot is a fact and a missing line would read as no data.
interface Concept { raw?: string }
interface Snapshot {
  asOf?: string; version?: string; sourceEncounterRefs?: unknown[];
  problems?: { normalizedConcept?: Concept; latestDocumentedStatus?: string; course?: string; occurrences?: unknown[]; lastDocumentedAt?: string }[];
  medications?: { normalizedConcept?: Concept; status?: string; occurrences?: unknown[]; lastSeen?: string }[];
  allergies?: { substance?: Concept; status?: string }[];
  investigations?: { normalizedAnalyte?: Concept; unit?: string; series?: { value?: unknown; date?: string }[] }[];
  procedures?: { normalizedConcept?: Concept; occurrences?: unknown[]; lastSeen?: string }[];
  followUps?: unknown[];
  conflicts?: { domain?: string; type?: string; severity?: string }[];
}

const day = (d?: string) => String(d ?? '').slice(0, 10) || '—';

function Chip({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'slate' | 'amber' | 'brand' }) {
  const cls = tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-800'
    : tone === 'brand' ? 'border-brand/30 bg-brand/5 text-brand'
    : 'border-slate-200 bg-slate-50 text-slate-600';
  return <span className={`rounded border px-1.5 py-0.5 text-[10.5px] ${cls}`}>{children}</span>;
}

function Slot({ title, n, children }: { title: string; n: number; children?: React.ReactNode }) {
  return (
    <div className="mt-2">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-slate-400">{title} <span className="text-slate-300">·</span> {n}</div>
      {n === 0
        ? <div className="text-[12px] italic text-slate-300">none</div>
        : <ul className="mt-0.5 space-y-0.5 text-[12px] text-slate-700">{children}</ul>}
    </div>
  );
}

function SnapshotBody({ snap }: { snap: Snapshot }) {
  const problems = snap.problems ?? []; const medications = snap.medications ?? [];
  const allergies = snap.allergies ?? []; const investigations = snap.investigations ?? [];
  const procedures = snap.procedures ?? []; const followUps = snap.followUps ?? [];
  const conflicts = snap.conflicts ?? [];
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-slate-400">
        <Chip>asOf {day(snap.asOf)}</Chip>
        {snap.version ? <Chip>{snap.version}</Chip> : null}
        <Chip>{(snap.sourceEncounterRefs ?? []).length} encounter{(snap.sourceEncounterRefs ?? []).length === 1 ? '' : 's'}</Chip>
      </div>
      <Slot title="Problems" n={problems.length}>
        {problems.map((p, i) => (
          <li key={i}><span className="font-medium">{p.normalizedConcept?.raw}</span>
            <span className="text-slate-400"> · {p.latestDocumentedStatus} · {p.course} · {(p.occurrences ?? []).length}× · last {day(p.lastDocumentedAt)}</span></li>
        ))}
      </Slot>
      <Slot title="Medications" n={medications.length}>
        {medications.map((m, i) => (
          <li key={i}><span className="font-medium">{m.normalizedConcept?.raw}</span>
            <span className="text-slate-400"> · {m.status} · {(m.occurrences ?? []).length}× · last {day(m.lastSeen)}</span></li>
        ))}
      </Slot>
      <Slot title="Allergies" n={allergies.length}>
        {allergies.map((a, i) => <li key={i}><span className="font-medium">{a.substance?.raw}</span><span className="text-slate-400"> · {a.status}</span></li>)}
      </Slot>
      <Slot title="Investigations" n={investigations.length}>
        {investigations.map((inv, i) => {
          const series = inv.series ?? []; const latest = series[series.length - 1];
          return (
            <li key={i}><span className="font-medium">{inv.normalizedAnalyte?.raw}</span>
              <span className="text-slate-400"> · {series.length} pt{series.length === 1 ? '' : 's'}
                {latest ? ` · latest ${String(latest.value)}${inv.unit ? ` ${inv.unit}` : ''} (${day(latest.date)})` : ''}</span></li>
          );
        })}
      </Slot>
      <Slot title="Procedures" n={procedures.length}>
        {procedures.map((p, i) => (
          <li key={i}><span className="font-medium">{p.normalizedConcept?.raw}</span>
            <span className="text-slate-400"> · {(p.occurrences ?? []).length}× · last {day(p.lastSeen)}</span></li>
        ))}
      </Slot>
      <Slot title="Follow-ups" n={followUps.length}>
        {followUps.map((f, i) => <li key={i} className="text-slate-700">{JSON.stringify(f).slice(0, 140)}</li>)}
      </Slot>
      <Slot title="Conflicts" n={conflicts.length}>
        {conflicts.map((c, i) => <li key={i}><span className="font-medium">{c.domain} · {c.type}</span><span className="text-slate-400"> · {c.severity}</span></li>)}
      </Slot>
    </div>
  );
}

// ── the page ──────────────────────────────────────────────────────────────────────────────────

export default function SequentialReviewPage() {
  const [wall, setWall] = useState<'checking' | 'locked' | 'open'>('checking');
  const [error, setError] = useState<string>('');
  const [session, setSession] = useState<SessionState | null>(null);
  const [busy, setBusy] = useState(false);

  // start form
  const [individualUid, setIndividualUid] = useState('');
  const [uhid, setUhid] = useState('');
  const [role, setRole] = useState('consulting_physician');
  const [chosen, setChosen] = useState<string[]>(VARIANTS.map((v) => v.id));

  // belief form
  const [diagnosis, setDiagnosis] = useState('');
  const [confidence, setConfidence] = useState(50);
  const [investigation, setInvestigation] = useState('ct_head');
  const [otherText, setOtherText] = useState('');
  const [unsafe, setUnsafe] = useState('no');
  const startedAt = useRef<number>(Date.now());

  const load = useCallback(async (sessionId?: string) => {
    setError('');
    const res = await fetch(`/api/admin/review${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''}`);
    if (res.status === 401) { setWall('locked'); return; }
    setWall('open');
    const j = await res.json().catch(() => null);
    if (!j?.ok) { setError(String(j?.error ?? 'could not read the session')); return; }
    setSession(j.session ?? null);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // The timer restarts whenever the reviewer is put in front of a different key.
  const keyLabel = session ? `${session.revealed_index}:${session.next_required?.variantId ?? 'base'}` : '';
  useEffect(() => {
    startedAt.current = Date.now();
    setDiagnosis(''); setConfidence(50); setInvestigation('ct_head'); setOtherText(''); setUnsafe('no');
  }, [keyLabel]);

  if (wall === 'checking') return <div className="py-16 text-center text-sm text-slate-400">…</div>;
  if (wall === 'locked') {
    return (
      <div className="mx-auto max-w-md py-16 text-center text-sm text-slate-500">
        Access-controlled. <Link href="/admin/observability" className="text-brand hover:underline">Unlock Observability</Link> first.
      </div>
    );
  }

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/admin/review', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'start', individual_uid: individualUid.trim() || undefined,
          uhid: uhid.trim() || undefined, reviewer_role: role,
          variants: VARIANTS.filter((v) => chosen.includes(v.id)).map((v) => v.id),
        }),
      });
      const j = await res.json().catch(() => null);
      if (!j?.ok) { setError(String(j?.error ?? `start failed (${res.status})`)); return; }
      await load(String(j.session_id));
    } finally { setBusy(false); }
  }

  async function record(e: React.FormEvent) {
    e.preventDefault();
    if (!session?.next_required) return;
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/admin/review', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'belief', session_id: session.id,
          step_index: session.next_required.stepIndex, variant_id: session.next_required.variantId,
          reviewer_role: session.reviewer_role,
          payload: {
            leading_diagnosis: diagnosis.trim(), confidence,
            next_investigation: investigation,
            other_text: investigation === 'other' ? otherText.trim() : null,
            unsafe_to_wait: unsafe === 'yes',
          },
          seconds_spent: Math.max(0, Math.min(3600, Math.round((Date.now() - startedAt.current) / 1000))),
        }),
      });
      const j = await res.json().catch(() => null);
      if (!j?.ok) { setError(String(j?.error ?? `could not record (${res.status})`)); return; }
      await load(session.id);
    } finally { setBusy(false); }
  }

  const cut = session ? session.cuts[session.revealed_index] : null;
  const activeVariant = session?.next_required?.variantId ?? null;
  const overlay = activeVariant ? VARIANTS.find((v) => v.id === activeVariant)?.overlay ?? '' : '';

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-[26px] font-semibold leading-tight text-slate-900 sm:text-[30px]">Sequential review</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-slate-500">
            One cut at a time. A revealed cut cannot be unseen. Beliefs are final. Nobody is scored.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/admin/observability/world-model" className="whitespace-nowrap text-xs font-medium text-brand hover:underline">World Model →</Link>
          <Link href="/admin/observability" className="whitespace-nowrap text-xs font-medium text-brand hover:underline">← Observability</Link>
        </div>
      </div>

      {error ? <p className="mt-4 text-[13px] text-red-700">{error}</p> : null}

      {!session ? (
        <form onSubmit={start} className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col text-[10.5px] text-slate-500">individual_uid
              <input value={individualUid} onChange={(e) => setIndividualUid(e.target.value)} placeholder="ind_…"
                className="mt-0.5 h-8 w-64 rounded-md border border-slate-200 px-2 font-mono text-[12px]" />
            </label>
            <label className="flex flex-col text-[10.5px] text-slate-500">uhid <span className="text-slate-300">(optional)</span>
              <input value={uhid} onChange={(e) => setUhid(e.target.value)} placeholder="resolved via individuals.kx_uhid"
                className="mt-0.5 h-8 w-56 rounded-md border border-slate-200 px-2 font-mono text-[12px]" />
            </label>
            <label className="flex flex-col text-[10.5px] text-slate-500">reviewer_role
              <select value={role} onChange={(e) => setRole(e.target.value)} className="mt-0.5 h-8 rounded-md border border-slate-200 bg-white px-2 text-[12px]">
                {ROLE_LABELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          </div>
          <div className="mt-3 border-t border-slate-100 pt-3">
            <div className="text-[10.5px] font-medium uppercase tracking-wide text-slate-400">Perturbations</div>
            <div className="mt-1 space-y-1">
              {VARIANTS.map((v) => (
                <label key={v.id} className="flex items-start gap-2 text-[12px] text-slate-700">
                  <input type="checkbox" checked={chosen.includes(v.id)} className="mt-0.5"
                    onChange={(e) => setChosen((c) => (e.target.checked ? [...c, v.id] : c.filter((x) => x !== v.id)))} />
                  <span>{v.overlay} <span className="font-mono text-[10.5px] text-slate-400">{v.id}</span></span>
                </label>
              ))}
            </div>
          </div>
          <button disabled={busy} className="mt-3 h-8 rounded-lg bg-brand px-4 text-[12px] font-medium text-white hover:bg-brand-dark disabled:opacity-50">Start session</button>
        </form>
      ) : session.status === 'completed' ? (
        <div className="mt-5 rounded-xl border border-slate-200 bg-white p-5 text-[13px] text-slate-700">
          Session complete. {session.stats?.rows ?? 0} beliefs recorded.
          {' '}Mean {session.stats?.meanSeconds == null ? '—' : Math.round(session.stats.meanSeconds)} s per belief,
          {' '}max {session.stats?.maxSeconds ?? '—'} s.
        </div>
      ) : session.status === 'incomplete' ? (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-5 text-[13px] text-amber-900">
          The spine could not be read at this cut. Session incomplete.
        </div>
      ) : (
        <div className="mt-5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-medium text-slate-900">
              Step {session.revealed_index + 1} of {session.cut_count} · {cut ? cut.date : '—'}
            </span>
            <Chip>grain: {session.grain_label}</Chip>
            <Chip tone="amber">{session.honesty_chip}</Chip>
            <Chip tone={session.ipd_fold === 'fold_off' ? 'amber' : 'brand'}>IPD: {session.ipd_fold}</Chip>
            {cut && cut.status === 'no_prior_history'
              ? <Chip>no prior history — we looked, and there was nothing before this day</Chip> : null}
          </div>

          {overlay ? (
            <div className="mt-3 rounded-xl border border-slate-300 bg-slate-50 p-4">
              <div className="text-[10.5px] font-medium uppercase tracking-wide text-slate-500">Perturbation</div>
              <p className="mt-0.5 text-[13px] text-slate-800">{overlay}</p>
            </div>
          ) : null}

          <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
            {cut?.snapshot
              ? <SnapshotBody snap={cut.snapshot} />
              : <p className="text-[12px] italic text-slate-400">No snapshot at this cut — the record held nothing before this day.</p>}
          </div>

          <form onSubmit={record} className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
            <label className="flex flex-col text-[10.5px] text-slate-500">Leading diagnosis
              <input value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} maxLength={200}
                className="mt-0.5 h-8 w-full max-w-lg rounded-md border border-slate-200 px-2 text-[12px]" />
            </label>
            <label className="mt-3 flex flex-col text-[10.5px] text-slate-500">Confidence
              <span className="mt-0.5 flex items-center gap-2">
                <input type="range" min={0} max={100} step={1} value={confidence}
                  onChange={(e) => setConfidence(Number(e.target.value))} className="w-64" />
                <span className="font-mono text-[12px] text-slate-700">{confidence}</span>
              </span>
            </label>
            <label className="mt-3 flex flex-col text-[10.5px] text-slate-500">Next investigation
              <select value={investigation} onChange={(e) => setInvestigation(e.target.value)}
                className="mt-0.5 h-8 w-56 rounded-md border border-slate-200 bg-white px-2 text-[12px]">
                {INVESTIGATION_LABELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            {investigation === 'other' ? (
              <label className="mt-3 flex flex-col text-[10.5px] text-slate-500">Other (specify)
                <input value={otherText} onChange={(e) => setOtherText(e.target.value)} maxLength={200}
                  className="mt-0.5 h-8 w-full max-w-lg rounded-md border border-slate-200 px-2 text-[12px]" />
              </label>
            ) : null}
            <label className="mt-3 flex flex-col text-[10.5px] text-slate-500">Unsafe to wait?
              <select value={unsafe} onChange={(e) => setUnsafe(e.target.value)}
                className="mt-0.5 h-8 w-24 rounded-md border border-slate-200 bg-white px-2 text-[12px]">
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </label>
            <button disabled={busy} className="mt-4 h-8 rounded-lg bg-brand px-4 text-[12px] font-medium text-white hover:bg-brand-dark disabled:opacity-50">Record belief</button>
          </form>
        </div>
      )}
    </div>
  );
}
