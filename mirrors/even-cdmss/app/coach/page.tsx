import HelpCard from '@/components/HelpCard';
import CoachClient from './coach-client';

export const metadata = { title: 'Coach' };

export default function CoachPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Clinical Reasoning Coach</h1>
      <p className="mt-1 text-sm text-slate-500">
        Socratic multi-turn teaching from the Even Hospital Database. The coach never gives the answer — it probes your reasoning. Difficulty adapts as you go.
      </p>
      <HelpCard
        storageKey="coach"
        title="About this Socratic teaching tool"
        body="Even Coach runs a multi-turn Socratic dialogue grounded in the same curated database that powers /ask and /ddx. You pick a topic or paste a case, then trade questions back and forth — the coach evaluates each of your replies, adapts difficulty in real time, and produces an end-of-session summary with concepts mastered, gaps, and a suggested next topic. The end summary is audited by a second model before you see it. Per-turn latency 8 – 25 s; full session typically 5 – 15 turns."
        bullets={[
          'Pick a Topic (free text or chip) or paste a Case vignette — start at novice / intermediate / advanced',
          'The coach NEVER tells you the answer — it probes with questions, evaluates each reply, and adapts difficulty',
          '✓ Correct / ~ Partial / ✗ Off-track shows under each of your messages with a one-line rationale',
          "Session ends automatically when the coach decides you've mastered the topic, or you tap End for a summary",
        ]}
      />
      <div className="mt-6"><CoachClient /></div>
    </div>
  );
}
