'use client';

import React, { useState, useEffect } from 'react';
import { CheckCircle2, Loader2, ChevronDown, ChevronUp, AlertTriangle, Copy, Check, ExternalLink } from 'lucide-react';
import { formatDuration } from '@/lib/format-duration';
import { getStageExplainer } from '@/lib/stage-explainers';
import { sanitizeModelNames } from '@/lib/model-labels';

type StageMedians = {
  variants: number; retrieving: number; reranking: number;
  drafting: number; reviewing: number; revising: number;
  total_p50: number; total_p90: number;
};
const STAGE_WEIGHTS_FALLBACK: StageMedians = {
  variants: 10_000, retrieving: 40_000, reranking: 5_000,
  drafting: 50_000, reviewing: 30_000, revising: 50_000,
  total_p50: 185_000, total_p90: 280_000,
};

export type TraceEvent = {
  stage: string;
  msg: string;
  ms?: number;
  done: boolean;
  error?: boolean;
  ts: number;
};



// v2.0.3 — chip-aware hybrid progress bar for /ask.
// /ask differs from /drugs in two ways: (1) it has real calibrated medians
// from /api/ask/stage-medians (rolling 30d p50 per stage), so the time-based
// bar is data-driven not estimated; (2) the pipeline shape depends on which
// toggle chips are active (PLOS, multi-query, self-critique, reranker,
// source-weights). The bar should reflect the SPECIFIC query's pipeline —
// no reserved space for stages that won't fire.
//
// Approach: stage milestones are computed at render time from (a) chips
// state and (b) the actual median weights per stage. Each active stage gets
// a milestone pct proportional to its median weight in the total. Then the
// bar acts hybrid — the highest-hit milestone is a FLOOR, but within a band
// the bar time-interpolates using the actual median for the next stage
// (capped at 90% of the band so it can't overshoot the next milestone).
export type AskChips = {
  useMultiQuery?: boolean;
  selfCritique?: boolean;
  useReranker?: boolean;
  useSourceWeights?: boolean;
  includePlos?: boolean;
};

type AskStageSpec = { stage: string; match: RegExp; weight: number; label: string };

function computeAskStages(medians: StageMedians, chips: AskChips): AskStageSpec[] {
  const stages: AskStageSpec[] = [];

  // 1. expanding — always fires; faster path when multi-query is off (just one rewrite)
  stages.push({
    stage: 'expanding',
    match: chips.useMultiQuery ? /(query variants|Generating query variants)/i : /(Rewriting query|Rewrote query)/i,
    weight: chips.useMultiQuery ? medians.variants : Math.max(3_000, medians.variants * 0.3),
    label: chips.useMultiQuery ? 'Generating variants' : 'Rewriting query',
  });

  // 2. retrieving — always fires
  stages.push({
    stage: 'retrieving',
    match: /Retrieved \d+/i,
    weight: medians.retrieving,
    label: 'Retrieving',
  });

  // 3. reranking OR fusing — only one fires
  if (chips.useReranker) {
    stages.push({
      stage: 'reranking',
      match: /Reranked by cross-encoder/i,
      weight: medians.reranking,
      label: 'Reranking',
    });
  } else if (chips.useSourceWeights) {
    stages.push({
      stage: 'fusing',
      match: /Applied source-quality/i,
      weight: 1_000,
      label: 'Source-quality fusion',
    });
  }

  // 4. answer generation — branched by selfCritique
  if (chips.selfCritique) {
    stages.push({ stage: 'drafting',  match: /Drafting answer/i,           weight: medians.drafting,  label: 'Drafting' });
    stages.push({ stage: 'reviewing', match: /Auditing draft/i,            weight: medians.reviewing, label: 'Auditing' });
    // Revising only fires if the audit flagged issues; reserve a partial band
    // (50%) since revisions happen on ~half of queries empirically.
    stages.push({ stage: 'revising',  match: /Revising with/i,             weight: medians.revising * 0.5, label: 'Revising' });
  } else {
    stages.push({
      stage: 'generating',
      match: /Generating answer/i,
      weight: medians.drafting,
      label: 'Generating',
    });
  }

  return stages;
}


// v2.0.3b — /ddx stage spec. Mirrors /ask hybrid pattern but with /ddx-specific
// emit-msg regexes ("Drafting with the reasoning model" vs "Drafting answer"),
// no reranking/fusing surface events (collapsed into retrieve()), and an
// extra `parsing` step since /ddx returns structured DDx JSON.
function computeDdxStages(medians: StageMedians, chips: AskChips): AskStageSpec[] {
  const stages: AskStageSpec[] = [];

  // expanding — multi-query variants OR single rewrite
  stages.push({
    stage: 'expanding',
    match: chips.useMultiQuery ? /(Generating query variants|Generated \d+ query variants)/i : /(Building clinical summary|expanding query)/i,
    weight: chips.useMultiQuery ? medians.variants : Math.max(3_000, medians.variants * 0.3),
    label: chips.useMultiQuery ? 'Generating variants' : 'Expanding query',
  });

  // retrieving — always fires
  stages.push({
    stage: 'retrieving',
    match: /Retrieved \d+/i,
    weight: medians.retrieving,
    label: 'Retrieving',
  });

  // answer generation — branched by selfCritique. /ddx uses qwen2.5:14b for both
  // draft and revise so timings track /ask medians closely.
  if (chips.selfCritique) {
    stages.push({ stage: 'drafting',  match: /Drafting with/i,             weight: medians.drafting,  label: 'Drafting DDx' });
    stages.push({ stage: 'reviewing', match: /Auditing DDx/i,              weight: medians.reviewing, label: 'Auditing DDx' });
    stages.push({ stage: 'revising',  match: /Revising DDx/i,              weight: medians.revising * 0.5, label: 'Revising DDx' });
  } else {
    stages.push({
      stage: 'generating',
      match: /Reasoning with/i,
      weight: medians.drafting,
      label: 'Reasoning',
    });
  }

  // parsing — always fires on /ddx (structured JSON output)
  stages.push({
    stage: 'parsing',
    match: /Parsing differential/i,
    weight: 1_500,
    label: 'Parsing DDx',
  });

  return stages;
}

function askMilestoneFor(events: TraceEvent[], stages: AskStageSpec[]): {
  current: number;
  next: number;
  nextWeightMs: number;
  sinceMs: number;
} {
  // Compute cumulative weights as percentages (cap last at 95% so 'done' triggers 100%).
  const total = stages.reduce((s, x) => s + x.weight, 0) || 1;
  const cumPcts: number[] = [];
  let cum = 0;
  for (const s of stages) {
    cum += s.weight;
    cumPcts.push(Math.min(95, (cum / total) * 95));
  }

  let currentIdx = -1;
  let sinceMs = Date.now();
  for (const e of events) {
    for (let i = 0; i < stages.length; i++) {
      if (stages[i].match.test(e.msg)) {
        if (i > currentIdx) { currentIdx = i; sinceMs = e.ts; }
      }
    }
  }
  const currentPct = currentIdx >= 0 ? cumPcts[currentIdx] : 2;
  const nextPct = currentIdx + 1 < cumPcts.length ? cumPcts[currentIdx + 1] : 95;
  const nextWeightMs = currentIdx + 1 < stages.length ? stages[currentIdx + 1].weight : 30_000;
  return { current: currentPct, next: nextPct, nextWeightMs, sinceMs };
}

// v2.0.2 — stage-anchored progress milestones for /drugs surfaces.
// The time-only bar from v2.0.1 still felt wrong on /drugs because the medians
// from /api/ask/stage-medians are calibrated for /ask (~30s) so on a 7-8min
// /drugs query the bar would either pin at 95% almost immediately (without
// re-scaling) or creep up linearly out of sync with what the pipeline is
// actually doing (with re-scaling). Milestones lock the bar to verified
// pipeline progress, with time-based interpolation only WITHIN a band.
type Milestone = { match: RegExp; pct: number };

// Order matches the /api/drugs/lookup emit sequence. The bar jumps when a
// matching message arrives and time-interpolates toward the next milestone
// while waiting. PubChem step is optional — skipped if PubChem fails to resolve.
const DRUGS_LOOKUP_MILESTONES: Milestone[] = [
  { match: /^Normalizing/i,                       pct: 3  },
  { match: /^Resolved to/i,                       pct: 6  },
  { match: /pharmacology excerpts/i,              pct: 10 },
  { match: /^PubChem CID/i,                       pct: 13 },
  { match: /^Phase 1\/3.*\(.*\)/i,             pct: 15 },
  { match: /^Phase 1\/3.*complete/i,             pct: 30 },
  { match: /^Phase 2\/3.*\(.*\)/i,             pct: 33 },
  { match: /pharmacology audit/i,                 pct: 50 },
  { match: /pharmacology revision/i,              pct: 58 },
  { match: /^Phase 2\/3.*complete/i,             pct: 70 },
  { match: /^Phase 3\/3.*\(.*\)/i,             pct: 73 },
  { match: /^Phase 3\/3.*complete/i,             pct: 95 },
];

const DRUGS_INTERACTIONS_MILESTONES: Milestone[] = [
  { match: /^Normalizing/i,           pct: 5  },
  { match: /^Checking:/i,             pct: 10 },
  { match: /^PubChem flagged/i,       pct: 20 },
  { match: /^Retrieved \d+ excerpts/i, pct: 35 },
  { match: /^Analyzing pairs/i,       pct: 45 },
  { match: /^Deduplicating/i,         pct: 90 },
];

// v2.x — /appropriateness surfaces (value · pathway · case-audit). The bar tracks
// the same retrieve→draft→critique→revise pipeline the grounded modes run, with the
// audit loop bands sized for its ~tripled latency. Messages match the route emits.
const APPROPRIATENESS_VALUE_MILESTONES: Milestone[] = [
  { match: /Retrieving evidence/i, pct: 8  },
  { match: /Retrieved \d+/i,       pct: 28 },
  { match: /Analyzing value/i,     pct: 42 },
  { match: /Auditing citations/i,  pct: 70 },
  { match: /Revising/i,            pct: 84 },
  { match: /Finalizing/i,          pct: 95 },
];

const APPROPRIATENESS_PATHWAY_MILESTONES: Milestone[] = [
  { match: /Detecting stage/i,     pct: 4  },
  { match: /Care path ready/i,     pct: 16 },
  { match: /Retrieving evidence/i, pct: 22 },
  { match: /Retrieved \d+/i,       pct: 38 },
  { match: /Enriching each step/i, pct: 50 },
  { match: /Auditing citations/i,  pct: 78 },
  { match: /Revising/i,            pct: 88 },
  { match: /Finalizing/i,          pct: 95 },
];

const APPROPRIATENESS_AUDIT_MILESTONES: Milestone[] = [
  { match: /Reading the document/i, pct: 5  },
  { match: /Document read/i,        pct: 20 },
  { match: /Retrieving evidence/i,  pct: 28 },
  { match: /Retrieved \d+/i,        pct: 42 },
  { match: /Auditing the case/i,    pct: 52 },
  { match: /Auditing citations/i,   pct: 78 },
  { match: /Revising/i,             pct: 88 },
  { match: /Finalizing/i,           pct: 95 },
];

function milestoneFor(events: TraceEvent[], table: Milestone[]): { current: number; next: number; sinceMs: number } {
  let currentIdx = -1;
  let sinceMs = Date.now();
  // Walk events in order; remember the highest milestone hit and when it landed.
  for (const e of events) {
    for (let i = 0; i < table.length; i++) {
      if (table[i].match.test(e.msg)) {
        if (i > currentIdx) {
          currentIdx = i;
          sinceMs = e.ts;
        }
      }
    }
  }
  const currentPct = currentIdx >= 0 ? table[currentIdx].pct : 2;
  const nextPct = currentIdx + 1 < table.length ? table[currentIdx + 1].pct : 95;
  return { current: currentPct, next: nextPct, sinceMs };
}

const STAGE_LABEL: Record<string, string> = {
  expanding: 'Query expansion',
  variants: 'Variants generated',
  retrieving: 'Hybrid retrieval',
  reranking: 'Reranking',
  fusing: 'Source-quality fusion',
  generating: 'Generating answer',
  drafting: 'Drafting answer',
  reviewing: 'Auditing draft',
  revising: 'Revising draft',
  finalizing: 'Finalizing',
  parsing: 'Parsing response',
  persisting: 'Saving trace',
  detecting: 'Detecting stage',
  enriching: 'Enriching steps',
  reading: 'Reading document',
  extracting: 'Extracting case',
  analyzing: 'Analyzing case',
  done: 'Done',
};

export default function TracePanel({ events, totalMs, traceId, surface, askChips }: { events: TraceEvent[]; totalMs?: number; traceId?: string | null; surface?: 'ask' | 'ddx' | 'coach' | 'drugs' | 'drugs-interactions' | 'appropriateness-value' | 'appropriateness-pathway' | 'appropriateness-audit'; askChips?: AskChips }) {
  // ALL HOOKS FIRST — no early returns above this line
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [medians, setMedians] = useState<StageMedians>(STAGE_WEIGHTS_FALLBACK);
  const [t0] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    fetch('/api/ask/stage-medians').then((r) => r.json()).then((j) => {
      if (!cancelled && j && typeof j.total_p50 === 'number') setMedians(j);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  function copyTraceId() {
    if (!traceId) return;
    navigator.clipboard?.writeText(traceId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  const last = events.length > 0 ? events[events.length - 1] : null;
  const isComplete = events.some((e) => e.stage === 'done') || !!totalMs;
  const hasError = events.some((e) => e.error);

  useEffect(() => {
    if (isComplete || hasError || events.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);  // 1Hz so progress bar feels live
    return () => clearInterval(t);
  }, [isComplete, hasError, events.length]);

  // Now safe to early-return
  if (events.length === 0 || !last) return null;
  const stalled = !isComplete && !hasError && (now - last.ts) > 45_000;

  return (
    <div className={`mb-3 rounded-lg border text-xs ${hasError ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-slate-50'}`}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        {hasError ? <AlertTriangle className="h-3.5 w-3.5 text-rose-600" />
          : isComplete ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
          : <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />}
        <span className="flex-1 font-medium text-slate-700">
          {isComplete ? `Pipeline complete · ${formatDuration(totalMs)}` : (STAGE_LABEL[last.stage] || last.stage)}
        </span>
        <span className="text-slate-400">{events.length} step{events.length !== 1 ? 's' : ''}</span>
        {open ? <ChevronUp className="h-3 w-3 text-slate-400" /> : <ChevronDown className="h-3 w-3 text-slate-400" />}
      </button>
      {open && !isComplete && !hasError && (() => {
        const elapsed = now - t0;
        // v2.0.2 — stage-anchored progress on /drugs surfaces; time-only fallback on /ask /ddx /coach.
        // For /drugs the bar tracks verified pipeline milestones (Phase 1/3 complete, audit, revision, etc).
        // Within a milestone band we time-interpolate toward the next milestone so the bar still moves
        // while qwen2.5:14b is grinding — but it never overshoots what the server has confirmed done.
        const milestoneTable =
          surface === 'drugs' ? DRUGS_LOOKUP_MILESTONES :
          surface === 'drugs-interactions' ? DRUGS_INTERACTIONS_MILESTONES :
          surface === 'appropriateness-value' ? APPROPRIATENESS_VALUE_MILESTONES :
          surface === 'appropriateness-pathway' ? APPROPRIATENESS_PATHWAY_MILESTONES :
          surface === 'appropriateness-audit' ? APPROPRIATENESS_AUDIT_MILESTONES :
          null;

        let pct: number;
        let etaLabel: React.ReactNode;
        if (milestoneTable) {
          // /drugs: pure stage-anchored bar (no calibrated medians on this surface).
          const ms = milestoneFor(events, milestoneTable);
          const inBandMs = Math.max(0, now - ms.sinceMs);
          const ASSUMED_BAND_MS = 60_000;
          const bandProgress = Math.min(0.9, inBandMs / ASSUMED_BAND_MS);
          pct = Math.min(95, Math.max(2, ms.current + (ms.next - ms.current) * bandProgress));
          etaLabel = <span className="text-slate-500">{STAGE_LABEL[last.stage] || last.stage}</span>;
        } else if ((surface === 'ask' || surface === 'ddx') && askChips) {
          // /ask + /ddx: HYBRID — stage milestones act as a FLOOR (bar never goes
          // backward, never overshoots), but within a band we time-interpolate using
          // the actual median weight for the next stage from /api/ask/stage-medians.
          // Stages flex based on chips so no reserved space for stages that won't fire.
          const askStages = surface === 'ddx'
            ? computeDdxStages(medians, askChips)
            : computeAskStages(medians, askChips);
          const ms = askMilestoneFor(events, askStages);
          const inBandMs = Math.max(0, now - ms.sinceMs);
          const bandProgress = Math.min(0.9, inBandMs / Math.max(2_000, ms.nextWeightMs));
          pct = Math.min(95, Math.max(2, ms.current + (ms.next - ms.current) * bandProgress));
          // Time-based ETA against the active chip configuration's total weight.
          const totalActiveWeight = askStages.reduce((s, x) => s + x.weight, 0);
          const overdue = elapsed > totalActiveWeight;
          const eta = Math.max(0, totalActiveWeight - elapsed);
          etaLabel = overdue
            ? <span className="text-amber-700">Longer than usual — still working</span>
            : <span>~{formatDuration(eta)} remaining</span>;
        } else {
          // /ddx /coach (or /ask without chips passed) — original time-only behavior.
          const overdue = elapsed > medians.total_p50;
          const effectiveTotal = overdue ? Math.max(medians.total_p50, elapsed * 1.15) : medians.total_p50;
          const eta = Math.max(0, effectiveTotal - elapsed);
          pct = Math.min(95, Math.max(2, (elapsed / effectiveTotal) * 100));
          etaLabel = overdue
            ? <span className="text-amber-700">Longer than usual — still working</span>
            : <span>~{formatDuration(eta)} remaining</span>;
        }
        const explainer = getStageExplainer(last.stage, surface);
        return (
          <div className="border-t border-slate-200 bg-white/40 px-3 py-2">
            <div className="mb-1 flex items-center justify-between text-[10.5px] text-slate-500">
              <span>{formatDuration(elapsed)} elapsed</span>
              {etaLabel}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded bg-slate-200">
              <div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} />
            </div>
            {explainer && (
              <div className="mt-2 rounded border border-slate-200 bg-white px-2.5 py-1.5 text-[11px]">
                <div className="font-medium text-slate-700">{explainer.title}</div>
                {explainer.body && <div className="mt-0.5 text-slate-600 leading-snug">{explainer.body}</div>}
              </div>
            )}
          </div>
        );
      })()}
      {open && stalled && (
        <div className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          ⚠ No progress for {Math.round((now - last.ts) / 1000)}s. Mac Mini Ollama may be queuing — this can take up to 90s per stage. The Vercel function will time out at 300s total.
        </div>
      )}
      {open && traceId && (
        <div className="flex items-center gap-2 border-t border-slate-200 bg-white/60 px-3 py-1.5 text-[11px] text-slate-500">
          <span className="font-mono uppercase tracking-wide text-slate-400">trace</span>
          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-700">{traceId.slice(0, 8)}…</code>
          <a
            href={`/ask/trace/${traceId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 rounded border border-brand bg-brand-faint px-2 py-0.5 text-[10.5px] font-medium text-brand hover:bg-brand hover:text-white"
            aria-label="View full trace"
            title="Open the full forensic trace for this query in a new tab"
          >
            View trace
            <ExternalLink className="h-3 w-3" />
          </a>
          <button
            onClick={copyTraceId}
            className="inline-flex items-center gap-1 rounded border border-slate-200 px-1.5 py-0.5 text-[10.5px] text-slate-500 hover:border-brand hover:text-brand"
            aria-label="Copy trace ID"
            title="Copy full trace ID"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
      )}
      {open && (
        <ol className="space-y-1 border-t border-slate-200 px-3 py-2">
          {events.map((e, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-0.5 inline-flex h-3 w-3 shrink-0 items-center justify-center">
                {e.error ? <AlertTriangle className="h-3 w-3 text-rose-600" />
                  : e.done ? <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                  : <Loader2 className="h-3 w-3 animate-spin text-slate-400" />}
              </span>
              <span className="flex-1">
                <span className="font-medium text-slate-700">{STAGE_LABEL[e.stage] || e.stage}</span>
                {e.msg && <span className="text-slate-500"> — {sanitizeModelNames(e.msg)}</span>}
              </span>
              {e.ms !== undefined && <span className="shrink-0 text-slate-400">{formatDuration(e.ms)}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
