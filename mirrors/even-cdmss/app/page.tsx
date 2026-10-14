import Link from 'next/link';
import {
  MessagesSquare, Network, Pill, Calculator, ClipboardCheck, ClipboardList,
  BookOpen, GraduationCap, ArrowRight, PhoneCall, Database, Link2, RefreshCw, ShieldCheck, FlaskConical,
} from 'lucide-react';
import { sql } from '@/lib/db';

export const metadata = { title: 'Home' };
// Live-ish platform numbers, ISR-cached so the landing page stays fast.
export const revalidate = 1800;

const run = sql as unknown as (t: string, p?: unknown[]) => Promise<Record<string, unknown>[]>;

async function getMetrics(): Promise<{ passages: number; audited: number }> {
  try {
    const [passages, audited] = await Promise.all([
      run(`SELECT reltuples::bigint AS n FROM pg_class WHERE relname = 'mksap_chunks' AND relkind = 'r'`, [])
        .then((r) => Number(r[0]?.n) || 0).catch(() => 0),
      run(`SELECT count(*)::int AS n FROM opd_note_audits`, [])
        .then((r) => Number(r[0]?.n) || 0).catch(() => 0),
    ]);
    return { passages, audited };
  } catch {
    // DATABASE_URL absent at build, or client construction failed — fall back to static.
    return { passages: 0, audited: 0 };
  }
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(n);
}

const CLINICIAN = [
  { href: '/ddx', label: 'Differential', desc: 'Structured presentation → cited differential, cannot-miss first.', Icon: Network },
  { href: '/drugs', label: 'Drugs', desc: 'Dosing, renal/hepatic adjustment, and interaction checks.', Icon: Pill },
  { href: '/calculators', label: 'Calculators', desc: '15 bedside scores — NEWS2, CURB-65, HEART, eGFR, and more.', Icon: Calculator },
  { href: '/appropriateness', label: 'Right Care', desc: 'Order check, care pathway, or record audit — right care at the right cost.', Icon: ClipboardCheck },
  { href: '/audit', label: 'Medication Audit', desc: 'Pharmacist chart review — allergy and drug-interaction cross-check.', Icon: ClipboardList },
];

const CONCORDANCE_CARD = { href: '/concordance', label: 'Concordance', desc: 'Does this lab result make sense for this patient? An adaptive check before release.', Icon: FlaskConical };

const REFERENCE = [
  { href: '/knowledge', label: 'Knowledge base', desc: 'Search the corpus or browse by source.', Icon: BookOpen },
  { href: '/learn', label: 'Learn', desc: 'Coaching, practice questions, topic guides, and review.', Icon: GraduationCap },
];

function Chip({ Icon, children }: { Icon: typeof Database; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-faint px-3 py-1 text-[12px] text-brand">
      <Icon className="h-3.5 w-3.5" /> {children}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">{children}</div>;
}

export default async function Home() {
  const { passages, audited } = await getMetrics();
  const clinicianCards = process.env.CONCORDANCE_ENABLED === '1' ? [...CLINICIAN, CONCORDANCE_CARD] : CLINICIAN;

  return (
    <div>
      {/* Hero — identity + proof + flagship */}
      <div className="mb-5">
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-400">Even · EHRC clinical intelligence</div>
        <h1 className="max-w-3xl font-serif text-[30px] font-semibold leading-tight text-slate-900 sm:text-[36px]">
          From the consult to the care conversation, grounded in evidence.
        </h1>
        <p className="mt-2.5 max-w-2xl text-[15px] leading-relaxed text-slate-500">
          Decision support for clinicians, grounded briefs for care managers, and a continuously self-auditing quality layer — every recommendation cited to a curated medical evidence base. Advisory only; it never replaces clinical judgment.
        </p>
      </div>

      <div className="mb-7 flex flex-wrap gap-2">
        <Chip Icon={Database}><span className="font-medium">{fmtCompact(passages || 2_230_000)}</span>&nbsp;evidence passages</Chip>
        <Chip Icon={Link2}>Cited behind every claim</Chip>
        <Chip Icon={RefreshCw}>{audited > 0 ? <><span className="font-medium">{audited.toLocaleString('en-IN')}</span>&nbsp;OPD notes audited</> : 'Audited nightly'}</Chip>
        <Chip Icon={ShieldCheck}>Tokyo-resident · under BAA</Chip>
      </div>

      {/* Primary action: Ask */}
      <Link
        href="/ask"
        className="group mb-9 flex items-center gap-3 rounded-2xl border-2 border-brand bg-paper px-5 py-4 transition hover:bg-brand-faint"
      >
        <MessagesSquare className="h-6 w-6 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium text-slate-900">Ask a clinical question</div>
          <div className="truncate text-[13px] text-slate-500">Grounded, cited answers — phrase it like a real consult</div>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-[13.5px] font-medium text-white transition group-hover:bg-brand-dark">
          Ask <ArrowRight className="h-4 w-4" />
        </span>
      </Link>

      {/* For clinicians */}
      <SectionLabel>For clinicians</SectionLabel>
      <div className="mb-9 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {clinicianCards.map(({ href, label, desc, Icon }) => (
          <Link
            key={href}
            href={href}
            className="group flex flex-col rounded-xl border border-slate-200 bg-paper p-4 shadow-card transition hover:-translate-y-0.5 hover:border-brand"
          >
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-faint text-brand">
              <Icon className="h-5 w-5" />
            </span>
            <span className="text-[14.5px] font-medium text-slate-900 group-hover:text-brand">{label}</span>
            <span className="mt-1 text-[12.5px] leading-relaxed text-slate-500">{desc}</span>
          </Link>
        ))}
      </div>

      {/* Care management — the new capability, highlighted */}
      <SectionLabel>Care management · after the visit</SectionLabel>
      <Link
        href="/care"
        className="group mb-9 flex items-center gap-4 rounded-xl border-2 border-brand bg-paper p-4 shadow-card transition hover:bg-brand-faint"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-brand-faint text-brand">
          <PhoneCall className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-medium text-slate-900 group-hover:text-brand">Care Conversation Brief</span>
            <span className="rounded-full bg-brand-faint px-2 py-0.5 text-[10.5px] font-medium text-brand">New</span>
          </div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-slate-500">
            Grounded, cited talking points from a member’s same-day results — surface the right specialist follow-up for the post-visit call.
          </div>
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-slate-400 group-hover:text-brand" />
      </Link>

      {/* Reference & learning */}
      <SectionLabel>Reference &amp; learning</SectionLabel>
      <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {REFERENCE.map(({ href, label, desc, Icon }) => (
          <Link
            key={href}
            href={href}
            className="group flex items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-transparent p-4 transition hover:border-brand hover:bg-paper"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 group-hover:bg-brand-faint group-hover:text-brand">
              <Icon className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-medium text-slate-800 group-hover:text-brand">{label}</span>
              <span className="block truncate text-[12px] text-slate-500">{desc}</span>
            </span>
          </Link>
        ))}
      </div>

      <div className="border-t border-slate-200 pt-4 text-[11.5px] leading-relaxed text-slate-400">
        Advisory clinical decision support · every claim cited to evidence · PHI handled in-region under BAA · not a substitute for clinical judgment.
      </div>
    </div>
  );
}
