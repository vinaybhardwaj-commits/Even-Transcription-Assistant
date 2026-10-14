import SepsisBundleCalculator from '@/components/calculators/SepsisBundleCalculator';

export const metadata = { title: 'Sepsis 1-h bundle · Calculators' };

export default function SepsisBundlePage() {
  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-4 text-xs">
        <ol className="flex items-center gap-1.5 text-slate-500">
          <li><a href="/calculators" className="hover:text-brand">Calculators</a></li>
          <li aria-hidden>›</li>
          <li className="font-medium text-slate-700">Sepsis 1-h bundle</li>
        </ol>
      </nav>
      <SepsisBundleCalculator />
    </div>
  );
}
