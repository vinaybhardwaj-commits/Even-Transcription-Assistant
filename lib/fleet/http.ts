import { NextResponse } from "next/server";
export const fleetReply = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
export const fleetError = (status: number, code: string) => fleetReply(status, { ok: false, error: code });
/** Read a request body as text, refusing more than `max` bytes. Null = too large. */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > max) return null;
  const text = await req.text();
  return Buffer.byteLength(text, "utf8") > max ? null : text;
}
