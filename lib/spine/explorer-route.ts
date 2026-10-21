/** lib/spine/explorer-route.ts — the guard shared by the three explorer routes (Spine S4b): the catalog's bearer-only admin check, then the spine_config `explorer` flag. */
import { NextRequest, NextResponse } from "next/server";
import { requireAdminBearer } from "@/lib/encounter-catalog/auth";
import { readExplorerEnabled } from "./explorer-read";

export const NO_STORE = { headers: { "cache-control": "no-store" } };
export const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status, ...NO_STORE });

/** null = proceed. 401 without the admin bearer (a `token` query param is 401 too); 404 when the explorer flag is missing, malformed or off. */
export async function explorerGate(req: NextRequest): Promise<NextResponse | null> {
  const denied = requireAdminBearer(req);
  if (denied) return denied;
  return (await readExplorerEnabled()) ? null : fail(404, "not_found");
}

export const dbFail = (e: unknown) => fail(503, `db:${(e as { code?: string }).code ?? "unknown"}`);
