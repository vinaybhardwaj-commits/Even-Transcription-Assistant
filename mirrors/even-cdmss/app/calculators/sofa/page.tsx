import SofaCalculator from '@/components/calculators/SofaCalculator';

export const metadata = { title: 'SOFA · Calculators' };

export default function SofaPage() {
  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-4 text-xs">
        <ol className="flex items-center gap-1.5 text-slate-500">
          <li><a href="/calculators" className="hover:text-brand">Calculators</a></li>
          <li aria-hidden>›</li>
          <li className="font-medium text-slate-700">SOFA</li>
        </ol>
      </nav>
      <SofaCalculator />
    </div>
  );
}
