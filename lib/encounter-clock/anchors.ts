/**
 * lib/encounter-clock/anchors.ts — Pulse consult ANCHORS for one room-day (epic #23, ticket g).
 *
 * A doctor's Start-consult click in Pulse is the strongest start signal the encounter clock has. End is
 * weaker: doctors often skip End consult, and the resolver then closes the window on a fallback
 * (lib/encounter-windows/compute.ts). This module turns resolved windows into anchors for the timeline
 * (ticket e), fusion (f) and E-7 scoring (h).
 *
 * THE RESOLVER IS NOT CHANGED. `close_reason`, its CHECK (0123) and EXPLICIT_CLOSE (compute.ts), which
 * counts `url_clear` as explicit, all stay as they are — and so does the consult cutter's Python copy
 * (tools/eta-consult-cutter/cutter/config.py). The split lives only here, as a DERIVED `close_kind` plus
 * `end_clicked`: only a real endConsult is a clicked end; `url_clear` (the doctor left the patient page)
 * is a WEAK end like every other fallback.
 *
 * READ-ONLY. One read through the existing queryWindows (lib/encounter-windows/db.ts), plus one row of
 * look-ahead so the day's last anchor still knows the next Start. No writes, no migration, no Pulse code.
 */
import { queryWindows, type CloseReason, type EncounterWindowRead, type Quality, type WindowsDb } from "@/lib/encounter-windows";

export type CloseKind = "clicked_end" | "url_clear" | "next_open" | "logout" | "idle" | "cap" | "open";

/** One CloseKind per CloseReason. A Record, so a new close_reason fails typecheck until it is mapped here. */
export const CLOSE_KIND: Readonly<Record<CloseReason, CloseKind>> = {
  endConsult: "clicked_end",
  url_clear: "url_clear",
  next_open: "next_open",
  logout: "logout",
  idle_timeout: "idle",
  cap_90m: "cap",
  open: "open",
};

/** Qualities whose START is shaky: two doctors present, or no attribution with several candidates. Scored separately (PRD §6.7). */
const WEAK_START: ReadonlySet<Quality> = new Set(["multi_doctor", "ambiguous"]);

export type DoctorSource = "warehouse" | "extension" | "none";

export type Anchor = {
  consult_key: string;
  room_id: string;
  /** Epoch ms of the Start click (t_open). */
  start_ms: number;
  close_kind: CloseKind;
  end_clicked: boolean;
  /** Epoch ms of a real End click; null otherwise. */
  end_click_ms: number | null;
  /** Epoch ms of a fallback close (anything but a click); null when clicked or still open. */
  end_weak_ms: number | null;
  end_weak_kind: Exclude<CloseKind, "clicked_end" | "open"> | null;
  /** Epoch ms of the next Start in the same room; null when there is none yet. */
  next_start_ms: number | null;
  doctor_uid_warehouse: string | null;
  doctor_uid_ext: string | null;
  /** Which doctor DOC-matching should use: the warehouse's first, else the extension's (PRD §6.7). */
  doctor_source: DoctorSource;
  quality: Quality;
  weak_start: boolean;
};

const ms = (iso: string | null): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/**
 * PURE — rows (any order) → anchors in Start order. `lookahead` is the first window opened at or after the
 * range's end, used only as the last anchor's next Start. Rows with no room or an unreadable t_open are
 * skipped and COUNTED, never guessed. Ties on start are broken by consult_key so the order is stable.
 */
export function toAnchors(
  rows: ReadonlyArray<EncounterWindowRead>,
  lookahead: EncounterWindowRead | null = null,
): { anchors: Anchor[]; skipped: number } {
  let skipped = 0;
  const usable: Array<{ r: EncounterWindowRead; start: number }> = [];
  for (const r of rows) {
    const start = ms(r.t_open);
    if (r.room_id === null || start === null) {
      skipped++;
      continue;
    }
    usable.push({ r, start });
  }
  usable.sort((a, b) => a.start - b.start || (a.r.consult_key < b.r.consult_key ? -1 : a.r.consult_key > b.r.consult_key ? 1 : 0));

  const anchors = usable.map(({ r, start }, i): Anchor => {
    const kind = CLOSE_KIND[r.close_reason];
    const clicked = kind === "clicked_end";
    const close = ms(r.t_close);
    const next = usable[i + 1];
    const nextStart = next ? next.start : lookahead && lookahead.room_id === r.room_id ? ms(lookahead.t_open) : null;
    const wh = r.warehouse_doctor_uid;
    const ext = r.doctor_uid;
    return {
      consult_key: r.consult_key,
      room_id: r.room_id!,
      start_ms: start,
      close_kind: kind,
      end_clicked: clicked,
      end_click_ms: clicked ? close : null,
      end_weak_ms: !clicked && kind !== "open" ? close : null,
      end_weak_kind: !clicked && kind !== "open" && close !== null ? (kind as Exclude<CloseKind, "clicked_end" | "open">) : null,
      next_start_ms: nextStart,
      doctor_uid_warehouse: wh,
      doctor_uid_ext: ext,
      doctor_source: wh ? "warehouse" : ext ? "extension" : "none",
      quality: r.quality,
      weak_start: WEAK_START.has(r.quality),
    };
  });
  return { anchors, skipped };
}

const IST_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** PURE — the IST calendar day as [from, to) ISO instants. */
export function istDayRange(istDate: string): { from: string; to: string } {
  if (!IST_DATE_RE.test(istDate)) throw new Error("ist_date must be YYYY-MM-DD");
  const from = Date.parse(`${istDate}T00:00:00+05:30`);
  if (!Number.isFinite(from)) throw new Error("ist_date is not a date");
  return { from: new Date(from).toISOString(), to: new Date(from + 86_400_000).toISOString() };
}

/** The anchors for one room on one IST day. Two reads, both through queryWindows; nothing is written. */
export async function loadAnchors(db: WindowsDb, roomId: string, istDate: string): Promise<{ anchors: Anchor[]; skipped: number }> {
  const { from, to } = istDayRange(istDate);
  const rows = await queryWindows(db, { room_id: roomId, from, to, limit: 5000 });
  const [lookahead] = await queryWindows(db, { room_id: roomId, from: to, limit: 1 });
  return toAnchors(rows, lookahead ?? null);
}
