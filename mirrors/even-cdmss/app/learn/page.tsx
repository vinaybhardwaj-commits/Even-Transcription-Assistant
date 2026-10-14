import Link from 'next/link';
import { MessageCircleQuestion, ListChecks, Layers, NotebookPen, ArrowRight } from 'lucide-react';
import PageHeader from '@/components/PageHeader';

export const metadata = { title: 'Learn' };

const TOOLS = [
  { href: '/coach', label: 'Clinical reasoning coach', desc: 'Socratic, multi-turn teaching that probes your reasoning rather than handing you the answer. Difficulty adapts as you go.', Icon: MessageCircleQuestion },
  { href: '/practice', label: 'Practice questions', desc: 'Board-style multiple-choice questions generated from the corpus, each with a cited explanation.', Icon: ListChecks },
  { href: '/topics', label: 'Topic guides', desc: 'Enter a clinical topic and get a structured, cited overview — best for orientation on a subject.', Icon: NotebookPen },
  { href: '/review', label: 'Shift review', desc: 'A digest of your recent queries plus spaced-repetition flashcards on your own schedule.', Icon: Layers },
];

// Merged hub for the four study/education tools (29-Jun IA decision). They keep
// their own pages; this is the single front door for them.
export default function LearnPage() {
  return (
    <div>
      <PageHeader
        title="Learn"
        subtitle="Education tools, grouped. These complement the bedside decision-support tools — use them to build and rehearse reasoning, not at the point of care."
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {TOOLS.map(({ href, label, desc, Icon }) => (
          <Link
            key={href}
            href={href}
            className="group flex flex-col rounded-xl border border-slate-200 bg-paper p-5 shadow-card transition hover:-translate-y-0.5 hover:border-brand"
          >
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-faint text-brand">
              <Icon className="h-5 w-5" />
            </span>
            <span className="flex items-center gap-1.5 text-[15px] font-medium text-slate-900 group-hover:text-brand">
              {label}
              <ArrowRight className="h-4 w-4 opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
            </span>
            <span className="mt-1 text-[13px] leading-relaxed text-slate-500">{desc}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
