'use client';

/**
 * /care/readmissions — the flat case-card list (CDMSS-READMISSIONS-R1-PRD v1.1 §3,
 * 17 Aug 2026; supersedes the Phase-2 lane board). Renders what the readmission agent
 * already stored, one card per finding: identity (KX-first), the index→readmit path with
 * the extracted diagnosis / indication / procedure, a situation line when true, eight
 * artefact-coverage chips, the Medical-justification + `Return stay bill` cells (R3: the return
 * stay's hospital bill, computed fresh by the list route on every load — never stored, never the
 * encounter id), the two advisory judgements ONLY as exception lines when they say something
 * (R4.1, R41-1: suspected red, not_suggested quiet, unknown silent; the negligence line carries
 * the advisory caveat), the R4.1 case line under the path (the stored account's first sentence,
 * R41-3), and ONE button that downloads a `.md` case brief built client-side (R3: Part 2 carries
 * both stays' bills by service type).
 *
 * R4 (CDMSS-READMISSIONS-R4-PRD v1.0, R4-1): clicking anywhere on a card (except its button)
 * opens the case page /care/readmissions/case/[key] — the dedup key, already the card key.
 * R5 (Readmissions R5 PRD v1.0, 19 Aug 2026): a search + filter toolbar over the loaded list —
 * browser-side, AND across groups, on top of the held-out checkbox, mirrored to the URL; the
 * review / pending badges stay whole-population; only "showing X of Y" moves.
 * R5.1 (Readmissions R5.1 PRD v1.0, 19 Aug 2026): the load path has a 45 s timeout, an honest
 * slow-load line at 8 s, an error state with one detail line and Retry; no polling, no auto-retry.
 * R6.1 (Readmissions R6.1 PRD v1.0, 19 Aug 2026): unknown `fac` dropped as if absent; a failed refresh
 * keeps the cards with an inline "Refresh did not work." + Retry; the Suspense wrapper removed so the
 * board hydrates (and fetches) with the root even in a hidden tab.
 *
 * READ-ONLY. Nothing on this page mutates a finding — the download is the only transmit
 * (decision 8), it calls no model, and it writes nothing. The route payload is still
 * lane-grouped (decision 11); this file flattens with `lanes.flatMap` and sorts
 * review-first (sortForCardList). The held-out sample and the not-auditable rows sit
 * behind one toggle, default off (decision 2). Tiles are gone (decision 1).
 *
 * ALL judgement lives in lib/readmission-surface-core.ts (sort, chips, situation line,
 * justification mapping, identity precedence) and lib/readmission/brief.ts (the brief) so
 * it is unit-tested; this file is markup and fetch. Missing data renders `unknown`, never
 * a guess; a failed case fetch still downloads a thinner brief from the card row alone.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import ReadmissionRatesModule from './ReadmissionRatesModule';
import { returnContextLines } from '@/lib/readmission-rates-core';
import { RotateCw, Download } from 'lucide-react';
import {
  BILLS_UNAVAILABLE_NOTICE, cardIdentityLine, caseHref, chipText, coverageChips, countsLine, isHeldOut, isReviewFinding,
  judgementExceptionLines, justificationCell, pathSegments, returnStayBill, returnStayBillSub, situationLine,
  sortForCardList,
  type ChipState, type LaneGroup, type SurfaceFinding, type SurfaceTiles,
} from '@/lib/readmission-surface-core';
import { composeBrief, type BillBreakdown, type ExtractSubset } from '@/lib/readmission/brief';
import {
  activeFilterChips, applyFilters, decodeFilters, departmentOptions, effectiveFilters, encodeFilters, facilityOptions, hasActiveFilters, laneOptions, showingLine,
  EMPTY_FILTERS, GAP_PRESETS, VERDICTS, VERDICT_LABEL, type FilterState,
} from '@/lib/readmission-filter-core';
import { classifyLoadFailure, LOAD_TIMEOUT_MS, LOADING_COPY, REFRESH_FAILED_COPY, RETRY_LABEL, SLOW_AFTER_MS, SLOW_LOAD_COPY, type LoadFailure } from '@/lib/readmission-load-core';

type BoardData = {
  ok: boolean;
  lanes: LaneGroup[];
  tiles: SurfaceTiles;
  pendingCount: number;
  reviewCount: number;
  total: number;
  namesResolved: boolean;
  /** R3: the batched bill fetch answered. Absent (older route) reads as resolved. */
  billsResolved?: boolean;
  error?: string;
};

export type CaseDetail = {
  ok: boolean;
  row: SurfaceFinding;
  indexExtract: ExtractSubset | null;
  readmitExtract: ExtractSubset | null;
  /** R3: both stays' bills by service_type — the brief's Part 2 tables. */
  indexBill?: BillBreakdown | null;
  readmitBill?: BillBreakdown | null;
};

/** R2 five states (constraints §4b): present solid · empty / absent / unknown hollow
 *  (the copy tells them apart — see chipText) · n/a greyed. Exhaustive by the compiler. */
const CHIP_STATE: Record<ChipState, string> = {
  present: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
  empty: 'bg-transparent text-amber-800 border border-amber-300',
  absent: 'bg-transparent text-slate-600 border border-slate-300',
  unknown: 'bg-transparent text-slate-500 border border-slate-200 border-dashed',
  'n/a': 'bg-slate-50 text-slate-400 border border-slate-100 line-through',
};

/** IST clock stamp for the brief header — the only clock the composer sees. */
function istStamp(): string {
  const d = new Date(Date.now() + 5.5 * 3_600_000);
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

/** The escalate-button Blob pattern (app/admin/opd-audit/[id]/escalate-button.tsx). */
function saveMarkdown(filename: string, markdown: string) {
  const blob = new Blob([markdown], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Fetch the pinned case detail, overlay the card's KX identity (decision 13 — the case
 * route does not re-join it), compose, download. Any failure on the fetch degrades to a
 * brief built from the card row alone; nothing here can leave the user without a file.
 */
export async function downloadBrief(card: SurfaceFinding): Promise<void> {
  let detail: CaseDetail | null = null;
  try {
    const r = await fetch(`/api/care/readmissions/case?dedup_key=${encodeURIComponent(card.dedupKey)}`);
    if (r.ok) {
      const j = (await r.json()) as CaseDetail;
      if (j.ok && j.row) detail = j;
    }
  } catch { /* thinner brief below */ }
  // R3: the case route's returnBill is the fresher read (same state rule); the card's is the
  // fallback so a thinner brief still says what the card said.
  const row: SurfaceFinding = detail
    ? { ...detail.row, patientName: card.patientName, ageGender: card.ageGender ?? detail.row.ageGender ?? null, indexCase: detail.row.indexCase ?? card.indexCase ?? null, returnBill: detail.row.returnBill ?? card.returnBill ?? null }
    : card;
  const brief = composeBrief({
    row,
    indexExtract: detail?.indexExtract ?? null,
    readmitExtract: detail?.readmitExtract ?? null,
    indexBill: detail?.indexBill ?? null,
    readmitBill: detail?.readmitBill ?? null,
    generatedAt: istStamp(),
    detailFetched: detail != null,
  });
  saveMarkdown(brief.filename, brief.markdown);
}

function Cell({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-canvas px-3 py-2">
      <div className="text-[10.5px] uppercase tracking-wider text-slate-500">{k}</div>
      <div className="mt-0.5 text-[12.5px] font-semibold text-slate-900">{v}</div>
      {sub && <div className="mt-0.5 text-[10.5px] italic text-slate-500">{sub}</div>}
    </div>
  );
}

function CaseCard({ f }: { f: SurfaceFinding }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const audited = f.auditStatus === 'audited';
  const situation = situationLine(f);
  const review = isReviewFinding(f);
  const href = caseHref(f.dedupKey);

  // R4-1: the WHOLE card opens the case page; the download button below stops propagation so a
  // click on it never navigates. Keyboard: Enter / Space on the focused card.
  const open = () => router.push(href);
  return (
    <div role="link" tabIndex={0} aria-label={`Open case ${cardIdentityLine(f)}`}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      className={`mb-3 cursor-pointer rounded-xl border bg-paper p-4 shadow-card transition hover:border-brand/40 focus:outline-none focus:ring-2 focus:ring-brand/30 ${review ? 'border-red-200' : 'border-line'}`}>
      {/* Zone 1 — identity (KX-first) */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[14.5px] font-semibold text-slate-900">
            {cardIdentityLine(f)}
            {/* R6-2: the hospital, verbatim from db13, whenever known — the filter matches what the reader sees */}
            {f.facility && <span className="ml-1.5 text-[11px] font-normal text-slate-500">· {f.facility}</span>}
          </div>
          {/* Zone 2 — path */}
          <div className="mt-1 text-[12.5px] text-slate-600">
            {pathSegments(f).map((seg, i) => (
              <span key={i}>{i > 0 && ' · '}{i === 0 ? <b className="font-semibold text-slate-900">{seg}</b> : seg}</span>
            ))}
          </div>
          {situation && <div className="mt-1 text-[12px] font-medium text-red-700">{situation}</div>}
          {/* R7 (R7-5 / R7-6) — return-context markers: immediate return (gap ≤ 1) · possible planned staged
              return. Annotation only — the situation line stays, no verdict changes. */}
          {returnContextLines(f.returnContext).map((l) => (
            <div key={l.key} className="mt-1 text-[12px] font-medium text-amber-800">{l.text}</div>
          ))}
          {/* R4.1 (R41-3) — the case line: the first sentence of the stored, code-validated account */}
          {f.caseLine && <div className="mt-1 text-[12.5px] italic text-slate-700">{f.caseLine}</div>}
        </div>
      </div>

      {/* Zone 3 — coverage chips */}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {coverageChips(f).map((c) => (
          <span key={c.key} title={`${c.label}: ${c.state}`}
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CHIP_STATE[c.state]}`}>
            {chipText(c)}
          </span>
        ))}
      </div>

      {/* Zone 4 — R4.1 (R41-1/2): the two always-valued cells; judgements only as exception lines */}
      {audited ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Cell k="Medical justification" v={justificationCell(f)} />
            <Cell k="Return stay bill" v={returnStayBill(f)} sub={returnStayBillSub(f)} />
          </div>
          {judgementExceptionLines(f).map((l) => (
            <div key={l.key} className={`mt-2 text-[12px] ${l.tone === 'red' ? 'font-medium text-red-700' : 'text-slate-500'}`}>
              {l.text}{l.caveat && <span className="ml-1 text-[10.5px] italic text-slate-400">— {l.caveat}</span>}
            </div>
          ))}
        </>
      ) : (
        // §3: one line. The qualifier names WHY for the two statuses the toggle reveals —
        // a held-out row will never be audited, by design, and saying only "not yet" would
        // promise otherwise (flagged in the R1 report as a one-line deviation).
        <p className="mt-3 text-[12px] text-slate-500">
          Not yet audited
          {f.auditStatus === 'excluded' && <span className="text-slate-400"> · held out by design</span>}
          {f.auditStatus === 'not_auditable' && <span className="text-slate-400"> · not auditable{f.notAuditableReason ? ` — ${f.notAuditableReason}` : ''}</span>}
        </p>
      )}

      {/* Action row */}
      <div className="mt-3 flex items-center justify-end">
        <button type="button" disabled={busy}
          onClick={(e) => { e.stopPropagation(); setBusy(true); void downloadBrief(f).finally(() => setBusy(false)); }}
          onKeyDown={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1 text-[12px] font-medium text-slate-600 transition hover:border-brand/40 hover:text-brand disabled:opacity-50">
          <Download className="h-3 w-3" />Download case brief · .md
        </button>
      </div>
    </div>
  );
}

/**
 * R5 (CDMSS Readmissions R5 PRD v1.0, 19 Aug 2026): the search + filter toolbar. Filtering runs in
 * the browser over the loaded list (R5-1); every group is AND-ed and composes ON TOP of the held-out
 * checkbox, whose behaviour and position are unchanged; the review / pending badges stay whole-
 * population (R5-3) — only the "showing X of Y" counter moves. Filters mirror to the URL (R5-4):
 * read once on mount, written with router.replace (no scroll jump, no history spam); malformed
 * params are ignored silently. (R6.1: the R5 Suspense wrapper is gone — see the hidden-tab note on the
 * component — the page is force-dynamic, so useSearchParams needs no boundary.)
 */
/**
 * R6.1 item 4 (R61-2) — HIDDEN-TAB LOAD. Measured live 19 Aug on a background tab: at 140 s hidden the
 * root was hydrated (a React fiber on <body>) but the board's h1 / Refresh button carried NO fiber, no
 * list request had been issued, no slow line, no error state. Mechanism: the Suspense boundary R5
 * added around the board (for useSearchParams) turned the board into a dehydrated boundary that React
 * hydrates lazily (selective hydration, idle lane) — and that hydration waits for the tab to become
 * visible, so the mount effect (the fetch) never ran while hidden. The page is `force-dynamic`, so
 * useSearchParams does not bail out to client rendering and needs no boundary: the wrapper is removed
 * and the board hydrates with the root again (as it did before R5), so the fetch starts right after
 * hydration regardless of visibility. Visible-tab markup is unchanged (the fallback was never shown
 * on a dynamic page).
 */
export default function ReadmissionsBoard() {
  const [data, setData] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(true);
  // R5.1 — the board stops hanging: the fetch runs under an AbortController (45 s); after 8 s a
  // second honest line appears; any failure becomes an error state with ONE detail line and Retry.
  // One fetch per page load or per Retry / Refresh press — nothing polls, nothing retries itself.
  const [slow, setSlow] = useState(false);
  const [loadError, setLoadError] = useState<LoadFailure | null>(null);
  // R6.1 (R61-1): a failed REFRESH over a loaded board keeps the cards and shows an inline notice by
  // the Refresh control with its own Retry; the control re-enables. First-load behaviour is R5.1's.
  const [refreshFailed, setRefreshFailed] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The URL is read ONCE on mount (R5-4); afterwards the state is the source of truth and is
  // mirrored back with router.replace on every change.
  const [filters, setFilters] = useState<FilterState>(() => decodeFilters(searchParams));
  const showHeldOut = filters.held;
  const setShowHeldOut = (held: boolean) => setFilters((f) => ({ ...f, held }));
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    const qs = encodeFilters(filters);
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [filters, pathname, router]);
  const set = <K extends keyof FilterState>(k: K, v: FilterState[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const clearAll = () => setFilters((f) => ({ ...EMPTY_FILTERS, held: f.held }));
  const clearOne = (k: keyof FilterState) => setFilters((f) => (k === 'from' ? { ...f, from: null, to: null } : { ...f, [k]: EMPTY_FILTERS[k] }));

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null); setSlow(false); setRefreshFailed(false);
    const ctrl = new AbortController();
    const killer = setTimeout(() => ctrl.abort(), LOAD_TIMEOUT_MS);
    const slowTimer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    try {
      const r = await fetch('/api/care/readmissions/list', { signal: ctrl.signal });
      const j = (await r.json()) as BoardData;
      if (!r.ok || !j.ok) throw new Error(String(j.error || `status ${r.status}`));
      setData(j);
    } catch (e) {
      // A failed FIRST load (no data yet) is the R5.1 error state; a failed Refresh with data on
      // screen keeps the existing small error line and the data (Refresh control unchanged).
      const failure = classifyLoadFailure(e);
      setLoadError(failure);
      setRefreshFailed(true);   // meaningful only when data is on screen (a refresh); the first-load path reads loadError
    } finally {
      clearTimeout(killer); clearTimeout(slowTimer);
      setSlow(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Decision 11: the payload stays lane-grouped; the board flattens and sorts here.
  const flat = useMemo(() => sortForCardList((data?.lanes ?? []).flatMap((g) => g.rows)), [data]);
  const heldOutCount = useMemo(() => flat.filter(isHeldOut).length, [flat]);
  // The held-out checkbox decides the ELIGIBLE set (unchanged); R5 filters narrow within it.
  const eligible = useMemo(() => (showHeldOut ? flat : flat.filter((r) => !isHeldOut(r))), [flat, showHeldOut]);
  const depts = useMemo(() => departmentOptions(flat), [flat]);
  const facs = useMemo(() => facilityOptions(flat), [flat]);   // R6: from the data, never hardcoded
  // R6.1 (R61-4): once loaded, a `fac` not among the facilities is dropped as if absent — no chip, no
  // filtering, the select on "All hospitals". The raw URL value is left alone (a shared link keeps
  // its intent); only what the board APPLIES and SHOWS is normalised.
  const applied = useMemo(() => effectiveFilters(filters, facs, data != null), [filters, facs, data]);
  const visible = useMemo(() => applyFilters(eligible, applied), [eligible, applied]);
  const chips = activeFilterChips(applied);
  const filtering = hasActiveFilters(applied);

  return (
    <div className="mx-auto max-w-content px-5 py-7">
      <div className="mb-3.5 text-[12px] text-slate-500">
        <Link href="/care" className="font-medium text-brand">Managed Care</Link> › Readmissions
      </div>

      <div className="flex items-center gap-2">
        <h1 className="font-serif text-[23px] font-semibold tracking-tight text-slate-900">Readmissions</h1>
        <span className="rounded-full bg-brand-faint px-2.5 py-0.5 text-[11px] font-medium text-brand-dark">Advisory · care management</span>
        <button onClick={() => void load()} disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
          <RotateCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Refresh
        </button>
      </div>
      {/* R6.1 (R61-1) — inline by the Refresh control: the slow line during a slow refresh, and the
          failure line + Retry when a refresh failed. The loaded cards stay exactly as they were. */}
      {data && loading && slow && <p className="mt-1 text-right text-[11.5px] text-slate-500">{SLOW_LOAD_COPY}</p>}
      {data && !loading && refreshFailed && (
        <p className="mt-1 text-right text-[11.5px] text-amber-800">
          {REFRESH_FAILED_COPY}{' '}
          <button type="button" onClick={() => void load()} className="font-medium text-brand underline-offset-2 hover:underline">{RETRY_LABEL}</button>
        </p>
      )}
      <p className="mt-1 text-[12.5px] text-slate-500">
        Every readmission the agent has audited, one card each. The agent proposes; you decide what to escalate.
      </p>

      {/* R7 (R7-1) — the rates module, above the counts line; its own fetch, its own fail-safe. The
          facility tabs honour R6's hospital filter when one is applied (R7-4). */}
      <ReadmissionRatesModule facility={applied.fac} />

      {data && (
        <p className="mt-4 text-[12.5px] text-slate-700">{countsLine(data.reviewCount, data.pendingCount)}</p>
      )}

      {loading && !data && (
        <div className="mt-6">
          <p className="text-[13px] text-slate-400">{LOADING_COPY}</p>
          {slow && <p className="mt-1 text-[12px] text-slate-500">{SLOW_LOAD_COPY}</p>}
        </div>
      )}
      {!loading && !data && loadError && (
        <div className="mt-6 rounded-xl border border-line bg-paper p-5 shadow-card">
          <p className="text-[13.5px] font-semibold text-slate-800">{loadError.heading}</p>
          <p className="mt-1 text-[12.5px] text-slate-600">{loadError.detail}</p>
          <button type="button" onClick={() => void load()} className="mt-3 rounded-lg border border-line bg-white px-3 py-1 text-[12px] font-medium text-slate-600 transition hover:border-brand/40 hover:text-brand">{RETRY_LABEL}</button>
        </div>
      )}

      {data && data.total > 0 && !data.namesResolved && (
        <p className="mt-1 text-[11.5px] text-slate-500">
          Patient names are unavailable right now — cards are identified by UHID.
        </p>
      )}
      {data && data.total > 0 && data.billsResolved === false && (
        <p className="mt-1 text-[11.5px] text-slate-500">{BILLS_UNAVAILABLE_NOTICE}</p>
      )}
      {data && data.total === 0 && !loading && (
        <p className="mt-6 text-[13px] text-slate-500">
          No audited findings yet{data.pendingCount > 0 ? ' — the sweep has not reached the detected ones.' : '.'}
        </p>
      )}

      {data && heldOutCount > 0 && (
        <label className="mt-3 flex items-center gap-2 text-[12px] text-slate-600">
          <input type="checkbox" checked={showHeldOut} onChange={(e) => setShowHeldOut(e.target.checked)} className="h-3.5 w-3.5" />
          Show held-out and not-auditable cases ({heldOutCount})
        </label>
      )}

      {/* R5 — the toolbar: four groups, AND-ed, on top of the held-out set. House pattern from
          app/admin/opd-audit/audit-table.tsx (search input · selects · dismissible chips · X of Y),
          restyled to the /care look. Department select is disabled (not hidden) when no options. */}
      {data && data.total > 0 && (
        <div className="mt-3 rounded-xl border border-line bg-paper p-3 shadow-card">
          <div className="flex flex-wrap items-center gap-2">
            <input value={filters.q} onChange={(e) => set('q', e.target.value)} placeholder="Search patient, doctor, diagnosis, UHID…" maxLength={200}
              className="w-64 max-w-full rounded-lg border border-line bg-white px-2.5 py-1 text-[12px] text-slate-700 outline-none focus:border-brand" />
            <select value={filters.verdict ?? ''} onChange={(e) => set('verdict', (e.target.value || null) as FilterState['verdict'])}
              className="rounded-lg border border-line bg-white px-2 py-1 text-[11.5px] text-slate-600" title="Medical-justification verdict">
              <option value="">Verdict: all</option>
              {VERDICTS.map((v) => <option key={v} value={v}>{VERDICT_LABEL[v]}</option>)}
            </select>
            <label className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-2 py-1 text-[11.5px] text-slate-600" title="Keeps cases where preventable injury is suspected or negligence is suspected">
              <input type="checkbox" checked={filters.flags} onChange={(e) => set('flags', e.target.checked)} className="h-3.5 w-3.5" />
              Serious flags only
            </label>
            <select value={filters.lane ?? ''} onChange={(e) => set('lane', e.target.value || null)}
              className="rounded-lg border border-line bg-white px-2 py-1 text-[11.5px] text-slate-600" title="Case type (detection lane)">
              <option value="">Case type: all</option>
              {laneOptions().map((o) => <option key={o.lane} value={o.lane}>{o.label}</option>)}
            </select>
            <select value={filters.dept ?? ''} onChange={(e) => set('dept', e.target.value || null)} disabled={depts.length === 0}
              className={`rounded-lg border px-2 py-1 text-[11.5px] ${depts.length === 0 ? 'border-line bg-slate-50 text-slate-300' : 'border-line bg-white text-slate-600'}`} title="Department — matches either stay">
              <option value="">Department: all</option>
              {depts.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            {/* R6 — the hospital select: options from the loaded data; disabled-not-hidden when none
                resolved (the name join failed → every facility null → everything passes). */}
            <select value={applied.fac ?? ''} onChange={(e) => set('fac', e.target.value || null)} disabled={facs.length === 0}
              className={`rounded-lg border px-2 py-1 text-[11.5px] ${facs.length === 0 ? 'border-line bg-slate-50 text-slate-300' : 'border-line bg-white text-slate-600'}`} title="Hospital — a case whose hospital is not known always stays visible">
              <option value="">All hospitals</option>
              {facs.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-slate-500">Returned</span>
            <input type="date" value={filters.from ?? ''} onChange={(e) => set('from', e.target.value || null)} className="rounded-lg border border-line bg-white px-2 py-1 text-[11.5px] text-slate-600" aria-label="Return date from" />
            <span className="text-[11px] text-slate-400">to</span>
            <input type="date" value={filters.to ?? ''} onChange={(e) => set('to', e.target.value || null)} className="rounded-lg border border-line bg-white px-2 py-1 text-[11.5px] text-slate-600" aria-label="Return date to" />
            <span className="ml-2 text-[11px] text-slate-500">Gap</span>
            <span className="flex overflow-hidden rounded-lg border border-line text-[11px]">
              <button type="button" onClick={() => set('gap', null)} className={`px-2 py-1 ${filters.gap == null ? 'bg-brand text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>Any</button>
              {GAP_PRESETS.map((g) => (
                <button key={g} type="button" onClick={() => set('gap', filters.gap === g ? null : g)} className={`px-2 py-1 ${filters.gap === g ? 'bg-brand text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>≤{g} d</button>
              ))}
            </span>
            <span className="ml-2 text-[11px] text-slate-500">Min return bill ₹</span>
            <input type="number" min={0} step={1000} value={filters.minBill ?? ''} onChange={(e) => { const n = Number(e.target.value); set('minBill', e.target.value === '' || !Number.isFinite(n) || n <= 0 ? null : n); }}
              className="w-28 rounded-lg border border-line bg-white px-2 py-1 text-[11.5px] text-slate-600" title="Cases whose bill is not finalised or not known always stay visible" />
            <span className="ml-auto text-[11px] text-slate-500">{showingLine(visible.length, eligible.length)}</span>
          </div>
          {chips.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {chips.map((c) => (
                <button key={c.key} type="button" onClick={() => clearOne(c.key)} className="rounded-lg bg-brand-faint px-2 py-0.5 text-[11px] font-medium text-brand hover:bg-brand/10">✕ {c.label}</button>
              ))}
              {chips.length >= 2 && <button type="button" onClick={clearAll} className="text-[11px] font-medium text-slate-500 underline-offset-2 hover:text-brand hover:underline">Clear all</button>}
            </div>
          )}
        </div>
      )}

      <div className="mt-4">
        {visible.map((f) => <CaseCard key={f.dedupKey} f={f} />)}
        {data && eligible.length > 0 && visible.length === 0 && filtering && (
          <div className="rounded-xl border border-line bg-paper p-6 text-center shadow-card">
            <p className="text-[13px] text-slate-600">No cases match these filters.</p>
            <button type="button" onClick={clearAll} className="mt-2 rounded-lg border border-line bg-white px-3 py-1 text-[12px] font-medium text-slate-600 transition hover:border-brand/40 hover:text-brand">Clear filters</button>
          </div>
        )}
      </div>

      <p className="mt-7 border-t border-line pt-3.5 text-[11.5px] leading-relaxed text-slate-500">
        Advisory throughout — never a clinician score, never a court or council finding. The agent is a high-sensitivity
        screen: it surfaces what to look at and shows its evidence. Oncology, dialysis and obstetric readmissions are
        expected by design and held out of the default view.{' '}
        <b className="font-semibold text-slate-700">The brief is the only transmit; nothing on this page changes a finding.</b>
      </p>
    </div>
  );
}


