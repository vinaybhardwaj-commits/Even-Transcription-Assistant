import TimiCalculator from '@/components/calculators/TimiCalculator';

export const metadata = { title: 'TIMI · Calculators' };

export default function TimiPage() {
  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-4 text-xs">
        <ol className="flex items-center gap-1.5 text-slate-500">
          <li><a href="/calculators" className="hover:text-brand">Calculators</a></li>
          <li aria-hidden>›</li>
          <li className="font-medium text-slate-700">TIMI</li>
        </ol>
      </nav>
      <TimiCalculator />
    </div>
  );
}
