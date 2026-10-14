'use client';
import { useState } from 'react';

// PRD §9.5 — "Escalate to Gemini". A quiet whole-note action. The portable package (de-identified
// note text + CDMSS findings + domain scores + engine_version + a fixed re-audit prompt) is
// pre-built server-side and handed in as `pkg`. This does Copy + Download <uid>-escalation.md —
// no network call, no structured import (the consumer is the CM's own Gemini, then Claude + this repo).

// F4 (OPD Feedback Loop MCP PRD §4.4): after a successful Copy/Download, log an escalation EVENT so
// it becomes visible to the feedback pull tools (feedback_detail scope=audit / feedback_rollup
// n_escalations). This exact marker is the read-side key — keep it in sync with ESCALATION_MARKER in
// lib/opd-feedback-rollup-core.ts.
const ESCALATION_MARKER = '[escalation package generated]';

// The escalate button only renders on /admin/opd-audit/[id], so the route param IS the audit id.
function currentAuditId(): string | null {
  try {
    const m = window.location.pathname.match(/\/admin\/opd-audit\/([0-9a-fA-F-]{36})(?:$|[/?#])/);
    return m ? m[1] : null;
  } catch { return null; }
}

// Fire-and-forget, cookie-authed (same as the triage strips). Any failure is swallowed — the export
// must never be blocked or show an error because of the log. No dedup (append-only; repeat escalations
// are informative). author = the ReviewerBar identity if the reviewer has set one, else omitted.
function logEscalation(uid: string) {
  const auditId = currentAuditId();
  if (!auditId) return;
  const body: Record<string, unknown> = { auditId, scope: 'audit', uid, comment: ESCALATION_MARKER };
  try { const a = (window.localStorage.getItem('opd-reviewer') || '').trim(); if (a) body.author = a; } catch { /* ignore */ }
  void fetch('/api/opd-audit/feedback', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => { /* silent by design */ });
}

export function EscalateButton({ pkg, uid }: { pkg: string; uid: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(pkg);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
      logEscalation(uid);
    } catch { /* clipboard blocked — download still works */ }
  }

  function download() {
    const blob = new Blob([pkg], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${uid || 'note'}-escalation.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    logEscalation(uid);
  }

  return (
    <div className="flex items-center gap-1.5">
      <button type="button" onClick={copy} title="Copy the de-identified note + audit + re-audit prompt for your own Gemini"
        className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10.5px] font-medium text-slate-500 hover:border-brand/40 hover:text-brand">
        {copied ? 'Copied' : 'Escalate to Gemini · copy'}
      </button>
      <button type="button" onClick={download} title="Download <uid>-escalation.md"
        className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10.5px] font-medium text-slate-500 hover:border-brand/40 hover:text-brand">
        ↓ .md
      </button>
    </div>
  );
}
