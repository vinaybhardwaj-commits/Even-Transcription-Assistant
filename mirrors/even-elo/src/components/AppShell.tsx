import { TopNav } from "./TopNav";

/**
 * AppShell — wraps user-facing pages with the top nav.
 * For admin pages, use AdminShell instead (it also includes a breadcrumb header).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopNav />
      {children}
    </>
  );
}
