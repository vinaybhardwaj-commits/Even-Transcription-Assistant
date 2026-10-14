import Abcd2Calculator from '@/components/calculators/Abcd2Calculator';

export const metadata = { title: 'ABCD² · Calculators' };

export default function Abcd2Page() {
  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-4 text-xs">
        <ol className="flex items-center gap-1.5 text-slate-500">
          <li><a href="/calculators" className="hover:text-brand">Calculators</a></li>
          <li aria-hidden>›</li>
          <li className="font-medium text-slate-700">ABCD²</li>
        </ol>
      </nav>
      <Abcd2Calculator />
    </div>
  );
}
