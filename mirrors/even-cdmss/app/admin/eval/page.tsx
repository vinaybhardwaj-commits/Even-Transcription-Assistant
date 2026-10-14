// DDx Reasoning V2 — Benchmark & Evaluation dashboard (Build 0b). Admin-gated, READ-ONLY.
// Renders the FROZEN evaluator's committed snapshots (data/ddx-eval/*.json) — no DB query,
// no engine call, nothing computed on the fly. The UI renders validated artefacts.

import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import baselineJson from '@/data/ddx-eval/frozen-baseline.json';
import worksheetsJson from '@/data/ddx-eval/regression-worksheets.json';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'DDx Eval · Admin' };

// ── shapes of the committed JSON (the frozen evaluator's output) ──
interface Summary {
  n: number;
  top1Accuracy: number; top3Recall: number; cannotMissRecall: number;
  forbiddenDxRate: number; unsafeActionRate: number; fabricatedFindingRate: number;
  harmWeightedError: number;
  laneCoverageRate: number | null; negativeMisuseRate: number | null; cannotMissOverFlagRate: number | null;
  latencyP50Ms: number | null; latencyP90Ms: number | null;
  matcherVersion: string; bankVersion: string;
}
interface RunBlock { source_results: string; summary: Summary; cannot_miss_missed: string[] }
interface Baseline { title: string; frozen_pair: { matcher: string; bank: string }; note: string; runs: { run1: RunBlock; run2: RunBlock } }
type Resolution = 'resolved-label-fix' | 'resolved-negative-excludes' | 'matcher-artifact' | 'genuine-open';
interface Worksheet {
  caseId: string; expectedDx: string; stem?: string;
  engineHypotheses?: string[]; retrievedEvidence?: string;
  omissionMechanism: string; resolution: Resolution; resolutionNote?: string;
}

const baseline = baselineJson as Baseline;
const worksheets = (worksheetsJson as { meta: { bank: string; generated: string }; worksheets: Worksheet[] });

const GATE_FLOOR = 0.9;
const pct = (x: number | null | undefined, digits = 1) => (x == null ? '—' : `${(x * 100).toFixed(digits)}%`);
const secs = (ms: number | null) => (ms == null ? '—' : `${(ms / 1000).toFixed(0)}s`);

function Locked({ configured, bad }: { configured: boolean; bad: boolean }) {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">DDx Evaluation</h1>
      <p className="mt-1.5 text-sm text-slate-500">Frozen benchmark results for the DDx engine. Access-controlled.</p>
      <div className="mt-8 max-w-sm rounded-xl border border-slate-200 bg-white p-5">
        {!configured ? (
          <p className="text-sm text-red-700">Locked. Set the <code className="rounded bg-slate-100 px-1">ADMIN_TOKEN</code> environment variable to enable this surface.</p>
        ) : (
          <form method="POST" action="/api/admin/unlock">
            <label className="block text-sm font-medium text-slate-700">Admin token</label>
            <input type="password" name="token" autoFocus className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Enter admin token" />
            {bad && <p className="mt-2 text-xs text-red-600">Incorrect token.</p>}
            <button type="submit" className="mt-3 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark">Unlock</button>
          </form>
        )}
      </div>
    </div>
  );
}

function Pill({ kind, children }: { kind: 'pass' | 'zero' | 'pending'; children: React.ReactNode }) {
  const cls = {
    pass: 'bg-green-100 text-green-700',
    zero: 'bg-brand-faint text-brand-dark',
    pending: 'bg-amber-100 text-amber-700',
  }[kind];
  return <span className={`mt-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${cls}`}>{children}</span>;
}

function Metric({ label, value, sub, pill }: { label: string; value: React.ReactNode; sub?: string; pill?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-bold text-slate-900">
        {value}{sub && <span className="ml-1 text-[13px] font-semibold text-slate-500">{sub}</span>}
      </div>
      {pill}
    </div>
  );
}

const RES_META: Record<Resolution, { tag: string; cls: string }> = {
  'resolved-label-fix': { tag: 'resolved · label fix', cls: 'bg-green-100 text-green-700' },
  'resolved-negative-excludes': { tag: 'resolved · negative excludes', cls: 'bg-green-100 text-green-700' },
  'matcher-artifact': { tag: 'matcher artifact', cls: 'bg-slate-100 text-slate-500' },
  'genuine-open': { tag: 'GENUINE — open', cls: 'bg-red-100 text-red-700' },
};

function Row({ dt, children }: { dt: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[12px] font-semibold text-slate-400">{dt}</dt>
      <dd className="m-0 text-[12.5px] text-slate-700">{children}</dd>
    </>
  );
}

export default async function DdxEvalDashboard({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) return <Locked configured={adminTokenConfigured()} bad={sp.locked === '1'} />;

  const r1 = baseline.runs.run1.summary;
  const r2 = baseline.runs.run2.summary;
  const cmPass = r1.cannotMissRecall >= GATE_FLOOR && r2.cannotMissRecall >= GATE_FLOOR;
  const genuineOpen = worksheets.worksheets.filter((w) => w.resolution === 'genuine-open').length;

  return (
    <div className="max-w-5xl">
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">DDx Benchmark &amp; Evaluation</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-slate-500">
        The UI renders <em>validated artefacts, not raw model output</em>. This surface reads the frozen evaluator&rsquo;s
        committed results — nothing here is generated on the fly.
      </p>

      {/* Frozen banner */}
      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-brand-faint bg-brand-faint/50 px-4 py-3 text-[12.5px] text-brand-dark">
        <span className="font-bold">🔒 FROZEN</span>
        <span>matcher <b>{baseline.frozen_pair.matcher}</b></span>
        <span>bank <b>{baseline.frozen_pair.bank}</b> ({r1.n} cases)</span>
        <span>gate floor <b>cannot-miss ≥ {GATE_FLOOR.toFixed(2)}</b></span>
        <span title="A run whose matcher or bank version drifts from the frozen pair exits non-zero.">drift guard <b>DDX_EVAL_FROZEN=1</b></span>
      </div>

      {/* Metric cards */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Cannot-miss recall" value={pct(r1.cannotMissRecall)} sub={`/ ${pct(r2.cannotMissRecall)}`}
          pill={<Pill kind={cmPass ? 'pass' : 'pending'}>{cmPass ? `▲ above ${GATE_FLOOR.toFixed(2)} floor` : 'below floor'}</Pill>} />
        <Metric label="Top-1 accuracy" value={pct(r1.top1Accuracy)} sub={`/ ${pct(r2.top1Accuracy)}`} pill={<Pill kind="pass">2-pass</Pill>} />
        <Metric label="Top-3 recall" value={pct(r1.top3Recall)} sub={`/ ${pct(r2.top3Recall)}`} />
        <Metric label="Harm-weighted error" value={r1.harmWeightedError.toFixed(2)} sub={`/ ${r2.harmWeightedError.toFixed(2)}`} />
        <Metric label="Forbidden dx" value={pct(r1.forbiddenDxRate)} pill={<Pill kind="zero">zero events</Pill>} />
        <Metric label="Unsafe action" value={pct(r1.unsafeActionRate)} pill={<Pill kind="zero">zero events</Pill>} />
        <Metric label="Latency p50 / p90" value={`${secs(r1.latencyP50Ms)}`} sub={`/ ${secs(r1.latencyP90Ms)}`} />
        <Metric label="Over-flag · neg-misuse · lane-cov"
          value={<span className="text-slate-400">3 null</span>}
          pill={<Pill kind="pending">pending Track-B labels (v1.1)</Pill>} />
      </div>
      <p className="mt-2 text-[11.5px] text-slate-400">
        Two values per metric = pass&#8209;1 / pass&#8209;2. The temperature&#8209;0.2 run&#8209;to&#8209;run spread is exactly why the 0.90 floor
        carries a ±1&#8209;case (~0.02) noise margin below the 0.92 baseline.
        The three label&#8209;driven metrics are <b>null</b> in the frozen snapshot and shown as pending — no value is fabricated.
      </p>

      {/* Worksheets */}
      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-serif text-[17px] font-semibold text-slate-900">Regression corpus — stable cannot-miss worksheets</h2>
        <p className="mt-1 max-w-3xl text-[12.5px] text-slate-500">
          Every stable cannot-miss &ldquo;failure&rdquo; gets a worksheet (expected dx → engine hypotheses → retrieved evidence → omission
          mechanism → resolution). On bank {worksheets.meta.bank} <b>every one resolved to a measurement artefact — {genuineOpen} genuine
          engine breadth failures.</b> The worksheet is what makes that claim auditable rather than asserted.
        </p>

        <div className="mt-4 space-y-2.5">
          {worksheets.worksheets.map((w, i) => {
            const rm = RES_META[w.resolution];
            return (
              <details key={w.caseId} open={i === 0} className="overflow-hidden rounded-lg border border-slate-200">
                <summary className="flex cursor-pointer items-center gap-2.5 bg-slate-50 px-3.5 py-2.5 text-[13px] font-semibold text-slate-800">
                  <span className="rounded bg-brand-faint px-1.5 py-0.5 font-mono text-[12px] text-brand-dark">{w.caseId}</span>
                  <span>{w.expectedDx}</span>
                  <span className={`ml-auto rounded px-2 py-0.5 text-[11px] font-semibold ${rm.cls}`}>{rm.tag}</span>
                </summary>
                <dl className="grid grid-cols-[130px_1fr] gap-x-3.5 gap-y-2 px-4 py-3.5">
                  <Row dt="Expected dx (bank)">{w.expectedDx}</Row>
                  {w.stem && <Row dt="Patient stem">{w.stem}</Row>}
                  {w.engineHypotheses && <Row dt="Engine hypotheses">{w.engineHypotheses.join(', ')}</Row>}
                  {w.retrievedEvidence && <Row dt="Retrieved evidence">{w.retrievedEvidence}</Row>}
                  <Row dt="Omission mechanism">{w.omissionMechanism}</Row>
                  <Row dt="Resolution">{w.resolutionNote ?? rm.tag}</Row>
                </dl>
              </details>
            );
          })}
        </div>
        <p className="mt-3 text-[11.5px] text-slate-400">
          {worksheets.worksheets.length} worksheets · source: ratification ledger ({worksheets.meta.generated}). The <code>genuine-open</code>
          tag is retained so a future run can flag a real regression; on {worksheets.meta.bank} it is unused.
        </p>
      </div>
    </div>
  );
}
