export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/scoring-policy/lab-packages/import
 *   · { csv }                        → VALIDATE + DIFF only. Writes nothing.
 *   · { csv, rationale, publish:true } → validate, then publish via the Phase A publish path.
 *
 * ═══ THE ROUND-TRIP GUARANTEE (§7.3, hard requirement) ═══
 * Re-uploading an unmodified export must yield a ZERO-ROW DIFF **and must not create a version**.
 * That is enforced HERE, not merely hoped for: when the diff is empty the publish branch short-
 * circuits with `noChange: true` before `publishVersion` is ever called. A clinician who changes
 * nothing must break nothing — that is what makes the mechanism trustworthy.
 *
 * Validation runs to completion BEFORE anything is written, and ANY failure rejects the whole file
 * (§7.3: "never partially apply"). Error messages name the offending row.
 *
 * Publishing reuses the Phase A versioning wholesale with note_type='lab_packages' — same table,
 * same mandatory rationale, same history/compare/restore screens. No parallel path.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authedAdminRequest, publishVersion, MIN_RATIONALE_CHARS } from '@/lib/scoring-policy/store';
import { parseLabPackagesCsv, diffLabPackages, CSV_MAX_BYTES } from '@/lib/scoring-policy/lab-packages-csv';
import { activeLabPackages, invalidateLabPackagesCache, LAB_PACKAGES_NOTE_TYPE } from '@/lib/scoring-policy/lab-packages';
import { cleanAttribution, ATTRIBUTION_REQUIRED_ERROR } from '@/lib/admin-attribution';

export async function POST(req: NextRequest) {
  if (!(await authedAdminRequest(req))) return NextResponse.json({ ok: false, error: 'admin required' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const csv = typeof body.csv === 'string' ? body.csv : '';
  if (!csv.trim()) return NextResponse.json({ ok: false, error: 'No CSV content was uploaded.' }, { status: 400 });
  if (csv.length > CSV_MAX_BYTES * 2) return NextResponse.json({ ok: false, error: 'File is larger than 1 MB.' }, { status: 400 });

  const filename = typeof body.filename === 'string' ? body.filename : undefined;
  const parsed = parseLabPackagesCsv(csv, { filename });
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });

  const current = await activeLabPackages();
  const diff = diffLabPackages(current.packages, parsed.packages);

  // ── validate + diff only ──────────────────────────────────────────────────────────────────────
  if (body.publish !== true) {
    return NextResponse.json({
      ok: true, preview: true, diff, count: parsed.packages.length,
      currentCount: current.packages.length, currentVersion: current.version, origin: current.origin,
    });
  }

  // ── publish ───────────────────────────────────────────────────────────────────────────────────
  // THE ROUND-TRIP GUARANTEE: nothing moved ⇒ no version. Checked before publishVersion is called.
  if (diff.isEmpty) {
    return NextResponse.json({
      ok: true, noChange: true, diff, count: parsed.packages.length,
      message: 'This file is identical to the live set — no version was created.',
    });
  }

  const rationale = typeof body.rationale === 'string' ? body.rationale.trim() : '';
  if (rationale.length < MIN_RATIONALE_CHARS) {
    return NextResponse.json(
      { ok: false, error: `Why are you making this change? A written rationale of at least ${MIN_RATIONALE_CHARS} characters is required.` },
      { status: 400 },
    );
  }

  // §12.4 — required alongside the rationale, rejected server-side too. Deliberately checked AFTER
  // the `noChange` short-circuit above, so re-uploading an unmodified export still creates no
  // version and still demands nothing: the round-trip guarantee is not weakened by attribution.
  const changedBy = cleanAttribution(body.published_by_name ?? body.changedBy);
  if (!changedBy) return NextResponse.json({ ok: false, error: ATTRIBUTION_REQUIRED_ERROR }, { status: 400 });

  // ⚠️ THE ARRAY SHAPE. `weights` carries a package ARRAY for note_type='lab_packages', where the
  // two weightage note types carry a {fieldKey: tier} OBJECT. Intentional divergence (§12.3); the
  // readers branch on note_type. `publishVersion` stores the value verbatim, so it is passed as-is.
  const result = await publishVersion({
    noteType: LAB_PACKAGES_NOTE_TYPE,
    vector: parsed.packages as unknown as Record<string, never>,
    rationale: rationale.slice(0, 4000),
    publishedBy: typeof body.published_by === 'string' ? body.published_by.slice(0, 200) : null,
    publishedByName: changedBy,
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error ?? 'publish failed' }, { status: 500 });

  invalidateLabPackagesCache();
  return NextResponse.json({
    ok: true, version: result.version, versionString: result.versionString,
    diff, count: parsed.packages.length, toast: `Version ${result.version} published`,
  });
}
