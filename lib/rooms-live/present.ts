/**
 * lib/rooms-live/present.ts — what the screen SAYS (SPEC-v1 §4): grouping, counts, the exact copy, colours. Pure, so the copy is unit-tested word for word.
 */
import type { RoomRow } from "./snapshot";
import type { RoomStateName } from "./state";

export type Group = "attention" | "fine" | "nodoctor";
export const PROBLEM_STATES: readonly RoomStateName[] = ["muted", "unplugged", "notrec", "off"];

type Grouped = Pick<RoomRow, "doctor" | "state"> & { doctor_known?: boolean };

/**
 * FIX-1 F1/F6. A doctor whose tile shows a name is never counted under "No doctor signed in". A room whose doctor could not be read (`doctor_known` false) is NOT
 * "no doctor": a problem state stays in Needs attention, and listening/quiet stays Fine. An unreadable room (state unknown) with a doctor needs someone to look.
 */
export function groupOf(r: Grouped): Group {
  const unknownDoctor = r.doctor_known === false;
  if (!r.doctor && !unknownDoctor) return "nodoctor";
  if (PROBLEM_STATES.includes(r.state)) return "attention";
  if (r.state === "listening" || r.state === "quiet") return "fine";
  return r.doctor ? "attention" : "nodoctor"; // state unknown
}

export function counts(rows: readonly Grouped[]): { need: number; fine: number; nodoctor: number } {
  const c = { need: 0, fine: 0, nodoctor: 0 };
  for (const r of rows) {
    const g = groupOf(r);
    if (g === "attention") c.need++;
    else if (g === "fine") c.fine++;
    else c.nodoctor++;
  }
  return c;
}

export const isProblem = (s: RoomStateName): boolean => PROBLEM_STATES.includes(s);

export const WORD: Record<RoomStateName, string> = {
  listening: "Listening",
  quiet: "Quiet",
  muted: "Mic silent",
  unplugged: "Mic unplugged",
  notrec: "Not recording",
  off: "Computer off",
  unknown: "Can't tell",
};
export const ICON: Record<RoomStateName, string> = { listening: "✓", quiet: "…", muted: "⊘", unplugged: "⚠", notrec: "■", off: "⏻", unknown: "?" };
export const COLORS: Record<RoomStateName, { fg: string; bg: string }> = {
  listening: { fg: "#1D6B57", bg: "#E2F0EA" },
  quiet: { fg: "#4F535A", bg: "#ECEBE6" },
  muted: { fg: "#A84A06", bg: "#FBE9D6" },
  unplugged: { fg: "#9E2A1E", bg: "#F9E1DC" },
  notrec: { fg: "#9E2A1E", bg: "#F9E1DC" },
  off: { fg: "#2F343B", bg: "#E4E5E7" },
  unknown: { fg: "#4F535A", bg: "#ECEBE6" },
};
export const GROUND = "#F6F5F2";

/** the last line of every problem state (no phone number: the ETA team is on site; the card itself escalates) */
export const STILL_NOT_WORKING = "Still not working? This card turns darker red the longer it stays, so everyone can see it.";

export function stepsFor(state: RoomStateName): string[] {
  switch (state) {
    case "muted":
      return ["Check the webcam's USB cable is pushed firmly into the back of the room computer. If it does not clear in 5 minutes, tell IT."];
    case "unplugged":
      return ["The computer cannot find the webcam mic. Push the webcam's USB cable firmly into the back of the room computer.", "Wait 30 seconds. The card clears by itself.", STILL_NOT_WORKING];
    case "notrec":
      return ["Recording restarts by itself within 5 minutes.", STILL_NOT_WORKING];
    case "off":
      return ["Check the room computer is switched on.", "Check its power cable and network cable.", STILL_NOT_WORKING];
    case "unknown":
      return ["No live sound reading from this room. Check the room computer is on."];
    default:
      return [];
  }
}

export function headline(r: Pick<RoomRow, "state" | "detail_code">): string {
  if (r.detail_code === "restarting") return "Recording is restarting by itself.";
  switch (r.state) {
    case "listening":
      return "The mic is hearing the room";
    case "quiet":
      return "Recording. Nobody is talking right now";
    case "muted":
      return "The mic is sending only silence";
    case "unplugged":
      return "The mic is unplugged";
    case "notrec":
      return r.detail_code === "app_not_responding" ? "The recording app is not responding" : "Not recording";
    case "off":
      return "The room computer looks switched off";
    default:
      return "Can't tell right now";
  }
}

/** staff-facing words for the "Today" strip (room_audio_state segment codes never reach the screen) */
export const SEGMENT_WORD: Record<string, string> = {
  audio_present: "Recording", speech: "Recording", consult: "Recording", audio_gated: "Quiet", room_quiet: "Quiet", withheld: "Quiet",
  muted: "Mic silent", zero_all_day: "Mic silent", device_missing: "Mic unplugged", device_dead: "Mic unplugged", recorder_off: "Not recording",
};
/** a segment code this screen does not know is shown as "Unknown", never guessed as Quiet */
export const segmentWord = (state: string): string => SEGMENT_WORD[state] ?? "Unknown";
/** the legend under the strip: words with their colours */
export const DAY_LEGEND: ReadonlyArray<{ word: string; color: string }> = [
  { word: "Recording", color: "#1D6B57" }, { word: "Quiet", color: "#8FB9AB" }, { word: "Mic silent", color: "#A84A06" }, { word: "Mic unplugged", color: "#9E2A1E" }, { word: "Not recording", color: "#C9CBCF" }, { word: "Computer off", color: "#2F343B" }, { word: "Unknown", color: "#8A8E96" },
];
export const segmentColor = (state: string): string => DAY_LEGEND.find((l) => l.word === segmentWord(state))!.color;

export const DEGRADED_NOTE = "Some live readings are delayed. This screen may be a few minutes behind.";
/** where a 401 sends the page: back to the staff login on THIS screen, never to /admin */
export const LOGIN_PATH = "/rooms-live";

export const NO_DOCTOR_PROBLEM_NOTE = "Check before the next doctor arrives";
/** FIX-2 N1: only when the doctor is KNOWN to be absent; an unreadable doctor (occupancy degraded) is not "no doctor" */
export const showNoDoctorNote = (r: Pick<RoomRow, "state" | "doctor"> & { doctor_known?: boolean }): boolean => isProblem(r.state) && !r.doctor && r.doctor_known !== false;

export function forMinutes(since: string | null, nowMs: number): string | null {
  if (!since) return null;
  const t = Date.parse(since);
  if (!Number.isFinite(t) || t > nowMs) return null;
  const m = Math.floor((nowMs - t) / 60_000);
  return m < 1 ? "For under a minute" : m < 120 ? `For ${m} min` : `For ${Math.floor(m / 60)} h ${m % 60} min`;
}

/** 0..1 for the sound bar: a log scale, 0.001 -> 0 and 0.1 -> 1 (healthy ambient 0.01 sits at the middle) */
export function barFraction(rms: number | null): number {
  if (rms === null || !(rms > 0)) return 0;
  return Math.max(0, Math.min(1, (Math.log10(rms) + 3) / 2));
}
