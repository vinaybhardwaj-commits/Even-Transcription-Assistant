/**
 * lib/encounter-clock/fusion.ts — E-6: acoustics propose encounters, Jev's content judgement confirms,
 * splits or rejects each one. PURE: judgements in, fused encounters and a decision per encounter out.
 *
 * THE RULES (PLAN-v3 §C E-6, Fable's E-6 order, 23 Sep):
 *   · An encounter needs at least one CLINICAL probe. With none it is REJECTED — and the reason is kept
 *     apart: `no_clinical_probe` (content was judged and none of it was clinical) vs `no_judged_probe`
 *     (nothing inside could be judged: no English text, or Jev did not answer). The order settles that
 *     both reject; E-7 needs to see how many were rejected for lack of evidence rather than on it.
 *   · A confident START inside a run (U2 start P >= START_P, on a clinical probe, not the run's first
 *     probe) SPLITS it there: a new patient's consultation began inside what acoustics saw as one.
 *     Each piece is re-tallied by the smoother's own arithmetic (summariseSpan), the earlier piece
 *     closes as `content_boundary`, the last keeps the acoustic reason, and a piece with no clinical
 *     probe is dropped — it is not an encounter by the first rule.
 *   · Otherwise the encounter is CONFIRMED unchanged.
 *   · E-6.1 — JEV PROPOSES where acoustics proposed nothing (Fable's E-6.1 order, 23 Sep; E-7 showed
 *     fusion alone cannot raise recall, it only removes). A run of at least JEV_MIN_RUN consecutive probes,
 *     opened by a U2 START marker and closed by a U2 END marker, every probe in it clinical and in a
 *     consultation phase, and none of it inside an acoustic encounter, becomes a candidate encounter with
 *     origin 'jev'. ACOUSTICS THEN TRIMS IT: leading and trailing probes the gate judged non_speech are
 *     cut; a candidate trimmed below JEV_MIN_RUN is dropped. It closes as `content_boundary` (the U2 end
 *     marker is a content reason). See proposeFromJev for each rule and what it counts.
 *
 * CODE ARBITRATES CONTRADICTIONS (§1.4), in two named places, and counts every one it resolves:
 *   · a probe U6 calls clinical while U1 calls it not-a-consultation at the ACT band is NOT clinical — a
 *     confident "no consultation here" outweighs a less confident "clinical", and when both are confident
 *     and disagree the probe is not trusted to anchor an encounter;
 *   · a U2 start on a probe that is not clinical is IGNORED — a consultation cannot begin in a window
 *     that holds none.
 *
 * CONFIDENCE BANDS are the plan's (§1.4): a U6 "clinical" below the review line (0.5) does not count.
 * U1 is asked nine-way (the trialled wording) and mapped to the order's four phases here, in phaseOf.
 */
import { summariseSpan, type ClosedBy, type Encounter, type ProbeVerdict } from "@/lib/encounter-clock/smooth";
import type { AcousticProbe } from "@/lib/encounter-clock/shadow";
import type { ConfidenceBand } from "@/lib/jev/confidence";
import type { U1Option, U6Option } from "@/lib/jev/prompts/encounter-v1";

export const FUSION_VERSION = "encounter-fusion-v1.1";
/** PROVISIONAL: a U2 start at or above this splits an encounter (the plan's act band). */
export const START_P = 0.9;
/** PROVISIONAL: a U2 end at or above this closes a Jev-proposed encounter (the same act band). */
export const END_P = 0.9;
/** The order's floor: a Jev-proposed encounter spans at least this many consecutive probes. */
export const JEV_MIN_RUN = 3;

/** Who proposed an encounter: the acoustic smoother (confirmed or split by Jev), or Jev alone (E-6.1). */
export type EncounterOrigin = "acoustic" | "jev";

export type Phase = "pre" | "consult" | "post" | "none" | "unknown";

/** PURE — the trialled nine-way U1 answer as the order's four phases (plus unknown for cannot_tell). */
export function phaseOf(choice: U1Option): Phase {
  switch (choice) {
    case "greeting": return "pre";
    case "closing": return "post";
    case "not_a_consultation": return "none";
    case "cannot_tell": return "unknown";
    default: return "consult"; // history_taking, examination, diagnosis_explained, prescribing, counselling_or_advice
  }
}

export type ProbeJudgement = {
  index: number;
  /** False when the probe had no English to show Jev, or Jev did not answer. Never a guessed default. */
  judged: boolean;
  phase?: { choice: U1Option; phase: Phase; confidence: number; band: ConfidenceBand };
  kind?: { choice: U6Option; confidence: number; band: ConfidenceBand };
  /** P(a new consultation STARTS in this probe), from U2. */
  start?: number;
  /** P(a consultation ENDS in this probe), from U2. */
  end?: number;
};

export type ClinicalVerdict = { clinical: boolean; contradiction: boolean };

/** PURE — is this probe clinical, after the U1/U6 arbitration? */
export function clinicalVerdict(j: ProbeJudgement): ClinicalVerdict {
  if (!j.judged || !j.kind) return { clinical: false, contradiction: false };
  const saysClinical = j.kind.choice === "clinical_consultation" && j.kind.band !== "review";
  const confidentNone = j.phase?.phase === "none" && j.phase.band === "act";
  if (saysClinical && confidentNone) return { clinical: false, contradiction: true };
  return { clinical: saysClinical, contradiction: false };
}

export type StartVerdict = { boundary: boolean; contradiction: boolean };

/** PURE — does a new consultation start in this probe, after the U2/U6 arbitration? */
export function startVerdict(j: ProbeJudgement): StartVerdict {
  if (!j.judged || j.start === undefined || j.start < START_P) return { boundary: false, contradiction: false };
  if (!clinicalVerdict(j).clinical) return { boundary: false, contradiction: true };
  return { boundary: true, contradiction: false };
}

/**
 * PURE — is this probe inside a consultation, as far as Jev can say? Clinical after the U1/U6 arbitration,
 * AND a U1 phase that is part of a consultation: pre (greeting), consult, or post (closing). A consultation
 * opens on its greeting and closes on its goodbye, which is where the U2 start and end markers fire, so
 * "consult-phase" here spans the three phases of one (PROVISIONAL reading of the order, flagged).
 */
export function inConsultation(j: ProbeJudgement): boolean {
  if (!clinicalVerdict(j).clinical || !j.phase) return false;
  return j.phase.phase === "pre" || j.phase.phase === "consult" || j.phase.phase === "post";
}

export type ProposalCounts = {
  /** Candidates kept and added to the fused run, origin 'jev'. */
  proposed: number;
  /** A start marker whose consultation run broke (gap, non-consultation probe, acoustic encounter) before any end marker. */
  unclosed: number;
  /** Opened and closed, but fewer than JEV_MIN_RUN probes. */
  short: number;
  /** Long enough, until acoustics trimmed its non_speech edges below JEV_MIN_RUN. */
  trimmed_away: number;
  /** Survived the trim but NO probe in it was acoustically `speech`: nobody heard it, so it is not proposed. */
  no_speech: number;
  /** Probes cut from kept candidates by the acoustic trim. */
  trimmed_probes: number;
};

/** Grid neighbours: consecutive centres one hop apart (a hole in the series breaks a run). */
const adjacent = (a: AcousticProbe, b: AcousticProbe, hop: number) => b.t - a.t <= hop * 1.5;

/**
 * PURE — E-6.1: Jev's content channel proposes encounters where the acoustic run has none.
 *
 *   OPEN at a probe with a U2 start marker (startVerdict: start >= START_P, on a clinical probe), that is in
 *     a consultation (inConsultation) and outside every acoustic encounter.
 *   EXTEND over grid neighbours that are in a consultation and outside every acoustic encounter.
 *   CLOSE at the first probe (the opener included) with a U2 end marker, end >= END_P. A second start
 *     marker before any end marker is a new patient: the open run is abandoned as unclosed and the scan
 *     re-opens there. A run that breaks before an end marker is unclosed — no end is invented.
 *   LENGTH: at least JEV_MIN_RUN probes, opener and closer included.
 *   TRIM: leading and trailing probes the acoustic gate judged non_speech are cut (unjudged is kept — no
 *     acoustic evidence is not evidence of silence); still at least JEV_MIN_RUN, or it is dropped.
 *   HEARD: at least one probe of what survives must be acoustically `speech`. No evidence is not silence,
 *     but no evidence is not a consultation either: a run with no speech-judged probe rests on transcript
 *     text alone, and whether text was invented from silence is the one question Jev cannot answer (PLAN-v3
 *     §1.1, J-A). Jev may propose without an acoustic BOUNDARY, never without acoustic evidence of SOUND
 *     (ETA-Refuter, E-6.1 verdict).
 *
 * TWO "UNJUDGED"S. A probe Jev did not answer (no judgement, or judged:false) is not in a consultation and
 * BREAKS the run (`eligible`). A probe the ACOUSTIC gate called `unjudged` (no energy evidence) does not
 * break it, is not trimmed, and does not count as heard.
 *   OUTSIDE ACOUSTICS: where an acoustic encounter exists, acoustics already proposed a boundary and
 *     fuseEncounters arbitrates it; Jev proposes only where acoustics proposed nothing.
 */
export function proposeFromJev(
  encounters: readonly Encounter[],
  probes: readonly AcousticProbe[],
  judgements: readonly ProbeJudgement[],
  hop_ms: number,
): { encounters: Encounter[]; counts: ProposalCounts } {
  const byIndex = new Map(judgements.map((j) => [j.index, j]));
  const grid: ProbeVerdict[] = probes.map((p) => ({ t: p.t, verdict: p.verdict, reason: p.reason as ProbeVerdict["reason"] }));
  const inAcoustic = (i: number) => encounters.some((e) => probes[i]!.t >= e.start_ms && probes[i]!.t < e.end_ms);
  const eligible = (i: number) => {
    const j = byIndex.get(i);
    return !!j && inConsultation(j) && !inAcoustic(i);
  };
  const opens = (i: number) => eligible(i) && startVerdict(byIndex.get(i)!).boundary;
  const closes = (i: number) => { const e = byIndex.get(i)?.end; return e !== undefined && e >= END_P; };

  const out: Encounter[] = [];
  const counts: ProposalCounts = { proposed: 0, unclosed: 0, short: 0, trimmed_away: 0, no_speech: 0, trimmed_probes: 0 };
  let i = 0;
  while (i < probes.length) {
    if (!opens(i)) { i++; continue; }
    const s = i;
    let e = -1;
    let k = s;
    for (;;) {
      if (closes(k)) { e = k; break; }
      const next = k + 1;
      if (next >= probes.length || !adjacent(probes[k]!, probes[next]!, hop_ms) || !eligible(next)) break;
      if (opens(next)) break; // a new patient starts before this one ended
      k = next;
    }
    // unclosed: resume after the last probe reached — which is exactly a new start marker, if that broke it
    if (e < 0) { counts.unclosed++; i = k + 1; continue; }
    i = e + 1;
    if (e - s + 1 < JEV_MIN_RUN) { counts.short++; continue; }
    let a = s, b = e;
    while (a <= b && probes[a]!.verdict === "non_speech") a++;
    while (b >= a && probes[b]!.verdict === "non_speech") b--;
    if (b - a + 1 < JEV_MIN_RUN) { counts.trimmed_away++; continue; }
    let heard = false;
    for (let q = a; q <= b; q++) if (probes[q]!.verdict === "speech") { heard = true; break; }
    if (!heard) { counts.no_speech++; continue; }
    counts.trimmed_probes += (a - s) + (e - b);
    out.push(summariseSpan(grid, a, b, hop_ms, "content_boundary"));
    counts.proposed++;
  }
  return { encounters: out, counts };
}

export type FusionAction = "confirm" | "split" | "reject";
export type RejectReason = "no_clinical_probe" | "no_judged_probe";

export type FusionDecision = {
  acoustic_index: number;
  start_ms: number;
  end_ms: number;
  action: FusionAction;
  reject_reason?: RejectReason;
  probes: number;
  judged_probes: number;
  clinical_probes: number;
  contradictions: number;
  /** For a split: pieces kept, and pieces dropped for having no clinical probe. */
  pieces_kept?: number;
  pieces_dropped?: number;
};

export type FusionResult = {
  version: typeof FUSION_VERSION;
  encounters: Encounter[];
  /** Index for index with `encounters`: who proposed each one. */
  origins: EncounterOrigin[];
  /** E-6.1: what Jev's own proposals did (see proposeFromJev). */
  proposals: ProposalCounts;
  decisions: FusionDecision[];
  counts: { confirm: number; split: number; reject: number; rejected_no_evidence: number; contradictions: number };
};

/**
 * PURE — fuse. `probes` is the acoustic grid (the smoother's verdicts, index for index with the
 * judgements); `encounters` are the acoustic run's. Probe i belongs to an encounter when its centre
 * falls in [start_ms, end_ms).
 */
export function fuseEncounters(
  encounters: readonly Encounter[],
  probes: readonly AcousticProbe[],
  judgements: readonly ProbeJudgement[],
  hop_ms: number,
): FusionResult {
  const byIndex = new Map(judgements.map((j) => [j.index, j]));
  // The smoother's own probe shape, so a split piece is re-tallied exactly as the smoother would.
  const grid: ProbeVerdict[] = probes.map((p) => ({ t: p.t, verdict: p.verdict, reason: p.reason as ProbeVerdict["reason"] }));
  const out: Encounter[] = [];
  const decisions: FusionDecision[] = [];
  let contradictionsTotal = 0;

  encounters.forEach((e, acousticIndex) => {
    const idxs: number[] = [];
    probes.forEach((p, i) => { if (p.t >= e.start_ms && p.t < e.end_ms) idxs.push(i); });
    const inside = idxs.map((i) => byIndex.get(i) ?? { index: i, judged: false });
    const judged = inside.filter((j) => j.judged);
    let contradictions = 0;
    const clinicalAt = new Set<number>();
    for (const j of inside) {
      const v = clinicalVerdict(j);
      if (v.contradiction) contradictions++;
      if (v.clinical) clinicalAt.add(j.index);
    }
    const base = {
      acoustic_index: acousticIndex, start_ms: e.start_ms, end_ms: e.end_ms,
      probes: idxs.length, judged_probes: judged.length, clinical_probes: clinicalAt.size,
    };

    if (clinicalAt.size === 0) {
      contradictionsTotal += contradictions;
      decisions.push({ ...base, contradictions, action: "reject",
        reject_reason: judged.length === 0 ? "no_judged_probe" : "no_clinical_probe" });
      return;
    }

    // Split points: a confident start on a clinical probe, never the run's own first probe.
    const cuts: number[] = [];
    for (const i of idxs.slice(1)) {
      const v = startVerdict(byIndex.get(i) ?? { index: i, judged: false });
      if (v.contradiction) contradictions++;
      if (v.boundary) cuts.push(i);
    }
    contradictionsTotal += contradictions;

    if (cuts.length === 0) {
      out.push(e);
      decisions.push({ ...base, contradictions, action: "confirm" });
      return;
    }

    // Pieces: [first..cut1-1], [cut1..cut2-1], ..., [cutN..last]
    const bounds = [idxs[0]!, ...cuts];
    const last = idxs[idxs.length - 1]!;
    let kept = 0, dropped = 0;
    bounds.forEach((a, k) => {
      const b = k + 1 < bounds.length ? bounds[k + 1]! - 1 : last;
      const isLast = k === bounds.length - 1;
      let hasClinical = false;
      for (let i = a; i <= b; i++) if (clinicalAt.has(i)) { hasClinical = true; break; }
      if (!hasClinical) { dropped++; return; }
      const by: ClosedBy = isLast ? e.closed_by : "content_boundary";
      out.push(summariseSpan(grid, a, b, hop_ms, by));
      kept++;
    });
    decisions.push({ ...base, contradictions, action: "split", pieces_kept: kept, pieces_dropped: dropped });
  });

  const proposed = proposeFromJev(encounters, probes, judgements, hop_ms);
  const all = [
    ...out.map((e) => ({ e, origin: "acoustic" as const })),
    ...proposed.encounters.map((e) => ({ e, origin: "jev" as const })),
  ].sort((x, y) => x.e.start_ms - y.e.start_ms);

  return {
    version: FUSION_VERSION,
    encounters: all.map((x) => x.e),
    origins: all.map((x) => x.origin),
    proposals: proposed.counts,
    decisions,
    counts: {
      confirm: decisions.filter((d) => d.action === "confirm").length,
      split: decisions.filter((d) => d.action === "split").length,
      reject: decisions.filter((d) => d.action === "reject").length,
      rejected_no_evidence: decisions.filter((d) => d.reject_reason === "no_judged_probe").length,
      contradictions: contradictionsTotal,
    },
  };
}
