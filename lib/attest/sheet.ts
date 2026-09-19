/**
 * lib/attest/sheet.ts — the attestation sheet a clinic coordinator fills in, and its parser.
 *
 * FIVE COLUMNS, and only these: room, date, start, end, clinician.
 *   room       the room's NAME as the clinic knows it. A coordinator never types an id.
 *   date       YYYY-MM-DD. Nothing else is accepted: a spreadsheet that has quietly turned 03/04
 *              into 4 March or 3 April is exactly the silent error this file exists to refuse.
 *   start/end  24-hour HH:MM, INDIA STANDARD TIME (UTC+05:30, no daylight saving). end must be later
 *              than start on the same date; `24:00` is accepted as an end only.
 *   clinician  the clinician's name or email as the clinic knows it. Resolved to an id downstream.
 *
 * COMMA or TAB separated, detected from the header line. Row numbers are SPREADSHEET row numbers
 * (the header is row 1), so a refusal that says "row 7" points at row 7 of the sheet.
 *
 * PURE. No I/O, no clock, no database. Every problem is a named refusal carrying the row; nothing
 * here warns and carries on, because a wrong attestation is worse than none (it would enrol one
 * doctor's voice onto another's print, and nothing downstream could catch it).
 */

export const SHEET_COLUMNS = ["room", "date", "start", "end", "clinician"] as const;
export type SheetColumn = (typeof SHEET_COLUMNS)[number];

/** Every reason this module or validate.ts can refuse for. A closed set: a reason is never free text. */
export const REFUSAL_REASONS = [
  // the sheet as a file
  "empty_sheet", "bad_header", "no_data_rows",
  // one row, syntax
  "wrong_cell_count", "unterminated_quote", "missing_cell", "bad_date", "bad_time", "end_not_after_start",
  // one row, against the database
  "unknown_room", "ambiguous_room", "unknown_clinician", "ambiguous_clinician", "clinician_deleted", "clinician_not_active",
  "no_room_day", "no_window_under_block",
  // across rows, and against what is already attested
  "duplicate_row", "overlap_same_room", "clinician_in_two_rooms", "conflicts_with_existing_attestation",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export type Refusal = {
  /** Spreadsheet row (header = 1), or null when the refusal is about the file as a whole. */
  row: number | null;
  reason: RefusalReason;
  /** A row number, a column name or a count — never the cell's text, which may be a person's name. */
  detail?: string;
};

export type SheetRow = { row: number; room: string; date: string; start: string; end: string; clinician: string };

export type ParsedSheet = {
  rows: SheetRow[];
  /** Syntax refusals only; cross-row and database refusals are validate.ts's. */
  refusals: Refusal[];
  delimiter: "," | "\t";
};

/** IST is a fixed +05:30 offset with no daylight saving, so a constant is exact. */
export const IST_OFFSET_MS = 330 * 60_000;

/** Split one line on `delim`, honouring double quotes (a doubled quote is a literal quote). null = an unterminated quote. */
export function splitLine(line: string, delim: string): string[] | null {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"' && cur === "") inQuotes = true;
    else if (ch === delim) { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  if (inQuotes) return null;
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** "HH:MM" → minutes since midnight, or null. 24:00 only when `allow24`. */
export function parseClock(s: string, allow24: boolean): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24) return null;
  if (h === 24 && (!allow24 || min !== 0)) return null;
  return h * 60 + min;
}

/** "YYYY-MM-DD" → epoch ms of that date's 00:00 IST, or null if it is not a real calendar date. */
export function istMidnightMs(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d);
  const back = new Date(utc);
  // A round trip catches 2026-02-30 and 2026-13-01, which Date.UTC would otherwise roll forward silently.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return utc - IST_OFFSET_MS;
}

/** The block's absolute bounds in epoch ms, or null when the row's date/times are not valid. */
export function blockBoundsMs(date: string, start: string, end: string): { startMs: number; endMs: number } | null {
  const base = istMidnightMs(date);
  const s = parseClock(start, false);
  const e = parseClock(end, true);
  if (base === null || s === null || e === null || e <= s) return null;
  return { startMs: base + s * 60_000, endMs: base + e * 60_000 };
}

export function parseSheet(input: string): ParsedSheet {
  const refusals: Refusal[] = [];
  const text = input.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx === -1) return { rows: [], refusals: [{ row: null, reason: "empty_sheet" }], delimiter: "," };

  const delimiter: "," | "\t" = lines[firstIdx]!.includes("\t") ? "\t" : ",";
  const header = splitLine(lines[firstIdx]!, delimiter);
  const names = header?.map((h) => h.toLowerCase()) ?? [];
  const headerOk =
    header !== null &&
    names.length === SHEET_COLUMNS.length &&
    new Set(names).size === SHEET_COLUMNS.length &&
    SHEET_COLUMNS.every((c) => names.includes(c));
  if (!headerOk) {
    // The detail says how many columns were found, never what they were called.
    return { rows: [], refusals: [{ row: null, reason: "bad_header", detail: `expected exactly: ${SHEET_COLUMNS.join(",")}` }], delimiter };
  }
  const idx = Object.fromEntries(SHEET_COLUMNS.map((c) => [c, names.indexOf(c)])) as Record<SheetColumn, number>;

  const rows: SheetRow[] = [];
  for (let i = firstIdx + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === "") continue;
    const rowNo = i + 1;
    const cells = splitLine(raw, delimiter);
    if (cells === null) { refusals.push({ row: rowNo, reason: "unterminated_quote" }); continue; }
    if (cells.length !== SHEET_COLUMNS.length) { refusals.push({ row: rowNo, reason: "wrong_cell_count", detail: `${cells.length} cells, expected ${SHEET_COLUMNS.length}` }); continue; }
    const row: SheetRow = {
      row: rowNo,
      room: cells[idx.room]!,
      date: cells[idx.date]!,
      start: cells[idx.start]!,
      end: cells[idx.end]!,
      clinician: cells[idx.clinician]!,
    };
    let clean = true;
    for (const col of SHEET_COLUMNS) {
      if (row[col] === "") { refusals.push({ row: rowNo, reason: "missing_cell", detail: col }); clean = false; }
    }
    if (!clean) continue;
    if (istMidnightMs(row.date) === null) { refusals.push({ row: rowNo, reason: "bad_date" }); continue; }
    if (parseClock(row.start, false) === null) { refusals.push({ row: rowNo, reason: "bad_time", detail: "start" }); clean = false; }
    if (parseClock(row.end, true) === null) { refusals.push({ row: rowNo, reason: "bad_time", detail: "end" }); clean = false; }
    if (!clean) continue;
    if (blockBoundsMs(row.date, row.start, row.end) === null) { refusals.push({ row: rowNo, reason: "end_not_after_start" }); continue; }
    rows.push(row);
  }
  if (rows.length === 0 && refusals.length === 0) refusals.push({ row: null, reason: "no_data_rows" });
  return { rows, refusals, delimiter };
}
