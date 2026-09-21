/**
 * lib/overnight-translate/gate.ts — the two gates checked before EVERY submit: the Mini's watchdog,
 * and free disk.
 *
 * The watchdog rule is the Orchestrator's, unchanged from the night-drain: GO when the verdict does not
 * start with `STOP_` AND `diarize_ms` is under 400. `free_pct` is NEVER read — it lies on this box.
 * FAIL CLOSED: an unreadable line, a `diarize_ms` that is not a finite number, or a line older than
 * PRESSURE_MAX_AGE_MS (the watchdog itself has died, and a dead watchdog leaves its last "ok" behind for
 * ever) is NO-GO.
 *
 * The disk floor is the second rule V's brief names ("stop on any STOP verdict or disk under 40 GB").
 * The night-drain gets it from a wrapper script; this driver checks it itself, per submit, because a
 * wrapper that only polls every 60 s can miss a fast fall between two submits.
 *
 * WHY THIS GATE MATTERS MORE HERE THAN IT DID FOR DIARIZE. qwen2.5:14b is ~9 GB on disk and 10-11.5 GB
 * resident on a 24 GB Mini that is also running Whisper, the Indic engines and, on the same nights, the
 * night-drain's diarize service. Ollama unloads it 5 minutes after the last call, but while it is loaded
 * the headroom is what the watchdog is measuring. A submit is the only moment this driver can decline to
 * add load, so the gate is read before each one and never cached.
 *
 * PURE except readLastLine / freeDiskGb, which are injected in the driver and exercised by tests.
 */
import { openSync, fstatSync, readSync, closeSync, statfsSync } from "node:fs";

export const DIARIZE_MS_LIMIT = 400;
export const PRESSURE_MAX_AGE_MS = 120_000;
export const DISK_FLOOR_GB = 40;
export const DEFAULT_PRESSURE_FILE = `${process.env.HOME ?? ""}/dev/mini-pressure.jsonl`;

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

/** PURE — the watchdog decision. `reason` is a short code for the log; it carries no free text. */
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

/** PURE — the disk decision. An unknown reading is NO-GO: a floor that fails open is not a floor. */
export function diskDecision(freeGb: number | null, floorGb = DISK_FLOOR_GB): GateDecision {
  if (freeGb === null || !Number.isFinite(freeGb)) return { go: false, reason: "disk:unreadable" };
  if (freeGb < floorGb) return { go: false, reason: `disk:${Math.floor(freeGb)}GB<${floorGb}GB` };
  return { go: true, reason: "ok" };
}

/** PURE — both gates, watchdog first (it is the one that names WHY the Mini is busy). */
export function gateDecision(line: string | null, nowMs: number, freeGb: number | null): GateDecision {
  const p = pressureDecision(line, nowMs);
  if (!p.go) return p;
  return diskDecision(freeGb);
}

/** The last non-empty line of a file, reading only its tail. Null when the file is missing or empty. */
export function readLastLine(path: string, tailBytes = 8192): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    console.warn(`[overnight-translate] pressure file unreadable: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
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

/** Free space on the volume holding `path`, in GB (1e9 bytes), or null when it cannot be read. */
export function freeDiskGb(path = "/"): number | null {
  try {
    const s = statfsSync(path);
    return (Number(s.bavail) * Number(s.bsize)) / 1e9;
  } catch {
    return null;
  }
}
