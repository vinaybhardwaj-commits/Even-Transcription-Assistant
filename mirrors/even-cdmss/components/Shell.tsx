'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import {
  MessagesSquare, Network, Pill, Calculator, ClipboardCheck,
  ClipboardList, BookOpen, GraduationCap, Settings, Menu, X, ChevronLeft, Activity, Lightbulb, BarChart3,
  PhoneCall, Filter, HardDrive, FlaskConical, Map, FileText, Radar, SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';

type NavItem = {
  href: string;
  label: string;
  Icon: LucideIcon;
  match?: string[]; // extra path prefixes that should mark this item active
};
type NavGroup = { heading?: string; items: NavItem[] };

// ── Clarity IA: ~7 surfaces, grouped. Decision-support first; the merged
//    Knowledge base (Search + Browse) and Learn hub (Coach/Practice/Review/
//    Topics) are demoted into a quiet "Reference & learning" group.
const CLINICIAN: NavGroup[] = [
  {
    heading: 'Decision support',
    items: [
      { href: '/ask', label: 'Ask', Icon: MessagesSquare },
      { href: '/ddx', label: 'Differential', Icon: Network },
      { href: '/drugs', label: 'Drugs', Icon: Pill },
      { href: '/calculators', label: 'Calculators', Icon: Calculator },
      { href: '/appropriateness', label: 'Right Care', Icon: ClipboardCheck },
    ],
  },
  {
    heading: 'Audit',
    items: [
      { href: '/audit', label: 'Medication Audit', Icon: ClipboardList },
    ],
  },
  {
    heading: 'Care management',
    items: [
      { href: '/care', label: 'Managed Care', Icon: PhoneCall },
    ],
  },
  {
    heading: 'Reference & learning',
    items: [
      { href: '/knowledge', label: 'Knowledge base', Icon: BookOpen, match: ['/search', '/browse'] },
      { href: '/learn', label: 'Learn', Icon: GraduationCap, match: ['/coach', '/practice', '/review', '/topics'] },
    ],
  },
];

const ADMIN: NavGroup[] = [
  {
    heading: 'Admin',
    items: [
      { href: '/admin/observability', label: 'Observability', Icon: Network, match: ['/admin/appropriateness-runs'] },
      { href: '/admin/opd-audit', label: 'OPD Audit', Icon: Activity, match: ['/admin/opd-audit/doctors', '/admin/opd-audit/doctor'] },
      { href: '/admin/ipd-audit', label: 'IPD Discharge Audit', Icon: FileText, match: ['/admin/ipd-audit/search', '/admin/ipd-audit/calendar', '/admin/ipd-audit/episodes'] },
      // Scoring policy sits immediately after IPD Discharge Audit (PRD §5.1) — it governs how that
      // audit's completeness is weighted, so it reads as a setting on the thing above it.
      { href: '/admin/scoring-policy', label: 'Scoring policy', Icon: SlidersHorizontal },
      { href: '/admin/stewardship', label: 'Stewardship', Icon: BarChart3 },
      { href: '/admin/ccb-funnel', label: 'Care Brief Funnel', Icon: Filter },
      { href: '/admin/learning', label: 'Learning loop', Icon: Lightbulb },
      { href: '/admin/literature', label: 'Literature', Icon: BookOpen },
    ],
  },
  // Backfill Workers — the two standing history/grounding workers as one group (Phase 2.2).
  {
    heading: 'Backfill Workers',
    items: [
      { href: '/admin/mini-backfill', label: 'Qwen re-score', Icon: HardDrive },
      { href: '/admin/lvc-ground', label: 'Grounding worker', Icon: Radar },
    ],
  },
  // The zoomed-out view of the whole system — its own quiet group at the foot of the
  // admin nav, below the day-to-day tools (System Map nav-placement mockup, 13 Jul 2026).
  {
    heading: 'Platform',
    items: [
      { href: '/admin/architecture', label: 'System Map', Icon: Map },
    ],
  },
];

function isActive(pathname: string, item: NavItem): boolean {
  const all = [item.href, ...(item.match ?? [])];
  return all.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

function NavLinks({ groups, pathname, onNavigate }: { groups: NavGroup[]; pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-5">
      {groups.map((group, gi) => (
        <div key={gi}>
          {group.heading && (
            <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
              {group.heading}
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = isActive(pathname, item);
              const Icon = item.Icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  className={
                    'group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] transition ' +
                    (active
                      ? 'bg-brand-faint font-medium text-brand'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')
                  }
                >
                  <Icon className={'h-[17px] w-[17px] shrink-0 ' + (active ? 'text-brand' : 'text-slate-400 group-hover:text-slate-600')} />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-1">
      <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-brand text-[15px] font-semibold text-white">C</span>
      <span className="flex flex-col leading-tight">
        <span className="font-serif text-[17px] font-semibold text-navy">CAT</span>
        <span className="text-[10.5px] text-slate-500">Clinical Analysis Tool</span>
      </span>
    </Link>
  );
}

// Concordance nav is injected at render from the SERVER runtime flag (passed as a prop),
// not a build-time NEXT_PUBLIC var — so it appears the moment CONCORDANCE_ENABLED is set,
// with no rebuild needed.
function injectConcordance(groups: NavGroup[]): NavGroup[] {
  return groups.map((g) =>
    g.heading === 'Decision support'
      ? { ...g, items: [...g.items, { href: '/concordance', label: 'Concordance', Icon: FlaskConical }] }
      : g.heading === 'Admin'
        ? { ...g, items: [...g.items, { href: '/admin/concordance', label: 'Concordance registry', Icon: FlaskConical }] }
        : g,
  );
}

/**
 * True for the CCB split-screen brief route `/care/<presc_uid>` — and ONLY that route. Every named
 * /care child (briefs, login, review, triage, m/<uid>, …) keeps the normal shell. Kept next to
 * `fullBleed` so the two stay in step.
 */
const CARE_NAMED_CHILDREN = new Set(['briefs', 'login', 'review', 'triage', 'm']);
function isCareBriefRoute(pathname: string): boolean {
  const seg = pathname.match(/^\/care\/([^/]+)\/?$/)?.[1];
  return !!seg && !CARE_NAMED_CHILDREN.has(seg);
}

/** The IPD audit REPORT route `/admin/ipd-audit/<id>` — and only it — joins the full-bleed set
 *  (PDF beside findings needs the width). The named children (search, calendar) keep the shell. */
// 'episodes' joins the named children with the IPD Episode Audit (2 Sep 2026): the episode LIST
// is a normal shelled page, so it must not be mistaken for `/admin/ipd-audit/<id>` and given the
// report route's full-bleed treatment. The episode DETAIL page is two segments deep and never
// matched this predicate at all.
const IPD_NAMED_CHILDREN = new Set(['search', 'calendar', 'episodes']);
function isIpdAuditReportRoute(pathname: string): boolean {
  const seg = pathname.match(/^\/admin\/ipd-audit\/([^/]+)\/?$/)?.[1];
  return !!seg && !IPD_NAMED_CHILDREN.has(seg);
}

export function Shell({ children, concordanceEnabled = false }: { children: React.ReactNode; concordanceEnabled?: boolean }) {
  const pathname = usePathname() || '';
  // Review Mode's 3-pane surface provides its own full-bleed padding — exempt ONLY it from the
  // shell's 1024px content cap (every other route renders pixel-identical). PRD addendum §1.1 patch 2.
  // CCB v2 P2: the split-screen brief at /care/<presc_uid> joins it — document beside findings needs
  // the full width, and the floating ☰ below restores the nav. Named /care children are excluded.
  const fullBleed = pathname === '/care/review' || isCareBriefRoute(pathname) || isIpdAuditReportRoute(pathname);
  const isAdmin = pathname.startsWith('/admin');
  const base = isAdmin ? ADMIN : CLINICIAN;
  const groups = concordanceEnabled ? injectConcordance(base) : base;
  const [drawer, setDrawer] = useState(false);

  // Close the mobile drawer on route change
  useEffect(() => { setDrawer(false); }, [pathname]);

  const SidebarInner = (
    <div className="flex h-full flex-col">
      <div className="px-3 pt-5 pb-4">
        <Brand />
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-4">
        <NavLinks groups={groups} pathname={pathname} onNavigate={() => setDrawer(false)} />
      </div>
      <div className="border-t border-slate-200 px-3 py-3">
        {isAdmin ? (
          <Link href="/ask" className="flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-slate-500 hover:bg-slate-100 hover:text-slate-900">
            <ChevronLeft className="h-4 w-4" /> Clinician app
          </Link>
        ) : (
          <Link href="/admin/observability" className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-slate-500 hover:bg-slate-100 hover:text-slate-900">
            <Settings className="h-[17px] w-[17px] text-slate-400" /> Admin
          </Link>
        )}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen">
      {/* Desktop sidebar — folded away in Review Mode (fullBleed); pixel-identical elsewhere */}
      <aside className={`fixed inset-y-0 left-0 z-30 hidden w-[230px] border-r border-slate-200 bg-paper ${fullBleed ? '' : 'md:block'}`}>
        {SidebarInner}
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-paper/90 px-4 py-3 backdrop-blur md:hidden">
        <Brand />
        <button
          onClick={() => setDrawer(true)}
          aria-label="Open menu"
          className="rounded-lg p-2 text-slate-600 hover:bg-slate-100"
        >
          <Menu className="h-5 w-5" />
        </button>
      </header>

      {/* Review Mode: a quiet floating ☰ (md+ only) reopens the module nav as the existing drawer overlay */}
      {fullBleed && (
        <button
          onClick={() => setDrawer(true)}
          aria-label="Open menu"
          className="fixed left-3 top-3 z-40 hidden rounded-lg border border-slate-200 bg-white/90 p-2 text-slate-600 shadow-sm backdrop-blur hover:bg-white md:block"
        >
          <Menu className="h-5 w-5" />
        </button>
      )}

      {/* Mobile drawer (also usable on md+ ONLY in Review Mode, where md:hidden is dropped) */}
      {drawer && (
        <div className={`fixed inset-0 z-40 ${fullBleed ? '' : 'md:hidden'}`}>
          <div className="absolute inset-0 bg-slate-900/30" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 w-[260px] bg-paper shadow-pop">
            <div className="flex justify-end p-2">
              <button onClick={() => setDrawer(false)} aria-label="Close menu" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100">
                <X className="h-5 w-5" />
              </button>
            </div>
            {SidebarInner}
          </div>
        </div>
      )}

      {/* Content — no sidebar gutter in Review Mode (fullBleed) so the navigator sits at the left edge */}
      <main className={fullBleed ? 'pl-0' : 'md:pl-[230px]'}>
        <div className={fullBleed ? 'cat-page w-full' : 'cat-page mx-auto w-full max-w-5xl px-5 py-7 sm:px-8 sm:py-9'}>
          {children}
        </div>
      </main>
    </div>
  );
}
