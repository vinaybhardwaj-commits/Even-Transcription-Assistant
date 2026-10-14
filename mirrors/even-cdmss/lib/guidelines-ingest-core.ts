/**
 * lib/guidelines-ingest-core.ts — PURE parse → chunk → row-shape for the guideline ingest job.
 * No db, no fs, no embed. REUSES chunkText (lab-core) for the sub-split — does NOT reimplement it.
 * The driver (scripts/corpus-eval/guidelines-ingest.mjs) reads files + embeds + inserts via the
 * vetted corpusAddQuarantined (quarantine invariants: source='labq:%', visible=false).
 *
 * Both sources land the 0.95 "guidelines" source-quality weight because their `book` contains the
 * substring 'guidelines' (source-quality.ts:60, matched case-insensitively over `book` + `source`).
 * Neither anchor is a DOI/PMID/URL — they are stable INTERNAL locators (sourceUrl → null); the chunks
 * carry category/internal authority, not a resolvable external citation. No fake identifiers minted.
 */
import { chunkText } from './lab-core';

export const EVEN = { label: 'guidelines-even-protocols', book: 'Even Clinical Protocols — Even Guidelines 2026' } as const;
export const ICMR = { label: 'guidelines-icmr-amr-2019', book: 'ICMR Treatment Guidelines for Antimicrobial Use 2019 — Guidelines' } as const;
export const MIN_CHUNK_CHARS = 120;   // drop rule (mirrors the connector's < 120 fragment gate)
export const CHUNK_MAX = 1400;        // chunkText window (mirrors corpusAddQuarantined default)

export interface GuidelineSection { book: string; section: string; anchor: string; text: string }
export interface GuidelineRow { book: string; section: string; itemNumber: string; chunkType: 'guideline'; text: string }
export interface ChunkStats { n: number; min: number; median: number; max: number }
export interface BuildResult { rows: GuidelineRow[]; dropped: number; stats: ChunkStats }

/** kebab-slug for a heading → a stable internal anchor fragment. */
export function slugify(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';
}

/** Strip base64 image blobs + markdown image refs from the Even .md BEFORE chunking. The 83 MB file
 *  is ~272 image lines (reference-style ![][imageN] + huge `[imageN]: data:image/...;base64,…` defs);
 *  removing them leaves ~360 KB of prose. */
export function stripEvenNonProse(md: string): string {
  return String(md)
    .split('\n')
    .filter((ln) => {
      if (/data:image|;base64,|base64/i.test(ln)) return false;   // base64 blobs + their reference defs
      if (/^\s*!\[/.test(ln)) return false;                       // ![alt](url) / ![][ref] image lines
      if (/^\s*\[[^\]]+\]:\s/.test(ln) && ln.length > 400) return false;   // long link/image reference defs
      return true;
    })
    .map((ln) => ln.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/!\[[^\]]*\]\[[^\]]*\]/g, ''))   // inline image refs
    .join('\n');
}

/** Parse the Even protocols .md into heading-scoped sections. Splits on H1/H2/H3; H2/H3 section paths
 *  are prefixed with the nearest H1 group. Content before the first heading (front-matter) is dropped. */
export function parseEvenProtocols(md: string): GuidelineSection[] {
  const lines = stripEvenNonProse(md).split('\n');
  const sections: GuidelineSection[] = [];
  let group = '';
  let cur: GuidelineSection | null = null;
  const flush = () => { if (cur && cur.text.trim().length) sections.push(cur); };
  for (const ln of lines) {
    const h = ln.match(/^(#{1,3})\s+(.*\S)\s*$/);
    if (h) {
      const level = h[1].length;
      const title = h[2].replace(/[:#*]+$/, '').trim();
      flush();
      if (level === 1) {
        group = title;
        cur = { book: EVEN.book, section: title, anchor: `even-protocol#${slugify(title)}`, text: '' };
      } else {
        const path = group && group.toLowerCase() !== title.toLowerCase() ? `${group} › ${title}` : title;
        cur = { book: EVEN.book, section: path, anchor: `even-protocol#${slugify(title)}`, text: '' };
      }
      continue;
    }
    if (cur) cur.text += `${ln}\n`;
  }
  flush();
  return sections;
}

/** Best-effort chapter/syndrome heading for an ICMR PDF page: a short, title/UPPER-case line with no
 *  sentence punctuation near the top. Returns null → the caller carries the previous chapter forward. */
export function detectIcmrHeading(pageText: string): string | null {
  const lines = String(pageText).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 6);
  for (const l of lines) {
    if (l.length < 6 || l.length > 70) continue;
    if (/[.:;]$/.test(l)) continue;                          // sentence-like → skip
    if (!/[A-Za-z]/.test(l)) continue;
    const letters = l.replace(/[^A-Za-z]/g, '');
    const upperRatio = letters ? (letters.replace(/[^A-Z]/g, '').length / letters.length) : 0;
    const titleish = /^[A-Z0-9]/.test(l) && /^[A-Za-z0-9 ,&/()\-]+$/.test(l);
    if (titleish && (upperRatio > 0.6 || /^[A-Z][a-z]/.test(l))) return l;
  }
  return null;
}

/** Parse pdftotext output (form-feed page-delimited) into per-page sections, page-numbered anchors. */
export function parseIcmr(pdfText: string): GuidelineSection[] {
  const pages = String(pdfText).split('\f');
  const sections: GuidelineSection[] = [];
  let chapter = 'ICMR AMR 2019';
  for (let p = 0; p < pages.length; p++) {
    const pageText = pages[p];
    if (!pageText || pageText.trim().length < MIN_CHUNK_CHARS) continue;
    const head = detectIcmrHeading(pageText);
    if (head) chapter = head;
    sections.push({ book: ICMR.book, section: chapter, anchor: `icmr-amr-2019#p${p + 1}`, text: pageText });
  }
  return sections;
}

export function chunkStats(charLens: number[]): ChunkStats {
  if (!charLens.length) return { n: 0, min: 0, median: 0, max: 0 };
  const s = [...charLens].sort((a, b) => a - b);
  return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
}

/** Chunk sections into final rows: chunkText(text, 1400), trim, DROP < 120 chars. Each row carries its
 *  section's anchor (sub-splits of one section share the anchor, per spec). */
export function chunkSections(sections: GuidelineSection[]): BuildResult {
  const rows: GuidelineRow[] = [];
  const charLens: number[] = [];
  let dropped = 0;
  for (const sec of sections) {
    for (const piece of chunkText(sec.text, CHUNK_MAX)) {
      const t = piece.replace(/\s+$/g, '').trim();
      if (t.length < MIN_CHUNK_CHARS) { dropped++; continue; }
      rows.push({ book: sec.book, section: sec.section, itemNumber: sec.anchor, chunkType: 'guideline', text: t });
      charLens.push(t.length);
    }
  }
  return { rows, dropped, stats: chunkStats(charLens) };
}

export function buildEven(md: string): BuildResult { return chunkSections(parseEvenProtocols(md)); }
export function buildIcmr(pdfText: string): BuildResult { return chunkSections(parseIcmr(pdfText)); }
