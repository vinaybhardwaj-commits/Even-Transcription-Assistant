/**
 * /buglog — internal, auth-gated view of the ETA bug log.
 *
 * SOURCE OF TRUTH: content/ETA-BUG-LOG.md, committed in this repo. Editing that
 * file and pushing republishes this page — there is NO separate sync step. The
 * file is traced into this route via next.config `outputFileTracingIncludes`.
 *
 * Access: requires a valid ADMIN session (cookie `eta_admin_session`, Path=/, so
 * it reaches this route). Doctor cookies are slug-scoped and intentionally do NOT
 * grant access. Unauthenticated visitors get a sign-in notice and NONE of the
 * content — the log documents still-unpatched security issues.
 */
import type { Metadata } from "next";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { renderMarkdown } from "@/lib/markdown-min";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata: Metadata = {
  title: "Evenscribe — Bug Log",
  robots: { index: false, follow: false },
};

const BUGLOG_PATH = join(process.cwd(), "content", "ETA-BUG-LOG.md");

function loadBuglog(): { md: string; updated: string } {
  try {
    const md = readFileSync(BUGLOG_PATH, "utf8");
    let updated = "";
    try { updated = statSync(BUGLOG_PATH).mtime.toUTCString(); } catch { /* mtime optional */ }
    return { md, updated };
  } catch {
    return { md: "# Bug log unavailable\n\nThe bug log file could not be read on the server.", updated: "" };
  }
}

const CSS = `
.buglog-wrap { max-width: 860px; margin: 0 auto; padding: 32px 20px 96px; color: #1a1a1a;
  font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.buglog-bar { display:flex; align-items:baseline; justify-content:space-between; gap:12px;
  border-bottom:1px solid #e5e7eb; padding-bottom:12px; margin-bottom:24px; flex-wrap:wrap; }
.buglog-bar h1 { font-size:20px; margin:0; font-weight:700; }
.buglog-bar .meta { color:#6b7280; font-size:12px; }
.buglog-doc h1 { font-size:24px; margin:28px 0 10px; }
.buglog-doc h2 { font-size:19px; margin:26px 0 8px; padding-top:10px; border-top:1px solid #f0f0f0; }
.buglog-doc h3 { font-size:16px; margin:20px 0 6px; }
.buglog-doc h4 { font-size:14px; margin:16px 0 6px; color:#374151; }
.buglog-doc p { margin:10px 0; }
.buglog-doc ul, .buglog-doc ol { margin:10px 0; padding-left:24px; }
.buglog-doc li { margin:4px 0; }
.buglog-doc code { background:#f3f4f6; border-radius:4px; padding:1px 5px; font-size:0.86em;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break:break-word; }
.buglog-doc pre { background:#0f172a; color:#e2e8f0; border-radius:8px; padding:14px 16px; overflow:auto; margin:12px 0; }
.buglog-doc pre code { background:none; color:inherit; padding:0; font-size:13px; }
.buglog-doc blockquote { border-left:3px solid #cbd5e1; margin:12px 0; padding:6px 14px; color:#475569; background:#f8fafc; border-radius:0 6px 6px 0; }
.buglog-doc hr { border:none; border-top:1px solid #e5e7eb; margin:28px 0; }
.buglog-doc a { color:#2563eb; }
.buglog-gate { max-width:520px; margin:14vh auto; text-align:center; padding:0 20px;
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color:#1a1a1a; }
.buglog-gate h1 { font-size:22px; margin-bottom:10px; }
.buglog-gate p { color:#6b7280; }
`;

export default async function BugLogPage() {
  const cookie = await readAdminCookie();
  let authed = false;
  if (cookie) {
    try { await verifyAdminJwt(cookie); authed = true; } catch { authed = false; }
  }

  if (!authed) {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="buglog-gate">
          <h1>Evenscribe Bug Log</h1>
          <p>This page is internal. Sign in to the Even admin panel, then return to <code>/buglog</code>.</p>
        </div>
      </>
    );
  }

  const { md, updated } = loadBuglog();
  const html = renderMarkdown(md);
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="buglog-wrap">
        <div className="buglog-bar">
          <h1>Evenscribe — Bug Log</h1>
          {updated ? <span className="meta">as of last deploy · {updated}</span> : null}
        </div>
        <article className="buglog-doc" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </>
  );
}
