import HelpCard from '@/components/HelpCard';
import PageHeader from '@/components/PageHeader';
import AskClient from './ask-client';

export const metadata = { title: 'Ask' };

export default function AskPage() {
  return (
    <div>
      <PageHeader
        title="Ask"
        subtitle="Free-form clinical questions, answered from the evidence base with a verifiable inline citation behind every claim."
      />
      <HelpCard
        storageKey="ask"
        title="About this clinical decision-support tool"
        body="Even CDMSS is a clinical decision-support system: it takes your clinical question, searches a curated database of textbooks, references, and primary research, and returns a synthesized answer with verifiable citations to every claim. The value over a quick web search is that the answer is grounded in evidence we control, and a second model audits the draft for unsupported claims, missing caveats, and clinical errors before you see it. The limits to know: it does not replace clinical judgment, and citations should still be verified for high-stakes decisions."
        bullets={[
          "Phrase questions as you would a real consult — 'first-line for HFrEF NYHA III' works better than 'heart failure drugs'",
          'Voice input is supported on Chrome and Safari — tap the mic, speak, the text streams in',
          'Inline citations [n] are clickable — tap to scroll to the source chunk and see the supporting text',
          'Every query is logged automatically — no separate save step. Click \'View trace ↗\' on any answer to see exactly what the system did.',
          'Answers take 3-5 minutes because the system runs a multi-stage retrieval + audit pipeline. The live tracker below shows what is happening at each step.',
        ]}
      />
      <div className="mt-6"><AskClient /></div>
    </div>
  );
}
