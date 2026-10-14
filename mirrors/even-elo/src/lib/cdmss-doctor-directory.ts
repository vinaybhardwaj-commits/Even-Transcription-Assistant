import { parseDirectory, type DirectoryDoctor } from "@/lib/cdmss-doctor-mapping";

const BASE = process.env.GOV_API_BASE || "https://even-cdmss.vercel.app";

/**
 * Fetch the canonical CDMSS doctor roster (`GET /api/governance/doctor-directory`). THROWS on any
 * failure: a mapping run against a half-read directory would report fake "unmatched" doctors.
 * Admin-triggered only, never in a doctor-facing request path.
 */
export async function fetchDoctorDirectory(): Promise<DirectoryDoctor[]> {
  const key = process.env.GOV_API_KEY;
  if (!key) throw new Error("GOV_API_KEY not configured");
  const res = await fetch(`${BASE}/api/governance/doctor-directory`, {
    headers: { "x-api-key": key },
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`CDMSS doctor-directory ${res.status}`);
  const json = (await res.json()) as { ok?: boolean };
  if (json?.ok === false) throw new Error("CDMSS doctor-directory not ok");
  const doctors = parseDirectory(json);
  if (doctors.length === 0) throw new Error("CDMSS doctor-directory returned no doctors");
  return doctors;
}
