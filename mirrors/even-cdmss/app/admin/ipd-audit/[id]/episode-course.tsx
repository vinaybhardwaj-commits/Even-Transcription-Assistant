// app/admin/ipd-audit/[id]/episode-course.tsx — EpisodeState (#4) SL3: the persisted intra-phase
// EpisodeState rendered as a legible phased course, on the IPD audit report.
//
// READ-ONLY render of what SL2 already persisted in episode_states — no re-build, no re-extract.
// FACTS-ONLY: documented facts + their provenance ONLY. It introduces NO band / CVI / scored /
// predicted element; the audit's Care-Value Index (shown elsewhere on this page) belongs to the
// AUDIT, not to EpisodeState — the two are kept visually and semantically separate. The palette is
// deliberately teal/slate (never the scored A–E ramp; no bandColor/scoreColor import).
//
// Reuses the CCB timeline primitives: the datable admission events are TimelineItem[] ordered by
// mergeTimeline; the non-datable documented facts render as the in-hospital course beneath them.
import type { EpisodeState, EpisodeFact } from '@/lib/episode-state/schema';
import { EPISODE_STATE_VERSION } from '@/lib/episode-state/schema';
import { mergeTimeline, type TimelineItem } from '@/lib/ccb-dossier-core';

const inr = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? `₹${n.toLocaleString('en-IN')}` : `₹${v}`;
};

/** Provenance made visible on hover — {sourceField, extractionMethod, confidence}, already on every
 *  fact. No PHI (the persisted object is de-identified). */
const prov = (f: EpisodeFact) =>
  `${f.provenance.sourceField} · ${f.provenance.extractionMethod} · confidence ${f.provenance.confidence}`;

/** The datable admission events as TimelineItem[], ordered by the shared mergeTimeline. Facts with
 *  no date (diagnosis, meds…) are the course content, rendered beneath — not timeline rows. */
export function admissionTimeline(s: EpisodeState): TimelineItem[] {
  const a = s.intra.admission;
  const events: TimelineItem[] = [];
  if (a.admitDate) {
    const bits = [a.speciality?.value, a.careSetting?.value, a.admissionType?.value ? `${a.admissionType.value} admission` : null].filter(Boolean);
    events.push({ date: a.admitDate.value, kind: 'ipd', title: 'Admitted', subtitle: bits.join(' · ') || null, refUid: null });
  }
  if (a.dischargeDate) {
    const bits = [a.dischargeType?.value, a.lengthOfStayDays?.value ? `${a.lengthOfStayDays.value}-day stay` : null].filter(Boolean);
    events.push({ date: a.dischargeDate.value, kind: 'ipd', title: 'Discharged', subtitle: bits.join(' · ') || null, refUid: null });
  }
  return mergeTimeline(events);   // date desc — discharge above admit
}

function FactChip({ f, tone = 'slate' }: { f: EpisodeFact; tone?: 'slate' | 'teal' }) {
  const cls = tone === 'teal' ? 'border-teal-200 bg-teal-50 text-teal-800' : 'border-slate-200 bg-slate-50 text-slate-700';
  return (
    <span title={prov(f)} className={`cursor-default rounded-md border px-2 py-0.5 text-[11.5px] ${cls}`}>{f.value}</span>
  );
}

function FactGroup({ label, facts }: { label: string; facts: EpisodeFact[] }) {
  if (!facts.length) return null;
  return (
    <div className="mt-2">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-slate-400">{label}</div>
      <div className="mt-1 flex flex-wrap gap-1.5">{facts.map((f, i) => <FactChip key={i} f={f} />)}</div>
    </div>
  );
}

function Phase({ label, active, empty, children }: { label: string; active: boolean; empty?: string; children?: React.ReactNode }) {
  return (
    <div className={`flex-1 rounded-lg border px-3 py-2 ${active ? 'border-teal-200 bg-white' : 'border-dashed border-slate-200 bg-slate-50/60'}`}>
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-teal-500' : 'bg-slate-300'}`} />
        <span className={`text-[11px] font-semibold uppercase tracking-[0.05em] ${active ? 'text-teal-700' : 'text-slate-400'}`}>{label}</span>
      </div>
      {active ? children : <div className="mt-1 text-[11px] italic text-slate-400">{empty ?? 'no OPD history linked'}</div>}
    </div>
  );
}

function PhaseFacts({ groups }: { groups: Array<{ label: string; facts: EpisodeFact[] }> }) {
  return <>{groups.filter((g) => g.facts.length).map((g) => (
    <div key={g.label} className="mt-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.05em] text-slate-400">{g.label}</div>
      <div className="mt-0.5 flex flex-wrap gap-1">{g.facts.map((f, i) => <FactChip key={i} f={f} />)}</div>
    </div>
  ))}</>;
}

export function NoEpisode() {
  return (
    <div className="mt-5 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-4 text-[12.5px] text-slate-500">
      No EpisodeState persisted for this admission yet — it is built on the next audit run.
    </div>
  );
}

/** The phased-course element. `state` is the persisted, de-identified EpisodeState (intra populated
 *  at v0.1; pre/post typed-but-empty). */
export default function EpisodeCourse({ state }: { state: EpisodeState }) {
  const i = state.intra;
  const a = i.admission;
  const events = admissionTimeline(state);
  const demo = [state.demographics.age != null ? `${state.demographics.age}y` : null, state.demographics.sex].filter(Boolean).join(' ');
  const preActive = !!(state.pre.presentingComplaints.length || state.pre.priorConditions.length || state.pre.homeMedications.length);
  const postActive = !!(state.post.followUpPlan.length || state.post.dischargeMedications.length || state.post.warningSigns.length);

  return (
    <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-slate-800">Documented course</span>
          <span className="rounded-full border border-teal-200 bg-teal-50 px-1.5 py-[1px] text-[10px] font-medium text-teal-700">facts only</span>
        </div>
        <span className="text-[10.5px] text-slate-400">EpisodeState · {EPISODE_STATE_VERSION} · {state.episodeRef}{demo ? ` · ${demo}` : ''}</span>
      </div>
      <p className="mt-0.5 text-[11px] text-slate-400">Documented facts + provenance (hover a fact) — a factual projection, not an audit assessment.</p>

      {/* pre → intra → post bracket; only intra populated at v0.1 */}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Phase label="Pre-admission" active={preActive} empty="no OPD history before admission">
          <PhaseFacts groups={[
            { label: 'Presenting', facts: state.pre.presentingComplaints },
            { label: 'Prior conditions', facts: state.pre.priorConditions },
            { label: 'Prior OPD meds', facts: state.pre.homeMedications },
          ]} />
        </Phase>
        <Phase label="In-hospital" active>
          {a.speciality || a.lengthOfStayDays ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {a.speciality && <FactChip f={a.speciality} tone="teal" />}
              {a.ward && <FactChip f={a.ward} />}
              {a.careSetting && <FactChip f={a.careSetting} />}
              {a.admissionType && <FactChip f={a.admissionType} />}
              {a.lengthOfStayDays && <FactChip f={a.lengthOfStayDays} tone="teal" />}
              {a.dischargeType && <FactChip f={a.dischargeType} />}
            </div>
          ) : null}
        </Phase>
        <Phase label="Post-discharge" active={postActive} empty="no OPD follow-up after discharge">
          <PhaseFacts groups={[
            { label: 'OPD follow-up', facts: state.post.followUpPlan },
            { label: 'Discharge meds', facts: state.post.dischargeMedications },
            { label: 'Warning signs', facts: state.post.warningSigns },
          ]} />
        </Phase>
      </div>

      {/* the in-hospital course */}
      <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/50 p-3">
        {events.length > 0 && (
          <ol className="relative mb-1 pl-[18px]">
            {events.map((t, idx) => (
              <li key={idx} className="relative mb-2">
                <span className="absolute -left-[18px] top-[6px] h-[11px] w-[11px] rounded-full border-[2.5px] border-white ring-[1.5px] ring-teal-300 bg-teal-400" />
                <span className="text-[11px] text-slate-400">{t.date || 'undated'}</span>
                <span className="ml-2 text-[13px] font-medium text-slate-800">{t.title}</span>
                {t.subtitle && <span className="ml-2 text-[12px] text-slate-500">{t.subtitle}</span>}
              </li>
            ))}
          </ol>
        )}

        {i.diagnosis && (
          <div className="mt-1">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-slate-400">Diagnosis</div>
            <span title={prov(i.diagnosis)} className="text-[13.5px] font-medium text-slate-800">{i.diagnosis.value}</span>
          </div>
        )}
        <FactGroup label="Procedures" facts={i.procedures} />
        <FactGroup label="Medications" facts={i.medications} />
        <FactGroup label="Treatments" facts={i.treatments} />
        <FactGroup label="Investigations" facts={i.investigations} />

        {i.billing.netTotal && (
          <div className="mt-3 flex items-center gap-2 border-t border-slate-200 pt-2">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-slate-400">Billed envelope</span>
            <span title={prov(i.billing.netTotal)} className="text-[13px] font-semibold text-slate-700">{inr(i.billing.netTotal.value)}</span>
            <span className="text-[10.5px] text-slate-400">documented fact — not an audit assessment</span>
          </div>
        )}
      </div>
    </div>
  );
}
