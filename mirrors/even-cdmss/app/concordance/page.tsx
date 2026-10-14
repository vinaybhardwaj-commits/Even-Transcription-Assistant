import HelpCard from '@/components/HelpCard';
import PageHeader from '@/components/PageHeader';
import ConcordanceClient from './concordance-client';

export const metadata = { title: 'Concordance' };

export default function ConcordancePage() {
  return (
    <div>
      <PageHeader
        eyebrow="Concordance"
        title="Does this result make sense for this patient?"
        subtitle="Before a lab result is released, an adaptive check reasons through whether it is a lab error or a real, unevaluated finding. Advisory only — it never releases or blocks a result."
      />
      <HelpCard
        storageKey="concordance"
        title="About Concordance"
        body="The lab's own QC already checks ranges, indices, and delta rules. Concordance does the clinical reasoning the instrument can't: given the patient in front of you, is this result concordant, or does it need a second look? It separates two very different causes and never lets one mask the other."
        bullets={[
          'Branch A — the result may be wrong (a pre-analytic or analytic error): verify or repeat before acting.',
          'Branch B — the result may be right and reveal something unevaluated: pursue the next step.',
          'A short adaptive interview asks only the questions that change the answer; "I don\'t have this" is always a valid answer and never stalls the check.',
          'Every check is a fresh start — no history, no prior-result lookup. Advisory only; the clinician decides.',
        ]}
      />
      <div className="mt-6"><ConcordanceClient /></div>
    </div>
  );
}
