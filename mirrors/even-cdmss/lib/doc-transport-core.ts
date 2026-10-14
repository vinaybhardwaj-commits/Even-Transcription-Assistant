/**
 *   node --experimental-strip-types lib/doc-transport-core.ts
 *
 * Document-transport PURE core (multimodal kickoff, 30 Jul 2026).
 *
 * Holds the three defect fixes the PDF-engine measurement surfaced — all engine-independent,
 * each worse than the engine question itself:
 *   §2.1 an unreadable document returned valid-looking EMPTY data (HTTP 200, finish stop,
 *        well-formed JSON, every field empty — reproduced 3/3). Our own prompt enabled it.
 *        The caller-side detector lives here: the prompt is advisory, the model may still
 *        return empties, and the caller cannot lie.
 *   §2.2 empty extracts were cached FOREVER (ccb_doc_extract is ON CONFLICT DO NOTHING).
 *        isEmptyExtract is what putExtract refuses on.
 *   §2.3 content type was guessed from the URL extension and guessed wrong (4 of 25 radiology
 *        "PDFs" are not PDFs). sniffMime reads the magic number instead.
 *
 * No lib/db, no next/*, no LLM imports — loadable under `node --experimental-strip-types`.
 */

// ── §2.3 · byte sniffing ──────────────────────────────────────────────────────────────────────

/** The set the transports accept. Mirrors SUPPORTED_DOC_MIME in gemini-multimodal (no runtime
 *  import: this core stays dependency-free), minus 'image/jpg' which is not a real magic number. */
export const SNIFFABLE_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;
export type SniffedMime = (typeof SNIFFABLE_MIME)[number];

/**
 * Identify a document by its MAGIC NUMBER. Never trusts a URL extension or an unverified
 * content-type header. Returns null when the bytes are not a supported document — the caller
 * must then treat it as unreadable (§2.3), never guess 'application/pdf'.
 */
export function sniffMime(bytes: Uint8Array | null | undefined): SniffedMime | null {
  if (!bytes || bytes.length < 4) return null;
  const b = bytes;
  // %PDF-
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'application/pdf';
  // \x89PNG\r\n\x1a\n
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  // JPEG SOI + marker
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  // RIFF....WEBP
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

export const isPdfMime = (m: string): boolean => m === 'application/pdf';

// ── §2.1/§2.2 · the empty-extract detector ────────────────────────────────────────────────────

/**
 * Is this CCB extract devoid of clinical content? TRUE means the read FAILED, whatever the
 * transport reported — the measured failure was a valid object with every field empty, which is
 * indistinguishable from an unremarkable report to any downstream reader.
 *
 * `kind` alone is never content: parseExtractedReport stamps it from the caller's own argument,
 * so an all-empty extract still carries it.
 */
export function isEmptyExtract(e: unknown): boolean {
  if (!e || typeof e !== 'object') return true;
  const o = e as { studyOrPanel?: unknown; impression?: unknown; keyFindings?: unknown; abnormalValues?: unknown };
  const str = (v: unknown) => typeof v === 'string' && v.trim() !== '';
  const arr = (v: unknown) => Array.isArray(v) && v.some((x) => String(x ?? '').trim() !== '');
  return !str(o.studyOrPanel) && !str(o.impression) && !arr(o.keyFindings) && !arr(o.abnormalValues);
}

/** Did the model use the explicit unreadable marker (§2.1)? Tolerant of shape: the marker may
 *  arrive as a boolean or a string, at the top level of the parsed JSON. */
export function saysUnreadable(parsedJson: unknown): boolean {
  if (!parsedJson || typeof parsedJson !== 'object') return false;
  const v = (parsedJson as { unreadable?: unknown }).unreadable;
  return v === true || (typeof v === 'string' && /^(true|yes|1)$/i.test(v.trim()));
}

// ── §3 · the OpenRouter document request ──────────────────────────────────────────────────────

/** The engine is SETTLED: native, pinned explicitly, every caller, every class (kickoff §1).
 *  Never the documented default — it falls through to mistral-ocr, a third vendor receiving
 *  patient documents on a call that still returns success. */
export const PDF_ENGINE = 'native' as const;

/** Google-operated providers only, no fallbacks (same pin as the chat bridge). */
export const DOC_PROVIDER_PIN = { allow_fallbacks: false, only: ['google-vertex', 'google-ai-studio'] } as const;

/** Wall-clock bound for one document read. The Vertex transport had NO AbortSignal at all, which
 *  is why Record audit HUNG rather than failed (measured 30 Jul: >399s at "Reading document",
 *  no trace, no fallback). 180s sits far inside the 800s route box while clearing the slowest
 *  observed read (21s) with a large margin. */
export const DOC_READ_TIMEOUT_MS = 180_000;

export interface DocRequestInput {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  base64: string;
  mime: string;
  maxOutputTokens?: number;
  temperature?: number;
  filename?: string;
}

/**
 * Build the OpenRouter /chat/completions body for one document.
 * PDFs ride `type: 'file'` with the file-parser plugin pinned to native; images ride
 * `type: 'image_url'` with a data URL. Images are UNEXERCISED by production traffic
 * (0 of 1,659 Record-audit reads over 30 days were images) — built because the UI offers
 * PNG/JPEG, and flagged as untested by real traffic.
 */
export function buildDocRequestBody(i: DocRequestInput): Record<string, unknown> {
  const dataUrl = `data:${i.mime};base64,${i.base64}`;
  const content: Record<string, unknown>[] = [{ type: 'text', text: i.userPrompt }];
  if (isPdfMime(i.mime)) {
    content.push({ type: 'file', file: { filename: i.filename || 'doc.pdf', file_data: dataUrl } });
  } else {
    content.push({ type: 'image_url', image_url: { url: dataUrl } });
  }
  return {
    model: i.model,
    messages: [
      { role: 'system', content: i.systemPrompt },
      { role: 'user', content },
    ],
    temperature: i.temperature ?? 0.1,
    // Pro spends output budget on reasoning FIRST — same headroom rule as the chat bridge.
    max_tokens: (i.maxOutputTokens ?? 8192) + 8192,
    // Plugin only applies to PDFs; harmless but omitted for images to keep the body honest.
    ...(isPdfMime(i.mime) ? { plugins: [{ id: 'file-parser', pdf: { engine: PDF_ENGINE } }] } : {}),
    provider: DOC_PROVIDER_PIN,
  };
}
