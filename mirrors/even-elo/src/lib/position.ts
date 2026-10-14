/**
 * Position helpers (EPI.0b).
 *
 * v1 stored the current position in localStorage via a chip-picker. EPI.0b
 * derives position from the auth JWT instead. The login route sets two
 * cookies:
 *   epi_session  (httpOnly) — JWT for server verification
 *   epi_position (readable) — current position label for client display
 *
 * This file keeps the same exported names (`getCurrentPosition`, etc.) so
 * v1 ELO pages that import them still type-check and run. Functions that
 * used to mutate localStorage are now no-ops; auth is the source of truth.
 *
 * After EPI.0b's server-side refactor (task 28), the position label sent
 * from client pages in write requests is IGNORED — the server uses the
 * JWT. Client-side display can still read it via getCurrentPosition() for
 * "Stamped as:" labels.
 */

const POSITION_COOKIE = "epi_position";

/** v1 catalogue retained for components that render position lists. */
export interface PositionSeed {
  name: string;
  team: string;
  description: string;
}

export const POSITION_SEEDS: PositionSeed[] = [
  { name: "OT Coordinator",          team: "OT",         description: "Creates cases · OT discipline + return-to-OT" },
  { name: "Anesthesia Coordinator",  team: "Anesthesia", description: "PAC completion" },
  { name: "Medical Superintendent",  team: "MS",         description: "Mortality, readmission, discharge summary, rounds" },
  { name: "ICN Lead",                team: "ICN",        description: "Surgical site infections" },
  { name: "Clinical Pharmacologist", team: "Pharmacy",   description: "Antibiotic stewardship" },
  { name: "Customer Care Lead",      team: "CC",         description: "NPS, complaints, family communication" },
  { name: "Billing Lead",            team: "Billing",    description: "Insurance denials" },
  { name: "Unit Head",               team: "UnitHead",   description: "Anomaly flags, behavioural patterns" },
  { name: "Committee Admin",         team: "Admin",      description: "Roster, weights, stream config" },
];

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const parts = document.cookie.split(";");
  for (const p of parts) {
    const [k, ...v] = p.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Returns the current user's position label from the readable cookie. */
export function getCurrentPosition(): string | null {
  return readCookie(POSITION_COOKIE);
}

/** No-op — auth is the source of truth. Kept for back-compat. */
export function setCurrentPosition(_name: string): void {
  // intentionally empty
}

/** No-op — logout clears via /api/auth/logout. */
export function clearCurrentPosition(): void {
  // intentionally empty
}

export const POSITION_CHANGE_EVENT = "epi-position-changed";

/**
 * Subscribe to position changes. Fires once on mount with the current value.
 * Returns an unsubscribe function. Auth flows (login/logout) trigger a full
 * page navigation so we don't need to poll cookies in practice.
 */
export function onPositionChange(handler: (name: string | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  handler(getCurrentPosition());
  return () => {};
}

export const STORAGE_KEY = POSITION_COOKIE;
