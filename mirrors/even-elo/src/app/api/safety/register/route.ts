import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/safety/register?month=YYYY-MM&unit=CODE — the Saturday review
 * register as a downloadable CSV.
 *
 * PRD Addendum A1 §A1.2. Deepthi reads every incident aloud with its RCA,
 * corrective action and preventive action from ONE page in the Saturday 2-3pm
 * stakeholder meeting. This is the artefact that meeting runs on.
 *
 * A1-D14 — the file is assembled HERE, not in even-incident: the /safety
 * [...path] proxy reads every upstream body with res.text(), so a file cannot be
 * served through it. This route therefore calls even-incident directly with the
 * service token (the same ifetch shape /api/mcp uses) and never goes through the
 * proxy. It gates on the identical predicate the proxy uses.
 *
 * A1-D13 — CSV, not .xlsx. Neither repo carries a spreadsheet library and no new
 * dependency was sanctioned for Q2. Accepted consequence: the pink header, bold
 * red text, wrapping, column widths and freeze pane are LOST. Quality gets the
 * ten columns, in order, with the data, opening in Excel. CSV also cannot carry
 * one-sheet-per-month — the MONTH column (already column A) does that job.
 *
 * A1-D30 — ELEVEN columns since Q7: UNIT is inserted as column B, immediately
 * after MONTH. This knowingly deviates from the ten-column format signed off in
 * A1.2.1, and is justified by Deepthi's own requirement #3 ("Unit name, if we
 * use the same template across all units"). Confirm with her at review.
 */

const BASE = process.env.INCIDENT_API_BASE;
const APITOK = process.env.INCIDENT_API_TOKEN;

/** Same predicate as src/app/api/safety/[...path]/route.ts — do not diverge. */
async function authed() {
  const u = await getCurrentUser();
  if (!u || u.status !== "active") return null;
  if (!(u.is_super_admin || u.is_sgc_member)) return null;
  return u;
}

type Row = {
  id: string;
  display_no: string | null;
  unit_code: string | null;
  unit_name: string | null;
  occurred_at: string | null;
  reported_at: string | null;
  narrative: string | null;
  care_type: string | null;
  nabh_class: string | null;
  status: string | null;
  rca_author: string | null;
  root_causes: string[];
  five_whys: string[];
  factors: { category: string | null; note: string | null }[];
  corrective: { action: string; control_level: string | null }[];
  preventive: { action: string; control_level: string | null }[];
  rca_count: number;
};

/**
 * NABH labels, verbatim from Deepthi's dropdown. Read the STORED nabh_class —
 * never re-derive from severity. Q1 already stored the reporter-confirmed value,
 * and deriving would reintroduce the catastrophic->Sentinel error A1-D2 forbids.
 */
const NABH_LABEL: Record<string, string> = {
  near_miss: "Near Miss (Potential error that was caught before it reached individual)",
  no_harm: "No Harm Incident (Caused no harm)",
  adverse_event: "Adverse Event (Serious, largely preventable event)",
  sentinel: "Sentinel Event",
};

/** Quality's own lifecycle wording. */
const REMARK: Record<string, string> = {
  open: "Open",
  under_investigation: "Under investigation",
  capa_assigned: "CAPA assigned",
  closed: "Closed",
  verified: "Closed - verified",
};

const CARE_LABEL: Record<string, string> = { clinical: "Clinical", non_clinical: "Non Clinical" };

const HEADERS = [
  "MONTH",
  "UNIT",
  "INCIDENT NO.",
  "INCIDENT",
  "CLINICAL/ NON CLINICAL",
  "INCIDENT SEVERITY",
  "ROOT CAUSE ANALYSIS",
  "RCA DONE BY",
  "CORRECTIVE ACTION",
  "PREVENTIVE ACTION",
  "REMARKS",
];

/** DD-MM-YYYY in IST. formatToParts avoids depending on a locale's field order. */
function istDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric",
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const dd = get("day"), mm = get("month"), yyyy = get("year");
  return dd && mm && yyyy ? `${dd}-${mm}-${yyyy}` : "";
}

/** YYYYMMDD in IST, for the filename. */
function istStamp(): string {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric",
  }).formatToParts(new Date());
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

/**
 * RFC 4180: quote a field whenever it contains a comma, a double quote, CR or
 * LF; escape an embedded double quote by doubling it. The RCA and CAPA columns
 * are multi-line BY DESIGN — the newlines stay inside the quoted field.
 */
function csvField(v: unknown): string {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvRow = (cells: unknown[]) => cells.map(csvField).join(",");

/** "Root cause: X", then each five-why as "- w", then each factor as "- [cat] note". */
function rcaCell(r: Row): string {
  if (!r.rca_count) return "";
  const lines: string[] = [];
  for (const rc of r.root_causes || []) if (rc) lines.push(`Root cause: ${rc}`);
  for (const w of r.five_whys || []) if (w) lines.push(`- ${w}`);
  for (const f of r.factors || []) {
    if (!f?.note) continue;
    lines.push(f.category ? `- [${f.category}] ${f.note}` : `- ${f.note}`);
  }
  return lines.join("\n");
}

/** One line per CAPA: "- action (control_level)"; parenthetical omitted when null. */
const capaCell = (list: { action: string; control_level: string | null }[]) =>
  (list || [])
    .filter((c) => c?.action)
    .map((c) => (c.control_level ? `- ${c.action} (${c.control_level})` : `- ${c.action}`))
    .join("\n");

function remarksCell(r: Row): string {
  const base = r.status ? (REMARK[r.status] ?? r.status) : "";
  return r.rca_count === 0 ? `${base} (RCA pending)`.trim() : base;
}

function buildCsv(rows: Row[]): string {
  const lines = [csvRow(HEADERS)];
  for (const r of rows) {
    lines.push(csvRow([
      istDate(r.occurred_at || r.reported_at),
      r.unit_name ?? r.unit_code ?? "",
      r.display_no ?? "",
      r.narrative ?? "",
      r.care_type ? (CARE_LABEL[r.care_type] ?? "") : "",
      r.nabh_class ? (NABH_LABEL[r.nabh_class] ?? "") : "",
      rcaCell(r),
      r.rca_author ?? "",
      capaCell(r.corrective),
      capaCell(r.preventive),
      remarksCell(r),
    ]));
  }
  // CRLF terminator, and a UTF-8 BOM so Excel on Windows does not render
  // non-ASCII as mojibake. Quality opens these on Windows.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

const fail = (msg: string) =>
  new NextResponse(msg, { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export async function GET(req: NextRequest) {
  const user = await authed();
  if (!user) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  if (!BASE || !APITOK) return fail("Incident API not configured.");

  const raw = req.nextUrl.searchParams.get("month");
  const month = raw && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : null;

  // A1-D30 — ?unit= is passed straight through. Upstream decides what an
  // unknown code means (an empty row set, never an error), and echoes back the
  // scope it actually applied so the filename below cannot overstate it.
  const rawUnit = (req.nextUrl.searchParams.get("unit") || "").trim().toUpperCase();
  const unit = /^[A-Z0-9_-]{1,16}$/.test(rawUnit) ? rawUnit : null;

  let j: { ok?: boolean; month?: string | null; unit?: string | null; rows?: Row[]; error?: string };
  try {
    // Same shape as the ifetch helper in /api/mcp: bearer + no-store + timeout.
    // Deliberately NOT routed through the [...path] proxy (A1-D14).
    const qs = new URLSearchParams();
    if (month) qs.set("month", month);
    if (unit) qs.set("unit", unit);
    const q = qs.toString();
    const res = await fetch(`${BASE}/api/office/register${q ? `?${q}` : ""}`, {
      headers: { Authorization: `Bearer ${APITOK}`, "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return fail(`Incident register unavailable (upstream ${res.status}). Nothing was downloaded.`);
    j = (await res.json()) as typeof j;
  } catch (e) {
    return fail(`Could not reach the incident system: ${e instanceof Error ? e.message : "error"}. Nothing was downloaded.`);
  }

  // Never hand back a half-written or empty file that looks valid.
  if (!j || j.ok === false || !Array.isArray(j.rows)) {
    return fail(`Incident register unavailable${j?.error ? `: ${j.error}` : ""}. Nothing was downloaded.`);
  }

  // Name the file after the scope actually APPLIED upstream, not the one asked
  // for — upstream ignores a malformed month, and a file called ...-2026-13-...
  // holding every month would be a lie.
  const applied = j.month !== undefined ? j.month : month;
  const appliedUnit = j.unit !== undefined ? j.unit : unit;
  const filename = `${appliedUnit ?? "EHRC"}-Incident-Register-${applied ?? "ALL"}-${istStamp()}.csv`;

  return new NextResponse(buildCsv(j.rows), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
