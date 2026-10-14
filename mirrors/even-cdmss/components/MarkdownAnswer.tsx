/**
 * v1.7 Sprint E — markdown answer renderer with custom citation tokenization,
 * Mermaid block support, and custom infographic-block dispatch.
 *
 * Replaces the old plain-text + regex citation renderer in ask-client.tsx.
 *
 * Streaming behavior: re-parses on every token (lock #14 — no throttle).
 * react-markdown handles partial markdown gracefully (literal `**` until
 * closer arrives, then snaps to bold). Unclosed fenced blocks render as
 * partial code text until the closing fence streams in.
 */
'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { MermaidBlock } from './blocks/MermaidBlock';
import { INFOGRAPHIC_BLOCKS } from './InfographicRegistry';

type Props = {
  text: string;
  onCite?: (n: string) => void;
};

// Custom text renderer that splits on [n] / [Pn] and emits clickable chips.
function renderTextWithCitations(text: string, onCite?: (n: string) => void): React.ReactNode[] {
  if (!text) return [];
  const out: React.ReactNode[] = [];
  const re = /\[(P?\d+)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    const n = m[1];
    const isPlos = n.startsWith('P');
    out.push(
      <button
        key={key++}
        type="button"
        onClick={() => onCite?.(n)}
        className={`mx-0.5 inline-flex items-center rounded px-1 py-px text-[10px] font-medium align-baseline ${
          isPlos ? 'bg-amber-100 text-amber-800 hover:bg-amber-200' : 'bg-brand-faint text-brand hover:bg-brand hover:text-white'
        }`}
        title={isPlos ? 'PLOS ONE source' : 'Textbook source'}
      >
        [{n}]
      </button>
    );
    last = re.lastIndex;
  }
  if (last < text.length) out.push(<span key={key++}>{text.slice(last)}</span>);
  return out;
}

export function MarkdownAnswer({ text, onCite }: Props) {
  const components: Components = {
    // Custom text node — split for citations
    // react-markdown passes text content as children of any leaf element.
    p: ({ children, ...props }) => (
      <p {...props}>
        {processChildren(children, onCite)}
      </p>
    ),
    li: ({ children, ...props }) => (
      <li {...props}>{processChildren(children, onCite)}</li>
    ),
    strong: ({ children, ...props }) => (
      <strong className="font-semibold text-navy" {...props}>{processChildren(children, onCite)}</strong>
    ),
    em: ({ children, ...props }) => (
      <em {...props}>{processChildren(children, onCite)}</em>
    ),
    h2: ({ children, ...props }) => (
      <h2 className="mt-4 mb-1.5 text-[15px] font-semibold text-navy" {...props}>{processChildren(children, onCite)}</h2>
    ),
    h3: ({ children, ...props }) => (
      <h3 className="mt-3 mb-1 text-[14px] font-semibold text-navy" {...props}>{processChildren(children, onCite)}</h3>
    ),
    table: ({ children, ...props }) => (
      <div className="overflow-x-auto my-3"><table className="min-w-full text-xs border border-slate-200" {...props}>{children}</table></div>
    ),
    th: ({ children, ...props }) => (
      <th className="border border-slate-200 bg-slate-50 px-2 py-1 text-left font-medium" {...props}>{children}</th>
    ),
    td: ({ children, ...props }) => (
      <td className="border border-slate-200 px-2 py-1" {...props}>{children}</td>
    ),
    blockquote: ({ children, ...props }) => (
      <blockquote className="border-l-2 border-brand-faint bg-slate-50 px-3 py-1 italic text-slate-700 my-2" {...props}>{children}</blockquote>
    ),
    code: (props) => {
      const { className, children } = props as { className?: string; children?: React.ReactNode };
      const match = /language-(\w[\w-]*)/.exec(className || '');
      const lang = match?.[1] || '';
      const raw = String(children).replace(/\n$/, '');

      // Mermaid block
      if (lang === 'mermaid') {
        return <MermaidBlock source={raw} />;
      }

      // Custom infographic block?
      const reg = INFOGRAPHIC_BLOCKS[lang];
      if (reg) {
        try {
          const data = reg.schema.parse(JSON.parse(raw));
          const C = reg.component;
          return <C data={data} onCite={onCite} />;
        } catch (e) {
          return (
            <figure className="my-3 rounded border border-amber-200 bg-amber-50 p-2 not-prose text-xs text-amber-800">
              ⚠ {lang} block could not be rendered: {(e as Error).message.slice(0, 120)}
              <pre className="mt-1 overflow-x-auto text-[10px] text-slate-700">{raw}</pre>
            </figure>
          );
        }
      }

      // Inline code? (no language, single line)
      if (!className) {
        return <code className="rounded bg-slate-100 px-1 py-0.5 text-[12px] font-mono text-slate-800">{children}</code>;
      }

      // Default fenced code block (no special language)
      return (
        <pre className="my-3 overflow-x-auto rounded bg-slate-50 p-3 text-xs font-mono text-slate-800">
          <code className={className}>{raw}</code>
        </pre>
      );
    },
  };

  return (
    <div className="prose prose-sm max-w-none prose-p:leading-[1.55] prose-li:leading-[1.55] prose-headings:mt-3 prose-ul:my-2 prose-ol:my-2 text-[14px]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

// Walk react children, replacing string nodes with citation-split spans.
function processChildren(children: React.ReactNode, onCite?: (n: string) => void): React.ReactNode {
  if (typeof children === 'string') return renderTextWithCitations(children, onCite);
  if (Array.isArray(children)) {
    return children.map((c, i) => {
      if (typeof c === 'string') {
        // We can't return a fragment with a key easily — wrap in span
        return <span key={i}>{renderTextWithCitations(c, onCite)}</span>;
      }
      return c;
    });
  }
  return children;
}
