import { NextRequest, NextResponse } from 'next/server';
import { extractCase, extractMemberIdentity } from '@/lib/doc-audit';
import { normDocType, type DocType } from '@/lib/doc-audit-core';
import { SUPPORTED_DOC_MIME } from '@/lib/gemini-multimodal';
import { sniffMime } from '@/lib/doc-transport-core';
import { recordAuditLinkEnabled, type MemberLink } from '@/lib/record-audit-link-store';

export const runtime = 'nodejs';
export const maxDuration = 800;

// Hard cap on the inline document (base64 chars). ~9 MB raw ≈ 12M base64 chars.
const MAX_B64 = 12_000_000;

// POST /api/doc-audit/extract — Gemini multimodal reads the uploaded document.
// Body: { base64, mime, docTypeHint?: 'discharge_summary'|'ot_note'|'opd_rx'|'auto', context? }
// PHI: processed in-memory; nothing persisted; trace is redacted.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  let base64 = typeof body.base64 === 'string' ? body.base64 : '';
  // Tolerate a data: URL prefix.
  const comma = base64.indexOf(',');
  if (base64.startsWith('data:') && comma > 0) base64 = base64.slice(comma + 1);
  base64 = base64.trim();
  if (!base64) return NextResponse.json({ ok: false, error: 'no document provided' }, { status: 400 });
  if (base64.length > MAX_B64) {
    return NextResponse.json({ ok: false, error: 'document too large (max ~9 MB)' }, { status: 413 });
  }

  // §2.3 (30 Jul) — the client-declared mime is a HINT; the bytes decide. A body whose magic
  // number is not a supported document is rejected here rather than being sent to the model
  // mislabelled (4 of 25 sampled radiology "PDFs" were not PDFs at all on the CCB side).
  const declaredMime = typeof body.mime === 'string' ? body.mime.trim().toLowerCase() : '';
  let sniffed: string | null = null;
  try { sniffed = sniffMime(Buffer.from(base64.slice(0, 64), 'base64')); } catch { sniffed = null; }
  const mime = sniffed || '';
  if (!mime || !SUPPORTED_DOC_MIME.has(mime)) {
    return NextResponse.json({ ok: false, error: 'unsupported file type — upload a PDF, PNG, or JPEG' }, { status: 415 });
  }
  if (declaredMime && declaredMime !== mime && !(declaredMime === 'image/jpg' && mime === 'image/jpeg')) {
    console.warn(`[doc-audit] declared mime ${declaredMime} != sniffed ${mime} — using sniffed`);
  }

  const hintRaw = typeof body.docTypeHint === 'string' ? body.docTypeHint.trim().toLowerCase() : 'auto';
  const docTypeHint: DocType | 'auto' = hintRaw === 'auto' || hintRaw === '' ? 'auto' : normDocType(hintRaw);
  const context = typeof body.context === 'string' ? body.context.slice(0, 1000) : undefined;
  const bytes = Math.floor((base64.length * 3) / 4);

  try {
    // Right Care × ClinicalState Slice 1, Part C — member linkage. The identity-only pass runs
    // IN PARALLEL with the de-identified content read, only when BOTH flags are on
    // (RIGHT_CARE_CLINICAL_STATE + RECORD_AUDIT_LINK). Its sole output is the linkage key
    // {uhid?, mrn?, name?, dob?}, returned as a SEPARATE response field the client forwards to
    // save-run — it never enters ExtractedCase, and it is never traced. Soft-fails to null.
    const [{ extracted, traceId }, memberLink] = await Promise.all([
      extractCase({ base64, mime, docTypeHint, context, bytes }),
      recordAuditLinkEnabled()
        ? extractMemberIdentity({ base64, mime })
        : Promise.resolve<MemberLink | null>(null),
    ]);
    if (!extracted) {
      return NextResponse.json({ ok: false, error: 'could not read the document — try a clearer scan or a different file', traceId }, { status: 200 });
    }
    return NextResponse.json({ ok: true, extracted, traceId, ...(memberLink ? { memberLink } : {}) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
