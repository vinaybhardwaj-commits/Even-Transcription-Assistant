// Phase 4 (N.1) — Resend integration core.
// Calls the Resend REST API directly via fetch (no new npm dependency).
// Gated by EMAIL_SENDING_ENABLED so nothing is sent until the evenos.app domain
// is verified in Resend AND the flag is flipped on in Vercel. Until then, sends
// are logged to the Vercel runtime (same observability as the old epi_email_stub).

const RESEND_API = "https://api.resend.com/emails";
const FROM = process.env.EMAIL_FROM || "Even Hospital <notifications@evenos.app>";

export interface EmailOpts {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

export function emailEnabled(): boolean {
  return process.env.EMAIL_SENDING_ENABLED === "true" && !!process.env.RESEND_API_KEY;
}

/** Minimal branded HTML shell for transactional emails. */
export function wrapHtml(heading: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#f5f5f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917;">
  <div style="max-width:520px;margin:0 auto;padding:24px;">
    <div style="font-weight:700;font-size:14px;color:#0f766e;margin-bottom:16px;">Even Physician Index</div>
    <div style="background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;padding:24px;">
      <h1 style="font-size:18px;margin:0 0 12px;">${heading}</h1>
      <div style="font-size:14px;line-height:1.6;color:#44403c;">${bodyHtml}</div>
    </div>
    <div style="font-size:11px;color:#a8a29e;margin-top:16px;">Even Hospital System · This is an automated message.</div>
  </div>
</body></html>`;
}

export async function sendEmail(opts: EmailOpts): Promise<{ ok: boolean; id?: string; error?: string; skipped?: boolean }> {
  const key = process.env.RESEND_API_KEY;
  if (!emailEnabled()) {
    console.log(JSON.stringify({ epi_email: "skipped_sending_disabled", to: opts.to, subject: opts.subject }));
    return { ok: true, skipped: true };
  }
  try {
    const r = await fetch(RESEND_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: FROM, to: Array.isArray(opts.to) ? opts.to : [opts.to], subject: opts.subject, html: opts.html, text: opts.text }),
    });
    const j = (await r.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!r.ok) { console.error(JSON.stringify({ epi_email: "send_failed", status: r.status, error: j?.message })); return { ok: false, error: j?.message || `HTTP ${r.status}` }; }
    return { ok: true, id: j?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
