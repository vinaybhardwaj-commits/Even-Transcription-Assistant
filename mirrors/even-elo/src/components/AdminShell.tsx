import Link from "next/link";
import { TopNav } from "./TopNav";

interface BreadcrumbCrumb {
  label: string;
  href?: string;
}

interface AdminShellProps {
  breadcrumbs: BreadcrumbCrumb[];
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Admin pages: top nav + breadcrumb header + title + optional actions slot.
 * Locked from EVEN-ELO-MOCKUPS.html admin styling — do not change without
 * updating the mockup first (PRD §3.1 / D35).
 */
export function AdminShell({
  breadcrumbs,
  title,
  subtitle,
  actions,
  children,
}: AdminShellProps) {
  return (
    <>
      <TopNav />
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <div className="flex items-end justify-between mb-6">
          <div>
            <div className="flex items-center gap-2 text-xs text-stone-500 mb-2">
              {breadcrumbs.map((c, i) => (
                <span key={i} className="flex items-center gap-2">
                  {c.href ? (
                    <Link href={c.href} className="hover:text-stone-900">
                      {c.label}
                    </Link>
                  ) : (
                    <span
                      className={i === breadcrumbs.length - 1 ? "text-stone-900 font-medium" : ""}
                    >
                      {c.label}
                    </span>
                  )}
                  {i < breadcrumbs.length - 1 && <span>/</span>}
                </span>
              ))}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {subtitle && <p className="text-sm text-stone-500 mt-1">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
        {children}
      </main>
    </>
  );
}
