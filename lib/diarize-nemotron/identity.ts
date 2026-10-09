/**
 * lib/diarize-nemotron/identity.ts — ECAPA identity on Nemotron speakers (epic #23, ticket c).
 *
 * Nemotron gives speaker ACTIVITY only: no embeddings, no confidence. Every identity in ETA comes from an ECAPA
 * cosine match against enrolled centroids, so this pass sends each Nemotron speaker's LONGEST span to the Mini's
 * /embed_speakers (lib/diarize-embed.ts — the hybrid's own call, same model, same 0.65 threshold) and stores who
 * matched (0141). Everything here except the two centroid loaders is PURE.
 *
 * THE MATCH ORDER IS THE SERVICE'S. /embed_speakers keeps the index it is sent and matches greedily in speech-time
 * order. The app's shadow auditor (lib/stt/losing-score.ts, E20) walks speakers by ascending index. So the index
 * sent here IS the speech-time rank (most speech first; a tie goes to the lower spkN): the service's order and the
 * shadow's are then one order, and the shadow's control means what it says.
 *
 * A CLINICIAN IS NAMED ONLY WITH THE MATCH THAT NAMED IT, and only where a voiceprint was actually compared
 * (attributionFor's rule, per speaker): an embedding, AND at least one centroid offered. A losing candidate is kept
 * only when the shadow's own control, in this window, found nothing wrong (shadowTrusted), as the hybrid does.
 *
 * NO EMBEDDINGS LEAVE THIS MODULE. speakerIdentities reads them and returns ids and scores only.
 */
import { sql } from "@/lib/db";
import { parseFlag } from "@/lib/flags";
import type { EmbeddedSpeaker, EmbedRequestSpeaker } from "@/lib/diarize-embed";
import type { ClinicianCentroid } from "@/lib/stt/diarize-window";
import { shadowMatch, shadowTrusted, type ShadowGuard } from "@/lib/stt/losing-score";
import type { Anchor } from "@/lib/encounter-clock/anchors";
import type { SpeakerRole, TimelineInput } from "@/lib/encounter-clock/timeline";

export const NEMOTRON_IDENTITY_ENABLED_ENV = "NEMOTRON_IDENTITY_ENABLED";
export const IDENT_CENTROID_SET_ENV = "IDENT_CENTROID_SET";
export const CENTROID_SETS = ["voice_print", "voice_centroid:room_primary", "confirmed6"] as const;
export type CentroidSet = (typeof CENTROID_SETS)[number];
/** A failed pass is retried until this many attempts, then left failed. */
export const IDENTITY_MAX_ATTEMPTS = 3;
/** PROVISIONAL (PRD §6.3): a matched clinician must speak this long inside a probe for doctor_present. */
export const DOCTOR_PRESENT_MIN_MS = 5_000;

/** The scheduled enqueue's on-switch. Strict: a typo throws (FlagValueError), it never reads as off or on. */
export const nemotronIdentityEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  parseFlag(NEMOTRON_IDENTITY_ENABLED_ENV, env);

export class CentroidSetError extends Error {}

/** IDENT_CENTROID_SET: unset or blank = voice_print (PRD §8 default); anything not in CENTROID_SETS throws. */
export function centroidSetFrom(env: Record<string, string | undefined> = process.env): CentroidSet {
  const raw = (env[IDENT_CENTROID_SET_ENV] ?? "").trim();
  if (raw === "") return "voice_print";
  if ((CENTROID_SETS as readonly string[]).includes(raw)) return raw as CentroidSet;
  throw new CentroidSetError(`${IDENT_CENTROID_SET_ENV} must be one of ${CENTROID_SETS.join(", ")}`);
}

// ── turns ─────────────────────────────────────────────────────────────────────────────────────────────

export type NemoSegment = { start_ms: number; end_ms: number; speaker_idx: number };

/** PURE — a stored turns_json ([[start_ms, end_ms, "spkN"], …]) as segments, or null if any turn is malformed. */
export function segmentsFromTurns(turnsJson: unknown): NemoSegment[] | null {
  if (!Array.isArray(turnsJson)) return null;
  const out: NemoSegment[] = [];
  for (const t of turnsJson) {
    if (!Array.isArray(t) || t.length !== 3) return null;
    const [s, e, l] = t as unknown[];
    const m = typeof l === "string" ? /^spk(\d{1,2})$/.exec(l) : null;
    if (typeof s !== "number" || typeof e !== "number" || !m || !(s >= 0) || !(e > s)) return null;
    out.push({ start_ms: s, end_ms: e, speaker_idx: Number(m[1]) });
  }
  return out;
}

const label = (idx: number) => `spk${idx}`;

type Span = { start_ms: number; end_ms: number };

function unionMs(spans: ReadonlyArray<Span>): number {
  const sorted = [...spans].sort((a, b) => a.start_ms - b.start_ms);
  let total = 0, curS = -Infinity, curE = -Infinity;
  for (const s of sorted) {
    if (s.start_ms > curE) { if (curE > curS) total += curE - curS; curS = s.start_ms; curE = s.end_ms; }
    else curE = Math.max(curE, s.end_ms);
  }
  if (curE > curS) total += curE - curS;
  return total;
}

/** PURE — each speaker's own speech (their turns unioned), by Nemotron speaker index. */
export function speechMsBySpeaker(segs: ReadonlyArray<NemoSegment>): Map<number, number> {
  const by = new Map<number, Span[]>();
  for (const s of segs) by.set(s.speaker_idx, [...(by.get(s.speaker_idx) ?? []), s]);
  return new Map([...by].map(([idx, spans]) => [idx, unionMs(spans)]));
}

export type EmbedPlan = {
  /** What /embed_speakers is sent: `idx` is the speech-time RANK, not the Nemotron index. */
  request: EmbedRequestSpeaker[];
  /** rank → Nemotron speaker index. */
  speakerOfRank: Map<number, number>;
};

/**
 * PURE — the embed request. One span per speaker, the LONGEST (a tie goes to the earlier span), as the hybrid's
 * longestSpanPerSpeaker; total_speech_sec is the speaker's whole speech. Ranked most speech first.
 */
export function embedPlan(segs: ReadonlyArray<NemoSegment>): EmbedPlan {
  const best = new Map<number, NemoSegment>();
  for (const s of segs) {
    const cur = best.get(s.speaker_idx);
    const len = s.end_ms - s.start_ms;
    const curLen = cur ? cur.end_ms - cur.start_ms : -1;
    if (!cur || len > curLen || (len === curLen && s.start_ms < cur.start_ms)) best.set(s.speaker_idx, s);
  }
  const speech = speechMsBySpeaker(segs);
  const order = [...best.keys()].sort((a, b) => (speech.get(b) ?? 0) - (speech.get(a) ?? 0) || a - b);
  const speakerOfRank = new Map<number, number>();
  const request = order.map((idx, rank) => {
    speakerOfRank.set(rank, idx);
    const s = best.get(idx)!;
    return { idx: rank, start_s: s.start_ms / 1000, end_s: s.end_ms / 1000, total_speech_sec: (speech.get(idx) ?? 0) / 1000 };
  });
  return { request, speakerOfRank };
}

export type SpeakerIdentity = {
  speaker_label: string;
  speech_ms: number;
  clinician_id: string | null;
  match_confidence: number | null;
  losing_clinician_id: string | null;
  losing_score: number | null;
  centroids_offered: number;
  attribution: "voiceprint" | "none";
};

/**
 * PURE — the service's answer, one row per Nemotron speaker. `centroids` must be the array sent, in order.
 * Returns ids and scores only; the embeddings it reads are not in the result.
 */
export function speakerIdentities(
  segs: ReadonlyArray<NemoSegment>,
  plan: EmbedPlan,
  embedded: ReadonlyArray<EmbeddedSpeaker>,
  centroids: ReadonlyArray<ClinicianCentroid>,
  threshold: number,
): { speakers: SpeakerIdentity[]; embedded: number; guard: ShadowGuard; trusted: boolean } {
  const speech = speechMsBySpeaker(segs);
  const byRank = new Map(embedded.map((e) => [e.idx, e] as const));
  const shadowIn = plan.request.map((r) => {
    const e = byRank.get(r.idx);
    return {
      idx: r.idx, label: "", type: "",
      ...(e?.embedding_base64 ? { embedding_base64: e.embedding_base64 } : {}),
      ...(e?.embedding_base64 && e.clinician_id ? { clinician_id: e.clinician_id } : {}),
      ...(e?.embedding_base64 && typeof e.confidence === "number" ? { confidence: e.confidence } : {}),
    };
  });
  const { losingByIdx, guard } = shadowMatch(shadowIn, centroids, threshold);
  const trusted = shadowTrusted(guard);
  let embeddedCount = 0;
  const rows = plan.request.map((r): SpeakerIdentity => {
    const idx = plan.speakerOfRank.get(r.idx)!;
    const e = byRank.get(r.idx);
    const compared = !!e?.embedding_base64 && centroids.length > 0;
    if (e?.embedding_base64) embeddedCount++;
    const matched = compared && typeof e!.clinician_id === "string" && e!.clinician_id !== "" && typeof e!.confidence === "number";
    const losing = compared && !matched && trusted ? losingByIdx.get(r.idx) ?? null : null;
    return {
      speaker_label: label(idx),
      speech_ms: speech.get(idx) ?? 0,
      clinician_id: matched ? e!.clinician_id! : null,
      match_confidence: matched ? e!.confidence! : null,
      losing_clinician_id: losing ? losing.clinician_id : null,
      losing_score: losing ? losing.score : null,
      centroids_offered: centroids.length,
      attribution: compared ? "voiceprint" : "none",
    };
  });
  rows.sort((a, b) => Number(a.speaker_label.slice(3)) - Number(b.speaker_label.slice(3)));
  return { speakers: rows, embedded: embeddedCount, guard, trusted };
}

// ── per-turn identity, probes, hypotheses ─────────────────────────────────────────────────────────────

/** A stretch of one window's audio: one speaker (with their match, if any), or two at once (`straddle`, no name). */
export type IdentityPiece = { start_ms: number; end_ms: number; speaker_label: string | null; clinician_id: string | null; straddle: boolean };

/**
 * PURE — each turn inherits its speaker's match; where two speakers' turns overlap, that stretch is `straddle`
 * and carries no name. Times stay as given (clip-relative or wall-clock, the caller's choice).
 */
export function turnIdentities(segs: ReadonlyArray<NemoSegment>, speakers: ReadonlyArray<Pick<SpeakerIdentity, "speaker_label" | "clinician_id">>): IdentityPiece[] {
  const who = new Map(speakers.map((s) => [s.speaker_label, s.clinician_id] as const));
  const cuts = [...new Set(segs.flatMap((s) => [s.start_ms, s.end_ms]))].sort((a, b) => a - b);
  const out: IdentityPiece[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i], b = cuts[i + 1];
    const active = [...new Set(segs.filter((s) => s.start_ms < b && s.end_ms > a).map((s) => s.speaker_idx))];
    if (active.length === 0) continue;
    const piece: IdentityPiece = active.length === 1
      ? { start_ms: a, end_ms: b, speaker_label: label(active[0]), clinician_id: who.get(label(active[0])) ?? null, straddle: false }
      : { start_ms: a, end_ms: b, speaker_label: null, clinician_id: null, straddle: true };
    const last = out[out.length - 1];
    if (last && last.end_ms === a && last.speaker_label === piece.speaker_label && last.straddle === piece.straddle) last.end_ms = b;
    else out.push(piece);
  }
  return out;
}

const clipMs = (p: Span, a: number, b: number) => Math.max(0, Math.min(p.end_ms, b) - Math.max(p.start_ms, a));

/** Matched speech per clinician inside [a, b), straddles excluded. */
function matchedMsIn(pieces: ReadonlyArray<IdentityPiece>, a: number, b: number): Map<string, number> {
  const by = new Map<string, number>();
  for (const p of pieces) if (p.clinician_id && !p.straddle) by.set(p.clinician_id, (by.get(p.clinician_id) ?? 0) + clipMs(p, a, b));
  return by;
}

/**
 * PURE — a probe's doctor_present: true when one voiceprint-matched clinician speaks for at least
 * DOCTOR_PRESENT_MIN_MS inside it; otherwise null. NEVER false: an unmatched voice may be the doctor whose
 * voiceprint fails on this audio (ruling 182), so absence of a match is not evidence of absence.
 */
export function doctorPresent(probe: Span, pieces: ReadonlyArray<IdentityPiece>): true | null {
  for (const ms of matchedMsIn(pieces, probe.start_ms, probe.end_ms).values()) if (ms >= DOCTOR_PRESENT_MIN_MS) return true;
  return null;
}

/** The identity shape encounter_hypothesis stores (0114: clinician_id requires match_source and doctor_cosine). */
export type HypothesisIdentity = { clinician_id: string; match_source: "voice_print"; centroid_id: null; doctor_cosine: number };

/**
 * PURE — a hypothesis's identity: the matched clinician with the most speech inside the interval (a tie goes to
 * the lower id), with the best cosine among that clinician's matched speakers. null when nobody matched there.
 */
export function dominantIdentity(
  interval: Span,
  pieces: ReadonlyArray<IdentityPiece>,
  speakers: ReadonlyArray<Pick<SpeakerIdentity, "clinician_id" | "match_confidence">>,
): HypothesisIdentity | null {
  const by = matchedMsIn(pieces, interval.start_ms, interval.end_ms);
  const best = [...by].filter(([, ms]) => ms > 0).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0];
  if (!best) return null;
  const cos = speakers.filter((s) => s.clinician_id === best[0] && typeof s.match_confidence === "number").map((s) => s.match_confidence as number);
  if (cos.length === 0) return null;
  return { clinician_id: best[0], match_source: "voice_print", centroid_id: null, doctor_cosine: Math.max(...cos) };
}

/**
 * PURE — the timeline's `role` (ticket e) from stored identities: a speaker is DOC when it matched the clinician
 * `consultClinician` names for the segment's anchor. `consultClinician` is the caller's: no table maps a Pulse
 * doctor uid to a clinician id yet, so until one exists the caller has nothing to pass and nobody is DOC.
 */
export function roleFromIdentities(
  byWindow: ReadonlyMap<string, ReadonlyMap<number, string | null>>,
  consultClinician: (anchor: Anchor | null) => string | null,
): NonNullable<TimelineInput["role"]> {
  return (windowId: string, speakerIdx: number, anchor: Anchor | null): SpeakerRole => {
    const want = consultClinician(anchor);
    if (!want) return "other";
    return byWindow.get(windowId)?.get(speakerIdx) === want ? "doc" : "other";
  };
}

// ── centroids ─────────────────────────────────────────────────────────────────────────────────────────

/** Float32 little-endian, base64 — the encoding decodeFloat32 and the service read. */
export function encodeFloat32(v: ArrayLike<number>): string {
  const buf = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i], i * 4);
  return buf.toString("base64");
}

/**
 * The centroids a set offers, in clinician-id order. `confirmed6` is not defined anywhere in this repo, so it
 * refuses (never guesses a list). Active clinicians only, as loadClinicianCentroids.
 */
export async function loadCentroidSet(set: CentroidSet): Promise<{ ok: true; centroids: ClinicianCentroid[] } | { ok: false; error: "centroid_set_undefined" }> {
  if (set === "voice_print") {
    const { loadClinicianCentroids } = await import("@/lib/stt/diarize-window");
    return { ok: true, centroids: await loadClinicianCentroids() };
  }
  if (set === "voice_centroid:room_primary") {
    const rows = (await sql`
      SELECT vc.clinician_id, d.full_name, vc.embedding
        FROM voice_centroid vc
        JOIN clinician d ON d.id = vc.clinician_id
       WHERE vc.domain = 'room_primary'
         AND vc.retired_at IS NULL
         AND d.status = 'active'
         AND d.deleted_at IS NULL
       ORDER BY vc.clinician_id
    `) as Array<{ clinician_id: string; full_name: string | null; embedding: number[] | null }>;
    return {
      ok: true,
      centroids: rows
        .filter((r) => Array.isArray(r.embedding) && r.embedding.length > 0)
        .map((r) => ({ clinician_id: r.clinician_id, full_name: r.full_name ?? r.clinician_id, centroid_base64: encodeFloat32(r.embedding!.map(Number)) })),
    };
  }
  return { ok: false, error: "centroid_set_undefined" };
}
