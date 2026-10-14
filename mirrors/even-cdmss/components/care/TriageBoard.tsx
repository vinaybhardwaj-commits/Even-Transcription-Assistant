'use client';

/**
 * TriageBoard — the care-manager OPD Audit Triage workspace (PRD §5 / spec §3.3).
 *
 * Doctor switcher ranked by attention → the selected doctor's signal-type cards ranked by
 * severity × noise → the four-step decision (validity → importance → route → response) applied to
 * the whole type ("Apply to all N"), with the audit-bug path short-circuiting to the bug feed.
 * Reads GET /api/opd-triage/queue, writes POST /api/opd-triage/decide. Advisory framing throughout.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, AlertTriangle, ChevronRight, CheckCircle2, Bug, ShieldAlert, RefreshCw, BellOff } from 'lucide-react';
import { classifyTransition, DISMISS_REASONS, RESOLUTION_OUTCOMES } from '@/lib/opd-triage-core';
import { isSafetySignalType } from '@/lib/audit-suppression-core';

// Feature C (Gold-Label Review-Mode §5) — friction-capped instrumentation chips. A dismiss transition
// (audit_bug OR valid_signal not routed) requires a REASON chip; a resolution transition (routed)
// requires an OUTCOME chip; free text is always optional. Every applied decision also writes an
// append-only opd_triage_events row via the decide route (born-instrumented, no behavior change).
const DISMISS_LABELS: Record<string, string> = {
  not_clinically_relevant: 'Not clinically relevant', already_addressed: 'Already addressed',
  patient_constraint: 'Patient constraint', other: 'Other',
};
const OUTCOME_LABELS: Record<string, string> = {
  resolved_with_doctor: 'Resolved with doctor', resolved_no_action_needed: 'No action needed',
  unable_to_contact: 'Unable to contact', other: 'Other',
};

type Importance = 'low' | 'med' | 'high';
type ResponseReq = 'none' | 'explanation' | 'acknowledgment' | 'recommend_privilege_review';

interface Representative {
  audit_id: string; finding_ref: string; subject: string; verdict: string;
  rationale: string; note_date: string; citation_ids: number[];
  // Right Care routing context (decision 16) — display only, no O/E / doctor-comparative data here.
  complexity_band?: string | null; complexity_inputs?: Record<string, unknown> | null; lvc_category?: string | null;
}

// Complexity band chip labels (NEW_TO_US → "New to Even" per decision 16) + tone.
const BAND_LABEL: Record<string, string> = { NEW_TO_US: 'New to Even', LOW: 'Low complexity', MODERATE: 'Moderate complexity', HIGH: 'High complexity' };
const BAND_TONE: Record<string, string> = {
  NEW_TO_US: 'bg-sky-100 text-sky-700', LOW: 'bg-slate-100 text-slate-600',
  MODERATE: 'bg-amber-100 text-amber-700', HIGH: 'bg-rose-100 text-rose-700',
};
const LVC_CAT_LABEL: Record<string, string> = {
  antibiotic: 'Antibiotic', imaging: 'Imaging', supplement_polypharmacy: 'Supplement / polypharmacy', other: 'Low-value',
};
interface TypeDecisionState {
  validity: string; bug_type: string | null; importance: string | null;
  routed: boolean; response_required: string | null; reason: string | null; cm_user: string | null; decided_at: string;
}
interface TypeGroup {
  signal_type: string; label: string; count: number; notes: number;
  severity_weight: number; importance_hint: Importance; concentrated: boolean; noisiest: boolean;
  representative: Representative; triage: TypeDecisionState | null;
  quieted_count?: number; quieted_rule?: string | null; quieted_only?: boolean;
}

// ── Quieting (demote) — PRD CDMSS-QUIETING-DEMOTE-SYSTEM ─────────────────────
interface QuietingRule {
  id: string; signal_type: string; discriminator: string | null; match_kind: string;
  action: string; status?: string; active: boolean; reason: string | null; created_by: string | null;
  approved_by: string | null; approved_at: string | null; created_at: string;
}
interface QuietingResp {
  ok: boolean; suppressions: QuietingRule[]; current_gen: number; is_admin: boolean;
  quieted_volume_30d?: { quieted: number; low_value: number };
}
/** Per-card quiet-proposal draft. */
interface QuietDraft {
  open?: boolean; scope?: 'category' | 'subject'; pattern?: string; reason?: string; proposer?: string;
  busy?: boolean; done?: string; error?: string;
}
const ruleShort = (id: string | null | undefined) => (id ? id.slice(0, 8) : '?');
interface DoctorGroup {
  doctor_uid: string; name?: string; speciality?: string;
  notes: number; instances: number; untriaged_types: number; max_importance_hint: Importance; types: TypeGroup[];
}
interface QueueResp {
  ok: boolean; window: { from: string; to: string; days: number }; status: string;
  doctors_total: number; doctors: DoctorGroup[]; error?: string;
}

// ── Stage 3 — the Longitudinal label-only lane (view models from GET /api/opd-triage/longitudinal-lane) ──
interface LaneGateVM {
  labelled: number; fpRate: number; threshold: number; minLabelled: number;
  status: 'eligible' | 'collecting' | 'failing'; eligible: boolean;
}
interface LaneInstanceVM { audit_id: string; finding_ref: string; subject: string; rationale: string; note_date: string; cited: string | null }
interface LaneTypeVM {
  signal_type: string; label: string; count: number; notes: number; doctor_uid: string;
  gate: LaneGateVM | null; triage: TypeDecisionState | null; instances: LaneInstanceVM[];
}
interface LaneResp {
  ok: boolean; enabled: boolean; window: { from: string; to: string; days: number };
  counts: { types: number; instances: number }; types: LaneTypeVM[]; error?: string;
}

const verdictPill: Record<string, string> = {
  'low-value': 'bg-rose-100 text-rose-700', 'context-dependent': 'bg-amber-100 text-amber-700',
  'high-value': 'bg-emerald-100 text-emerald-700', 'uncertain': 'bg-slate-100 text-slate-600',
};
const impPill: Record<Importance, string> = {
  high: 'bg-rose-100 text-rose-700', med: 'bg-amber-100 text-amber-700', low: 'bg-slate-100 text-slate-600',
};
const RESPONSE_LABELS: Record<ResponseReq, string> = {
  none: 'FYI (no response)', explanation: 'Ask for explanation', acknowledgment: 'Ask to acknowledge',
  recommend_privilege_review: 'Recommend privilege review',
};

// Per-card working state for the decision pipeline.
interface Draft {
  validity?: 'valid_signal' | 'audit_bug';
  bug_type?: 'process_bug' | 'structural_bug';
  importance?: Importance;
  routed?: boolean;
  response_required?: ResponseReq;
  eventChip?: string;   // Feature C: dismiss reason OR resolution outcome (required for the transition)
  eventNote?: string;   // Feature C: optional free text
  busy?: boolean;
  done?: string; // a short receipt once applied
  error?: string;
}

/** Feature C — the transition kind (and thus which chip is required) for the current draft. Returns
 *  null until the CM has chosen enough of the pipeline to know (validity, and route for valid signals). */
function transitionKind(d: Draft): 'dismiss' | 'resolution' | null {
  if (d.validity === 'audit_bug') return d.bug_type ? 'dismiss' : null;
  if (d.validity === 'valid_signal') {
    if (d.routed === true) return 'resolution';
    if (d.routed === false) return 'dismiss';
  }
  return null;
}

// Explicit active-class map (Tailwind JIT can't see dynamically-built class names).
const TONE_ACTIVE: Record<string, string> = {
  slate: 'border-slate-500 bg-slate-100 text-slate-800',
  emerald: 'border-emerald-500 bg-emerald-50 text-emerald-800',
  rose: 'border-rose-500 bg-rose-50 text-rose-800',
  sky: 'border-sky-500 bg-sky-50 text-sky-800',
  purple: 'border-purple-500 bg-purple-50 text-purple-800',
};
const Btn = ({ active, onClick, children, tone = 'slate' }: { active?: boolean; onClick: () => void; children: React.ReactNode; tone?: string }) => (
  <button onClick={onClick}
    className={`rounded-md border px-2.5 py-1 text-[12px] font-medium transition ${
      active ? (TONE_ACTIVE[tone] || TONE_ACTIVE.slate) : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
    }`}>{children}</button>
);

export default function TriageBoard() {
  const [data, setData] = useState<QueueResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'untriaged' | 'all'>('untriaged');
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // Stage 3 — the label-only lane. `lane` toggles the two tabs; the tabs render ONLY when the lane is
  // enabled (dark ship) so the board is byte-identical to today while OPD_LONGITUDINAL_ENABLED is off.
  const [lane, setLane] = useState<'action' | 'longitudinal' | 'quieting'>('action');
  const [laneData, setLaneData] = useState<LaneResp | null>(null);
  // Quieting: policy state (rules + gen + is_admin), per-card proposal drafts, filter toggle.
  const [quieting, setQuieting] = useState<QuietingResp | null>(null);
  const [quietDrafts, setQuietDrafts] = useState<Record<string, QuietDraft>>({});
  const [showQuieted, setShowQuieted] = useState(false);

  const load = useCallback(async (status: 'untriaged' | 'all', quieted: boolean) => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/opd-triage/queue?status=${status}${quieted ? '&quieted=1' : ''}`, { cache: 'no-store' });
      const j = (await r.json()) as QueueResp;
      if (!j.ok) throw new Error(j.error || 'failed to load queue');
      setData(j);
      setSelected((prev) => (prev && j.doctors.some((d) => d.doctor_uid === prev) ? prev : j.doctors[0]?.doctor_uid ?? null));
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setLoading(false); }
  }, []);

  const loadLane = useCallback(async () => {
    try {
      const r = await fetch('/api/opd-triage/longitudinal-lane', { cache: 'no-store' });
      const j = (await r.json()) as LaneResp;
      setLaneData(j.ok ? j : null);
    } catch { setLaneData(null); }
  }, []);

  const loadQuieting = useCallback(async () => {
    try {
      const r = await fetch('/api/opd-triage/suppressions', { cache: 'no-store' });
      const j = (await r.json()) as QuietingResp;
      setQuieting(j.ok ? j : null);
    } catch { setQuieting(null); }
  }, []);

  useEffect(() => { load(statusFilter, showQuieted); }, [load, statusFilter, showQuieted]);
  useEffect(() => { loadLane(); }, [loadLane]);
  useEffect(() => { loadQuieting(); }, [loadQuieting]);
  const laneEnabled = !!laneData?.enabled;
  const quietingGen = quieting?.current_gen ?? 0;

  const doctor = useMemo(() => data?.doctors.find((d) => d.doctor_uid === selected) ?? null, [data, selected]);

  const setDraft = (key: string, patch: Draft) => setDrafts((d) => ({ ...d, [key]: { ...d[key], ...patch } }));

  async function apply(dg: DoctorGroup, t: TypeGroup) {
    const key = `${dg.doctor_uid}|${t.signal_type}`;
    const draft = drafts[key] || {};
    const body: Record<string, unknown> = {
      scope: 'type', doctor_uid: dg.doctor_uid, signal_type: t.signal_type,
      window_from: data?.window.from, window_to: data?.window.to,
      validity: draft.validity,
    };
    let receipt = '';
    if (draft.validity === 'audit_bug') {
      body.bug_type = draft.bug_type; body.routed = false;
      receipt = `Audit bug · ${draft.bug_type === 'process_bug' ? 'process' : 'structural'} → engineering feed`;
    } else {
      body.importance = draft.importance ?? t.importance_hint;
      body.routed = !!draft.routed;
      if (draft.routed) body.response_required = draft.response_required;
      receipt = draft.routed
        ? `${String(body.importance).toUpperCase()} · routed · ${RESPONSE_LABELS[(draft.response_required || 'none') as ResponseReq]}`
        : `${String(body.importance).toUpperCase()} · not routed (logged)`;
    }
    // Feature C: attach the instrumentation event (chip + optional note). from_status = the prior
    // disposition of this type, if any (else 'open'). Best-effort server-side; never blocks the decision.
    const kind = transitionKind(draft);
    if (kind) {
      const fromStatus = t.triage
        ? (t.triage.validity === 'audit_bug' ? 'dismissed' : t.triage.routed ? 'routed' : 'dismissed')
        : 'open';
      body.event = { chip: draft.eventChip, note: (draft.eventNote || '').trim() || undefined, from_status: fromStatus };
    }
    setDraft(key, { busy: true, error: undefined });
    try {
      const r = await fetch('/api/opd-triage/decide', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'decision failed');
      setDraft(key, { busy: false, done: receipt });
    } catch (e) { setDraft(key, { busy: false, error: String((e as Error).message) }); }
  }

  const canApply = (key: string): boolean => {
    const d = drafts[key];
    if (!d?.validity) return false;
    // Feature C: the transition's chip (dismiss reason / resolution outcome) is required once known.
    if (transitionKind(d) && !d.eventChip) return false;
    if (d.validity === 'audit_bug') return !!d.bug_type;
    if (!d.routed) return true;                    // valid + not routed (importance defaults to hint)
    return !!d.response_required;                  // routed needs a response requirement
  };

  return (
    <div className="mx-auto max-w-6xl px-5 py-7" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-[20px] font-semibold text-slate-900">OPD Audit Triage</h1>
          <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] text-sky-700">Advisory · care management</span>
          {/* Quieting policy-generation chip (Q4) — hidden at gen 0 */}
          {quietingGen > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700" title="Findings matching an active quieting rule are informational: recorded and visible here, but out of doctor scores and doctor-facing display.">
              <BellOff className="h-3 w-3" /> quieting policy · gen {quietingGen}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <a href="/admin/opd-audit/how-it-works" className="text-[12.5px] text-sky-700 hover:underline">How the audit works →</a>
          <a href="/care/triage/health" className="text-[12.5px] text-sky-700 hover:underline">Signal health →</a>
          {/* Quieting filter toggle (default off): reveal quieted findings as passive badge-only cards */}
          <button onClick={() => setShowQuieted((v) => !v)}
            className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[12px] font-medium transition ${
              showQuieted ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}
            title="Show findings quieted by an active rule (they never score and never route)">
            <BellOff className="h-3 w-3" /> {showQuieted ? 'Hiding nothing' : 'Show quieted'}
          </button>
          <div className="flex rounded-lg border border-slate-200 p-0.5 text-[12px]">
            {(['untriaged', 'all'] as const).map((s) => (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={`rounded-md px-2.5 py-1 font-medium ${statusFilter === s ? 'bg-slate-800 text-white' : 'text-slate-500'}`}>
                {s === 'untriaged' ? 'To do' : 'All'}
              </button>
            ))}
          </div>
          <button onClick={() => { load(statusFilter, showQuieted); loadLane(); loadQuieting(); }} className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:border-slate-300" title="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Lanes: Action queue (routable) | Longitudinal (label-only; renders only when its dark-ship
          flag is on) | Quieting (Q4 — proposed/active/retired demote rules). */}
      <div className="mt-3 flex gap-1.5 border-b border-slate-200">
        {([
          ['action', 'Action queue', data ? data.doctors.reduce((n, d) => n + d.instances, 0) : 0, 'routable'],
          ...(laneEnabled ? [['longitudinal', 'Longitudinal · labelling', laneData?.counts.instances ?? 0, 'informational'] as const] : []),
          ['quieting', 'Quieting', quieting ? quieting.suppressions.filter((s) => s.action === 'demote').length : 0, 'rules'],
        ] as ReadonlyArray<readonly [string, string, number, string]>).map(([id, label, count, kind]) => {
          const on = lane === id;
          const tone = id === 'longitudinal' ? 'border-indigo-500 text-indigo-700' : id === 'quieting' ? 'border-violet-500 text-violet-700' : 'border-sky-600 text-sky-700';
          const badge = on
            ? (id === 'longitudinal' ? 'bg-indigo-50 text-indigo-700' : id === 'quieting' ? 'bg-violet-50 text-violet-700' : 'bg-sky-50 text-sky-700')
            : 'bg-slate-100 text-slate-500';
          return (
            <button key={id} onClick={() => setLane(id as 'action' | 'longitudinal' | 'quieting')}
              className={`flex items-center gap-2 border-b-2 px-3.5 py-2 text-[13px] font-semibold transition ${on ? tone : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
              {label}
              <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${badge}`}>{count} {kind}</span>
            </button>
          );
        })}
      </div>

      {lane === 'quieting' ? (
        <QuietingTab data={quieting} onChanged={loadQuieting} />
      ) : laneEnabled && lane === 'longitudinal' ? (
        <LongitudinalLane data={laneData} onDecided={loadLane} />
      ) : (
      <>
      {data && (
        <p className="mt-0.5 text-[12.5px] text-slate-500">
          Window {data.window.from}{data.window.to !== data.window.from ? ` → ${data.window.to}` : ''} · {data.doctors_total} doctor(s) audited · {data.doctors.length} with {statusFilter === 'untriaged' ? 'open' : ''} signals
        </p>
      )}

      {loading ? (
        <div className="mt-16 flex items-center justify-center text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : err ? (
        <div className="mt-6 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700"><AlertTriangle className="h-4 w-4" /> {err}</div>
      ) : !data || data.doctors.length === 0 ? (
        <div className="mt-16 text-center text-[13px] text-slate-400">
          {statusFilter === 'untriaged' ? 'Nothing to triage — every signal is cleared. Nice.' : 'No audited notes in this window.'}
        </div>
      ) : (
        <div className="mt-5 grid gap-5 md:grid-cols-[220px_1fr]">
          {/* Doctor switcher */}
          <aside className="space-y-1">
            {data.doctors.map((d) => (
              <button key={d.doctor_uid} onClick={() => setSelected(d.doctor_uid)}
                className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                  selected === d.doctor_uid ? 'border-sky-300 bg-sky-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                <div className="flex items-center justify-between">
                  <span className="truncate text-[13px] font-medium text-slate-800">{d.name || d.doctor_uid}</span>
                  <span className={`ml-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${impPill[d.max_importance_hint]}`}>{d.untriaged_types}</span>
                </div>
                <div className="truncate text-[11px] text-slate-400">{d.speciality || '—'} · {d.notes} notes · {d.instances} findings</div>
              </button>
            ))}
          </aside>

          {/* Signal-type cards for the selected doctor */}
          <section className="space-y-3">
            {doctor?.types.map((t) => {
              const key = `${doctor.doctor_uid}|${t.signal_type}`;
              const draft = drafts[key] || {};
              const rep = t.representative;
              if (draft.done) {
                return (
                  <div key={key} className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-[12.5px] text-emerald-800">
                    <CheckCircle2 className="h-4 w-4 shrink-0" /> <span className="font-medium">{t.label}</span> · {t.count} — {draft.done}
                  </div>
                );
              }
              // Quieting: a fully-quieted type renders as a passive card — visible, badged, no
              // decision pipeline (its findings are informational and score nothing).
              if (t.quieted_only) {
                return (
                  <div key={key} className="rounded-xl border border-violet-100 bg-violet-50/40 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <BellOff className="h-3.5 w-3.5 text-violet-500" />
                      <span className="text-[14px] font-semibold text-slate-700">{t.label}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">×{t.count}</span>
                      <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700">quieted · rule {ruleShort(t.quieted_rule)}</span>
                      <span className="ml-auto text-[11px] text-slate-400">{rep.note_date}</span>
                    </div>
                    <div className="mt-2 rounded-lg bg-white/70 px-3 py-2">
                      <span className="text-[12.5px] text-slate-600">{rep.subject}</span>
                      <p className="mt-1 text-[11px] text-slate-400">Recorded and counted in analytics; out of the doctor’s score and doctor-facing display. Retire the rule on the Quieting tab to restore scoring for future audits.</p>
                    </div>
                  </div>
                );
              }
              const existing = t.triage;
              return (
                <div key={key} className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-semibold text-slate-900">{t.label}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">×{t.count}</span>
                    {(t.quieted_count ?? 0) > 0 && (
                      <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700">+{t.quieted_count} quieted · rule {ruleShort(t.quieted_rule)}</span>
                    )}
                    {t.noisiest && <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold text-orange-700">loudest</span>}
                    {t.concentrated && <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold text-purple-700">concentrated</span>}
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${impPill[t.importance_hint]}`}>hint: {t.importance_hint}</span>
                    {existing && (
                      <span className="ml-auto rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-white">
                        {existing.validity === 'audit_bug' ? 'bug' : existing.routed ? `routed · ${existing.response_required}` : existing.importance || 'logged'}
                      </span>
                    )}
                  </div>

                  {/* Representative instance */}
                  <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${verdictPill[rep.verdict] || verdictPill.uncertain}`}>{rep.verdict}</span>
                      <span className="text-[12.5px] font-medium text-slate-800">{rep.subject}</span>
                      {/* Right Care band chip (routing context; NULL band → no chip) */}
                      {rep.complexity_band && BAND_LABEL[rep.complexity_band] && (
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${BAND_TONE[rep.complexity_band] || 'bg-slate-100 text-slate-600'}`}>{BAND_LABEL[rep.complexity_band]}</span>
                      )}
                      {rep.lvc_category && (
                        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700">{LVC_CAT_LABEL[rep.lvc_category] || rep.lvc_category}</span>
                      )}
                      <span className="ml-auto text-[11px] text-slate-400">{rep.note_date} · 1 of {t.count}</span>
                    </div>
                    {rep.rationale && <p className="mt-1 text-[12px] leading-relaxed text-slate-600">{rep.rationale}</p>}
                    {/* complexity inputs line (expanded detail; chronic ICDs / abnormal labs / 12m visits) */}
                    {rep.complexity_inputs && (
                      <p className="mt-1 text-[10.5px] text-slate-400">
                        Case mix: {Number(rep.complexity_inputs.chronic_codes ?? 0)} chronic dx · {Number(rep.complexity_inputs.abnormal_labs ?? 0)} abnormal labs · {Number(rep.complexity_inputs.enc_12m ?? 0)} visits/12m
                      </p>
                    )}
                  </div>

                  {/* Decision pipeline */}
                  <div className="mt-3 space-y-2.5">
                    <div className="flex items-center gap-2">
                      <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-400">Validity</span>
                      <Btn active={draft.validity === 'valid_signal'} tone="emerald" onClick={() => setDraft(key, { validity: 'valid_signal', bug_type: undefined })}>Valid signal</Btn>
                      <Btn active={draft.validity === 'audit_bug'} tone="rose" onClick={() => setDraft(key, { validity: 'audit_bug', importance: undefined, routed: undefined, response_required: undefined })}>
                        <span className="inline-flex items-center gap-1"><Bug className="h-3 w-3" /> Audit bug</span>
                      </Btn>
                    </div>

                    {draft.validity === 'audit_bug' && (
                      <div className="flex items-center gap-2">
                        <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-400">Bug type</span>
                        <Btn active={draft.bug_type === 'process_bug'} onClick={() => setDraft(key, { bug_type: 'process_bug' })}>Process</Btn>
                        <Btn active={draft.bug_type === 'structural_bug'} onClick={() => setDraft(key, { bug_type: 'structural_bug' })}>Structural</Btn>
                      </div>
                    )}

                    {draft.validity === 'valid_signal' && (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-400">Importance</span>
                          {(['low', 'med', 'high'] as Importance[]).map((i) => (
                            <Btn key={i} active={(draft.importance ?? t.importance_hint) === i} onClick={() => setDraft(key, { importance: i })}>{i}</Btn>
                          ))}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-400">Route?</span>
                          <Btn active={draft.routed === true} tone="sky" onClick={() => setDraft(key, { routed: true })}>Route to doctor</Btn>
                          <Btn active={draft.routed === false} onClick={() => setDraft(key, { routed: false, response_required: undefined })}>Don’t route</Btn>
                        </div>
                        {draft.routed && (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-400">Response</span>
                            {(Object.keys(RESPONSE_LABELS) as ResponseReq[]).map((rr) => (
                              <Btn key={rr} active={draft.response_required === rr} tone={rr === 'recommend_privilege_review' ? 'purple' : 'sky'} onClick={() => setDraft(key, { response_required: rr })}>
                                {rr === 'recommend_privilege_review' ? <span className="inline-flex items-center gap-1"><ShieldAlert className="h-3 w-3" /> Privilege review</span> : RESPONSE_LABELS[rr].replace('Ask for ', '').replace('Ask to ', '')}
                              </Btn>
                            ))}
                          </div>
                        )}
                      </>
                    )}

                    {/* Feature C — required dismiss reason / resolution outcome chip + optional note */}
                    {(() => {
                      const kind = transitionKind(draft);
                      if (!kind) return null;
                      const chips = kind === 'dismiss' ? DISMISS_REASONS : RESOLUTION_OUTCOMES;
                      const labels = kind === 'dismiss' ? DISMISS_LABELS : OUTCOME_LABELS;
                      return (
                        <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-400">{kind === 'dismiss' ? 'Reason' : 'Outcome'}</span>
                            {chips.map((c) => (
                              <Btn key={c} active={draft.eventChip === c} tone={kind === 'dismiss' ? 'rose' : 'emerald'} onClick={() => setDraft(key, { eventChip: c })}>{labels[c]}</Btn>
                            ))}
                          </div>
                          <input value={draft.eventNote || ''} onChange={(e) => setDraft(key, { eventNote: e.target.value })}
                            placeholder="Add a note (optional)"
                            className="mt-2 h-7 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12px] text-slate-700 outline-none focus:border-slate-300" />
                        </div>
                      );
                    })()}

                    {draft.error && <div className="text-[11.5px] text-rose-600">{draft.error}</div>}

                    <div className="flex items-center gap-2 pt-0.5">
                      <button disabled={!canApply(key) || draft.busy} onClick={() => apply(doctor, t)}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-white transition ${
                          canApply(key) && !draft.busy ? 'bg-slate-800 hover:bg-slate-900' : 'cursor-not-allowed bg-slate-300'}`}>
                        {draft.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        {draft.validity === 'audit_bug' ? `Junk all ${t.count}` : `Apply to all ${t.count}`}
                      </button>
                      <span className="text-[11px] text-slate-400">Batches the decision across all {t.count} instance(s)</span>
                      {/* Quieting (Q4/Q5): named care proposal → admin activation. Safety types are
                          structurally un-quietable — the button is disabled with the reason shown
                          (and the core + store both enforce the floor server-side regardless). */}
                      {isSafetySignalType(t.signal_type) ? (
                        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-slate-400" title="Deterministic patient-safety signals cannot be quieted — the severity floor is enforced in the engine, not just here.">
                          <BellOff className="h-3 w-3" /> safety signal — can’t quiet
                        </span>
                      ) : (
                        <button onClick={() => setQuietDrafts((qd) => ({ ...qd, [key]: { ...qd[key], open: !qd[key]?.open, scope: qd[key]?.scope ?? (rep.lvc_category ? 'category' : 'subject') } }))}
                          className="ml-auto inline-flex items-center gap-1 rounded-lg border border-violet-200 bg-white px-2 py-1 text-[11.5px] font-medium text-violet-700 transition hover:bg-violet-50">
                          <BellOff className="h-3 w-3" /> Quiet this signal type
                        </button>
                      )}
                    </div>

                    {/* Quiet proposal form (care session): scope + mandatory reason + named proposer */}
                    {quietDrafts[key]?.open && !isSafetySignalType(t.signal_type) && (() => {
                      const qd = quietDrafts[key] || {};
                      const setQd = (patch: QuietDraft) => setQuietDrafts((all) => ({ ...all, [key]: { ...all[key], ...patch } }));
                      if (qd.done) return <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-[12px] text-violet-800">{qd.done}</div>;
                      const canSubmit = !!(qd.reason || '').trim() && !!(qd.proposer || '').trim() && (qd.scope === 'category' ? !!rep.lvc_category : !!(qd.pattern || rep.subject));
                      const submit = async () => {
                        setQd({ busy: true, error: undefined });
                        try {
                          const body = {
                            op: 'propose-demote', signal_type: t.signal_type,
                            match_kind: qd.scope === 'category' ? 'lvc_category' : 'subject_contains',
                            discriminator: qd.scope === 'category' ? rep.lvc_category : (qd.pattern || rep.subject),
                            reason: (qd.reason || '').trim(), created_by: (qd.proposer || '').trim(),
                            source_triage_ref: rep.audit_id,
                          };
                          const r = await fetch('/api/opd-triage/suppressions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
                          const j = await r.json();
                          if (!j.ok) throw new Error(j.error || 'proposal failed');
                          setQd({ busy: false, done: 'Quiet proposal recorded — pending administrator activation (Quieting tab).' });
                        } catch (e) { setQd({ busy: false, error: String((e as Error).message) }); }
                      };
                      return (
                        <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-wide text-violet-500">Scope</span>
                            {rep.lvc_category && <Btn active={qd.scope === 'category'} tone="purple" onClick={() => setQd({ scope: 'category' })}>Category: {LVC_CAT_LABEL[rep.lvc_category] || rep.lvc_category}</Btn>}
                            <Btn active={qd.scope === 'subject'} tone="purple" onClick={() => setQd({ scope: 'subject' })}>Subject pattern</Btn>
                          </div>
                          {qd.scope === 'subject' && (
                            <input value={qd.pattern ?? rep.subject} onChange={(e) => setQd({ pattern: e.target.value })}
                              className="mt-2 h-7 w-full rounded-md border border-violet-200 bg-white px-2.5 text-[12px] text-slate-700 outline-none focus:border-violet-300" placeholder="Subject contains…" />
                          )}
                          <input value={qd.reason || ''} onChange={(e) => setQd({ reason: e.target.value })}
                            className="mt-2 h-7 w-full rounded-md border border-violet-200 bg-white px-2.5 text-[12px] text-slate-700 outline-none focus:border-violet-300" placeholder="Reason (required) — e.g. commonplace in Indian practice per governance ruling" />
                          <input value={qd.proposer || ''} onChange={(e) => setQd({ proposer: e.target.value })}
                            className="mt-2 h-7 w-full rounded-md border border-violet-200 bg-white px-2.5 text-[12px] text-slate-700 outline-none focus:border-violet-300" placeholder="Your name (required — recorded as the proposer)" />
                          {qd.error && <div className="mt-1.5 text-[11.5px] text-rose-600">{qd.error}</div>}
                          <div className="mt-2 flex items-center gap-2">
                            <button disabled={!canSubmit || qd.busy} onClick={submit}
                              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium text-white transition ${canSubmit && !qd.busy ? 'bg-violet-600 hover:bg-violet-700' : 'cursor-not-allowed bg-slate-300'}`}>
                              {qd.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BellOff className="h-3 w-3" />} Propose quieting
                            </button>
                            <span className="text-[11px] text-violet-500">Scores nothing until an administrator activates it.</span>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
            {doctor && doctor.types.length === 0 && (
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-[13px] text-slate-400">All of {doctor.name || doctor.doctor_uid}’s signals are cleared.</div>
            )}
          </section>
        </div>
      )}
      </>
      )}
    </div>
  );
}

// ── Stage 3 — the Longitudinal label-only lane (normative mockup: CDMSS-STAGE3-MOCKUP-TRIAGE-LABEL-ONLY).
// Corpus-wide informational findings grouped by signal_type. The CM's ONLY decision is a validity label
// (valid_signal | audit_bug) — no route, no response. The label is what earns the type promotion; the gate
// meter reads the same signal-health FP-rate. Writes via the shared POST /api/opd-triage/decide (routed:false).
type LaneValidity = 'valid_signal' | 'audit_bug';
interface LaneDraft { validity?: LaneValidity; importance?: Importance; busy?: boolean; done?: string; error?: string }

const GATE_PILL: Record<string, string> = {
  eligible: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  collecting: 'bg-indigo-50 text-indigo-700 border border-indigo-200',
  failing: 'bg-rose-50 text-rose-700 border border-rose-200',
};
const GATE_BAR: Record<string, string> = { eligible: 'bg-emerald-500', collecting: 'bg-indigo-500', failing: 'bg-rose-500' };
const GATE_LABEL: Record<string, string> = { eligible: 'Eligible to promote', collecting: 'Collecting labels', failing: 'Failing gate' };

function GateMeter({ gate }: { gate: LaneGateVM | null }) {
  const status = gate?.status ?? 'collecting';
  const labelled = gate?.labelled ?? 0;
  const min = gate?.minLabelled ?? 50;
  const fpPct = Math.round((gate?.fpRate ?? 0) * 100);
  const barW = status === 'collecting' ? Math.min(100, Math.round((labelled / Math.max(1, min)) * 100)) : 100;
  const right = status === 'collecting' ? `need ≥${min}` : 'gate <20%';
  const foot = status === 'eligible' ? `${labelled} / ${min} labelled · corpus-wide`
    : status === 'failing' ? `${labelled} / ${min} labelled · too noisy to promote`
    : `${labelled} / ${min} labelled`;
  return (
    <div className="ml-auto min-w-[260px]">
      <div className="mb-1 flex items-center justify-end gap-2 text-[12px] text-slate-500">
        <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${GATE_PILL[status]}`}>{GATE_LABEL[status]}</span>
        <b className="text-slate-800">FP-rate {fpPct}%</b> · {right}
      </div>
      <div className="h-2 overflow-hidden rounded-md bg-slate-100">
        <div className={`h-full rounded-md ${GATE_BAR[status]}`} style={{ width: `${barW}%` }} />
      </div>
      <div className="mt-1 text-right text-[11.5px] text-slate-400">{foot}</div>
    </div>
  );
}

function LongitudinalLane({ data, onDecided }: { data: LaneResp | null; onDecided: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, LaneDraft>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const set = (k: string, patch: LaneDraft) => setDrafts((d) => ({ ...d, [k]: { ...d[k], ...patch } }));

  if (!data) return <div className="mt-16 text-center text-[13px] text-slate-400">Longitudinal lane unavailable.</div>;
  const types = data.types;

  async function label(t: LaneTypeVM, validity: LaneValidity, importance?: Importance) {
    const k = t.signal_type;
    if (!t.doctor_uid) { set(k, { error: 'no doctor context to record the label' }); return; }
    const draft = drafts[k] || {};
    const imp = importance || draft.importance || 'med';
    const body: Record<string, unknown> = {
      scope: 'type', doctor_uid: t.doctor_uid, signal_type: t.signal_type,
      window_from: data!.window.from, window_to: data!.window.to, validity, routed: false,
    };
    // The shipped validator requires a bug_type for audit_bug and an importance for valid_signal, even
    // for a label-only decision. Longitudinal audit-bugs are prompt/logic issues → process_bug; importance
    // defaults to Medium (the mockup's shown default). routed:false keeps it out of the doctor-facing lane.
    let receipt = '';
    if (validity === 'audit_bug') { body.bug_type = 'process_bug'; receipt = 'Audit bug — logged (informational)'; }
    else { body.importance = imp; receipt = `Valid signal · ${imp} — logged (no route)`; }
    set(k, { validity, importance: validity === 'valid_signal' ? imp : undefined, busy: true, error: undefined });
    try {
      const r = await fetch('/api/opd-triage/decide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'label failed');
      set(k, { busy: false, done: receipt });
      onDecided();
    } catch (e) { set(k, { busy: false, error: String((e as Error).message) }); }
  }

  return (
    <div className="mt-4">
      <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 px-4 py-3 text-[13px] text-indigo-900/80">
        <b className="text-indigo-700">Label-only lane.</b> These are informational, context-aware findings — they don’t route to a doctor and don’t touch the score. Your <b>validity label</b> is what earns each type promotion to the scored plane: a type becomes eligible once its false-positive rate is <b>under 20% over at least 50 labelled instances</b>. No route or response needed.
      </div>
      <div className="mt-2 flex flex-wrap gap-4 text-[11.5px] text-slate-500">
        <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-5 rounded bg-emerald-500" /> eligible to promote</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-5 rounded bg-indigo-500" /> collecting labels</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-5 rounded bg-rose-500" /> failing the gate</span>
      </div>

      {types.length === 0 ? (
        <div className="mt-14 text-center text-[13px] text-slate-400">No longitudinal findings in this window yet.</div>
      ) : (
        <div className="mt-4 space-y-4">
          {types.map((t) => {
            const draft = drafts[t.signal_type] || {};
            const current = draft.validity || t.triage?.validity;                 // draft wins; else the stored label
            const showImportance = current === 'valid_signal';
            const rep = t.instances[0];
            const isOpen = !!expanded[t.signal_type];
            const failing = t.gate?.status === 'failing';
            return (
              <div key={t.signal_type} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3.5">
                  <span className="rounded-md border border-indigo-200 bg-indigo-50 px-2 py-0.5 font-mono text-[12px] font-bold text-indigo-700">{t.signal_type}</span>
                  <div>
                    <div className="text-[14px] font-semibold text-slate-900">{t.label}</div>
                    <div className="text-[12px] text-slate-500">{t.count} instance{t.count === 1 ? '' : 's'} this window · {t.gate?.labelled ?? 0} labelled all-time</div>
                  </div>
                  <GateMeter gate={t.gate} />
                </div>

                {failing && (
                  <div className="border-b border-slate-100 bg-rose-50 px-4 py-3 text-[12.5px] text-rose-800">
                    <b className="text-rose-700">Not eligible.</b> Care managers marked {Math.round((t.gate?.fpRate ?? 0) * 100)}% of these an audit bug — above the 20% ceiling. This type stays informational and does <b>not</b> move to scoring; the gate is protecting doctors from a noisy signal. Send it to the <a href="/care/triage/health" className="underline">signal-health panel</a> for a prompt/logic review before it can qualify.
                  </div>
                )}

                {rep && (
                  <div className="px-4 py-3.5">
                    <div className="text-[13.5px] text-slate-800">{rep.subject}</div>
                    {rep.rationale && <p className="mt-0.5 text-[12.5px] leading-relaxed text-slate-600">{rep.rationale}</p>}
                    <div className="mt-1.5 text-[12px] text-slate-500">
                      note {rep.note_date}{rep.cited ? <> · cited <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11.5px] text-slate-600">{rep.cited.replace(/^Cited:\s*/i, '')}</code></> : null}
                    </div>

                    {/* Label-only decision — no route, no response. */}
                    <div className="mt-3 flex flex-wrap items-center gap-2.5">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Validity</span>
                      <button disabled={draft.busy || !t.doctor_uid} onClick={() => label(t, 'valid_signal')}
                        className={`rounded-lg border px-3 py-1 text-[12.5px] font-semibold transition ${current === 'valid_signal' ? 'border-emerald-500 bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}>
                        Valid signal
                      </button>
                      <button disabled={draft.busy || !t.doctor_uid} onClick={() => label(t, 'audit_bug')}
                        className={`inline-flex items-center gap-1 rounded-lg border px-3 py-1 text-[12.5px] font-semibold transition ${current === 'audit_bug' ? 'border-rose-400 bg-rose-50 text-rose-700 ring-1 ring-rose-200' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}>
                        <Bug className="h-3 w-3" /> Audit bug
                      </button>
                      {showImportance && (
                        <label className="ml-1 flex items-center gap-1.5 text-[12px] text-slate-500">
                          importance
                          <select value={draft.importance || 'med'} disabled={draft.busy}
                            onChange={(e) => label(t, 'valid_signal', e.target.value as Importance)}
                            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-700 outline-none focus:border-slate-300">
                            <option value="low">Low</option><option value="med">Medium</option><option value="high">High</option>
                          </select>
                        </label>
                      )}
                      <span className="ml-auto text-[11.5px] italic text-slate-400">
                        {draft.busy ? <span className="inline-flex items-center gap-1 not-italic"><Loader2 className="h-3 w-3 animate-spin" /> saving…</span>
                          : draft.done ? <span className="not-italic text-emerald-600">✓ {draft.done}</span>
                          : 'no route · no response — informational'}
                      </span>
                    </div>
                    {draft.error && <div className="mt-1 text-[11.5px] text-rose-600">{draft.error}</div>}
                  </div>
                )}

                {t.count > 1 && (
                  <div className="border-t border-slate-100">
                    <button onClick={() => setExpanded((x) => ({ ...x, [t.signal_type]: !isOpen }))}
                      className="w-full px-4 py-2.5 text-left text-[12.5px] font-semibold text-indigo-700 hover:bg-indigo-50/40">
                      {isOpen ? '− Hide the other instances' : `+ ${t.count - 1} more instance${t.count - 1 === 1 ? '' : 's'} in this window →`}
                    </button>
                    {isOpen && (
                      <div className="space-y-2 px-4 pb-3.5">
                        {t.instances.slice(1).map((i) => (
                          <div key={i.finding_ref} className="rounded-lg bg-slate-50 px-3 py-2">
                            <div className="text-[12.5px] text-slate-700">{i.subject}</div>
                            <div className="text-[11.5px] text-slate-500">note {i.note_date}{i.cited ? ` · ${i.cited.replace(/^Cited:\s*/i, '')}` : ''}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-5 border-t border-slate-100 pt-3.5 text-[11.5px] text-slate-500">
        The promotion gate reads from the <a href="/care/triage/health" className="text-indigo-700 underline">signal-health panel</a> — the same FP-rate machinery already tracking scored signals. Promoting an eligible type to the scored plane is a deliberate versioned step (a 0.9 addendum), never automatic. The Action-queue lane (routable signals → governance threads) is unchanged by Stage 3.
      </p>
    </div>
  );
}

// ── Quieting tab (PRD CDMSS-QUIETING-DEMOTE-SYSTEM Q4/Q5) ─────────────────────
// Proposed + active + retired demote rules with full provenance (proposer, reason, dates) and a live
// 30-day dry-run count per rule. Activate/retire render ONLY under the admin surface (is_admin from
// the server); the endpoints enforce admin regardless of what this client shows.
function QuietingTab({ data, onChanged }: { data: QuietingResp | null; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number | null>>({});

  const rules = (data?.suppressions || []).filter((s) => s.action === 'demote');
  const order: Record<string, number> = { proposed: 0, active: 1, retired: 2 };
  rules.sort((a, b) => (order[a.status || 'retired'] - order[b.status || 'retired']) || (a.created_at < b.created_at ? 1 : -1));

  useEffect(() => {
    let dead = false;
    (async () => {
      for (const r of rules) {
        if (counts[r.id] !== undefined) continue;
        try {
          const resp = await fetch('/api/admin/quieting-dryrun', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ signal_type: r.signal_type, match_kind: r.match_kind, discriminator: r.discriminator }),
          });
          const j = await resp.json();
          if (!dead) setCounts((c) => ({ ...c, [r.id]: j.ok ? Number(j.would_quiet) : null }));
        } catch { if (!dead) setCounts((c) => ({ ...c, [r.id]: null })); }
      }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  async function act(id: string, op: 'approve-demote' | 'retire-demote') {
    setBusy(id); setErr(null);
    try {
      const r = await fetch('/api/opd-triage/suppressions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, id }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `${op} failed`);
      onChanged();
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(null); }
  }

  const pill: Record<string, string> = {
    proposed: 'bg-amber-100 text-amber-700', active: 'bg-violet-100 text-violet-700', retired: 'bg-slate-100 text-slate-500',
  };
  const vol = data?.quieted_volume_30d;

  return (
    <div className="mt-4">
      <div className="rounded-xl border border-violet-100 bg-violet-50/60 px-4 py-3 text-[13px] text-violet-900/80">
        <b className="text-violet-700">Quieting = routing and scoring policy, never the record.</b> A quieted finding is still generated, stored and counted in care/admin/analytics surfaces — it stops affecting the doctor’s score and doctor-facing display. A named care manager proposes with a reason; the <b>administrator role</b> activates; every activation increments the policy generation stamped on each audit row. Deterministic safety signals cannot be quieted.
        {vol && <span className="ml-1 text-violet-700">Last 30 days: <b>{vol.quieted}</b> quieted finding(s) vs {vol.low_value} low-value flagged.</span>}
      </div>

      {err && <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700">{err}</div>}

      <div className="mt-4 space-y-2.5">
        {rules.length === 0 && (
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-[13px] text-slate-400">
            No quieting rules yet. Propose one from a finding card on the Action queue.
          </div>
        )}
        {rules.map((r) => (
          <div key={r.id} className="rounded-xl border border-slate-200 bg-white p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${pill[r.status || 'retired']}`}>{r.status || 'retired'}</span>
              <span className="text-[13px] font-semibold text-slate-800">{r.signal_type}</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                {r.match_kind === 'lvc_category' ? `category = ${r.discriminator}` : r.match_kind === 'subject_contains' ? `subject ∋ “${r.discriminator}”` : 'whole type'}
              </span>
              <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10.5px] text-violet-700">
                {counts[r.id] === undefined ? 'counting…' : counts[r.id] === null ? 'count unavailable' : `would have quieted ${counts[r.id]} finding(s) · 30d`}
              </span>
              <span className="ml-auto text-[11px] text-slate-400">rule {r.id.slice(0, 8)}</span>
            </div>
            <div className="mt-1.5 text-[12px] text-slate-600">{r.reason || <i>no reason recorded</i>}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
              <span>proposed by <b className="text-slate-600">{r.created_by || 'unknown'}</b> · {r.created_at.slice(0, 10)}</span>
              {r.approved_at && <span>· activated by <b className="text-slate-600">{r.approved_by}</b> (role) · {r.approved_at.slice(0, 10)}</span>}
              {data?.is_admin && r.status === 'proposed' && (
                <button disabled={busy === r.id} onClick={() => act(r.id, 'approve-demote')}
                  className="ml-auto rounded-lg bg-violet-600 px-2.5 py-1 text-[11.5px] font-medium text-white transition hover:bg-violet-700 disabled:bg-slate-300">
                  {busy === r.id ? 'Activating…' : 'Activate (admin)'}
                </button>
              )}
              {data?.is_admin && r.status === 'active' && (
                <button disabled={busy === r.id} onClick={() => act(r.id, 'retire-demote')}
                  className="ml-auto rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11.5px] font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
                  {busy === r.id ? 'Retiring…' : 'Retire (admin)'}
                </button>
              )}
              {!data?.is_admin && r.status === 'proposed' && <span className="ml-auto italic">awaiting administrator activation</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
