// Panels for the episode-audit detail page (PRD §10 items 2–6). Server components, no state.
//
// THREE THINGS THESE PANELS ARE BUILT TO SHOW HONESTLY.
//
//  · EVERY EVENT NAMES ITS SOURCE TABLE. A timeline whose rows do not say where they came from
//    invites a reader to treat an inferred event as a recorded one.
//  · EVERY FINDING NAMES ITS PASS. Divergence findings were written blind; fidelity findings were
//    written with the discharge summary in view, and both feed one index (decision 16's recorded
//    trade-off). Labelling the pass is what lets a reader subtract the second kind.
//  · UNASSESSABLE FINDINGS GET THEIR OWN BLOCK, not a footnote. "The record cannot answer this"
//    is an output of this engine, not a failure of it.
import {
  NO_DIVERGENCE_COPY, OUTCOME_AWARE_NOTICE, fmtStamp,
} from '../ui';

type Row = Record<string, unknown>;

const s = (v: unknown): string => (v == null ? '' : String(v));

// ── 2. the timeline ──────────────────────────────────────────────────────────────────────────

export function TimelinePanel({ events }: { events: Row[] }) {
  if (!events.length) return <Section title="Timeline"><Empty>No events were assembled for this admission.</Empty></Section>;
  const byDay = new Map<number, Row[]>();
  for (const e of events) {
    const d = Number(e.day_index ?? 0);
    byDay.set(d, [...(byDay.get(d) ?? []), e]);
  }
  return (
    <Section title="Timeline">
      {Array.from(byDay.keys()).sort((a, b) => a - b).map((day) => (
        <div key={day} className="mt-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Day {day}</div>
          <ul className="mt-1 space-y-1">
            {(byDay.get(day) ?? []).map((e, i) => {
              const prov = (e.provenance ?? {}) as Row;
              return (
                <li key={`${s(e.event_id)}-${i}`} className="rounded-lg border border-slate-100 bg-white px-3 py-2">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                    <span className="font-semibold text-slate-800">{s(e.event_type)}</span>
                    <span className="text-slate-400">{fmtStamp(e.occurred_at)}</span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">tier {s(e.evidence_tier)}</span>
                    <span className="text-[10.5px] text-slate-400">{s(prov.source_table)}</span>
                    {e.author_name ? <span className="text-[10.5px] text-slate-500">· {s(e.author_name)}{e.author_role ? `, ${s(e.author_role)}` : ''}</span> : null}
                  </div>
                  {e.summary ? <div className="mt-0.5 text-[12.5px] leading-snug text-slate-600">{s(e.summary).slice(0, 700)}</div> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </Section>
  );
}

// ── 3 and 4. findings ────────────────────────────────────────────────────────────────────────

function FindingCard({ f }: { f: Row }) {
  const basis = Array.isArray(f.evidence_basis) ? (f.evidence_basis as Row[]) : [];
  return (
    <li className="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
        <Tag tone={s(f.pass) === 'fidelity' ? 'amber' : 'slate'}>{s(f.pass)}</Tag>
        <Tag>{s(f.finding_type)}</Tag>
        <Tag>{s(f.domain)}</Tag>
        <Tag tone={s(f.severity) === 'major' ? 'red' : s(f.severity) === 'moderate' ? 'amber' : 'slate'}>{s(f.severity)}</Tag>
        <Tag>{s(f.verdict)}</Tag>
        <Tag>tier {s(f.evidence_tier)}</Tag>
        {f.lvc_category ? <Tag tone="amber">low value · {s(f.lvc_category)}</Tag> : null}
        {/* The cap trail: what the model said before code intervened. Without it, a reader cannot
            tell a finding the judge called context_dependent from one the cap moved there. */}
        {f.capped ? (
          <Tag tone="amber">
            capped from {s(f.severity_before_cap)} · {s(f.verdict_before_cap)}
          </Tag>
        ) : null}
        {/* What KIND of source this finding stands on. A guideline is a standard; a journal
            passage is evidence. A finding backed only by literature is capped at moderate in
            code, so the reader can see why a serious-sounding finding is not marked major. */}
        {f.citation_provenance ? (
          <Tag tone={s(f.citation_provenance) === 'literature' ? 'amber' : 'slate'}>
            {s(f.citation_provenance) === 'normative' ? 'guideline-backed'
              : s(f.citation_provenance) === 'mixed' ? 'guideline + literature'
              : 'literature only'}
          </Tag>
        ) : null}
      </div>
      <div className="mt-1 text-[13px] leading-snug text-slate-800">{s(f.statement)}</div>
      <div className="mt-1 text-[10.5px] text-slate-400">
        {f.author_name ? <>author {s(f.author_name)}{f.author_role ? `, ${s(f.author_role)}` : ''} · </> : null}
        {f.responsible_clinician_id ? <>responsible clinician {s(f.responsible_clinician_id)} · </> : null}
        {f.checkpoint_ref ? <>against {s(f.checkpoint_ref)} · </> : null}
        {basis.length ? `${basis.length} evidence row${basis.length === 1 ? '' : 's'}` : 'no evidence rows cited'}
      </div>
    </li>
  );
}

export function FindingsPanel({ findings }: { findings: Row[] }) {
  const scored = findings.filter((f) => s(f.verdict) !== 'unassessable');
  if (!scored.length) return <Section title="Findings"><Empty>{NO_DIVERGENCE_COPY}</Empty></Section>;
  const byDay = new Map<number, Row[]>();
  for (const f of scored) {
    const d = Number(f.day_index ?? 0);
    byDay.set(d, [...(byDay.get(d) ?? []), f]);
  }
  return (
    <Section title="Findings">
      {Array.from(byDay.keys()).sort((a, b) => a - b).map((day) => (
        <div key={day} className="mt-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Day {day}</div>
          <ul className="mt-1 space-y-1.5">
            {(byDay.get(day) ?? []).map((f, i) => <FindingCard key={`${s(f.finding_id)}-${i}`} f={f} />)}
          </ul>
        </div>
      ))}
    </Section>
  );
}

export function UnassessablePanel({ findings }: { findings: Row[] }) {
  const list = findings.filter((f) => s(f.verdict) === 'unassessable');
  if (!list.length) return null;
  return (
    <Section title="Could not assess">
      <p className="text-[12px] text-slate-500">
        The record cannot answer these. They are an output of the audit, not a gap in it — a finding
        resting on no evidence, or only on a source class this mirror does not hold, is reported as
        unassessable rather than scored.
      </p>
      <ul className="mt-2 space-y-1.5">{list.map((f, i) => <FindingCard key={`${s(f.finding_id)}-${i}`} f={f} />)}</ul>
    </Section>
  );
}

// ── 5. commentary ────────────────────────────────────────────────────────────────────────────
// Moved to a client component under decision 35: the panel now generates the commentary on the
// first open instead of reading one the pipeline wrote. Re-exported from here so the page's
// import list still reads as one set of panels.
export { CommentaryPanel } from './commentary-client';

// ── 6. checkpoints ───────────────────────────────────────────────────────────────────────────

function ExpectedList({ title, items, kind }: { title: string; items: Row[]; kind: 'item' | 'trigger' }) {
  if (!items.length) return null;
  return (
    <div className="mt-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      <ul className="mt-0.5 space-y-0.5">
        {items.map((e, i) => {
          const ids = Array.isArray(e.citation_ids) ? (e.citation_ids as unknown[]) : [];
          return (
            <li key={i} className="text-[12.5px] text-slate-700">
              {kind === 'trigger' ? <>if {s(e.trigger)} → {s(e.action)}</> : <>{s(e.item)}{e.by_day != null ? ` (by day ${s(e.by_day)})` : ''}{e.frequency ? ` — ${s(e.frequency)}` : ''}</>}
              <span className="ml-1 text-[10.5px] text-slate-400">{ids.length ? `[citations ${ids.join(', ')}]` : '[no citation — findings on this entry are capped]'}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function CheckpointPanels({ checkpoints }: { checkpoints: Row[] }) {
  if (!checkpoints.length) return null;
  return (
    <div className="mt-6">
      <h2 className="text-[13px] font-semibold text-slate-800">Checkpoints</h2>
      <p className="mt-0.5 text-[12px] text-slate-500">
        Each was generated from only what was documented before its cut-off. The cut-off and the input
        event count are stored on the row, so the blinding is checkable rather than asserted.
      </p>
      <div className="mt-2 space-y-2">
        {checkpoints.map((c, i) => {
          const course = (c.expected_course ?? null) as Row | null;
          const ids = Array.isArray(c.citation_ids) ? (c.citation_ids as unknown[]) : [];
          return (
            <details key={i} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5">
              <summary className="cursor-pointer text-[12.5px] font-semibold text-slate-800">
                {s(c.checkpoint_type) === 'episode' ? 'Episode-level checkpoint' : `Day ${s(c.day_index)} checkpoint`}
                <span className="ml-2 text-[10.5px] font-normal text-slate-400">
                  cut-off {fmtStamp(c.input_cutoff_at)} · {s(c.input_event_count)} event(s) in · {s(c.status)}
                  {c.retrieval_failed ? ' · retrieval failed' : ''}
                  {c.retrieval_offtopic ? ` · ${s(c.offtopic_excerpt_count)} off-topic excerpt(s)` : ''}
                  {c.day0_query_from_ot ? ' · day 0 query from OT note' : ''}
                  {c.temperature != null ? ` · temp ${s(c.temperature)}${c.seed == null ? ', no seed' : `, seed ${s(c.seed)}`}` : ''}
                  {Number(c.entry_count ?? 0) > 0
                    ? ` · ${Number(c.entry_count) - Number(c.uncited_entry_count ?? 0)}/${s(c.entry_count)} entries cited`
                    : ''}
                </span>
              </summary>
              {c.retrieval_query ? (
                <p className="mt-2 text-[10.5px] text-slate-400">
                  <span className="font-semibold uppercase tracking-wide">Query</span> {s(c.retrieval_query).slice(0, 400)}
                </p>
              ) : null}
              {s(c.status) === 'error' ? (
                <p className="mt-2 text-[12px] text-red-700">This checkpoint did not produce an expected course: {s(c.error_detail) || 'no detail recorded'}.</p>
              ) : !course ? (
                <p className="mt-2 text-[12px] text-slate-500">No expected course was stored.</p>
              ) : (
                <div>
                  <ExpectedList title="Expected diagnostics" items={(course.expected_diagnostics ?? []) as Row[]} kind="item" />
                  <ExpectedList title="Expected therapeutics" items={(course.expected_therapeutics ?? []) as Row[]} kind="item" />
                  <ExpectedList title="Expected monitoring" items={(course.expected_monitoring ?? []) as Row[]} kind="item" />
                  <ExpectedList title="Escalation triggers" items={(course.escalation_triggers ?? []) as Row[]} kind="trigger" />
                  {Array.isArray(course.uncertainty) && course.uncertainty.length ? (
                    <div className="mt-2">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Stated uncertainty</div>
                      <ul className="mt-0.5 list-disc pl-4 text-[12.5px] text-slate-600">
                        {(course.uncertainty as unknown[]).map((u, j) => <li key={j}>{s(u)}</li>)}
                      </ul>
                    </div>
                  ) : null}
                  <div className="mt-2 text-[10.5px] text-slate-400">
                    {ids.length
                      ? `Retrieved chunk ids: ${ids.map((id) => {
                          const src = (c.citation_sources as Record<string, string> | null)?.[String(id)];
                          return src ? `${id} (${src})` : String(id);
                        }).join(', ')}`
                      : 'No excerpts were retrieved for this checkpoint.'}
                  </div>
                  {Array.isArray(c.retrieved_titles) && (c.retrieved_titles as unknown[]).length ? (
                    <div className="mt-1">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">What was retrieved</div>
                      <ul className="mt-0.5 space-y-0.5">
                        {(c.retrieved_titles as unknown[]).map((t, j) => (
                          <li key={j} className="text-[11px] text-slate-500">[{j + 1}] {s(t)}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {c.retrieval_offtopic ? (
                    <p className="mt-1 text-[11px] text-amber-800">
                      {s(c.offtopic_excerpt_count)} of the retrieved excerpts shared no clinical term with this
                      checkpoint&rsquo;s query. The expected course was still generated; its uncited entries are
                      scored conservatively.
                    </p>
                  ) : null}
                  {ids.length > 0 && Number(c.entry_count ?? 0) > 0 && Number(c.uncited_entry_count ?? 0) === Number(c.entry_count)
                    ? (
                      <p className="mt-1 text-[11px] text-amber-800">
                        Every entry in this checkpoint cites nothing, although {ids.length} excerpts were retrieved.
                        Findings measured against it are capped at minor and context-dependent.
                      </p>
                    ) : null}
                </div>
              )}
            </details>
          );
        })}
      </div>
    </div>
  );
}

// ── small chrome ─────────────────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="text-[13px] font-semibold text-slate-800">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12.5px] text-slate-500">{children}</p>;
}

function Tag({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'slate' | 'amber' | 'red' }) {
  const cls = tone === 'red' ? 'bg-red-50 text-red-700 border-red-200'
    : tone === 'amber' ? 'bg-amber-50 text-amber-800 border-amber-200'
    : 'bg-slate-50 text-slate-600 border-slate-200';
  return <span className={`rounded border px-1.5 py-0.5 font-medium ${cls}`}>{children}</span>;
}
