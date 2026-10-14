import HelpCard from '@/components/HelpCard';
import PageHeader from '@/components/PageHeader';
import AppropriatenessClient from './appropriateness-client';

export const metadata = { title: 'Right Care' };

export default function AppropriatenessPage() {
  return (
    <div>
      <PageHeader
        eyebrow="Right Care"
        title="Is this the right care, at the right cost?"
        subtitle="Check an order before you place it, map a care pathway, or audit a completed record. Advisory only — it never blocks an order."
      />
      <HelpCard
        storageKey="appropriateness"
        title="About Right Care"
        body="Right Care flags over- and under-use across the care timeline. It matches society 'don't do this' recommendations (Choosing Wisely USA/Canada and India's National Cancer Grid), checks whether each one actually applies to this patient before flagging it, and cites the source for every flag."
        bullets={[
          'Order check — before ordering: is a proposed test or treatment worth it for this patient?',
          'Care pathway — while planning: what are the right next steps, with value flagged along the way?',
          'Record audit — after the episode: upload a discharge summary, OT note, or prescription for a value and completeness review.',
          'It only flags when a recommendation genuinely applies; absence of a flag is not an endorsement. Decision support, never a directive.',
        ]}
      />
      <div className="mt-6"><AppropriatenessClient /></div>
    </div>
  );
}
