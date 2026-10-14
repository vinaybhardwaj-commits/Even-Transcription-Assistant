import Link from 'next/link';
import { Library, ArrowRight } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import HelpCard from '@/components/HelpCard';
import SearchClient from '@/app/search/search-client';

export const metadata = { title: 'Knowledge base' };

// Merged surface: Search (embedded) + Browse the corpus (linked). Replaces the
// two separate top-level nav items per the 29-Jun IA decision.
export default function KnowledgePage() {
  return (
    <div>
      <PageHeader
        title="Knowledge base"
        subtitle="Search the evidence base directly for ranked source passages, or browse the full corpus by source — no synthesis, just the underlying material with citations."
      />
      <HelpCard
        storageKey="knowledge"
        title="About the knowledge base"
        bullets={[
          'Search returns the most similar corpus passages for your query, ranked by relevance — no answer is synthesised.',
          'Use it to verify a citation or find primary material fast.',
          'Browse walks the whole corpus by source and chapter — the raw passages that ground Ask, Differential, and the rest.',
        ]}
      />

      <SearchClient />

      <Link
        href="/browse"
        className="group mt-6 flex items-center gap-3 rounded-xl border border-slate-200 bg-paper p-4 transition hover:border-brand"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-faint text-brand">
          <Library className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-medium text-slate-900 group-hover:text-brand">Browse the corpus by source</span>
          <span className="block text-[12.5px] text-slate-500">Walk every book and chapter in the evidence base.</span>
        </span>
        <ArrowRight className="h-5 w-5 shrink-0 text-slate-400 group-hover:text-brand" />
      </Link>
    </div>
  );
}
