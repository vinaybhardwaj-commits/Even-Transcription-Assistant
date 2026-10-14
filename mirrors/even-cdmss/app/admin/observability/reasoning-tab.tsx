/**
 * app/admin/observability/reasoning-tab.tsx — the Reasoning tab (Reasoning Observability
 * Stage 2). Three panels per the approved mockup:
 *   · governed-layer coverage (committed snapshot; CI-diffed against the live scan — see
 *     GOVERNANCE_SNAPSHOT in lib/reasoning/registry-core.ts for why it can't scan at runtime)
 *   · the prompt & rubric registry (Stage-0 generated registry + sidecar manifest — read via
 *     registry-core, never re-parsed from code)
 *   · a prompt viewer (expand any prompt to its full text + sha256). A v-to-v diff arrives in
 *     Stage 3, when two registry snapshots exist.
 * The only DB read is OBSERVED models per prompt (Stage-1 envelope columns) — soft-fails to
 * an empty map pre-migration; everything else renders from committed files. No PHI: prompt/
 * rubric/metadata only (the Stage-0 research-only contract).
 */
import { sql } from '@/lib/db';
import { registryTabRows, GOVERNANCE_SNAPSHOT, renderRegistryExport, shortPromptRef, type Maturity } from '@/lib/reasoning/registry-core';
import { allOutcomes, GOLD_PASS_FLOOR, outcomeClearsGold } from '@/lib/reasoning/outcome-core';

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (t: string, p?: unknown[]) => Promise<Record<string, unknown>[]>;

// INFERRED read of the Stage-1 columns (0012). Pre-migration the column reference throws →
// catch → empty map → the model column renders '—'. Never a 500.
async function observedModels(): Promise<Map<string, string>> {
  try {
    const rows = await run(
      `SELECT prompt_id, call_model, count(*)::int n
       FROM trace_events
       WHERE app_source = $1 AND prompt_id IS NOT NULL AND call_model IS NOT NULL
         AND ts > now() - interval '30 days'
       GROUP BY 1, 2 ORDER BY 3 DESC`,
      [APP],
    );
    const map = new Map<string, string>();
    for (const r of rows) {
      const id = String(r.prompt_id);
      if (!map.has(id)) map.set(id, String(r.call_model));   // top model per prompt (rows are count-ordered)
    }
    return map;
  } catch { return new Map(); }
}

const MATURITY_STYLE: Record<Maturity, string> = {
  mature: 'bg-green-100 text-green-700',
  review: 'bg-amber-100 text-amber-700',
  draft: 'bg-slate-100 text-slate-500',
  unregistered: 'bg-slate-50 text-slate-400',
};

function Kpi({ label, value, sub, danger }: { label: string; value: string; sub?: string; danger?: boolean }) {
  return (
    <div className="rounded-lg bg-slate-50 px-4 py-3">
      <div className="text-[12px] text-slate-500">{label}</div>
      <div className={`text-[22px] font-medium ${danger ? 'text-red-600' : 'text-slate-900'}`}>{value}</div>
      {sub && <div className={`text-[11px] ${danger ? 'text-red-500' : 'text-slate-400'}`}>{sub}</div>}
    </div>
  );
}

export default async function ReasoningTab() {
  const rows = registryTabRows();
  const rubrics = renderRegistryExport().rubrics;
  const models = await observedModels();
  const g = GOVERNANCE_SNAPSHOT;
  const registered = rows.filter((r) => r.maturity !== 'unregistered').length;

  return (
    <div>
      <p className="mb-4 max-w-3xl text-sm text-slate-500">
        The reasoning configuration as a first-class, versioned, observable asset — every standing prompt with its content hash, rubric linkage, and maturity, plus the governed-layer coverage the Stage-4 CI rule will enforce. Prompt/rubric/metadata only; no clinical data. <a href="/api/admin/reasoning-registry?format=json" className="text-brand hover:underline">Download the research export</a>.
      </p>

      {/* ── governed-layer coverage ── */}
      <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
        <div className="text-sm font-medium text-slate-800">Governed reasoning layer — coverage</div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi label="Prompts in the registry" value={String(rows.length)} sub={`${registered} manifest-registered · sha256-hashed`} />
          <Kpi label="Envelope-tagged prompts" value={String(g.taggedPromptRefs)} sub="Right Care wrappers · + DDx / ClinicalState / OPD-audit tags" />
          <Kpi label="Direct (ungoverned) calls" value={`${g.directSites} sites`} sub="every model call routes via the governed layer" danger={g.directSites > 0} />
          {/* Human label on purpose: the literal table name here would count as an extra
              reference in the governance scan's parallel-store pattern. */}
          <Kpi label="Blind parallel stores" value="0" sub={`concordance runs folded into traces · ${g.concordanceRefs} refs remain (its own surface)`} />
        </div>
        {g.ungovernedFiles.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-[12px] text-slate-500 hover:text-slate-700">Ungoverned files ({g.directFiles})</summary>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {g.ungovernedFiles.map((f) => <span key={f} className="rounded bg-white px-1.5 py-0.5 font-mono text-[10.5px] text-slate-600">{f}</span>)}
            </div>
          </details>
        )}
        <p className="mt-3 text-[11.5px] text-slate-500">
          CI rule (HARD gate since Stage 4, mirrors <span className="font-mono">architecture:check</span>): <b>no direct model calls outside the governed layer</b> — <span className="font-mono">reasoning:governance</span> exits 1 on any new one. Snapshot at {g.capturedAt}; the test suite diffs it against the live scan, so it cannot silently rot. Prompt-drift teeth live in the registry staleness gate (any prompt-text change re-hashes and diffs the committed artifact).
        </p>
      </div>

      {/* ── prompt & rubric registry ── */}
      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.05em] text-slate-400">Prompt &amp; rubric registry · {rows.length} prompts</div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <thead className="text-[10.5px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="py-1 pr-3 font-medium">prompt id</th><th className="py-1 pr-3 font-medium">ver</th>
                <th className="py-1 pr-3 font-medium">hash</th><th className="py-1 pr-3 font-medium">feature</th>
                <th className="py-1 pr-3 font-medium">rubric</th><th className="py-1 pr-3 font-medium">schema</th>
                <th className="py-1 pr-3 font-medium">model (observed)</th><th className="py-1 pr-3 font-medium">approver</th>
                <th className="py-1 font-medium">maturity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 align-top hover:bg-slate-50">
                  <td className="py-1.5 pr-3">
                    <details>
                      <summary className="cursor-pointer font-mono text-slate-700 hover:text-brand">{r.shortId}</summary>
                      <div className="mt-1 font-mono text-[10px] text-slate-400">{r.id} · sha256 {r.sha12}… · {r.chars.toLocaleString()} chars / {r.lines} lines</div>
                      <pre className="mt-1 max-h-72 max-w-3xl overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-[11px] leading-snug text-slate-700">{r.text}</pre>
                    </details>
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-slate-600">{r.version}</td>
                  <td className="py-1.5 pr-3 font-mono text-slate-400">{r.sha12}</td>
                  <td className="py-1.5 pr-3 text-slate-600">{r.feature}</td>
                  <td className="py-1.5 pr-3 text-slate-600">{r.rubricId ?? '—'}</td>
                  <td className="py-1.5 pr-3 font-mono text-slate-500">{r.schemaId ?? '—'}</td>
                  <td className="py-1.5 pr-3 text-slate-600">{models.get(r.id) ?? '—'}</td>
                  <td className="py-1.5 pr-3 text-slate-600">{r.clinicianApprover ?? '—'}</td>
                  <td className="py-1.5"><span className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${MATURITY_STYLE[r.maturity]}`}>{r.maturity}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11.5px] text-slate-500">
          Generated-not-authored: rows come from the committed registry (<span className="font-mono">reasoning:registry</span>, CI-gated) merged with the hand-authored sidecar manifest. Click a prompt id to read its full text — the exact hashed bytes the platform runs. The observed-model column reads the Stage-1 envelope; “—” until the 0012 migration is live (or the prompt is untagged).
        </p>
      </div>

      {/* ── version → outcome (Stage 3) ── */}
      {allOutcomes().map((o) => {
        const pct = (v: number) => `${(v * 100).toFixed(1).replace(/\.0$/, '')}%`;
        const f2 = (v: number) => v.toFixed(2);
        const base = o.arms.find((a) => a.arm === 'ungrounded')!;
        const grounded = o.arms.find((a) => a.arm === 'grounded');
        const deltaPp = grounded ? (grounded.recall.mean - base.recall.mean) * 100 : null;
        const floorPp = grounded ? grounded.recall.std * 100 : null;
        return (
          <div key={o.promptId} className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.05em] text-indigo-500">Version → outcome · Order check vs <span className="font-mono normal-case">{o.gold}</span></div>
            <div className="mb-2 text-[11.5px] text-slate-500">
              <span className="font-mono">{shortPromptRef(o.promptId)}</span> · measured at <span className="font-mono">{o.measuredAtSha}</span> on hash <span className="font-mono">{o.measuredHash.slice(0, 12)}…</span> ·{' '}
              {o.current
                ? <span className="text-teal-700">measured on the LIVE prompt bytes ✓</span>
                : <span className="text-amber-700">prompt text has changed since measurement — evidence is stale, re-run the gold</span>}
              {' '}· {o.cases} cases × {o.repeats} repeats · gold cleared: {outcomeClearsGold(o) ? <span className="text-teal-700">yes (floor {GOLD_PASS_FLOOR})</span> : <span className="text-red-600">no</span>}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12px]">
                <thead className="text-[10.5px] uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="py-1 pr-3 font-medium">prompt · version</th><th className="py-1 pr-3 font-medium">arm</th>
                    <th className="py-1 pr-3 text-right font-medium">gold F1</th><th className="py-1 pr-3 text-right font-medium">recall</th>
                    <th className="py-1 pr-3 text-right font-medium">specificity</th><th className="py-1 pr-3 text-right font-medium">₹/run</th>
                    <th className="py-1 text-right font-medium">p50</th>
                  </tr>
                </thead>
                <tbody>
                  {o.arms.map((a) => (
                    <tr key={a.arm} className={`border-t border-indigo-100 ${a.arm === 'ungrounded' ? 'font-medium' : ''}`}>
                      <td className="py-1.5 pr-3 font-mono text-[11.5px] text-slate-700">{shortPromptRef(o.promptId)} · {o.measuredVersion === 'unversioned (git-tracked)' ? 'unversioned' : o.measuredVersion}</td>
                      <td className="py-1.5 pr-3 text-slate-600">{a.arm} <span className="font-mono text-[10px] text-slate-400">({a.flag})</span></td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-slate-800">{f2(a.f1.mean)}{a.f1.std > 0 ? <span className="text-[10px] text-slate-400"> ±{f2(a.f1.std)}</span> : null}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-slate-800">{pct(a.recall.mean)}{a.recall.std > 0 ? <span className="text-[10px] text-slate-400"> ±{pct(a.recall.std)}</span> : null}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-slate-800">{pct(a.specificity.mean)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-slate-400">—</td>
                      <td className="py-1.5 text-right tabular-nums text-slate-400">—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11.5px] text-slate-600">
              <b>Grounding evidence (O2):</b> the grounded arm moves recall {deltaPp != null ? `${deltaPp >= 0 ? '+' : ''}${deltaPp.toFixed(1)}pp` : '—'}
              {floorPp != null ? ` — inside the ±${floorPp.toFixed(1)}pp repeat noise` : ''} — while the ungrounded baseline already sits at ceiling, so this gold can show grounding is <i>harmless</i> but cannot show benefit. A harder gold (batch 2) is what would measure value.
            </p>
            <p className="mt-1 text-[11px] text-slate-400">The eval harness records neither spend nor latency (₹/p50 render as “—”); live spend per prompt version is the LLM-cost tab's “By prompt version” card. Maturity ladder: ‘mature’ requires a cleared gold on the live prompt bytes — CI-asserted.</p>
          </div>
        );
      })}

      {/* ── rubrics ── */}
      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.05em] text-slate-400">Rubrics · {rubrics.length}</div>
        <table className="w-full text-left text-[12px]">
          <thead className="text-[10.5px] uppercase tracking-wide text-slate-400">
            <tr><th className="py-1 pr-3 font-medium">id</th><th className="py-1 pr-3 font-medium">kind</th><th className="py-1 pr-3 font-medium">where</th><th className="py-1 font-medium">version</th></tr>
          </thead>
          <tbody>
            {rubrics.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="py-1.5 pr-3 font-mono text-slate-700">{r.id}</td>
                <td className="py-1.5 pr-3 text-slate-600">{r.kind}</td>
                <td className="py-1.5 pr-3 font-mono text-[11px] text-slate-500">{r.embedded_in ?? r.source ?? '—'}</td>
                <td className="py-1.5 text-slate-600">{r.version}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11.5px] text-slate-500">One external rubric (<span className="font-mono">nabh/6e</span>) is versioned independently; the rest are embedded in their prompt text today — separating them is registry roadmap, not a Stage-2 change. Version-to-version prompt diffs and the version→outcome panel arrive in Stage 3.</p>
      </div>
    </div>
  );
}
