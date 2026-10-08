/**
 * lib/rooms-live/steward-history.ts — A1 S7 / S8: the pure parts of the Steward log page. No I/O.
 * parseDay: the IST date asked for, today when it is missing / malformed / in the future / older than 30 days (a bad date never errors: it shows today).
 * collapseRows: consecutive ok rows of the same mode become one "All fine HH:MM-HH:MM (N checks)" item. Rows come newest first.
 * resultWords: the outcome in plain words. Every sentence comes from steward-lines.ts (one mapping table); no raw rule / action / result name is rendered.
 */
import { istHm, lineOf, outcomeOf, whyOf, type StewardLine, type StewardRowIn } from "./steward-lines";

const IST_MS = 19_800_000;
const DAY_MS = 86_400_000;
export const RETENTION_DAYS = 30;

export type DayWindow = { date: string; fromIso: string; toIso: string; isToday: boolean; minDate: string; maxDate: string };

const istDate = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(0, 10);

export function parseDay(raw: string | null | undefined, nowMs: number): DayWindow {
  const today = istDate(nowMs);
  const minDate = istDate(nowMs - RETENTION_DAYS * DAY_MS);
  let date = today;
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) && Number.isFinite(Date.parse(`${raw}T00:00:00Z`)) && istDate(Date.parse(`${raw}T00:00:00Z`)) === raw && raw >= minDate && raw <= today) date = raw;
  const from = Date.parse(`${date}T00:00:00Z`) - IST_MS;
  return { date, fromIso: new Date(from).toISOString(), toIso: new Date(from + DAY_MS).toISOString(), isToday: date === today, minDate, maxDate: today };
}

export const parseOffset = (raw: string | null | undefined): number => {
  const n = typeof raw === "string" && /^\d{1,5}$/.test(raw) ? Number(raw) : 0;
  return Math.min(10_000, n);
};

export type HistoryRowIn = StewardRowIn & { room_id: string };
export type HistoryItem =
  | { type: "fine"; room_id: string; mode: "live" | "shadow"; fromHm: string; toHm: string; count: number; text: string }
  | { type: "row"; room_id: string; line: StewardLine; hm: string; result: string; why: string | null };

export function resultWords(r: StewardRowIn): string {
  if (r.action === "none" || r.action === "log_only") return "";
  const o = outcomeOf(r.mode, r.result);
  if (o === "watching") return "not done (watching only)";
  if (o === "done") return "done";
  if (o === "pending") return "waiting for the kiosk";
  if (o === "failed") return /no ack/i.test(r.result ?? "") ? "kiosk didn't answer" : "didn't go through";
  return /^\s*skipped:\s*kiosk not listening/i.test(r.result ?? "") ? "skipped, kiosk not ready" : "not sent";
}

const isOk = (r: StewardRowIn) => r.rule === "ok" && (r.action === "none" || r.action === "log_only");

/** newest-first rows -> items. A run of consecutive ok rows (same room, same mode) is ONE item; its times are oldest-newest. */
export function collapseRows(rows: readonly HistoryRowIn[]): HistoryItem[] {
  const out: HistoryItem[] = [];
  for (const r of rows) {
    if (isOk(r)) {
      const last = out[out.length - 1];
      const mode = r.mode === "live" ? "live" : "shadow";
      if (last && last.type === "fine" && last.room_id === r.room_id && last.mode === mode) {
        last.fromHm = istHm(r.ts);
        last.count += 1;
        last.text = fineText(last.fromHm, last.toHm, last.count);
      } else {
        const hm = istHm(r.ts);
        out.push({ type: "fine", room_id: r.room_id, mode, fromHm: hm, toHm: hm, count: 1, text: fineText(hm, hm, 1) });
      }
      continue;
    }
    const line = lineOf(r);
    const speaks = r.action !== "message" && r.action !== "alert" && r.action !== "none" && r.action !== "log_only";
    out.push({ type: "row", room_id: r.room_id, line, hm: istHm(r.ts), result: resultWords(r), why: speaks ? whyOf(r.rule) : null });
  }
  return out;
}

const fineText = (from: string, to: string, n: number): string => `All fine ${from === to ? from : `${from}-${to}`} (${n} ${n === 1 ? "check" : "checks"})`;
