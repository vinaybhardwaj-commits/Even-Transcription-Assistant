/**
 * lib/night-drain/pressure.ts — the watchdog gate.
 *
 * The Mini's watchdog appends one JSON line every ~30 s to mini-pressure.jsonl. The rule, from the
 * Orchestrator: GO when the verdict does not start with `STOP_` AND `diarize_ms` is under 400.
 * `free_pct` is NEVER read — it lies on this box.
 *
 * FAIL CLOSED. A line the drain cannot read, a `diarize_ms` that is not a finite number, or a line
 * older than PRESSURE_MAX_AGE_MS (the watchdog itself has died) is NO-GO. Only the age check is an
 * addition to the Orchestrator's rule, and it exists because a dead watchdog leaves its last
 * "ok" line in the file for ever.
 */
import { openSync, fstatSync, readSync, closeSync } from "node:fs";

export const DIARIZE_MS_LIMIT = 400;
export const PRESSURE_MAX_AGE_MS = 120_000;
export const DEFAULT_PRESSURE_FILE = "/Users/vinaybhardwaj/dev/mini-pressure.jsonl";

export type PressureLine = { t: string; verdict: string; diarize_ms: number };

export type GateDecision = { go: boolean; reason: string };

/** PURE — parse one watchdog line. Reads only t, verdict and diarize_ms. */
export function parsePressureLine(line: string | null): { ok: true; p: PressureLine } | { ok: false; reason: string } {
  if (!line || !line.trim()) return { ok: false, reason: "no_line" };
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch (e) {
    return { ok: false, reason: `unparseable:${(e as Error).name}` };
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, reason: "not_an_object" };
  const r = o as Record<string, unknown>;
  if (typeof r.t !== "string" || typeof r.verdict !== "string") return { ok: false, reason: "missing_t_or_verdict" };
  const d = r.diarize_ms;
  if (typeof d !== "number" || !Number.isFinite(d)) return { ok: false, reason: "diarize_ms_not_a_number" };
  return { ok: true, p: { t: r.t, verdict: r.verdict, diarize_ms: d } };
}

/** PURE — the decision. `reason` is a short code for the progress log; it carries no free text. */
export function pressureDecision(line: string | null, nowMs: number): GateDecision {
  const parsed = parsePressureLine(line);
  if (!parsed.ok) return { go: false, reason: `unreadable:${parsed.reason}` };
  const { p } = parsed;
  const at = Date.parse(p.t);
  if (!Number.isFinite(at)) return { go: false, reason: "unreadable:bad_timestamp" };
  const age = nowMs - at;
  if (age > PRESSURE_MAX_AGE_MS) return { go: false, reason: `stale:${Math.round(age / 1000)}s` };
  if (p.verdict.startsWith("STOP_")) return { go: false, reason: `stop:${p.verdict}` };
  if (p.diarize_ms >= DIARIZE_MS_LIMIT) return { go: false, reason: `diarize_ms:${Math.round(p.diarize_ms)}` };
  return { go: true, reason: "ok" };
}

/** The last non-empty line of a file, reading only its tail. Null when the file is missing or empty. */
export function readLastLine(path: string, tailBytes = 8192): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    console.warn(`[night-drain] pressure file unreadable: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, tailBytes);
    if (len === 0) return null;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim() !== "");
    return lines.length ? lines[lines.length - 1]! : null;
  } finally {
    closeSync(fd);
  }
}
