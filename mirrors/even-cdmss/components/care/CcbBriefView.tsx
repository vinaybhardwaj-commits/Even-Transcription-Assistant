'use client';

// Renders a CcbEnvelope as the two-layer Care Conversation Brief: a cited CLINICAL engine
// beside a clearly-WALLED commercial layer. Reuses the Right Care citation kit so chips/sources
// stay pixel-consistent with the rest of CDMSS.
import { Stethoscope, BookOpen, Megaphone, ShieldCheck, Info } from 'lucide-react';
import { CitationChips, SourcesPanel, Collapsible, SectionTitle } from '@/components/right-care/kit';
import type { CcbEnvelope, ClinicalFinding, FindingKind, Grounding } from '@/lib/ccb-brief-core';

const KIND_LABEL: Record<FindingKind, string> = {
  synthesis: 'Episode synthesis',
  speciality: 'Speciality to work it up with',
  diagnosis: 'Potential diagnosis',
  treatment_line: 'Alternative treatment line',
  surgical_indication: 'Surgical / specialist indication',
  caution: 'Caution',
};

function GroundingPill({ g }: { g: Grounding }) {
  if (g === 'corpus_cited') return <span className="inline-flex items-center gap-1 rounded-full bg-teal-50 px-2 py-0.5 text-[10.5px] font-medium text-teal-800"><BookOpen className="h-3 w-3" /> Grounded in CDMSS corpus</span>;
  if (g === 'deterministic_rule') return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-medium text-slate-600">Deterministic rule</span>;
  return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-medium text-slate-500">General clinical reasoning</span>;
}

function FindingCard({ f, sources }: { f: ClinicalFinding; sources: CcbEnvelope['sources'] }) {
  const accent = f.kind === 'surgical_indication' ? 'border-l-violet-500' : f.kind === 'caution' ? 'border-l-amber-500' : 'border-l-slate-200';
  return (
    <div className={`rounded-lg border border-slate-200 border-l-4 ${accent} bg-white p-3`}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-slate-500">{KIND_LABEL[f.kind]}</span>
        <span className="ml-auto"><GroundingPill g={f.grounding} /></span>
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-slate-800">{f.claim}</p>
      {f.grounding === 'corpus_cited' && <CitationChips ids={f.citation_ids} sources={sources} />}
    </div>
  );
}

const PRIORITY_TONE: Record<string, string> = {
  high: 'bg-red-50 text-red-800 border-red-200',
  med: 'bg-amber-50 text-amber-800 border-amber-200',
  low: 'bg-slate-50 text-slate-600 border-slate-200',
};

export default function CcbBriefView({ env }: { env: CcbEnvelope }) {
  const gs = env.grounding_summary;
  const c = env.commercial;
  const gatedClaims = c.gated_on
    .map((id) => env.clinical.find((f) => f.id === id)?.claim)
    .filter(Boolean) as string[];

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-slate-500">
          <span className="inline-flex items-center gap-1 rounded-full bg-teal-50 px-2 py-0.5 font-medium text-teal-800"><ShieldCheck className="h-3.5 w-3.5" /> {gs.citation_coverage_pct}% grounded · {gs.distinct_sources} sources</span>
          <span className={`rounded-full px-2 py-0.5 font-medium ${env.episode.coverage === 'rich' ? 'bg-teal-50 text-teal-700' : 'bg-slate-100 text-slate-500'}`}>{env.episode.coverage === 'rich' ? 'Result documents read' : 'Order-level (no result PDF)'}</span>
          <span className="ml-auto text-[11px] text-slate-400">{env.episode.date} · {env.engine_version}</span>
        </div>
      </div>

      {/* clinical engine */}
      <section>
        <SectionTitle icon={<Stethoscope className="h-3.5 w-3.5" />} text="Clinical engine — advisory, non-diagnostic" />
        <div className="space-y-2">
          {env.clinical.length ? env.clinical.map((f) => <FindingCard key={f.id} f={f} sources={env.sources} />)
            : <div className="rounded-lg border border-dashed border-slate-200 p-3 text-[12.5px] text-slate-400">No findings generated.</div>}
        </div>
      </section>

      {/* commercial layer — visibly walled */}
      <section className="rounded-xl border-2 border-dashed border-violet-200 bg-violet-50/40 p-4">
        <SectionTitle icon={<Megaphone className="h-3.5 w-3.5 text-violet-500" />} text="Outreach layer — care conversation, not medical advice" />
        {c.pitch_allowed ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[12px]">
              <span className={`rounded-full border px-2 py-0.5 font-medium ${PRIORITY_TONE[c.priority] || PRIORITY_TONE.low}`}>Priority: {c.priority}</span>
              {c.push_harder && <span className="rounded-full bg-violet-100 px-2 py-0.5 font-medium text-violet-800">Push harder</span>}
            </div>
            {c.script && <p className="rounded-lg border border-violet-200 bg-white p-3 text-[13px] leading-relaxed text-slate-800">{c.script}</p>}
            {gatedClaims.length > 0 && (
              <div className="text-[11px] text-violet-700"><span className="font-medium">Indicated by:</span> {gatedClaims.join(' · ')}</div>
            )}
          </div>
        ) : (
          <div className="flex items-start gap-1.5 text-[12.5px] text-slate-500">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            No second-opinion pitch — the brief found no corpus-cited surgical/specialist indication. (Priority: {c.priority}.)
          </div>
        )}
      </section>

      {/* sources */}
      {env.sources.length > 0 && (
        <Collapsible title="Sources" icon={<BookOpen className="h-4 w-4" />} count={env.sources.length}>
          <SourcesPanel sources={env.sources} />
        </Collapsible>
      )}

      <p className="text-[11px] leading-relaxed text-slate-400">{env.disclaimer}</p>
    </div>
  );
}
