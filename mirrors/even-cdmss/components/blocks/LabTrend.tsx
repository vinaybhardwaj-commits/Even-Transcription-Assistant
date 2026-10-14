/**
 * v1.7c — lab-trend infographic block.
 *
 * Serial lab values telling a story. Mini-table + inline SVG sparkline +
 * one-sentence narrative.
 */
import { z } from 'zod';

export const LabTrendSchema = z.object({
  test_name: z.string().min(1),
  unit: z.string().optional(),
  normal_range: z.string().optional(),
  values: z.array(z.object({
    when: z.string(),                       // "Day 1", "Visit 2026-01-15", "2hr post-tx"
    value: z.number(),
    flag: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  })).min(2),
  narrative: z.string().optional(),
  citation_ids: z.array(z.union([z.number(), z.string()])).optional(),
});

export type LabTrendData = z.infer<typeof LabTrendSchema>;

const FLAG_CLS: Record<string, string> = {
  low: 'text-amber-700',
  normal: 'text-emerald-700',
  high: 'text-amber-700',
  critical: 'text-rose-700 font-bold',
};

function Sparkline({ values }: { values: number[] }) {
  const W = 120, H = 28;
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (W - 4) + 2;
    const y = H - 2 - ((v - min) / span) * (H - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width={W} height={H} className="text-teal-600">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" />
      {values.map((v, i) => {
        const x = (i / (values.length - 1)) * (W - 4) + 2;
        const y = H - 2 - ((v - min) / span) * (H - 4);
        return <circle key={i} cx={x} cy={y} r="1.8" fill="currentColor" />;
      })}
    </svg>
  );
}

export function LabTrend({ data, onCite }: { data: LabTrendData; onCite?: (n: string) => void }) {
  const numericValues = data.values.map((v) => v.value);
  return (
    <figure className="my-4 rounded-xl border border-teal-200 bg-teal-50/30 p-4 not-prose">
      <header className="mb-3 flex items-baseline justify-between border-b border-teal-200 pb-2">
        <div>
          <div className="text-base font-semibold text-teal-900">{data.test_name}{data.unit ? <span className="ml-1 text-xs font-normal text-teal-700">({data.unit})</span> : null}</div>
          {data.normal_range && <div className="text-xs text-teal-700">Normal: <span className="font-mono">{data.normal_range}</span></div>}
        </div>
        <div className="flex items-center gap-2">
          <Sparkline values={numericValues} />
          <span className="rounded bg-teal-100 px-2 py-0.5 text-[10px] uppercase tracking-wider text-teal-800">Lab trend</span>
        </div>
      </header>

      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className="px-1 py-1 text-left font-semibold text-teal-700">When</th>
            <th className="px-1 py-1 text-right font-semibold text-teal-700">Value</th>
            <th className="px-1 py-1 text-right font-semibold text-teal-700">Δ</th>
          </tr>
        </thead>
        <tbody>
          {data.values.map((v, i) => {
            const prev = i > 0 ? data.values[i - 1].value : null;
            const delta = prev !== null ? v.value - prev : null;
            const flagCls = v.flag ? FLAG_CLS[v.flag] : 'text-slate-800';
            return (
              <tr key={i} className="border-t border-teal-100">
                <td className="px-1 py-1 text-slate-700">{v.when}</td>
                <td className={`px-1 py-1 text-right font-mono ${flagCls}`}>{v.value}</td>
                <td className="px-1 py-1 text-right font-mono text-slate-500">
                  {delta === null ? '—' : (delta > 0 ? '↑' : delta < 0 ? '↓' : '→')} {delta !== null && delta !== 0 ? Math.abs(delta).toFixed(2).replace(/\.?0+$/, '') : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {data.narrative && (
        <div className="mt-3 rounded border border-teal-200 bg-teal-100/40 p-2 text-xs italic text-teal-900">
          {data.narrative}
        </div>
      )}

      {data.citation_ids && data.citation_ids.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1 border-t border-teal-100 pt-2">
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
