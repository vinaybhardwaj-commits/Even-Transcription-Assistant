/**
 * lib/ccb-episode-docs-core.ts — CCB v2 P2: the episode's source documents, PURE half.
 *
 * Maps an already-assembled `EpisodeBundle` to the list the split-screen document pane renders.
 * No SQL, no network: `assembleEpisode()` is reused verbatim by the route; this only reshapes it.
 *
 * NOTE on `processedUrl` (flagged in the build report): `ReportDoc` at this commit is
 * `{ kind, url, date }` — it carries NO `processedUrl` and NO `serviceName`. Those columns exist
 * on the DOSSIER's report reads, not the episode's, and adding them here would mean editing
 * `ccb-fetch-core.ts`, which is on the untouched list. So `processedUrl` is always null today and
 * the label is derived from `kind` + `date`. The field is kept in the shape because the pane
 * prefers it when present, and a later build can populate it without a contract change.
 */

import type { EpisodeBundle, ReportDoc } from './ccb-fetch-core';

export type EpisodeDocKind = 'prescription' | ReportDoc['kind'];

export interface EpisodeDoc {
  kind: EpisodeDocKind;
  label: string;
  url: string;
  processedUrl: string | null;
}

const REPORT_LABEL: Record<string, string> = {
  radiology: 'Radiology report',
  diagnostic: 'Lab report',
  hcu: 'Health checkup report',
};

/** `2026-07-08T10:03:00Z` → `2026-07-08`; anything unparseable → null. */
function dayOf(date: string | null | undefined): string | null {
  const d = String(date ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

function labelFor(kind: string, date: string | null | undefined): string {
  const base = REPORT_LABEL[kind] ?? 'Report'; // unknown kind → generic, never blank
  const day = dayOf(date);
  return day ? `${base} · ${day}` : base;
}

const isUrl = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * Prescription first (label "Encounter note"), then each report in bundle order.
 * Documents with no URL are dropped — there is nothing to frame. Duplicate URLs collapse to the
 * first occurrence, so the switcher never shows the same document twice.
 * A null/empty bundle yields an empty list, not a throw.
 */
export function docsFromBundle(bundle: EpisodeBundle | null | undefined): EpisodeDoc[] {
  if (!bundle) return [];

  const out: EpisodeDoc[] = [];
  const seen = new Set<string>();
  const push = (doc: EpisodeDoc) => {
    if (seen.has(doc.url)) return;
    seen.add(doc.url);
    out.push(doc);
  };

  const rxUrl = bundle.prescription?.url;
  if (isUrl(rxUrl)) {
    push({ kind: 'prescription', label: 'Encounter note', url: rxUrl, processedUrl: null });
  }

  for (const r of bundle.reports ?? []) {
    if (!isUrl(r?.url)) continue;
    push({ kind: r.kind, label: labelFor(r.kind, r.date), url: r.url, processedUrl: null });
  }

  return out;
}
