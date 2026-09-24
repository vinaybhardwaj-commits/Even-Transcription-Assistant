/**
 * Diarize bridge — server-side client for the Mac Mini pyannote diarization
 * service (v2.1). At submit, /process POSTs the canonical recording and gets
 * back speaker clusters, role labels, overlap windows, and speech-time
 * aggregates (PRD §20.3.2 contract).
 *
 * Non-critical: diarization never blocks an encounter. Callers soft-fail.
 *
 * ── THE CLOCK STARTS AT DISPATCH (23 Aug 2026) ─────────────────────────────
 *
 * The 22 Aug timing probe (docs/ETA-DIARIZE-TIMING-PROBE-22-AUG-2026.md) found the service is
 * LINEAR in audio length across a 10x range — service_ms = 46.42 x seconds + 148 — with a 148 ms
 * intercept, so warm per-call overhead is negligible and a 403-second file is about 26 seconds of
 * work. Length never was the problem. What is: the service is single-worker uvicorn (GIL + MPS),
 * so it SERIALISES, and a request sent while another is running waits inside the service with our
 * timeout already ticking. Wait long enough and 26 seconds of work breaches a 90-second budget.
 * That is why a 288 s file failed on a day a 482 s file succeeded.
 *
 * So the queue moved to our side (lib/diarize-gate.ts, depth 1) and the timeout now covers ONLY
 * the dispatched call. Time spent waiting for the slot is reported as queue wait and charged to
 * nothing. The two numbers are separate because they mean different things: queue wait is
 * contention, dispatch time is the model.
 *
 * Env: DIARIZE_BASE_URL (e.g. https://diarize.llmvinayminihome.uk),
 *      DIARIZE_TIMEOUT_MS (see DIARIZE_TIMEOUT_MS_DEFAULT — read the provenance note),
 *      DIARIZE_QUEUE_WAIT_MS (see lib/diarize-gate.ts).
 */

import { acquireDiarizeSlot, DIARIZE_QUEUE_WAIT_MS } from "@/lib/diarize-gate";
import { endpointsFor, runPool, type Verdict } from "@/lib/service-pool";
import { withServiceAccess, withDiarizeAuth } from "@/lib/service-access";

/**
 * REDUNDANCY-R1 — which /diarize answers mean "try the next endpoint": a transport failure, a 5xx, or a 404 (that
 * endpoint does not serve /diarize — R2). NOT our own timeout (R1): a diarization that ran out of time has spent the
 * whole budget and may still be running on that server; starting a second one would be double work. `aborted` is the
 * CALLER cancelling, never a reason to ask another machine. Any other 4xx is the answer.
 */
export function diarizeVerdict(o: DiarizeOutcome): Verdict {
  if (o.ok) return "ok";
  if (o.error.startsWith("network:")) return "failover";
  const m = /^http_(\d{3})/.exec(o.error);
  if (!m) return "final";
  const status = Number(m[1]);
  return status >= 500 || status === 404 ? "failover" : "final";
}

/**
 * Budget for ONE DISPATCHED /diarize call — it starts when the request is actually sent, never
 * when it was queued.
 *
 * ⚠ PROVENANCE — READ BEFORE TRUSTING THIS NUMBER.
 *
 * 300 000 ms is the figure recommended by the 22 Aug 2026 timing probe (Q4), and that probe ran
 * WHILE A NINE-HOUR RECORDING WAS LIVE ON THE SAME MAC MINI. It is therefore an UPPER BOUND
 * measured under load, not a calibrated timeout. Nobody has re-measured on a quiet machine.
 *
 * What IS measured, on a contended Mini: 15 minutes of real room audio diarized in 58 367 ms
 * wall / 41 915 ms service. 300 000 ms is roughly 5x that, and about 11x the fit's prediction for
 * a 403-second encounter (~26 s wall). The headroom is deliberate — a timeout only binds on
 * failure, so being generous costs nothing when calls succeed, and the old 90 000 ms was tight
 * enough that one cold start (12–30 s of model load) plus a busy Mini could breach it.
 *
 * Re-measure on a quiet machine before anyone treats this as calibrated, and especially before
 * anyone TIGHTENS it. It is configurable via DIARIZE_TIMEOUT_MS precisely so it need not be
 * re-deployed to change.
 */
export const DIARIZE_TIMEOUT_MS_DEFAULT = 300_000;

/** Machine-readable provenance, so anything that reports the timeout also reports what it is. */
export const DIARIZE_TIMEOUT_MS_PROVENANCE =
  "probe 22-Aug-2026 Q4, measured under load (nine-hour recording live on the same Mini) — upper bound, not calibrated; re-measure on a quiet machine";

export const DIARIZE_TIMEOUT_MS = (): number =>
  Number(process.env.DIARIZE_TIMEOUT_MS || DIARIZE_TIMEOUT_MS_DEFAULT);

/**
 * Lease headroom: the slot must outlive the dispatched call by enough that a lease can never
 * expire under a request that is still legitimately in flight (which would admit a second one).
 */
const SLOT_TTL_HEADROOM_MS = 60_000;

export type DiarizeSpeaker = {
  idx: number;
  label: string;
  type: string; // clinician|patient|attender|nurse|other (forward-compatible)
  total_speech_sec?: number;
  first_heard_at_sec?: number;
  manually_relabeled?: boolean;
  source?: string;
  clinician_id?: string;
  confidence?: number;
  role_source?: string;
  embedding_base64?: string; // Sprint B: per-speaker ECAPA embedding (Mini returns it → passive capture)
};
export type DiarizeResult = {
  speakers: DiarizeSpeaker[];
  transcript_segments: unknown[];
  overlap_windows: unknown[];
  aggregates: unknown;
  latency_ms?: number;
  model_versions?: unknown;
};
/**
 * Per-run timing. Transfer is separated from service time on purpose (B4): 16.5 s of the probe's
 * 58 s 15-minute wall was UPLOAD — about 1.1 s per MB over the tunnel, 28% of the total. Folded
 * together, a slow network reads as a slow model, and the next person measures the wrong thing.
 */
export type DiarizeTiming = {
  /** Waiting for the depth-1 slot. Charged against nothing — see DIARIZE_TIMEOUT_MS. */
  queue_wait_ms: number;
  /** Dispatch → response body fully read. This, and only this, is what the timeout bounds. */
  wall_ms: number;
  /** The service's own reported latency_ms (its compute). Null when it did not answer. */
  service_ms: number | null;
  /** wall − service: upload over the tunnel + HTTP + response parse. Null when service_ms is. */
  transfer_ms: number | null;
  audio_bytes: number;
  /** The budget actually in force for this call, so a stored row explains its own verdict. */
  timeout_ms: number;
  timed_out: boolean;
  /** True when the gate admitted without a lease (migration 0063 not applied). */
  ungated: boolean;
  queued_at: string;
  /** When the request was actually sent. Two calls' [dispatched_at, completed_at] never overlap. */
  dispatched_at: string | null;
  completed_at: string | null;
};

export type DiarizeOutcome =
  | { ok: true; result: DiarizeResult; latencyMs: number; timing: DiarizeTiming; served_by?: string }
  | {
      ok: false;
      error: string;
      latencyMs: number;
      timing: DiarizeTiming;
      /** True when we never reached the service (no slot). Retry later; do NOT mark failed. */
      retryable?: boolean;
      /** REDUNDANCY-R1 — the origin that answered; present only when a diarize pool is configured. */
      served_by?: string;
    };

export async function runDiarize(
  audio: Buffer | Uint8Array,
  contentType: string,
  opts: {
    encounterId: string;
    clinicianCentroids?: unknown[];
    manualRelabels?: unknown[];
    batchThreshold?: number;
    signal?: AbortSignal;
    /** Override the queue-wait budget (the caller knows its own remaining function time). */
    queueWaitMs?: number;
  },
): Promise<DiarizeOutcome> {
  const timeoutMs = DIARIZE_TIMEOUT_MS();
  const audioBytes = audio.byteLength;
  const queuedAt = new Date();
  const blank = (over: Partial<DiarizeTiming> = {}): DiarizeTiming => ({
    queue_wait_ms: 0,
    wall_ms: 0,
    service_ms: null,
    transfer_ms: null,
    audio_bytes: audioBytes,
    timeout_ms: timeoutMs,
    timed_out: false,
    ungated: false,
    queued_at: queuedAt.toISOString(),
    dispatched_at: null,
    completed_at: null,
    ...over,
  });

  const endpoints = endpointsFor("diarize");
  if (endpoints.length === 0) return { ok: false, error: "diarize_base_url_missing", latencyMs: 0, timing: blank() };
  const baseType = (contentType.split(";")[0] || "").trim().toLowerCase() || "audio/webm";
  const ext = baseType.includes("webm") ? "webm" : baseType.includes("mp4") ? "mp4" : baseType.includes("wav") ? "wav" : "webm";

  // ── QUEUE. Not clocked by the timeout. ───────────────────────────────────────────────────────
  // The service serialises, so a second concurrent request buys nothing and costs the first one's
  // runtime out of its own budget. Wait here instead, where waiting is visible and free.
  const slot = await acquireDiarizeSlot({
    label: opts.encounterId,
    ttlMs: timeoutMs + SLOT_TTL_HEADROOM_MS,
    waitMs: opts.queueWaitMs ?? DIARIZE_QUEUE_WAIT_MS(),
    signal: opts.signal,
  });
  if (!slot.acquired) {
    return {
      ok: false,
      error: `diarize_busy_${slot.reason}_${slot.queueWaitMs}ms`,
      latencyMs: 0,
      retryable: true,
      timing: blank({ queue_wait_ms: slot.queueWaitMs }),
    };
  }
  const { hold } = slot;

  // ── DISPATCH, per endpoint. The clock starts HERE, and not one millisecond earlier. ─────────────
  const dispatchAt = async (base: string, budgetMs: number): Promise<DiarizeOutcome> => {
    const form = new FormData();
    form.append("audio", new Blob([audio], { type: baseType }), `audio.${ext}`);
    form.append("encounter_id", opts.encounterId);
    form.append("clinician_centroids", JSON.stringify(opts.clinicianCentroids ?? []));
    form.append("manual_relabels", JSON.stringify(opts.manualRelabels ?? []));
    if (typeof opts.batchThreshold === "number") form.append("batch_threshold", String(opts.batchThreshold));

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), budgetMs);
    const onOuterAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    const t0 = Date.now();
    const dispatchedAt = new Date();
    const finish = (over: Partial<DiarizeTiming>): DiarizeTiming => {
      const wall = Date.now() - t0;
      const service = typeof over.service_ms === "number" ? over.service_ms : null;
      return blank({
        queue_wait_ms: hold.queueWaitMs,
        wall_ms: wall,
        service_ms: service,
        transfer_ms: service == null ? null : Math.max(0, wall - service),
        ungated: hold.ungated,
        dispatched_at: dispatchedAt.toISOString(),
        completed_at: new Date().toISOString(),
        ...over,
      });
    };

    try {
      const url = `${base.replace(/\/+$/, "")}/diarize`;
      const res = await fetch(url, withServiceAccess(url, withDiarizeAuth(url, {
        method: "POST", body: form, signal: controller.signal, cache: "no-store",
      })));
      clearTimeout(tid);
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        const timing = finish({});
        return { ok: false, error: `http_${res.status}: ${text.slice(0, 180)}`, latencyMs: timing.wall_ms, timing };
      }
      const j = JSON.parse(text) as Partial<DiarizeResult>;
      const serviceMs = typeof j.latency_ms === "number" ? j.latency_ms : null;
      const timing = finish({ service_ms: serviceMs });
      return {
        ok: true,
        latencyMs: timing.wall_ms,
        timing,
        result: {
          speakers: Array.isArray(j.speakers) ? (j.speakers as DiarizeSpeaker[]) : [],
          transcript_segments: Array.isArray(j.transcript_segments) ? j.transcript_segments : [],
          overlap_windows: Array.isArray(j.overlap_windows) ? j.overlap_windows : [],
          aggregates: j.aggregates ?? {},
          latency_ms: serviceMs ?? undefined,
          model_versions: j.model_versions,
        },
      };
    } catch (e: unknown) {
      clearTimeout(tid);
      // Distinguish OUR timeout from the caller cancelling the whole pipeline: the error names the
      // budget that was actually in force, so a stored `timeout_300000ms` is self-explaining.
      const outerAborted = !!opts.signal?.aborted;
      const timedOut = controller.signal.aborted && !outerAborted;
      const timing = finish({ timed_out: timedOut });
      if (timedOut) return { ok: false, error: `timeout_${budgetMs}ms`, latencyMs: timing.wall_ms, timing };
      if (outerAborted) return { ok: false, error: "aborted", latencyMs: timing.wall_ms, timing, retryable: true };
      return { ok: false, error: `network: ${e instanceof Error ? e.message : String(e)}`, latencyMs: timing.wall_ms, timing };
    } finally {
      if (opts.signal) opts.signal.removeEventListener("abort", onOuterAbort);
    }
  };

  // REDUNDANCY-R1: the dispatch, across the diarize pool (one endpoint when no pool is configured). The
  // slot above is still ONE slot for the whole pool: conservative, and exactly today's behaviour.
  try {
    // R1: the whole pool gets the ONE timeout a /diarize call always had; a failover gets only what is left.
    const { value, served_by } = await runPool("diarize", endpoints, dispatchAt, diarizeVerdict, { budgetMs: timeoutMs });
    return served_by ? { ...value, served_by } : value;
  } finally {
    // Release BEFORE returning to the caller, so the next waiter starts its dispatch immediately
    // rather than sitting through the post-processing (tagging, role refinement) that follows.
    await hold.release();
  }
}

/**
 * One-line human summary of a run, for the progress stream and the logs. Always names queue,
 * transfer and service separately — the whole point of recording them apart is that whoever
 * reads the line can tell a slow tunnel from a slow model without opening the row.
 */
export function diarizeTimingLine(t: DiarizeTiming): string {
  const parts = [`${t.wall_ms}ms wall`];
  if (t.service_ms != null) parts.push(`${t.service_ms}ms service`);
  if (t.transfer_ms != null) parts.push(`${t.transfer_ms}ms transfer`);
  parts.push(`${t.queue_wait_ms}ms queued`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Note speaker-tagging (V2.SD — reconciliation)
//
// Sarvam batch translate (with_diarization) yields ENGLISH text segments with
// timing + an ANONYMOUS speaker_id ("speaker_0"…). pyannote (/diarize) yields
// NAMED speakers (clinician matched by voiceprint) + timed segments but NO
// text. We reconcile by TIME OVERLAP: each Sarvam speaker_id is mapped to the
// pyannote speaker index it overlaps most (summed across all its entries),
// then every English entry inherits that pyannote speaker's name/role. The
// result is a speaker-tagged English conversation for the note + admin view.
// ---------------------------------------------------------------------------

export type TaggedEntry = {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker_id: string;       // Sarvam's anonymous id
  speaker_idx: number | null; // matched pyannote idx (null = unmatched)
  name: string;             // resolved display name (clinician name / role / "Speaker N")
  type: string;             // clinician|patient|attender|nurse|other
};

type SarvamEntryLike = { transcript: string; start: number; end: number; speakerId: string };
type SegLike = { start_ms?: number; end_ms?: number; speaker_idx?: number };

export function reconcileTagged(
  entries: SarvamEntryLike[],
  segments: SegLike[],
  speakers: DiarizeSpeaker[],
): TaggedEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  // 1. accumulate overlap(ms) between each Sarvam speaker_id and each pyannote idx
  const overlap = new Map<string, Map<number, number>>();
  for (const e of entries) {
    const es = e.start * 1000, ee = e.end * 1000;
    const m = overlap.get(e.speakerId) ?? new Map<number, number>();
    for (const s of segments) {
      const ss = s.start_ms ?? 0, se = s.end_ms ?? 0;
      const ov = Math.min(ee, se) - Math.max(es, ss);
      if (ov > 0 && typeof s.speaker_idx === "number") m.set(s.speaker_idx, (m.get(s.speaker_idx) ?? 0) + ov);
    }
    overlap.set(e.speakerId, m);
  }
  // 2. argmax → sarvam speaker_id ⇒ pyannote idx
  const idxFor = new Map<string, number | null>();
  for (const [sid, m] of overlap) {
    let best: number | null = null, bestv = 0;
    for (const [idx, v] of m) if (v > bestv) { bestv = v; best = idx; }
    idxFor.set(sid, best);
  }
  // 3. tag every entry; unmatched ids get a stable "Speaker N"
  const byIdx = new Map(speakers.map((s) => [s.idx, s] as const));
  const fallback = new Map<string, number>(); let fc = 0;
  return entries.map((e) => {
    const idx = idxFor.get(e.speakerId) ?? null;
    const sp = idx != null ? byIdx.get(idx) : undefined;
    let name = sp?.label, type = sp?.type;
    if (!name) {
      if (!fallback.has(e.speakerId)) fallback.set(e.speakerId, ++fc);
      name = `Speaker ${fallback.get(e.speakerId)}`; type = "other";
    }
    return { text: e.transcript, start_ms: Math.round(e.start * 1000), end_ms: Math.round(e.end * 1000), speaker_id: e.speakerId, speaker_idx: idx, name, type: type ?? "other" };
  });
}

// ---------------------------------------------------------------------------
// Role refinement (diarization polish) — first-person "patient" override.
// pyannote/Mac-Mini role labels are coarse (duration/segment heuristics). Now
// that we have per-speaker text (tagged_transcript), promote the speaker with
// the strongest first-person symptom language to Patient — UNLESS they are the
// enrolled-clinician auto-match (never override that). Conservative: needs ≥2
// first-person markers and only relabels a non-patient, non-clinician speaker.
// ---------------------------------------------------------------------------
const FIRST_PERSON = /\b(i\s+(have|had|feel|felt|am|was|get|got|can'?t|cannot|need|noticed|started|stopped|take|took)|i'?ve\s+been|i'?m\s+(having|feeling|getting)|my\s+(pain|chest|head|stomach|belly|back|leg|arm|knee|fever|cough|cold|throat|breathing|sugar|bp|pressure|period|wound|eye|ear|skin)|it\s+(hurts|pains)|since\s+(yesterday|last|two|three|four|five|a\s+(week|month|year)))\b/gi;

export function applyRoleOverrides(
  speakers: DiarizeSpeaker[],
  tagged: TaggedEntry[],
): { speakers: DiarizeSpeaker[]; changed: boolean } {
  if (!Array.isArray(tagged) || tagged.length === 0) return { speakers, changed: false };
  const hits = new Map<number, number>();
  for (const t of tagged) {
    if (t.speaker_idx == null || !t.text) continue;
    const m = t.text.match(FIRST_PERSON);
    if (m) hits.set(t.speaker_idx, (hits.get(t.speaker_idx) ?? 0) + m.length);
  }
  let bestIdx = -1, bestN = 0;
  for (const [idx, n] of hits) {
    const sp = speakers.find((s) => s.idx === idx);
    if (!sp || sp.source === "auto") continue;   // never override an enrolled-clinician match
    if (n > bestN) { bestN = n; bestIdx = idx; }
  }
  if (bestIdx < 0 || bestN < 2) return { speakers, changed: false };
  let changed = false;
  const out = speakers.map((s) => {
    if (s.idx === bestIdx && s.type !== "patient") {
      changed = true;
      return { ...s, type: "patient", label: "Patient", role_source: "first_person_override" };
    }
    return s;
  });
  return { speakers: out, changed };
}
