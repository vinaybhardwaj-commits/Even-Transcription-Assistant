import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FileBlob {
  filename: string;
  mime: string;
  size_bytes: number;
  data: string;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string; qid: string }> }) {
  const { id, qid } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(qid)) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500 });
  const sql = neon(url);
  const rows = (await sql`
    SELECT file_data FROM qualifications
    WHERE id = ${qid}::uuid AND physician_id = ${id}::uuid
  `) as Array<{ file_data: FileBlob | null }>;
  if (rows.length === 0 || !rows[0].file_data) {
    return NextResponse.json({ ok: false, error: "no file" }, { status: 404 });
  }
  const f = rows[0].file_data;
  const buf = Buffer.from(f.data, "base64");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": f.mime,
      "Content-Length": String(buf.length),
      "Content-Disposition": `inline; filename="${f.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}
