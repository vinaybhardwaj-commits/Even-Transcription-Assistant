import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const REQUIRED_HEADERS = [
  "physician_email", "hospital_code", "year", "month",
  "opd_count", "ipd_admissions", "ot_cases", "revenue_inr",
];

interface ParseResult {
  rows: Record<string, string>[];
  errors: string[];
}

function parseCsv(text: string): ParseResult {
  const errors: string[] = [];
  const rows: Record<string, string>[] = [];
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed) {
    errors.push("Empty file");
    return { rows, errors };
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    errors.push("Need at least a header row + 1 data row");
    return { rows, errors };
  }
  const header = lines[0].split(",").map((s) => s.trim().toLowerCase());
  const missing = REQUIRED_HEADERS.filter((h) => !header.includes(h));
  if (missing.length > 0) {
    errors.push(`Missing required columns: ${missing.join(", ")}`);
    return { rows, errors };
  }
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map((c) => c.trim());
    if (cells.length !== header.length) {
      errors.push(`Row ${i + 1}: column count mismatch (${cells.length} vs ${header.length})`);
      continue;
    }
    const obj: Record<string, string> = {};
    header.forEach((h, ix) => { obj[h] = cells[ix] ?? ""; });
    rows.push(obj);
  }
  return { rows, errors };
}

export async function POST(req: NextRequest) {
  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const { csv, mode, source_file } = body ?? {};
  if (!csv || typeof csv !== "string") {
    return NextResponse.json({ ok: false, error: "csv (string) required" }, { status: 400, headers: NO_STORE });
  }
  if (csv.length > 4 * 1024 * 1024) {
    return NextResponse.json({ ok: false, error: "CSV exceeds 4 MB cap" }, { status: 413, headers: NO_STORE });
  }
  const dryRun = mode !== "commit";

  const parsed = parseCsv(csv);
  if (parsed.errors.length > 0 && parsed.rows.length === 0) {
    return NextResponse.json({ ok: false, errors: parsed.errors }, { status: 400, headers: NO_STORE });
  }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // Look up all referenced physicians + hospitals in 2 queries
  const emails = Array.from(new Set(parsed.rows.map((r) => r.physician_email.toLowerCase())));
  const codes = Array.from(new Set(parsed.rows.map((r) => r.hospital_code.toUpperCase())));

  const physRows = (await sql`
    SELECT id::text AS id, lower(email) AS email FROM physicians WHERE lower(email) = ANY(${emails}::text[])
  `) as Array<{ id: string; email: string }>;
  const hospRows = (await sql`
    SELECT id::text AS id, code FROM hospitals WHERE code = ANY(${codes}::text[]) AND is_active = true
  `) as Array<{ id: string; code: string }>;

  const physByEmail = new Map(physRows.map((r) => [r.email, r.id]));
  const hospByCode = new Map(hospRows.map((r) => [r.code, r.id]));

  const validated: {
    raw: Record<string, string>;
    physician_id: string;
    hospital_id: string;
    hospital_code: string;
    year: number;
    month: number;
    opd_count: number | null;
    ipd_admissions: number | null;
    ot_cases: number | null;
    revenue_inr: number | null;
  }[] = [];
  const rowErrors: string[] = [...parsed.errors];

  for (let i = 0; i < parsed.rows.length; i++) {
    const r = parsed.rows[i];
    const lineNum = i + 2;
    const email = (r.physician_email || "").toLowerCase();
    const code = (r.hospital_code || "").toUpperCase();
    const physician_id = physByEmail.get(email);
    const hospital_id = hospByCode.get(code);
    if (!physician_id) {
      rowErrors.push(`Row ${lineNum}: physician_email '${email}' not found`);
      continue;
    }
    if (!hospital_id) {
      rowErrors.push(`Row ${lineNum}: hospital_code '${code}' not active`);
      continue;
    }
    const year = parseInt(r.year, 10);
    const month = parseInt(r.month, 10);
    if (!Number.isFinite(year) || year < 2020 || year > 2100) {
      rowErrors.push(`Row ${lineNum}: bad year '${r.year}'`);
      continue;
    }
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      rowErrors.push(`Row ${lineNum}: bad month '${r.month}'`);
      continue;
    }
    const numOrNull = (s: string) => {
      const t = s.trim();
      if (!t) return null;
      const n = Number(t.replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    validated.push({
      raw: r,
      physician_id,
      hospital_id,
      hospital_code: code,
      year,
      month,
      opd_count: r.opd_count ? parseInt(r.opd_count, 10) || null : null,
      ipd_admissions: r.ipd_admissions ? parseInt(r.ipd_admissions, 10) || null : null,
      ot_cases: r.ot_cases ? parseInt(r.ot_cases, 10) || null : null,
      revenue_inr: numOrNull(r.revenue_inr),
    });
  }

  if (dryRun) {
    return NextResponse.json(
      {
        ok: rowErrors.length === 0,
        mode: "preview",
        parsed_count: parsed.rows.length,
        valid_count: validated.length,
        errors: rowErrors,
        sample: validated.slice(0, 8).map((v) => ({
          email: v.raw.physician_email,
          hospital: v.hospital_code,
          year: v.year,
          month: v.month,
          opd: v.opd_count,
          ipd: v.ipd_admissions,
          ot: v.ot_cases,
          revenue: v.revenue_inr,
        })),
      },
      { headers: NO_STORE },
    );
  }

  // Commit: insert rows, ON CONFLICT DO NOTHING (so re-uploads of same month are idempotent)
  let inserted = 0;
  let skipped = 0;
  for (const v of validated) {
    const r = (await sql`
      INSERT INTO clinical_metrics_monthly (
        physician_id, hospital_id, year, month,
        opd_count, ipd_admissions, ot_cases, revenue_inr,
        uploaded_by, source_file
      ) VALUES (
        ${v.physician_id}::uuid, ${v.hospital_id}::uuid, ${v.year}, ${v.month},
        ${v.opd_count}, ${v.ipd_admissions}, ${v.ot_cases}, ${v.revenue_inr},
        ${actor.profileId}::uuid, ${source_file ?? null}
      )
      ON CONFLICT (physician_id, hospital_id, year, month) DO NOTHING
      RETURNING id::text AS id
    `) as Array<{ id: string }>;
    if (r.length > 0) inserted++; else skipped++;
  }

  const fileHash = crypto.createHash("sha256").update(csv).digest("hex");
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (
      ${actor.profileId}::uuid, 'upload', 'clinical_metrics', NULL,
      ${JSON.stringify({
        source_file: source_file ?? null,
        file_hash: fileHash,
        row_count_total: parsed.rows.length,
        row_count_inserted: inserted,
        row_count_skipped: skipped,
        row_errors: rowErrors.length,
      })}::jsonb
    )
  `;

  return NextResponse.json(
    {
      ok: true,
      mode: "commit",
      inserted,
      skipped,
      errors: rowErrors,
      file_hash: fileHash,
    },
    { headers: NO_STORE },
  );
}
