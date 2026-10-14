/**
 * v1.7 Sprint E — inline Mermaid renderer for ```mermaid fenced blocks.
 *
 * Lazy-imports mermaid (~600KB) only when a block actually appears.
 * Sanitizes the generated SVG via DOMPurify before injecting.
 * Falls back to a small "Mermaid render failed" caption on syntax error
 * — never crashes the surrounding answer.
 */
import { useEffect, useRef, useState } from 'react';

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
let dompurifyPromise: Promise<typeof import('dompurify').default> | null = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(m => {
      m.default.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
      return m.default;
    });
  }
  return mermaidPromise;
}

function loadDOMPurify() {
  if (!dompurifyPromise) {
    dompurifyPromise = import('dompurify').then(m => m.default);
  }
  return dompurifyPromise;
}

export function MermaidBlock({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [mermaid, dompurify] = await Promise.all([loadMermaid(), loadDOMPurify()]);
        if (cancelled || !ref.current) return;
        const uniqueId = 'mm-' + Math.random().toString(36).slice(2, 10);
        const { svg } = await mermaid.render(uniqueId, source);
        if (cancelled || !ref.current) return;
        const clean = dompurify.sanitize(svg, { ADD_TAGS: ['use', 'foreignObject'], ADD_ATTR: ['transform', 'xmlns:xlink', 'xlink:href'] });
        ref.current.innerHTML = clean;
        setError(null);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message).slice(0, 200));
      }
    })();
    return () => { cancelled = true; };
  }, [source]);

  if (error) {
    return (
      <figure className="my-4 rounded border border-amber-200 bg-amber-50 p-3 not-prose">
        <div className="text-xs text-amber-800">⚠ Mermaid render failed: {error}</div>
        <pre className="mt-2 overflow-x-auto text-[11px] text-slate-700">{source}</pre>
      </figure>
    );
  }

  return (
    <figure className="my-4 overflow-x-auto rounded-lg border border-slate-200 bg-white p-4 text-center not-prose">
      <div ref={ref} />
    </figure>
  );
}
