import HelpCard from '@/components/HelpCard';
import ReviewClient from './review-client';

export const metadata = { title: 'Review' };

export default function ReviewPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Shift Review</h1>
      <p className="mt-1 text-sm text-slate-500">
        Generate a digest of your recent queries, then work through the flashcards on your own schedule.
      </p>
            <HelpCard
        storageKey="review"
        title='Shift digest + spaced-repetition flashcards'
        bullets={[
          "Today's Digest reads your queries since your last digest, themes them, flags knowledge gaps, and generates 3–5 cloze flashcards",
          'Run it at shift end (or any time after several queries) — needs at least 3 queries in the window',
          'Flashcard Review shows due cards one at a time; rate Again / Hard / Good / Easy to schedule the next review',
          "Modified SM-2 scheduler — first 'Easy' caps at 4 days (vs standard 6) to account for shift gaps",
        ]}
      />
      <div className="mt-6"><ReviewClient /></div>
    </div>
  );
}
