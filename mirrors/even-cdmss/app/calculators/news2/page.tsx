import News2Calculator from '@/components/calculators/News2Calculator';

export const metadata = { title: 'NEWS2 · Calculators' };

export default function News2Page() {
  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-4 text-xs">
        <ol className="flex items-center gap-1.5 text-slate-500">
          <li><a href="/calculators" className="hover:text-brand">Calculators</a></li>
          <li aria-hidden>›</li>
          <li className="font-medium text-slate-700">NEWS2</li>
        </ol>
      </nav>
      <News2Calculator />
    </div>
  );
}
