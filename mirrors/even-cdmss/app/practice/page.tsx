import HelpCard from '@/components/HelpCard';
import PracticeClient from './practice-client';

export const metadata = { title: 'Practice' };

export default function PracticePage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Practice Questions</h1>
      <p className="mt-1 text-sm text-slate-500">
        Self-test with board-style questions generated from the Even Hospital Database, with cited explanations.
      </p>
      <HelpCard
        storageKey="practice"
        title="About practice mode"
        bullets={[
          'Generates a board-style multiple-choice question, then reveals the cited explanation',
          'Grounded in the same corpus that powers Ask and DDx',
          'Use it to actively rehearse rather than passively read',
        ]}
      />
      <div className="mt-6"><PracticeClient /></div>
    </div>
  );
}
