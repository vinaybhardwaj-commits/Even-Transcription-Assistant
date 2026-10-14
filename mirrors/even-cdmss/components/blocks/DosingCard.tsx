/**
 * v1.7 Sprint E — proof-of-concept infographic block.
 *
 * The LLM emits JSON inside a ```dosing-card fenced block. We validate it
 * with Zod, then render a styled card. Required: drug, starting_dose.
 * Everything else optional — sparse cards still render well.
 *
 * If validation fails, we fall back to a JSON code-block view rather than
 * crash — fails closed.
 */
'use client';
import { useEffect, useState } from 'react';
import { z } from 'zod';

export const DosingCardSchema = z.object({
  drug: z.string().min(1),
  starting_dose: z.string().min(1),
  indication: z.string().optional(),
  max_dose: z.string().optional(),
  renal: z.array(z.object({
    egfr: z.string(),
    guidance: z.string(),
  })).optional(),
  hepatic: z.array(z.object({
    grade: z.string(),
    guidance: z.string(),
  })).optional(),
  pediatric: z.string().optional(),
  elderly: z.string().optional(),
  pregnancy: z.string().optional(),
  key_warnings: z.array(z.string()).optional(),
  black_box: z.string().optional(),
  citation_ids: z.array(z.union([z.number(), z.string()])).optional(),
});

export type DosingCardData = z.infer<typeof DosingCardSchema>;

type PubChemMini = {
  cid: number;
  canonical_name: string | null;
  atc_codes: string[];
  url: string;
  mesh_top: string | null;
};

export function DosingCard({ data, onCite }: { data: DosingCardData; onCite?: (n: string) => void }) {
  // v1.9b: fetch PubChem facts for the drug on mount — non-blocking, soft-fail
  const [pubchem, setPubchem] = useState<PubChemMini | null>(null);
  useEffect(() => {
    if (!data.drug) return;
    const ctrl = new AbortController();
    fetch(`/api/pubchem/lookup?name=${encodeURIComponent(data.drug)}`, { signal: ctrl.signal })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (j && j.found) setPubchem({ cid: j.cid, canonical_name: j.canonical_name, atc_codes: j.atc_codes || [], url: j.url, mesh_top: j.mesh_top });
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [data.drug]);

  return (
    <figure className="my-4 rounded-xl border border-rose-200 bg-rose-50/30 p-4 not-prose">
      <header className="mb-3 flex items-baseline justify-between border-b border-rose-200 pb-2">
        <div>
          <div className="text-base font-semibold text-rose-900">{data.drug}</div>
          {data.indication && <div className="text-xs text-rose-700">{data.indication}</div>}
        </div>
        <span className="rounded bg-rose-100 px-2 py-0.5 text-[10px] uppercase tracking-wider text-rose-800">Dosing</span>
      </header>

      <dl className="space-y-2 text-sm">
        <div className="flex gap-3">
          <dt className="w-28 shrink-0 font-medium text-rose-800">Start</dt>
          <dd className="text-slate-800">{data.starting_dose}</dd>
        </div>
        {data.max_dose && (
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 font-medium text-rose-800">Max</dt>
            <dd className="text-slate-800">{data.max_dose}</dd>
          </div>
        )}
        {data.pediatric && (
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 font-medium text-rose-800">Peds</dt>
            <dd className="text-slate-800">{data.pediatric}</dd>
          </div>
        )}
        {data.elderly && (
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 font-medium text-rose-800">Elderly</dt>
            <dd className="text-slate-800">{data.elderly}</dd>
          </div>
        )}
        {data.pregnancy && (
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 font-medium text-rose-800">Pregnancy</dt>
            <dd className="text-slate-800">{data.pregnancy}</dd>
          </div>
        )}
      </dl>

      {data.renal && data.renal.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wider text-rose-700">Renal adjustment</div>
          <table className="w-full text-xs">
            <tbody>
              {data.renal.map((r, i) => (
                <tr key={i} className="border-t border-rose-100">
                  <td className="py-1 pr-3 font-mono text-rose-800">eGFR {r.egfr}</td>
                  <td className="py-1 text-slate-700">{r.guidance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.hepatic && data.hepatic.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wider text-rose-700">Hepatic adjustment</div>
          <table className="w-full text-xs">
            <tbody>
              {data.hepatic.map((r, i) => (
                <tr key={i} className="border-t border-rose-100">
                  <td className="py-1 pr-3 font-mono text-rose-800">Child-Pugh {r.grade}</td>
                  <td className="py-1 text-slate-700">{r.guidance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.black_box && (
        <div className="mt-3 rounded border border-rose-500 bg-rose-100 p-2 text-xs text-rose-900">
          <strong>⚠ Black box:</strong> {data.black_box}
        </div>
      )}

      {data.key_warnings && data.key_warnings.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wider text-rose-700">Warnings</div>
          <ul className="space-y-1 text-xs text-slate-700">
            {data.key_warnings.map((w, i) => <li key={i}>• {w}</li>)}
          </ul>
        </div>
      )}

      {((data.citation_ids && data.citation_ids.length > 0) || pubchem) && (
        <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-rose-100 pt-2">
          {data.citation_ids && data.citation_ids.map((c, i) => (
            <button key={i} onClick={() => onCite?.(String(c))}
                    className="rounded bg-brand-faint px-1.5 py-0.5 text-[10px] font-medium text-brand hover:bg-brand hover:text-white">
              [{c}]
            </button>
          ))}
          {pubchem && (
            <a href={pubchem.url} target="_blank" rel="noopener noreferrer"
               className="ml-auto inline-flex items-center gap-1 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800 hover:bg-sky-200"
               title={`PubChem CID ${pubchem.cid}${pubchem.atc_codes.length ? ` · ATC ${pubchem.atc_codes.join(', ')}` : ''}${pubchem.mesh_top ? ` · ${pubchem.mesh_top}` : ''}`}>
              PubChem ↗ CID {pubchem.cid}{pubchem.atc_codes[0] ? ` · ${pubchem.atc_codes[0]}` : ''}
            </a>
          )}
        </div>
      )}
    </figure>
  );
}
