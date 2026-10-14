'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CalculatorConfig, FormField, CalculatorResult, LiveScoreFn } from '@/lib/calculators/types';

// Tooltip cache version sentinel (PRD §3.14). Compared against server's value on app boot.
const TOOLTIP_VERSION_LS_KEY = 'cdmss_tooltip_cache_version';

async function ensureTooltipCacheFresh() {
  if (typeof window === 'undefined') return;
  try {
    const r = await fetch('/api/health');
    const data = await r.json();
    const serverVersion = data?.tooltip_cache_version ?? null;
    if (!serverVersion) return;
    const local = localStorage.getItem(TOOLTIP_VERSION_LS_KEY);
    if (local !== serverVersion) {
      // Clear all tooltip:* keys
      const toClear: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('tooltip:')) toClear.push(k);
      }
      for (const k of toClear) localStorage.removeItem(k);
      localStorage.setItem(TOOLTIP_VERSION_LS_KEY, serverVersion);
    }
  } catch {
    // bridge or health down — leave cache alone
  }
}

async function getTooltip(calc: string, field: string): Promise<string> {
  const key = `tooltip:${calc}:${field}`;
  if (typeof window !== 'undefined') {
    const cached = localStorage.getItem(key);
    if (cached) return cached;
  }
  try {
    const r = await fetch(`/api/calculators/tooltip?calc=${calc}&field=${field}`);
    const data = await r.json();
    const text = data?.text ?? '';
    if (text && typeof window !== 'undefined') localStorage.setItem(key, text);
    return text;
  } catch {
    return '';
  }
}

function FieldInput({
  calc,
  field,
  value,
  setValue,
  error,
}: {
  calc: string;
  field: FormField;
  value: unknown;
  setValue: (v: unknown) => void;
  error?: string;
}) {
  const [tip, setTip] = useState<string>(field.staticTooltip);
  const [tipLoaded, setTipLoaded] = useState(false);
  const [showTip, setShowTip] = useState(false);

  async function handleHover() {
    if (!tipLoaded) {
      const fresh = await getTooltip(calc, field.key);
      if (fresh) setTip(fresh);
      setTipLoaded(true);
    }
    setShowTip(true);
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-1.5">
        <span className="text-sm font-semibold text-slate-800">{field.label}</span>
        {field.unit && <span className="text-xs text-slate-500">({field.unit})</span>}
        <button
          type="button"
          aria-label={`Info about ${field.label}`}
          onMouseEnter={handleHover}
          onMouseLeave={() => setShowTip(false)}
          onFocus={handleHover}
          onBlur={() => setShowTip(false)}
          className="ml-1 text-slate-400 hover:text-brand focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-1 rounded"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path d="M8 7v4M8 4.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {/* v2.0: always-visible subtitle removes the need to hover ⓘ */}
      {field.subtitle && <div className="text-xs text-slate-500 leading-snug">{field.subtitle}</div>}

      {showTip && tip && (
        <div className="relative">
          <div role="tooltip" className="absolute z-10 -mt-1 max-w-xs rounded-md bg-slate-800 px-3 py-2 text-xs leading-relaxed text-white shadow-lg">
            {tip}
          </div>
        </div>
      )}

      {field.type === 'enum' && field.options ? (
        /* v2.0 — vertical button stack with descriptive labels + per-option points chip */
        <div className="space-y-1">
          {field.options.map((o) => {
            const selected = String(value ?? '') === String(o.value);
            return (
              <button
                type="button"
                key={String(o.value)}
                onClick={() => setValue(o.value)}
                className={`flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition ${
                  selected
                    ? 'border-brand bg-brand-faint text-brand shadow-sm'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-brand/40 hover:bg-slate-50'
                }`}
              >
                <span className="flex-1">
                  <span className={selected ? 'font-semibold' : ''}>{o.label}</span>
                  {o.description && <span className="block text-xs text-slate-500">{o.description}</span>}
                </span>
                {typeof o.points === 'number' && (
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-mono font-semibold ${
                    selected ? 'bg-brand text-white' : 'bg-slate-100 text-slate-600'
                  }`}>{o.points > 0 ? '+' : ''}{o.points}</span>
                )}
              </button>
            );
          })}
        </div>
      ) : field.type === 'bool' ? (
        /* v2.0 — two-button stack (Yes/No) with optional per-option points */
        <div className="flex gap-2">
          {[
            { v: true,  label: (field.options?.find(o => o.value === true)?.label) || 'Yes', pts: field.options?.find(o => o.value === true)?.points },
            { v: false, label: (field.options?.find(o => o.value === false)?.label) || 'No',  pts: field.options?.find(o => o.value === false)?.points },
          ].map(({ v, label, pts }) => {
            const selected = value === v;
            return (
              <button
                type="button"
                key={String(v)}
                onClick={() => setValue(v)}
                className={`flex flex-1 items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm transition ${
                  selected
                    ? 'border-brand bg-brand-faint text-brand shadow-sm font-semibold'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-brand/40 hover:bg-slate-50'
                }`}
              >
                <span>{label}</span>
                {typeof pts === 'number' && (
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-mono font-semibold ${
                    selected ? 'bg-brand text-white' : 'bg-slate-100 text-slate-600'
                  }`}>{pts > 0 ? '+' : ''}{pts}</span>
                )}
              </button>
            );
          })}
        </div>
      ) : field.type === 'number' || field.type === 'integer' ? (
        <input
          type="number"
          inputMode={field.type === 'integer' ? 'numeric' : 'decimal'}
          step={field.type === 'integer' ? '1' : 'any'}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => setValue(e.target.value === '' ? undefined : Number(e.target.value))}
          className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-1 ${
            error ? 'border-red-400 focus:border-red-500 focus:ring-red-500' : 'border-slate-300 focus:border-brand focus:ring-brand'
          }`}
        />
      ) : (
        <input
          type="text"
          value={String(value ?? '')}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
      )}

      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
}

export type CalculatorShellProps<TDeterministic = Record<string, unknown>> = {
  config: CalculatorConfig;
  /** v2.0 — optional client-side live preview from each calc's math fn. */
  liveScore?: LiveScoreFn;
  // Override default form rendering (rare — most calcs use the default).
  renderForm?: (props: {
    values: Record<string, unknown>;
    setValue: (k: string, v: unknown) => void;
    errors: Record<string, string>;
  }) => React.ReactNode;
  renderResult: (props: { result: CalculatorResult & { deterministic: TDeterministic } }) => React.ReactNode;
};

export default function CalculatorShell<T = Record<string, unknown>>({ config, liveScore, renderForm, renderResult }: CalculatorShellProps<T>) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const f of config.fields) {
      if (f.defaultValue !== undefined) init[f.key] = f.defaultValue;
    }
    return init;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [softWarnings, setSoftWarnings] = useState<string[]>([]);
  const [result, setResult] = useState<CalculatorResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const idemKey = useRef<string>(crypto.randomUUID());

  // v2.0 — live score preview computed client-side from each calc's math fn.
  // Returns null when liveScore prop not supplied OR when inputs incomplete.
  const livePreview = useMemo(() => {
    if (!liveScore) return null;
    try { return liveScore(values); } catch { return null; }
  }, [liveScore, values]);

  // Tooltip cache freshness check on mount.
  useEffect(() => { ensureTooltipCacheFresh(); }, []);

  function setValue(k: string, v: unknown) {
    setValues((prev) => ({ ...prev, [k]: v }));
    if (errors[k]) setErrors((prev) => { const next = { ...prev }; delete next[k]; return next; });
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    for (const f of config.fields) {
      const v = values[f.key];
      if (f.required && (v === undefined || v === null || v === '')) {
        e[f.key] = 'Required';
        continue;
      }
      if (typeof v === 'number') {
        if (f.hardMin !== undefined && v < f.hardMin) e[f.key] = `Must be ≥ ${f.hardMin}`;
        if (f.hardMax !== undefined && v > f.hardMax) e[f.key] = `Must be ≤ ${f.hardMax}`;
      }
    }
    setErrors(e);

    // Soft warnings: physiologically unusual values per softMin/softMax — allow Submit,
    // surface as a yellow banner so the user can confirm before computing (PRD §14.4).
    const warnings: string[] = [];
    for (const f of config.fields) {
      const v = values[f.key];
      if (typeof v !== 'number') continue;
      if (f.softMin !== undefined && v < f.softMin) warnings.push(`${f.label} ${v}${f.unit ? ' ' + f.unit : ''} is unusually low — confirm`);
      if (f.softMax !== undefined && v > f.softMax) warnings.push(`${f.label} ${v}${f.unit ? ' ' + f.unit : ''} is unusually high — confirm`);
    }
    setSoftWarnings(warnings);
    return Object.keys(e).length === 0;
  }

  // Live re-compute soft warnings whenever values change (so the banner appears as the user types)
  useEffect(() => {
    const warnings: string[] = [];
    for (const f of config.fields) {
      const v = values[f.key];
      if (typeof v !== 'number') continue;
      if (f.softMin !== undefined && v < f.softMin) warnings.push(`${f.label} ${v}${f.unit ? ' ' + f.unit : ''} is unusually low — confirm`);
      if (f.softMax !== undefined && v > f.softMax) warnings.push(`${f.label} ${v}${f.unit ? ' ' + f.unit : ''} is unusually high — confirm`);
    }
    setSoftWarnings(warnings);
  }, [values, config.fields]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const r = await fetch(config.apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey.current },
        body: JSON.stringify({ ...values, idempotency_key: idemKey.current }),
      });
      const data = await r.json();
      if (!r.ok) {
        setServerError(data?.error ?? `HTTP ${r.status}`);
        setSubmitting(false);
        return;
      }
      // If this calc pushes context (eGFR → renal_ctx), write it to sessionStorage.
      if (data.pushed_to_context && data.pushed_to_context.target === 'drugs' && data.pushed_to_context.renal_ctx) {
        try {
          sessionStorage.setItem('cdmss_renal_ctx', JSON.stringify(data.pushed_to_context.renal_ctx));
        } catch {}
      }
      setResult(data);
      // Persist result for navigate-away-and-back per PRD §14.6
      try {
        sessionStorage.setItem(`cdmss_calc_result:${config.name}:${data.trace_id}`, JSON.stringify(data));
      } catch {}
      setSubmitting(false);
      // Fresh idempotency key for next submission
      idemKey.current = crypto.randomUUID();
    } catch (e2) {
      setServerError(String((e2 as Error).message));
      setSubmitting(false);
    }
  }

  function handleReset() {
    setResult(null);
    setServerError(null);
    setValues(() => {
      const init: Record<string, unknown> = {};
      for (const f of config.fields) if (f.defaultValue !== undefined) init[f.key] = f.defaultValue;
      return init;
    });
    setErrors({});
    idemKey.current = crypto.randomUUID();
  }

  const formContent = useMemo(() => {
    if (renderForm) return renderForm({ values, setValue, errors });
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        {config.fields.map((f) => (
          <FieldInput
            key={f.key}
            calc={config.name}
            field={f}
            value={values[f.key]}
            setValue={(v) => setValue(f.key, v)}
            error={errors[f.key]}
          />
        ))}
      </div>
    );
  }, [config, values, errors, renderForm]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{config.displayTitle}</h1>
      </header>

      {!result ? (
        <form onSubmit={handleSubmit} className="space-y-5">
          {livePreview && (
            <div className={`sticky top-0 z-10 -mx-4 -mt-4 mb-2 flex items-baseline justify-between gap-3 border-b px-4 py-2.5 backdrop-blur sm:mx-0 sm:rounded-t-lg sm:mt-0 ${
              livePreview.complete
                ? 'border-brand/30 bg-brand-faint/70 text-brand'
                : 'border-slate-200 bg-slate-50/80 text-slate-600'
            }`}>
              <span className="text-sm font-medium">
                {livePreview.complete ? 'Score' : 'Running score'}: <span className="font-mono text-base font-bold">{livePreview.score}{typeof livePreview.max === 'number' && ` / ${livePreview.max}`}</span>
              </span>
              {livePreview.band_label && (
                <span className="text-xs italic">{livePreview.band_label}</span>
              )}
            </div>
          )}
          {formContent}

          {softWarnings.length > 0 && (
            <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <div className="font-medium">Unusual values — confirm before computing:</div>
              <ul className="mt-1 list-disc pl-5">
                {softWarnings.map((w, i) => (<li key={i}>{w}</li>))}
              </ul>
            </div>
          )}
          {serverError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {serverError}
            </div>
          )}

          <div className="sticky bottom-0 z-10 flex items-center justify-end gap-3 border-t border-slate-200 bg-white py-3">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand/90 disabled:opacity-50"
            >
              {submitting ? 'Computing…' : 'Compute'}
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-5">
          {renderResult({ result: result as CalculatorResult & { deterministic: T } })}
          <div className="flex gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={() => { setResult(null); }}
              className="text-sm text-brand hover:underline"
            >
              ← Edit inputs and re-score
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="text-sm text-slate-500 hover:text-slate-700"
            >
              Start over
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
