import Curb65Calculator from '@/components/calculators/Curb65Calculator';

export const metadata = { title: 'CURB-65 · Calculators' };

export default function Curb65Page() {
  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-4 text-xs">
        <ol className="flex items-center gap-1.5 text-slate-500">
          <li><a href="/calculators" className="hover:text-brand">Calculators</a></li>
          <li aria-hidden>›</li>
          <li className="font-medium text-slate-700">CURB-65</li>
        </ol>
      </nav>
      <Curb65Calculator />
    </div>
  );
}
