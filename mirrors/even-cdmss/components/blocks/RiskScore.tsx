/**
 * v1.7c — risk-score infographic block.
 *
 * Renders a clinical scoring tool (CHA2DS2-VASc, HEART, qSOFA, Wells, etc.) with
 * the input checklist, computed total, and color-coded interpretation band.
 */
import { z } from 'zod';

export const RiskScoreSchema = z.object({
  name: z.string().min(1),
  components: z.array(z.object({
    label: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    points: z.number(),
  })).min(1),
  total: z.number(),
  max_total: z.number().optional(),
  interpretation_bands: z.array(z.object({
    range: z.string(),                    // e.g. "0", "1-2", "≥3"
    meaning: z.string(),
    action: z.string().optional(),
    severity: z.enum(['low', 'moderate', 'high', 'critical']).optional(),
  })).optional(),
  citation_ids: z.array(z.union([z.number(), z.string()])).optional(),
});

export type RiskScoreData = z.infer<typeof RiskScoreSchema>;

const SEV_CLS: Record<string, string> = {
  low: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  moderate: 'bg-amber-100 text-amber-900 border-amber-200',
  high: 'bg-rose-100 text-rose-900 border-rose-200',
  critical: 'bg-rose-200 text-rose-900 border-rose-400',
};

export function RiskScore({ data, onCite }: { data: RiskScoreData; onCite?: (n: string) => void }) {
  const totalText = data.max_total ? `${data.total} / ${data.max_total}` : String(data.total);
  return (
    <figure className="my-4 rounded-xl border border-sky-200 bg-sky-50/40 p-4 not-prose">
      <header className="mb-3 flex items-baseline justify-between border-b border-sky-200 pb-2">
        <div>
          <div className="text-base font-semibold text-sky-900">{data.name}</div>
          <div className="text-xs text-sky-700">Score: <span className="font-mono text-base font-bold text-sky-900">{totalText}</span></div>
        </div>
        <span className="rounded bg-sky-100 px-2 py-0.5 text-[10px] uppercase tracking-wider text-sky-800">Risk score</span>
      </header>

      <table className="w-full text-xs">
        <tbody>
          {data.components.map((c, i) => (
            <tr key={i} className="border-t border-sky-100">
              <td className="py-1 pr-3 text-slate-700">{c.label}</td>
              {c.value !== undefined && (
                <td className="py-1 pr-3 font-mono text-slate-500">
                  {typeof c.value === 'boolean' ? (c.value ? '✓' : '—') : String(c.value)}
                </td>
              )}
              <td className="py-1 text-right font-mono font-medium text-sky-800">{c.points > 0 ? '+' : ''}{c.points}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.interpretation_bands && data.interpretation_bands.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wider text-sky-700">Interpretation</div>
          <div className="space-y-1">
            {data.interpretation_bands.map((b, i) => {
              const cls = b.severity ? SEV_CLS[b.severity] : 'bg-slate-50 text-slate-700 border-slate-200';
              return (
                <div key={i} className={`flex items-start gap-2 rounded border px-2 py-1 text-xs ${cls}`}>
                  <span className="w-12 shrink-0 font-mono font-semibold">{b.range}</span>
                  <span className="flex-1">
                    <span className="font-medium">{b.meaning}</span>
                    {b.action && <span className="ml-1 text-slate-600">— {b.action}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {data.citation_ids && data.citation_ids.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1 border-t border-sky-100 pt-2">
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
