/**
 * v1.7c — drug-comparison infographic block.
 *
 * Side-by-side X-vs-Y pharma decisions. Horizontal-scroll table with color
 * coding for monitoring burden + cost tier.
 */
import { z } from 'zod';

export const DrugComparisonSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.object({
    drug: z.string().min(1),
    dose: z.string().optional(),
    indications: z.string().optional(),
    contraindications: z.string().optional(),
    monitoring: z.string().optional(),
    monitoring_burden: z.enum(['none', 'minimal', 'moderate', 'heavy']).optional(),
    cost_tier: z.enum(['$', '$$', '$$$', '$$$$']).optional(),
    evidence_grade: z.string().optional(),  // e.g. "Class I, Level A"
    notes: z.string().optional(),
  })).min(2),
  bottom_line: z.string().optional(),
  citation_ids: z.array(z.union([z.number(), z.string()])).optional(),
});

export type DrugComparisonData = z.infer<typeof DrugComparisonSchema>;

const BURDEN_CLS: Record<string, string> = {
  none: 'bg-emerald-100 text-emerald-800',
  minimal: 'bg-emerald-50 text-emerald-700',
  moderate: 'bg-amber-100 text-amber-900',
  heavy: 'bg-rose-100 text-rose-900',
};

export function DrugComparison({ data, onCite }: { data: DrugComparisonData; onCite?: (n: string) => void }) {
  const rows: Array<[string, (o: DrugComparisonData['options'][number]) => React.ReactNode]> = [
    ['Dose', (o) => o.dose || '—'],
    ['Indications', (o) => o.indications || '—'],
    ['Contraindications', (o) => o.contraindications || '—'],
    ['Monitoring', (o) => o.monitoring || '—'],
    ['Monitoring burden', (o) => o.monitoring_burden
      ? <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${BURDEN_CLS[o.monitoring_burden]}`}>{o.monitoring_burden}</span>
      : '—'],
    ['Cost', (o) => o.cost_tier ? <span className="font-mono text-emerald-700">{o.cost_tier}</span> : '—'],
    ['Evidence', (o) => o.evidence_grade || '—'],
    ['Notes', (o) => o.notes || '—'],
  ];
  // Skip rows where every option has — (no data)
  const usefulRows = rows.filter(([, fn]) => data.options.some((o) => fn(o) !== '—'));

  return (
    <figure className="my-4 rounded-xl border border-violet-200 bg-violet-50/30 p-4 not-prose">
      <header className="mb-3 flex items-baseline justify-between border-b border-violet-200 pb-2">
        <div className="text-base font-semibold text-violet-900">{data.question}</div>
        <span className="rounded bg-violet-100 px-2 py-0.5 text-[10px] uppercase tracking-wider text-violet-800">Drug compare</span>
      </header>

      <div className="-mx-2 overflow-x-auto">
        <table className="w-full min-w-full text-xs">
          <thead>
            <tr>
              <th className="bg-violet-100 px-2 py-1 text-left font-semibold text-violet-900"></th>
              {data.options.map((o, i) => (
                <th key={i} className="bg-violet-100 px-2 py-1 text-left font-semibold text-violet-900">{o.drug}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {usefulRows.map(([label, fn], rIdx) => (
              <tr key={rIdx} className="border-t border-violet-100">
                <td className="px-2 py-1 font-medium text-violet-700">{label}</td>
                {data.options.map((o, i) => (
                  <td key={i} className="px-2 py-1 align-top text-slate-700">{fn(o)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.bottom_line && (
        <div className="mt-3 rounded border border-violet-200 bg-violet-100/50 p-2 text-xs italic text-violet-900">
          <strong>Bottom line:</strong> {data.bottom_line}
        </div>
      )}

      {data.citation_ids && data.citation_ids.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1 border-t border-violet-100 pt-2">
          {data.citation_ids.map((c, i) => (
            <button key={i} onClick={() => onCite?.(String(c))}
                    className="rounded bg-brand-faint px-1.5 py-0.5 text-[10px] font-medium text-brand hover:bg-brand hover:text-white">
              [{c}]
            </button>
          ))}
        </div>
      )}
    </figure>
  );
}
