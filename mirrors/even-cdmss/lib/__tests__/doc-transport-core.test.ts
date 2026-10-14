/**
 *   node --test --import tsx lib/__tests__/doc-transport-core.test.ts
 *
 * Multimodal document transport via OpenRouter (30 Jul 2026) + the three defects the PDF-engine
 * measurement surfaced. Engine SETTLED: native, pinned, every caller, every class.
 *
 * The defects, all engine-independent and each worse than the engine question:
 *   §2.1 an unreadable document returned valid-looking EMPTY data (HTTP 200, finish stop,
 *        well-formed JSON, every field empty — reproduced 3/3 on a real scanned report).
 *   §2.2 that empty extract was cached FOREVER (ccb_doc_extract is ON CONFLICT DO NOTHING).
 *   §2.3 content type was guessed from the URL (4 of 25 radiology "PDFs" are not PDFs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sniffMime, isEmptyExtract, saysUnreadable, buildDocRequestBody,
  PDF_ENGINE, DOC_PROVIDER_PIN, DOC_READ_TIMEOUT_MS,
} from '../doc-transport-core.ts';
import { EXTRACT_SYSTEM, parseExtractedReport } from '../ccb-brief-core.ts';

const MM = readFileSync('lib/gemini-multimodal.ts', 'utf8');
const CACHE = readFileSync('lib/ccb-extract-cache.ts', 'utf8');
const BRIEF = readFileSync('lib/ccb-brief.ts', 'utf8');
const EXTRACT_ROUTE = readFileSync('app/api/doc-audit/extract/route.ts', 'utf8');

const b = (...n: number[]) => new Uint8Array(n);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · §2.3 — byte sniffing, never the URL
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2.3: magic numbers identify the document', () => {
  assert.equal(sniffMime(b(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31)), 'application/pdf');
  assert.equal(sniffMime(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a)), 'image/png');
  assert.equal(sniffMime(b(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffMime(b(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50)), 'image/webp');
});

test('§2.3: an unsupported body returns NULL — the old code guessed application/pdf', () => {
  assert.equal(sniffMime(b(0x50, 0x4b, 0x03, 0x04)), null, 'a zip is not a document');
  assert.equal(sniffMime(b(0x3c, 0x68, 0x74, 0x6d, 0x6c)), null, 'an HTML error page is not a document');
  assert.equal(sniffMime(b(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 9, 9, 9, 9)), null, 'RIFF that is not WEBP');
  assert.equal(sniffMime(null), null);
  assert.equal(sniffMime(b(0x25)), null, 'too short to judge');
});

test('§2.3: the URL-extension guess is GONE from ccb-brief; the bytes decide and null ⇒ unreadable', () => {
  assert.ok(!BRIEF.includes("return 'application/pdf';        // GCS report bodies are overwhelmingly PDF"),
    'the fall-through guess is removed');
  assert.ok(BRIEF.includes('const mime = mimeForBytes(buf);'));
  assert.ok(BRIEF.includes('if (!mime) return null;'), 'unsupported bytes ⇒ unreadable, never a guess');
});

test('§2.3: the Record-audit upload sniffs too — the client mime is only a hint', () => {
  assert.ok(EXTRACT_ROUTE.includes('sniffMime(Buffer.from(base64.slice(0, 64)'), 'sniffed from the payload head');
  assert.ok(EXTRACT_ROUTE.includes('const mime = sniffed || \'\';'), 'the sniffed type is what is used');
  assert.ok(EXTRACT_ROUTE.includes('!SUPPORTED_DOC_MIME.has(mime)'), 'still gated on the supported set');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · §2.1 — an unreadable document must be reportable as unreadable
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2.1: EXTRACT_SYSTEM demands an explicit marker and FORBIDS empty-fields-as-signal', () => {
  assert.ok(EXTRACT_SYSTEM.includes('{"unreadable": true}'), 'the explicit marker');
  assert.ok(!EXTRACT_SYSTEM.includes('If unreadable, return empty fields'), 'the enabling instruction is gone');
  assert.ok(/Never return empty fields to signal an unreadable document/.test(EXTRACT_SYSTEM));
});

test('§2.1: the marker is honoured, in either shape', () => {
  assert.equal(saysUnreadable({ unreadable: true }), true);
  assert.equal(saysUnreadable({ unreadable: 'true' }), true);
  assert.equal(saysUnreadable({ unreadable: false }), false);
  assert.equal(saysUnreadable({}), false);
  assert.equal(saysUnreadable(null), false);
  assert.equal(parseExtractedReport('{"unreadable": true}', 'radiology'), null);
});

test('§2.1 THE MEASURED FAILURE: a well-formed all-empty extract is a FAILED READ, not a report', () => {
  // Exactly the diagnostic#3 shape: valid JSON, every field empty, HTTP 200, finish stop.
  assert.equal(parseExtractedReport('{"studyOrPanel":null,"impression":null,"keyFindings":[],"abnormalValues":[]}', 'diagnostic'), null);
  assert.equal(parseExtractedReport('{"studyOrPanel":"","impression":"  ","keyFindings":[""],"abnormalValues":[]}', 'diagnostic'), null,
    'whitespace-only is empty too');
  // …and the belt-and-braces claim: the detector fires even though the prompt told it not to.
  assert.equal(isEmptyExtract({ kind: 'diagnostic', studyOrPanel: null, impression: null, keyFindings: [], abnormalValues: [] }), true,
    '`kind` alone is never content — it is stamped from the caller argument');
});

test('§2.1 control: ANY real clinical content survives — one field is enough', () => {
  const one = parseExtractedReport('{"studyOrPanel":"CBC","impression":null,"keyFindings":[],"abnormalValues":[]}', 'diagnostic');
  assert.equal(one?.studyOrPanel, 'CBC');
  const abn = parseExtractedReport('{"studyOrPanel":null,"impression":null,"keyFindings":[],"abnormalValues":["X (low)"]}', 'diagnostic');
  assert.equal(abn?.abnormalValues.length, 1, 'an abnormal value alone keeps the extract alive');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · §2.2 — an empty extract can never enter the immutable store
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2.2: putExtract REFUSES an empty extract, at the write, before the immutable insert', () => {
  assert.ok(CACHE.includes('if (isEmptyExtract(extract)) return;'), 'the guard exists');
  const fn = CACHE.slice(CACHE.indexOf('export async function putExtract'));
  const guardIdx = fn.indexOf('isEmptyExtract');
  const insertIdx = fn.indexOf('INSERT INTO ccb_doc_extract');
  assert.ok(guardIdx > 0 && insertIdx > guardIdx, 'the guard precedes the INSERT — no caller can bypass it');
  assert.ok(fn.includes('ON CONFLICT (doc_sha) DO NOTHING'), 'the store is still immutable; that is WHY the guard matters');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · §1/§3 — the transport: engine pinned, provider pinned, bounded, never mistral-ocr
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1: the PDF engine is native, pinned explicitly — never the default that falls to mistral-ocr', () => {
  assert.equal(PDF_ENGINE, 'native');
  const body = buildDocRequestBody({ model: 'google/gemini-2.5-pro', systemPrompt: 's', userPrompt: 'u', base64: 'AAAA', mime: 'application/pdf' });
  assert.deepEqual(body.plugins, [{ id: 'file-parser', pdf: { engine: 'native' } }]);
});

test('§4: mistral-ocr appears NOWHERE in the shipped transport', () => {
  const CORE = readFileSync('lib/doc-transport-core.ts', 'utf8');
  for (const [name, src] of [['core', CORE], ['multimodal', MM]] as const) {
    const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    assert.ok(!code.includes('mistral'), `${name} carries no mistral-ocr reference outside comments`);
  }
});

test('§3: the Google-only provider pin rides EVERY document call', () => {
  assert.deepEqual(DOC_PROVIDER_PIN, { allow_fallbacks: false, only: ['google-vertex', 'google-ai-studio'] });
  for (const mime of ['application/pdf', 'image/png']) {
    const body = buildDocRequestBody({ model: 'm', systemPrompt: 's', userPrompt: 'u', base64: 'AAAA', mime });
    assert.deepEqual(body.provider, DOC_PROVIDER_PIN, `pinned for ${mime}`);
  }
});

test('§3: PDFs ride type:file; images ride type:image_url (built, but UNEXERCISED by production traffic)', () => {
  const pdf = buildDocRequestBody({ model: 'm', systemPrompt: 's', userPrompt: 'u', base64: 'QUJD', mime: 'application/pdf' });
  const pdfContent = (pdf.messages as { content: Record<string, unknown>[] }[])[1].content;
  assert.equal(pdfContent[1].type, 'file');
  assert.match(String((pdfContent[1].file as { file_data: string }).file_data), /^data:application\/pdf;base64,QUJD$/);

  const png = buildDocRequestBody({ model: 'm', systemPrompt: 's', userPrompt: 'u', base64: 'QUJD', mime: 'image/png' });
  const pngContent = (png.messages as { content: Record<string, unknown>[] }[])[1].content;
  assert.equal(pngContent[1].type, 'image_url');
  assert.ok(!('plugins' in png), 'no file-parser plugin on an image');
});

test('§3: token headroom — Pro spends output budget on reasoning first', () => {
  assert.equal(buildDocRequestBody({ model: 'm', systemPrompt: 's', userPrompt: 'u', base64: 'A', mime: 'application/pdf', maxOutputTokens: 2048 }).max_tokens, 2048 + 8192);
});

test('§3: a TIMEOUT bounds the read — its absence is why Record audit HUNG instead of failing', () => {
  assert.equal(DOC_READ_TIMEOUT_MS, 180_000, 'far inside the 800s route box');
  assert.ok(MM.includes('const ctl = new AbortController();'));
  assert.ok(MM.includes('setTimeout(() => ctl.abort(), DOC_READ_TIMEOUT_MS)'));
  assert.ok(MM.includes('signal: ctl.signal,'), 'the signal actually reaches the fetch');
  assert.ok(MM.includes('clearTimeout(timer);'), 'and is cleared on every exit');
});

test('§3: failures surface as provider_error AND as unreadable (null), never as an empty extract', () => {
  assert.equal((MM.match(/kind was here/g) || []).length, 0);
  assert.ok(MM.includes("logEvent(opts.traceId, 'provider_error'"), 'emitted like the chat path');
  const orFn = MM.slice(MM.indexOf('async function generateFromDocumentViaOpenRouter'), MM.indexOf('const isPdf ='));
  assert.ok(orFn.includes('if (!res.ok || j?.error) {'), 'a corrupt source (both engines fail) is an error path');
  assert.equal((orFn.match(/return null;/g) || []).length, 2, 'both the error path and the throw path return unreadable');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · §4 — the Vertex path must still work the moment the API is re-enabled
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4: the Vertex path is untouched and is what runs with the flag unset', () => {
  assert.ok(MM.includes(':generateContent`'), 'the native Vertex endpoint is still built');
  assert.ok(MM.includes("systemInstruction: { parts: [{ text: systemPrompt }] },"), 'its body is unchanged');
  assert.ok(MM.includes("provider: 'vertex-multimodal'"), 'and it still self-logs under its own provider label');
  // The bridge is selected ONLY by the flag, via the same helper the chat bridge uses.
  assert.ok(MM.includes('const orSlug = openrouterGeminiSlug(model);'));
  assert.ok(MM.includes('if (orSlug && openrouterConfigured()) {'));
  const idx = MM.indexOf('const orSlug = openrouterGeminiSlug(model);');
  assert.ok(MM.indexOf('if (!geminiConfigured())', idx) > idx,
    'the geminiConfigured gate now sits AFTER the bridge check — otherwise an unconfigured Vertex would block the bridge');
});
