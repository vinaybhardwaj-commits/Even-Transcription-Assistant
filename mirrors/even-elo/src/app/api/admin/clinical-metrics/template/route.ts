import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET() {
  const csv = [
    "physician_email,hospital_code,year,month,opd_count,ipd_admissions,ot_cases,revenue_inr",
    "vinay.bhardwaj@even.in,EHRC,2026,4,42,15,3,825000",
    "vinay.bhardwaj@even.in,EHRC,2026,5,48,18,4,910000",
  ].join("\n") + "\n";
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="epi-clinical-metrics-template.csv"',
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
