import HelpCard from '@/components/HelpCard';
import TopicsClient from './topics-client';

export const metadata = { title: 'Topics' };

export default function TopicsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Topic Synthesis</h1>
      <p className="mt-1 text-sm text-slate-500">
        Enter a clinical topic and get a structured, cited overview synthesised from the Even Hospital Database.
      </p>
      <HelpCard
        storageKey="topics"
        title="About topic synthesis"
        bullets={[
          'Give a topic (e.g. "atrial fibrillation management") and get a structured overview',
          'Every claim is cited to a corpus passage you can open',
          'Best for orientation on a subject rather than a specific consult question',
        ]}
      />
      <div className="mt-6"><TopicsClient /></div>
    </div>
  );
}
