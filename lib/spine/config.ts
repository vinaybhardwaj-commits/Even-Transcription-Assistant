/**
 * lib/spine/config.ts — the S1 gate. spine_config has no seed rows, so a missing or malformed value means off.
 *   kill_switch  {on: boolean} or a bare boolean. true, or anything else that is present (a string included), means off. A missing row is not a kill (ingest itself defaults to off).
 *   ingest       "shadow" | "live", or {mode: "shadow"|"live"}. Anything else, or missing, means off.
 */
export type IngestMode = "off" | "shadow" | "live";

const val = (v: unknown): unknown => { if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } } return v; };   // the driver may hand a jsonb back as text (ingest only)

export function parseIngestMode(rows: ReadonlyArray<{ key: string; value: unknown }>): IngestMode {
  const m = new Map(rows.map((r) => [r.key, r.key === "ingest" ? val(r.value) : r.value] as const));   // kill_switch is never decoded: a string there is malformed, i.e. killed
  if (m.has("kill_switch")) {
    const k = m.get("kill_switch");
    const on = typeof k === "boolean" ? k : k && typeof k === "object" && typeof (k as { on?: unknown }).on === "boolean" ? (k as { on: boolean }).on : true;
    if (on) return "off";
  }
  const i = m.get("ingest");
  const mode = i && typeof i === "object" ? (i as { mode?: unknown }).mode : i;
  return mode === "shadow" || mode === "live" ? mode : "off";
}
