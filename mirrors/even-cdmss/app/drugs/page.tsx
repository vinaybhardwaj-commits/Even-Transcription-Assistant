import HelpCard from '@/components/HelpCard';
import DrugsClient from './drugs-client';

export const metadata = { title: 'Drugs' };

export default function DrugsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Drug Dosing & Interactions</h1>
      <p className="mt-1 text-sm text-slate-500">
        Look up a single drug, or check interactions among up to 5 drugs. Grounded in MKSAP, StatPearls, and UpToDate.
      </p>
            <HelpCard
        storageKey="drugs"
        title='Drug lookup and interaction checker'
        bullets={[
          'Lookup: type generic or brand name (auto-normalized) — get class, dosing, renal/hepatic, contraindications, AEs, monitoring',
          'Interactions: add 2–5 drugs, severity-sorted pair list (red contraindicated, orange major, amber moderate, slate minor)',
          'Severity is grounded in your corpus — once we add a dedicated DDI database, grading sharpens further',
          'Click any [n] citation chip to verify the source',
        ]}
      />
      <div className="mt-6"><DrugsClient /></div>
    </div>
  );
}
