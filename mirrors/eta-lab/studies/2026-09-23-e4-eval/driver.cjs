"use strict";

// lib/stt/window-measure.ts
var DEFAULT_ROOM_ENERGY_FLOOR = 398e-5;

// lib/encounter-clock/gate.ts
var GATE_VERSION = "encounter-clock-gate-v1";
var UNIQUE_CHARS_PER_SECOND_MIN = 0.15;
var ENERGY_ACTIVE_MIN = 0.05;
var DEAD_MIC_ZERO_RATIO = 0.98;
var DEAD_MIC_DBFS = -90;
var dbfs = (amplitude) => amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
var median = (xs) => {
  if (xs.length === 0)
    return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
var missingEnergy = (source, n = 0) => ({ state: "missing", source, level_basis: null, active_frac: null, median_dbfs: null, median_zero_ratio: null, n });
function energyHalf(ev, floor = DEFAULT_ROOM_ENERGY_FLOOR) {
  if (!ev)
    return missingEnergy(null);
  let levels;
  let zero = null;
  let basis = null;
  if (ev.kind === "levels") {
    const fin = (v) => typeof v === "number" && Number.isFinite(v);
    const usable = ev.samples.filter((s) => fin(s.avg) || fin(s.peak));
    basis = usable.length > 0 && usable.every((s) => fin(s.avg)) ? "avg" : "peak";
    levels = usable.map((s) => basis === "avg" ? s.avg : s.peak).filter(fin);
    zero = median(ev.samples.map((s) => s.zero_ratio).filter(fin));
    if (levels.length === 0 && zero === null)
      return missingEnergy("levels", ev.samples.length);
    if (levels.length === 0)
      basis = null;
  } else {
    levels = ev.frame_rms.filter((v) => Number.isFinite(v));
    if (levels.length === 0)
      return missingEnergy("frames");
  }
  const med = median(levels);
  const medDb = med === null ? null : dbfs(med);
  const dead = zero !== null && zero >= DEAD_MIC_ZERO_RATIO || medDb !== null && medDb <= DEAD_MIC_DBFS;
  const activeFrac = levels.length ? levels.filter((v) => v >= floor).length / levels.length : null;
  const state = dead ? "dead_mic" : activeFrac === null ? "missing" : activeFrac >= ENERGY_ACTIVE_MIN ? "active" : "quiet";
  return { state, source: ev.kind, level_basis: basis, active_frac: activeFrac, median_dbfs: medDb, median_zero_ratio: zero, n: levels.length };
}
function normaliseLine(line) {
  return line.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
function uniqueCharsPerSecond(spans, t0, t1) {
  const seen = /* @__PURE__ */ new Map();
  for (const s of spans) {
    const ov = Math.min(s.end_ms, t1) - Math.max(s.start_ms, t0);
    if (ov <= 0 || s.end_ms <= s.start_ms || !s.text)
      continue;
    const w = ov / (s.end_ms - s.start_ms);
    for (const raw of s.text.split("\n")) {
      const l = normaliseLine(raw);
      if (l && !seen.has(l))
        seen.set(l, l.length * w);
    }
  }
  let chars = 0;
  for (const v of seen.values())
    chars += v;
  return chars / ((t1 - t0) / 1e3);
}
function covers(coverage, t0, t1) {
  const iv = [...coverage].sort((a, b) => a.start_ms - b.start_ms);
  let reach = t0;
  for (const c of iv) {
    if (c.start_ms > reach)
      break;
    reach = Math.max(reach, c.end_ms);
    if (reach >= t1)
      return true;
  }
  return reach >= t1;
}
function transcriptHalf(ev, t0, t1) {
  if (!ev || !covers(ev.coverage, t0, t1))
    return { state: "missing", unique_chars_per_s: null };
  const u = uniqueCharsPerSecond(ev.spans, t0, t1);
  return { state: u >= UNIQUE_CHARS_PER_SECOND_MIN ? "text" : "no_text", unique_chars_per_s: u };
}
function splitWindowText(text, spans, windowStartMs, tolerance = 3) {
  const sp = spans.filter((s) => s.chars > 0);
  if (sp.length === 0)
    return text.trim() ? null : [];
  const expected = sp.reduce((n, s) => n + s.chars, 0) + (sp.length - 1);
  if (Math.abs(text.length - expected) > tolerance)
    return null;
  const out = [];
  let off = 0;
  for (const s of sp) {
    out.push({ start_ms: windowStartMs + s.start_s * 1e3, end_ms: windowStartMs + s.end_s * 1e3, text: text.slice(off, off + s.chars) });
    off += s.chars + 1;
  }
  return out;
}
function gateProbe(input) {
  const { start_ms, end_ms } = input;
  const energy = energyHalf(input.energy, input.floor ?? DEFAULT_ROOM_ENERGY_FLOOR);
  const transcript = transcriptHalf(input.transcript, start_ms, end_ms);
  const out = (verdict, reason) => ({ version: GATE_VERSION, start_ms, end_ms, verdict, reason, energy, transcript });
  if (energy.state === "dead_mic")
    return out("unjudged", "dead_mic");
  if (energy.state === "missing")
    return out("unjudged", "no_energy_evidence");
  if (energy.state === "quiet")
    return transcript.state === "text" ? out("unjudged", "halves_disagree") : out("non_speech", "quiet_room");
  if (transcript.state === "missing")
    return out("unjudged", "no_transcript_evidence");
  return transcript.state === "text" ? out("speech", "speech") : out("non_speech", "no_text");
}

// lib/encounter-clock/probe.ts
var HOP_SECONDS = 60;

// lib/encounter-clock/smooth.ts
var SMOOTHER_VERSION = "encounter-clock-smooth-v1";
var ENTER_SPEECH_PROBES = 2;
var EXIT_NON_SPEECH_PROBES = 3;
var MERGE_GAP_MS = 18e4;
var BRIDGE_UNJUDGED_MAX_MS = MERGE_GAP_MS;
var SMOOTH_HOP_MS = HOP_SECONDS * 1e3;
var HOLE_HOPS = 1.5;
function smoothEncounters(probes, opts = {}) {
  const enter = opts.enter ?? ENTER_SPEECH_PROBES;
  const exit = opts.exit ?? EXIT_NON_SPEECH_PROBES;
  const hop = opts.hop_ms ?? SMOOTH_HOP_MS;
  const gap = opts.merge_gap_ms ?? MERGE_GAP_MS;
  const bridge = opts.bridge_ms ?? BRIDGE_UNJUDGED_MAX_MS;
  if (!(enter >= 1) || !(exit >= 1) || !(hop > 0) || !(gap >= 0) || !(bridge >= 0))
    throw new Error("smoother constants out of range");
  const ps = [...probes].sort((a, b) => a.t - b.t);
  const off = [...opts.tape_off ?? []].sort((a, b) => a.start_ms - b.start_ms);
  const half = hop / 2;
  const raw = [];
  let state = "idle";
  let enterCount = 0, exitCount = 0;
  let first = -1, lastSpeech = -1, lastJudged = -1;
  const close = (by) => {
    raw.push(summarise(ps, first, lastSpeech, hop, by));
    state = "idle";
    enterCount = 0;
    exitCount = 0;
    first = -1;
    lastSpeech = -1;
    lastJudged = -1;
  };
  const tapeOffBetween = (from, to) => off.find((o) => o.start_ms > from && o.start_ms <= to);
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i], v = p.verdict;
    if (state === "open") {
      if (tapeOffBetween(ps[lastSpeech].t, p.t))
        close("tape_off");
    }
    if (state === "open" && p.reason === "dead_mic") {
      close("dead_mic");
      continue;
    }
    if (state === "open" && lastJudged >= 0 && p.t - ps[lastJudged].t > bridge)
      close("unjudged_gap");
    if (v === "unjudged")
      continue;
    if (state === "idle") {
      if (v === "speech") {
        state = "pending";
        enterCount = 1;
        first = i;
        lastSpeech = i;
        lastJudged = i;
        if (enterCount >= enter)
          state = "open";
      } else
        lastJudged = i;
    } else if (state === "pending") {
      lastJudged = i;
      if (v === "speech") {
        enterCount++;
        lastSpeech = i;
        if (enterCount >= enter) {
          state = "open";
          exitCount = 0;
        }
      } else {
        state = "idle";
        enterCount = 0;
        first = -1;
        lastSpeech = -1;
      }
    } else {
      lastJudged = i;
      if (v === "speech") {
        lastSpeech = i;
        exitCount = 0;
      } else if (++exitCount >= exit)
        close("non_speech");
    }
  }
  if (state === "open") {
    close(tapeOffBetween(ps[lastSpeech].t, Infinity) ? "tape_off" : "end_of_input");
  }
  const out = [];
  for (const e of raw) {
    const prev = out[out.length - 1];
    const forced = prev && (prev.closed_by === "tape_off" || prev.closed_by === "dead_mic");
    const overBridge = prev && prev.closed_by === "unjudged_gap" && e.start_ms - prev.end_ms > bridge;
    if (prev && !forced && !overBridge && e.start_ms - prev.end_ms <= gap) {
      out[out.length - 1] = mergeTwo(prev, e, ps, half);
    } else
      out.push(e);
  }
  return out;
}
function summarise(ps, a, b, hop, by) {
  const half = hop / 2;
  const start = ps[a].t - half, end = ps[b].t + half;
  const e = {
    version: SMOOTHER_VERSION,
    start_ms: start,
    end_ms: end,
    speech_probes: 0,
    non_speech_probes: 0,
    unjudged_ms: 0,
    longest_unjudged_run_ms: 0,
    dead_mic_ms: 0,
    doctor_present: { yes: 0, no: 0, unknown: 0 },
    closed_by: by,
    merged_from: 1
  };
  tally(e, ps, a, b, hop);
  return e;
}
function tally(e, ps, a, b, hop) {
  let run = 0;
  const bump = (ms) => {
    e.unjudged_ms += ms;
    run += ms;
    if (run > e.longest_unjudged_run_ms)
      e.longest_unjudged_run_ms = run;
  };
  for (let i = a; i <= b; i++) {
    if (i > a) {
      const hole = ps[i].t - ps[i - 1].t - hop;
      if (ps[i].t - ps[i - 1].t > HOLE_HOPS * hop && hole > 0)
        bump(hole);
    }
    const p = ps[i];
    if (p.verdict === "unjudged") {
      bump(hop);
      if (p.reason === "dead_mic")
        e.dead_mic_ms += hop;
      continue;
    }
    run = 0;
    if (p.verdict === "speech") {
      e.speech_probes++;
      if (p.doctor_present === true)
        e.doctor_present.yes++;
      else if (p.doctor_present === false)
        e.doctor_present.no++;
      else
        e.doctor_present.unknown++;
    } else
      e.non_speech_probes++;
  }
}
function mergeTwo(x, y, ps, half) {
  const hop = half * 2;
  const a = ps.findIndex((p) => p.t - half === x.start_ms);
  let b = -1;
  for (let i = ps.length - 1; i >= 0; i--)
    if (ps[i].t + half === y.end_ms) {
      b = i;
      break;
    }
  const e = {
    version: SMOOTHER_VERSION,
    start_ms: x.start_ms,
    end_ms: y.end_ms,
    speech_probes: 0,
    non_speech_probes: 0,
    unjudged_ms: 0,
    longest_unjudged_run_ms: 0,
    dead_mic_ms: 0,
    doctor_present: { yes: 0, no: 0, unknown: 0 },
    closed_by: y.closed_by,
    merged_from: x.merged_from + y.merged_from
  };
  tally(e, ps, a, b, hop);
  return e;
}

// e4-entry.ts
var chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const inp = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const coverage = [];
  const spans = [];
  let placed = 0, unplaceable = 0;
  for (const w of inp.windows) {
    const s = w.timeline ? splitWindowText(w.text, w.timeline, w.start_ms) : null;
    if (!s) {
      unplaceable++;
      continue;
    }
    placed++;
    coverage.push({ start_ms: w.start_ms, end_ms: w.end_ms });
    for (const x of s)
      spans.push({ start_ms: x.start_ms, end_ms: x.end_ms, text: x.text ?? "" });
  }
  const transcript = { coverage, spans };
  const verdicts = inp.probes.map((p) => {
    const frames = p.frames_b64 ? Array.from(new Float32Array(new Uint8Array(Buffer.from(p.frames_b64, "base64")).buffer)) : null;
    const g = gateProbe({ start_ms: p.start_ms, end_ms: p.end_ms, energy: frames ? { kind: "frames", frame_rms: frames } : null, transcript });
    return {
      start_ms: p.start_ms,
      end_ms: p.end_ms,
      t: (p.start_ms + p.end_ms) / 2,
      verdict: g.verdict,
      reason: g.reason,
      energy: g.energy.state,
      active_frac: g.energy.active_frac,
      transcript: g.transcript.state,
      ucps: g.transcript.unique_chars_per_s
    };
  });
  const smoothed = {};
  for (const gap of inp.merge_gaps_ms) {
    smoothed[String(gap)] = smoothEncounters(
      verdicts.map((v) => ({ t: v.t, verdict: v.verdict, reason: v.reason })),
      { merge_gap_ms: gap, tape_off: inp.tape_off }
    ).map((e) => ({
      start_ms: e.start_ms,
      end_ms: e.end_ms,
      speech_probes: e.speech_probes,
      non_speech_probes: e.non_speech_probes,
      unjudged_ms: e.unjudged_ms,
      longest_unjudged_run_ms: e.longest_unjudged_run_ms,
      dead_mic_ms: e.dead_mic_ms,
      closed_by: e.closed_by,
      merged_from: e.merged_from
    }));
  }
  process.stdout.write(JSON.stringify({
    gate_version: GATE_VERSION,
    smoother_version: SMOOTHER_VERSION,
    bridge_unjudged_max_ms: BRIDGE_UNJUDGED_MAX_MS,
    windows_placed: placed,
    windows_unplaceable: unplaceable,
    verdicts,
    smoothed
  }));
});
