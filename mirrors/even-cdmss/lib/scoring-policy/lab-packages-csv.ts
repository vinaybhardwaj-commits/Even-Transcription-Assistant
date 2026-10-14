/**
 * lib/scoring-policy/lab-packages-csv.ts — lab-package CSV parse / serialise / validate / diff.
 *
 * PURE, dependency-free, strip-types testable. NO CSV LIBRARY — the parser is written by hand
 * because the PRD forbids a new dependency, and because the format is narrow enough to specify
 * exactly (§7.3).
 *
 * ═══ THE FORMAT (§7.3) ═══
 *   package,aliases,contains          ← header row, EXACT, required
 *   Multi-value fields are SEMICOLON-separated INSIDE a quoted field, because comma is the column
 *   delimiter and Excel handles this correctly.
 *
 *   "Even Hospital Advanced Diabetes Screening","diabetes screening;diabetic panel","CBC;Lipid Profile Test"
 *
 * ═══ THE ROUND-TRIP GUARANTEE (hard requirement) ═══
 *   serialise → parse must return a deeply equal package set, and re-importing an unmodified export
 *   must yield a ZERO-ROW DIFF and create NO new version. That property is what makes the whole
 *   download-edit-upload mechanism trustworthy: a clinician who changes nothing must break nothing.
 *   It is the first test in the suite.
 */

export interface LabPackage {
  package: string;
  aliases: string[];
  contains: string[];
  source?: string;
}

export const CSV_HEADERS = ['package', 'aliases', 'contains'] as const;
export const CSV_MAX_ROWS = 500;
export const CSV_MAX_BYTES = 1024 * 1024;   // 1 MB
export const MULTI_SEP = ';';

/** The provenance stamp the generator writes; preserved across a round trip. */
export const LAB_PACKAGE_SOURCE = 'db13:individuals-prescriptions__further_investigation';

// ── serialise ────────────────────────────────────────────────────────────────────────────────────

/** RFC4180-style quoting: always quote, and double any embedded quote. Always-quoting keeps the
 *  output stable and makes the round trip trivially exact. */
function quote(v: string): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

/**
 * Serialise the CURRENT LIVE SET (§7.3 — "exports the current live set, not a blank template").
 * Row order follows the input, so an export is stable between calls.
 */
export function serialiseLabPackagesCsv(packages: LabPackage[]): string {
  const lines = [CSV_HEADERS.join(',')];
  for (const p of Array.isArray(packages) ? packages : []) {
    lines.push([
      quote(p?.package ?? ''),
      quote((p?.aliases ?? []).join(MULTI_SEP)),
      quote((p?.contains ?? []).join(MULTI_SEP)),
    ].join(','));
  }
  // Trailing newline: every line terminated, which is what Excel writes and what diff tools expect.
  return `${lines.join('\n')}\n`;
}

// ── parse ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Split one CSV line into fields, honouring quotes and doubled quotes. Written explicitly rather
 * than with a regex so an unterminated quote is a defined outcome (the rest of the line becomes one
 * field) instead of catastrophic backtracking.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Split rows on newlines, respecting quoted fields that contain one. Handles CRLF and a BOM. */
export function splitCsvRows(text: string): string[] {
  const src = String(text ?? '').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      if (inQuotes && src[i + 1] === '"') { cur += '""'; i++; continue; }
      inQuotes = !inQuotes;
      cur += ch;
      continue;
    }
    if (ch === '\n' && !inQuotes) { rows.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur !== '') rows.push(cur);
  return rows.filter((r, i) => i === 0 || r.trim() !== '');   // keep the header, drop blank lines
}

/** Trim + drop empties + de-duplicate case-insensitively, keeping first-seen casing. */
export function cleanMultiValue(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(raw ?? '').split(MULTI_SEP)) {
    const v = part.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

export type ParseResult =
  | { ok: true; packages: LabPackage[] }
  | { ok: false; error: string };

/**
 * Parse + VALIDATE. Every check runs before anything is returned, and ANY failure rejects the WHOLE
 * file (§7.3: "reject the whole file on any failure, never partially apply"). Error messages name
 * the offending row so a clinician can fix it in Excel without guessing.
 */
export function parseLabPackagesCsv(text: string, opts: { filename?: string } = {}): ParseResult {
  const name = opts.filename ?? '';
  if (name && !/\.csv$/i.test(name)) return { ok: false, error: 'Expected a .csv file.' };

  const src = String(text ?? '');
  // Byte length, not character length — a 1 MB cap on multi-byte content must mean bytes.
  const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(src).length : src.length;
  if (bytes > CSV_MAX_BYTES) return { ok: false, error: `File is larger than 1 MB (${Math.round(bytes / 1024)} KB).` };

  const rows = splitCsvRows(src);
  if (!rows.length || !rows[0].trim()) return { ok: false, error: 'The file is empty.' };

  const header = splitCsvLine(rows[0]).map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase());
  if (header.length !== CSV_HEADERS.length || CSV_HEADERS.some((h, i) => header[i] !== h)) {
    return { ok: false, error: 'Expected columns: package, aliases, contains' };
  }

  const body = rows.slice(1);
  if (body.length > CSV_MAX_ROWS) {
    return { ok: false, error: `Too many rows: ${body.length}. The maximum is ${CSV_MAX_ROWS}.` };
  }

  const packages: LabPackage[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < body.length; i++) {
    const rowNo = i + 2;   // 1-based, +1 for the header — the number Excel shows
    const cells = splitCsvLine(body[i]);
    if (cells.length !== CSV_HEADERS.length) {
      return { ok: false, error: `Row ${rowNo}: expected 3 columns, found ${cells.length}.` };
    }
    const pkg = cells[0].trim();
    if (!pkg) return { ok: false, error: `Row ${rowNo}: package name is empty.` };
    const key = pkg.toLowerCase();
    if (seen.has(key)) {
      return { ok: false, error: `Row ${rowNo}: duplicate package "${pkg}" (already on row ${seen.get(key)}).` };
    }
    seen.set(key, rowNo);

    const contains = cleanMultiValue(cells[2]);
    if (!contains.length) return { ok: false, error: `Row ${rowNo}: "${pkg}" lists no constituent tests.` };

    packages.push({ package: pkg, aliases: cleanMultiValue(cells[1]), contains });
  }

  return { ok: true, packages };
}

// ── diff ─────────────────────────────────────────────────────────────────────────────────────────

export interface PackageDiff {
  added: string[];
  /** REMOVALS ARE LISTED PROMINENTLY (§7.3): deleting a package silently re-enables duplication
   *  flagging for it, which is the failure mode that brought Dr. Binita here. */
  removed: string[];
  changed: { package: string; aliasesAdded: string[]; aliasesRemoved: string[]; containsAdded: string[]; containsRemoved: string[] }[];
  /** True when nothing at all moved — the round-trip guarantee's observable form. */
  isEmpty: boolean;
}

function byKey(list: LabPackage[]): Map<string, LabPackage> {
  const m = new Map<string, LabPackage>();
  for (const p of Array.isArray(list) ? list : []) {
    if (p && typeof p.package === 'string' && p.package.trim()) m.set(p.package.trim().toLowerCase(), p);
  }
  return m;
}

/** Set difference, case-insensitive, preserving the source casing. */
function missingFrom(a: string[], b: string[]): string[] {
  const has = new Set((b ?? []).map((x) => x.toLowerCase()));
  return (a ?? []).filter((x) => !has.has(x.toLowerCase()));
}

export function diffLabPackages(current: LabPackage[], next: LabPackage[]): PackageDiff {
  const cur = byKey(current), nxt = byKey(next);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: PackageDiff['changed'] = [];

  for (const [k, p] of nxt) if (!cur.has(k)) added.push(p.package);
  for (const [k, p] of cur) if (!nxt.has(k)) removed.push(p.package);
  for (const [k, p] of nxt) {
    const c = cur.get(k);
    if (!c) continue;
    const aliasesAdded = missingFrom(p.aliases ?? [], c.aliases ?? []);
    const aliasesRemoved = missingFrom(c.aliases ?? [], p.aliases ?? []);
    const containsAdded = missingFrom(p.contains ?? [], c.contains ?? []);
    const containsRemoved = missingFrom(c.contains ?? [], p.contains ?? []);
    if (aliasesAdded.length || aliasesRemoved.length || containsAdded.length || containsRemoved.length) {
      changed.push({ package: p.package, aliasesAdded, aliasesRemoved, containsAdded, containsRemoved });
    }
  }

  added.sort(); removed.sort(); changed.sort((a, b) => a.package.localeCompare(b.package));
  return { added, removed, changed, isEmpty: !added.length && !removed.length && !changed.length };
}

// ── the stored form ──────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ THE VERSIONING SHAPE DIVERGES BY NOTE TYPE, DELIBERATELY (§12.3).
 *
 * `scoring_policy_versions.weights` holds an OBJECT of {fieldKey: tier} for the two weightage note
 * types, and an ARRAY of package objects for `note_type = 'lab_packages'`. A reader MUST branch on
 * note_type and must never assume the object shape. This function is that branch for the array
 * side; lib/scoring-policy/store.ts `toVector` is the object side.
 *
 * Tolerant: anything that is not a usable array yields [], which the judge treats exactly as "no
 * packages file" — i.e. today's behaviour.
 */
export function parseStoredLabPackages(raw: unknown): LabPackage[] {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  if (!Array.isArray(v)) return [];
  const out: LabPackage[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const name = typeof o.package === 'string' ? o.package.trim() : '';
    if (!name) continue;
    const contains = Array.isArray(o.contains) ? o.contains.map((c) => String(c ?? '').trim()).filter(Boolean) : [];
    if (!contains.length) continue;   // a package with no constituents cannot inform the judge
    out.push({
      package: name,
      aliases: Array.isArray(o.aliases) ? o.aliases.map((a) => String(a ?? '').trim()).filter(Boolean) : [],
      contains,
      source: typeof o.source === 'string' ? o.source : undefined,
    });
  }
  return out;
}
