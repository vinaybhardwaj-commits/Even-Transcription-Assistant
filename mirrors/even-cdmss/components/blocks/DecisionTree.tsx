/**
 * v1.7c — decision-tree infographic block.
 *
 * Recursive clinical decision tree with color-coded urgency. Each node is
 * either a Question (with branches[]) or a leaf Action.
 *
 * Schema is intentionally recursive — Zod handles via z.lazy().
 */
import { z } from 'zod';

// Recursive node type definition
export type DecisionNode =
  | { question: string; branches: Array<{ label: string; leads_to: DecisionNode }> }
  | { action: string; urgency?: 'routine' | 'urgent' | 'emergent'; note?: string };

const ActionNodeSchema = z.object({
  action: z.string().min(1),
  urgency: z.enum(['routine', 'urgent', 'emergent']).optional(),
  note: z.string().optional(),
});

// z.lazy lets us reference the same schema from inside itself
const DecisionNodeSchema: z.ZodType<DecisionNode> = z.lazy(() => z.union([
  z.object({
    question: z.string().min(1),
    branches: z.array(z.object({
      label: z.string().min(1),
      leads_to: DecisionNodeSchema,
    })).min(1),
  }),
  ActionNodeSchema,
]));

export const DecisionTreeSchema = z.object({
  title: z.string().min(1),
  root: DecisionNodeSchema,
  citation_ids: z.array(z.union([z.number(), z.string()])).optional(),
});

export type DecisionTreeData = z.infer<typeof DecisionTreeSchema>;

const URG_CLS: Record<string, string> = {
  routine: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  urgent: 'border-amber-300 bg-amber-50 text-amber-900',
  emergent: 'border-rose-400 bg-rose-50 text-rose-900',
};

function NodeView({ node, depth }: { node: DecisionNode; depth: number }) {
  if ('action' in node) {
    const cls = node.urgency ? URG_CLS[node.urgency] : 'border-slate-300 bg-white text-slate-800';
    return (
      <div className={`my-1 rounded-md border-l-4 px-2 py-1 text-xs ${cls}`}>
        {node.urgency && (
          <span className="mr-1 rounded bg-white/60 px-1 py-px text-[9px] font-semibold uppercase tracking-wider">
            {node.urgency}
          </span>
        )}
        <strong>→</strong> {node.action}
        {node.note && <div className="mt-0.5 text-[11px] italic opacity-80">{node.note}</div>}
      </div>
    );
  }
  return (
    <div className="my-1">
      <div className="rounded-md border border-indigo-200 bg-indigo-50/60 px-2 py-1 text-xs font-medium text-indigo-900">
        ? {node.question}
      </div>
      <ul className="mt-1 ml-3 space-y-1 border-l-2 border-indigo-100 pl-3">
        {node.branches.map((b, i) => (
          <li key={i}>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-indigo-700">
              {b.label}
            </div>
            <NodeView node={b.leads_to} depth={depth + 1} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DecisionTree({ data, onCite }: { data: DecisionTreeData; onCite?: (n: string) => void }) {
  return (
    <figure className="my-4 rounded-xl border border-indigo-200 bg-indigo-50/30 p-4 not-prose">
      <header className="mb-2 flex items-baseline justify-between border-b border-indigo-200 pb-2">
        <div className="text-base font-semibold text-indigo-900">{data.title}</div>
        <span className="rounded bg-indigo-100 px-2 py-0.5 text-[10px] uppercase tracking-wider text-indigo-800">Decision tree</span>
      </header>

      <NodeView node={data.root} depth={0} />

      {data.citation_ids && data.citation_ids.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1 border-t border-indigo-100 pt-2">
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
