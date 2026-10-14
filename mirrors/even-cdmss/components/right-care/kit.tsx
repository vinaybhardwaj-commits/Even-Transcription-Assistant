'use client';

// Shared Right Care result kit — verdict-first primitives reused across all three
// modes (Order check / Care pathway / Record audit) so they stay pixel-consistent.
import { useState, type ReactNode } from 'react';
import { BookOpen, ExternalLink, AlertTriangle, IndianRupee, ChevronDown, ChevronUp } from 'lucide-react';
import { sourceLabel, type Source } from '@/lib/citations-core';
import type { TariffRef, NetValue } from '@/lib/lvc-value-core';

export const inr = (n: number) => '₹' + Number(n).toLocaleString('en-IN');

export const NET_BADGE: Record<NetValue, string> = {
  'high-value': 'bg-teal-50 text-teal-800',
  'context-dependent': 'bg-amber-50 text-amber-800',
  'low-value': 'bg-red-50 text-red-800',
  uncertain: 'bg-slate-100 text-slate-600',
};
export const NET_LABEL: Record<NetValue, string> = {
  'high-value': 'High value', 'context-dependent': 'Context-dependent', 'low-value': 'Low value', uncertain: 'Uncertain',
};
// Left-accent colour for a verdict card.
export const NET_ACCENT: Record<NetValue, string> = {
  'high-value': 'border-l-teal-500', 'context-dependent': 'border-l-amber-500', 'low-value': 'border-l-red-500', uncertain: 'border-l-slate-300',
};

export function tariffLine(t: TariffRef): string {
  const parts: string[] = [];
  if (t.kind === 'investigation') {
    if (t.opd != null) parts.push(`${inr(t.opd)} OPD`);
    if (t.general != null) parts.push(`${inr(t.general)} general`);
  } else {
    if (t.general != null) parts.push(`${inr(t.general)} general`);
    if (t.private != null) parts.push(`${inr(t.private)} private`);
    if (t.suite != null) parts.push(`${inr(t.suite)} suite`);
  }
  return parts.join(' · ');
}

export function SectionTitle({ icon, text, right }: { icon?: ReactNode; text: string; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-500">
      {icon} {text}{right && <span className="ml-auto">{right}</span>}
    </div>
  );
}

export function MetricCard({ label, value, sub, tone = 'neutral' }: {
  label: string; value: string; sub?: string; tone?: 'good' | 'warn' | 'bad' | 'neutral';
}) {
  const color = tone === 'good' ? 'text-teal-700' : tone === 'warn' ? 'text-amber-700' : tone === 'bad' ? 'text-red-700' : 'text-slate-900';
  return (
    <div className="rounded-lg bg-slate-50 p-3.5">
      <div className="text-[12px] text-slate-500">{label}</div>
      <div className={`text-[22px] font-medium leading-tight ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

export function Collapsible({ title, icon, count, defaultOpen = false, children }: {
  title: string; icon?: ReactNode; count?: number | string; defaultOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left">
        {icon && <span className="shrink-0 text-slate-400">{icon}</span>}
        <span className="text-[13px] font-medium text-slate-700">{title}</span>
        {count != null && <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10.5px] text-slate-500">{count}</span>}
        {open ? <ChevronUp className="ml-auto h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-slate-400" />}
      </button>
      {open && <div className="border-t border-slate-100 p-3.5">{children}</div>}
    </section>
  );
}

export function TariffBlock({ tariffs }: { tariffs: TariffRef[] }) {
  if (!tariffs || tariffs.length === 0) return null;
  return (
    <div className="mt-2.5 rounded-lg border border-teal-200 bg-teal-50 p-2.5">
      <div className="flex items-center gap-1 text-[11px] font-medium text-teal-800"><IndianRupee className="h-3 w-3" /> EHRC charge master — cited tariff (not an estimate)</div>
      <ul className="mt-1 space-y-0.5">
        {tariffs.map((t) => (
          <li key={t.code} className="text-[12px] text-teal-900"><span className="font-medium">{t.item}</span> <span className="text-teal-700">({t.code})</span>: {tariffLine(t)}</li>
        ))}
      </ul>
    </div>
  );
}

export function EvidenceList({ items }: { items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-2.5">
      <div className="flex items-center gap-1 text-[11px] font-medium text-slate-500"><BookOpen className="h-3 w-3" /> Evidence</div>
      <ul className="mt-1 list-disc pl-4 text-[12px] text-slate-600">{items.map((e, i) => <li key={i}>{e}</li>)}</ul>
    </div>
  );
}

export function EstimatesList({ items }: { items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-2.5 rounded-lg border border-dashed border-amber-300 bg-amber-50 p-2.5">
      <div className="flex items-center gap-1 text-[11px] font-medium text-amber-700"><AlertTriangle className="h-3 w-3" /> Model estimates — not validated</div>
      <ul className="mt-1 list-disc pl-4 text-[12px] text-amber-900">{items.map((e, i) => <li key={i}>{e}</li>)}</ul>
    </div>
  );
}

export function CitationChips({ ids, sources }: { ids: number[]; sources: Source[] }) {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const cited = ids.map((n) => byN.get(n)).filter((s): s is Source => !!s);
  if (cited.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[10.5px] uppercase tracking-wide text-slate-400">Cited</span>
      {cited.map((s) => s.url ? (
        <a key={s.n} href={s.url} target="_blank" rel="noopener noreferrer" title={s.preview}
          className="inline-flex items-center gap-0.5 rounded-full border border-teal-200 bg-teal-50 px-1.5 py-0.5 text-[10.5px] font-medium text-teal-800 hover:bg-teal-100">
          [{s.n}] <ExternalLink className="h-2.5 w-2.5" />
        </a>
      ) : (
        <span key={s.n} title={s.preview}
          className="rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-600">[{s.n}]</span>
      ))}
    </div>
  );
}

export function SourcesPanel({ sources }: { sources: Source[] }) {
  if (!sources || sources.length === 0) return null;
  return (
    <ol className="space-y-1.5">
      {sources.map((s) => (
        <li key={s.n} className="text-[12px] leading-relaxed text-slate-600">
          <span className="font-medium text-slate-700">[{s.n}]</span> {sourceLabel(s)}
          {s.url && (
            <a href={s.url} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-brand hover:underline">
              PubMed <ExternalLink className="h-2.5 w-2.5" />
            </a>
          )}
          {s.preview && <span className="block text-[11px] text-slate-400">{s.preview.slice(0, 160)}{s.preview.length > 160 ? '…' : ''}</span>}
        </li>
      ))}
    </ol>
  );
}
