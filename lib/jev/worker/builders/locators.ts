/**
 * lib/jev/worker/builders/locators.ts — the pitch and doubt subjects (PRD §6, §8): `<consult_key>#p<n>` and `<consult_key>#d<n>`.
 *
 * CODE OR THE AGENT ENUMERATES them; Jev does not. A subject is therefore a consult plus a LOCATOR (the time near which the suggestion or doubt is, an optional type hint
 * for a pitch, the extracted doubt text for a doubt). P2 has no enumeration source in the database (the agent's rubric run holds closed codes, not times), so locators
 * are handed in by the bench runner from its subject list and registered here; a subject with no locator is an `abstain: no_locator` row, never a guess. P4 wires the agent's list.
 * A doubt state is the excerpt -45 s / +150 s and never the agent's coding.
 */
import { readConsultText, type ConsultText } from "@/lib/rubrics/readers/consult-text";
import { transcriptState, type Focus } from "./transcript";
import type { StateBuild } from "../uses";

const locators = new Map<string, Focus>();
export const setLocator = (subjectId: string, f: Focus): void => { locators.set(subjectId, f); };
export const clearLocators = (): void => { locators.clear(); };

export const SUBJECT_P = /^([A-Za-z0-9_.:@-]{1,120})#p(\d{1,3})$/;
export const SUBJECT_D = /^([A-Za-z0-9_.:@-]{1,120})#d(\d{1,3})$/;
export const DOUBT_BEFORE_MS = 45_000;
export const DOUBT_AFTER_MS = 150_000;

export type ReadDeps = { read: (consultKey: string) => Promise<{ ok: true; data: Pick<ConsultText, "lines" | "source"> } | { ok: false; reason: string }> };
export const defaultReadDeps: ReadDeps = { read: async (k) => { const r = await readConsultText(k); return r.ok ? { ok: true, data: r.data } : { ok: false, reason: r.reason }; } };

export async function buildPitchState(subjectId: string, deps: ReadDeps = defaultReadDeps): Promise<StateBuild | null> {
  const m = SUBJECT_P.exec(subjectId);
  if (!m) return null;
  const focus = locators.get(subjectId);
  if (!focus) return { abstain: "no_locator" };
  const got = await deps.read(m[1]!);
  if (!got.ok) return null;
  return transcriptState(m[1]!, got.data, { focus });
}

export async function buildDoubtState(subjectId: string, deps: ReadDeps = defaultReadDeps): Promise<StateBuild | null> {
  const m = SUBJECT_D.exec(subjectId);
  if (!m) return null;
  const focus = locators.get(subjectId);
  if (!focus) return { abstain: "no_locator" };
  const got = await deps.read(m[1]!);
  if (!got.ok) return null;
  return transcriptState(m[1]!, got.data, { focus, excerpt: { before_ms: DOUBT_BEFORE_MS, after_ms: DOUBT_AFTER_MS } });
}

/** A consult subject (pitch-detect, chair-affect): the whole clip. */
export async function buildConsultState(consultKey: string, deps: ReadDeps = defaultReadDeps): Promise<StateBuild | null> {
  if (!/^[A-Za-z0-9_.:@-]{1,120}$/.test(consultKey)) return null;
  const got = await deps.read(consultKey);
  if (!got.ok) return null;
  return transcriptState(consultKey, got.data);
}
