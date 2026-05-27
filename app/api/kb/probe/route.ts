/**
 * GET /api/kb/probe?q=<question> — smoke endpoint for the KB.
 *
 * Returns top-K hits with similarity scores so we can verify the
 * embedding + retrieval round-trip end-to-end without standing up
 * the full CDMSS pipeline. Gated by ADMIN_TOKEN bearer to avoid
 * exposing the KB to the world.
 *
 * Remove after Sprint 3 is shipped — replaced by structured retrieval
 * inside the /process pipeline.
 */
import { NextRequest } from "next/server";
import { retrieve } from "@/lib/kb-retrieve";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${process.env.ADMIN_TOKEN ?? ""}`;
  if (!process.env.ADMIN_TOKEN || auth !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const q = req.nextUrl.searchParams.get("q") ?? "";
  if (q.length < 3) {
    return new Response(JSON.stringify({ error: "q_too_short_min_3" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const topK = parseInt(req.nextUrl.searchParams.get("topK") ?? "5", 10);

  const r = await retrieve(q, { topK });
  if (!r.ok) {
    return new Response(JSON.stringify({ error: r.error }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(
    JSON.stringify({
      query: q,
      embed_ms: r.embed_ms,
      query_ms: r.query_ms,
      hits: r.hits.map((h) => ({
        id: h.id,
        book: h.book,
        chapter: h.chapter,
        section: h.section,
        page_start: h.page_start,
        page_end: h.page_end,
        similarity: typeof h.similarity === "number" ? Number(h.similarity.toFixed(4)) : 0,
        text_preview: (h.text || "").slice(0, 200),
      })),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}
