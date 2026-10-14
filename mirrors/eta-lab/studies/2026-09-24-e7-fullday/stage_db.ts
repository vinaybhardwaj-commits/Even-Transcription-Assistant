/**
 * E-7 full-day rescore, database stages. Run by e7-rescore.sh under vite-node inside the E-6.1 worktree
 * (so `@/…` is that branch's code). Numbers, ids and room labels only on stdout; secrets arrive by env.
 *
 *   rooms  <date> <outdir>   every room-day of the IST date, its voiceprint attribution, and whether one
 *                            clinician is confirmed (>= 30 attributed turns, one clinician >= 80% of them —
 *                            the thresholds of the 20-23 Sep runs). Writes confirmed.json, and windows.json: every
 *                            window of the confirmed room-days with whether it was transcribed (E-6.2 proposal 3 —
 *                            a consult with no transcript is an STT gap, not an encounter-clock miss).
 *   replay <date> <outdir>   shadow-runner v2 (fusion v1.1 = E-6 + E-6.1) over the CONFIRMED room-days only:
 *                            writes an acoustic and a fused run each, then derives the three arms from that
 *                            ONE Jev sample: acoustic, fused (acoustic-origin intervals of the fused run —
 *                            exactly E-6), fused+E-6.1 (all of them). Writes hyp-{acoustic,fused,fused-e61}.json.
 *   check  <date>            SELECT 1 and a room_day count for the date. No Jev, no writes.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { sql } from "@/lib/db";
import { runFusionShadowForRoomDay } from "@/lib/encounter-clock/shadow-v2";
import { readRun } from "@/lib/encounter-hypotheses";
import { FUSION_VERSION, START_P } from "@/lib/encounter-clock/fusion";
import { JEV_INPUT_TOKEN_COST_USD } from "@/lib/jev/counters";

const MIN_ATTRIBUTED = 30, MIN_SHARE = 0.8;
// transcript_version from e7-rescore.sh --transcript (W28.2): recorded in every hyp-*.json as the
// version the replays were scored under; null when the flag is absent (no behavior change).
const TRANSCRIPT_VERSION: string | null = process.env.E7_TRANSCRIPT_VERSION ?? null;
const [mode, date, outdir] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) { console.log("STAGE_FAIL bad_date"); process.exit(2); }

type Confirmed = { room: string; room_id: string; room_day_id: string; turns: number; attributed: number;
  attribution_rate: number | null; top_clinician_id: string | null; top_clinician_name: string | null; top_share: number | null; confirmed: boolean };

async function rooms() {
  const days = (await sql`
    SELECT rd.id AS room_day_id, rd.room_id, r.name AS room,
           count(rts.window_id)::int AS turns,
           count(*) FILTER (WHERE rts.role = 'clinician')::int AS attributed
      FROM room_day rd JOIN room r ON r.id = rd.room_id
      LEFT JOIN room_turn_speaker rts ON rts.room_day_id = rd.id
     WHERE rd.ist_date = ${date}::date
     GROUP BY 1, 2, 3 ORDER BY 3`) as Array<{ room_day_id: string; room_id: string; room: string; turns: number; attributed: number }>;
  const by = (await sql`
    SELECT rts.room_day_id, rts.clinician_id, c.full_name, count(*)::int AS n
      FROM room_turn_speaker rts
      JOIN room_day rd ON rd.id = rts.room_day_id
      LEFT JOIN clinician c ON c.id = rts.clinician_id
     WHERE rd.ist_date = ${date}::date AND rts.role = 'clinician'
     GROUP BY 1, 2, 3`) as Array<{ room_day_id: string; clinician_id: string | null; full_name: string | null; n: number }>;
  const out: Confirmed[] = days.map((d) => {
    const mine = by.filter((b) => b.room_day_id === d.room_day_id).sort((a, b) => b.n - a.n);
    const top = mine[0];
    const share = top && d.attributed ? top.n / d.attributed : null;
    return {
      room: d.room, room_id: d.room_id, room_day_id: d.room_day_id, turns: d.turns, attributed: d.attributed,
      attribution_rate: d.turns ? Math.round((d.attributed / d.turns) * 1000) / 1000 : null,
      top_clinician_id: top?.clinician_id ?? null, top_clinician_name: top?.full_name ?? null,
      top_share: share === null ? null : Math.round(share * 1000) / 1000,
      confirmed: d.attributed >= MIN_ATTRIBUTED && share !== null && share >= MIN_SHARE,
    };
  });
  writeFileSync(`${outdir}/confirmed.json`, JSON.stringify({ date, thresholds: { min_attributed_turns: MIN_ATTRIBUTED, min_share_one_clinician: MIN_SHARE }, room_days: out }, null, 1));
  const confirmedIds = out.filter((r) => r.confirmed).map((r) => r.room_day_id);
  const windows = confirmedIds.length ? ((await sql`
    SELECT w.room_day_id, w.start_ms, w.end_ms,
           EXISTS (SELECT 1 FROM transcription_run t
                    WHERE t.subject_type = 'bench_window' AND t.subject_id = w.id
                      AND coalesce(t.transcript_original, '') <> '') AS transcribed
      FROM bench_window w
     WHERE w.room_day_id = ANY(${confirmedIds}::text[])
     ORDER BY 1, 2`) as Array<{ room_day_id: string; start_ms: number | string; end_ms: number | string; transcribed: boolean }>) : [];
  writeFileSync(`${outdir}/windows.json`, JSON.stringify(windows.map((w) => ({ room_day_id: w.room_day_id, start_ms: Number(w.start_ms), end_ms: Number(w.end_ms), transcribed: w.transcribed }))));
  console.log(`WINDOWS confirmed_room_days=${confirmedIds.length} windows=${windows.length} transcribed=${windows.filter((w) => w.transcribed).length}`);
  // When one doctor is confirmed in TWO rooms on the same day, PQM (no room field) cannot say which room a
  // consult was in. attribution.json places the doctor's voice in time, per window, so build_truth.py can put
  // each consult in the room where that voice was, or report it ambiguous. Counts only.
  const attribution = confirmedIds.length ? ((await sql`
    SELECT rts.room_day_id, w.start_ms, w.end_ms, rts.clinician_id, count(*)::int AS n
      FROM room_turn_speaker rts JOIN bench_window w ON w.id = rts.window_id
     WHERE rts.room_day_id = ANY(${confirmedIds}::text[]) AND rts.role = 'clinician'
     GROUP BY 1, 2, 3, 4`) as Array<{ room_day_id: string; start_ms: number | string; end_ms: number | string; clinician_id: string; n: number }>) : [];
  writeFileSync(`${outdir}/attribution.json`, JSON.stringify(attribution.map((a) => ({ room_day_id: a.room_day_id, start_ms: Number(a.start_ms), end_ms: Number(a.end_ms), clinician_id: a.clinician_id, n: a.n }))));
  // ENCOUNTER-FIRST arm d (Fable, 24 Sep 10:20): the day's level samples and the diarizer's speaker segments for
  // the confirmed room-days — the only inputs of studies/2026-09-24-encounter-first/segmenter.py. Numbers only.
  const roomOfRd = new Map(out.filter((r) => r.confirmed).map((r) => [r.room_day_id, r.room_id] as const));
  const confirmedRooms = [...new Set(roomOfRd.values())];
  const levels = confirmedRooms.length ? ((await sql`
    SELECT room_id, (extract(epoch from sampled_at) * 1000)::bigint AS t, peak
      FROM bench_level_sample
     WHERE ist_date = ${date}::date AND room_id = ANY(${confirmedRooms}::text[])
     ORDER BY 1, 2`) as Array<{ room_id: string; t: number | string; peak: number }>) : [];
  const rdOfRoom = new Map([...roomOfRd].map(([rd, room]) => [room, rd] as const));
  writeFileSync(`${outdir}/levels.json`, JSON.stringify(levels.map((l) => ({ room_day_id: rdOfRoom.get(l.room_id), t: Number(l.t), peak: Number(l.peak) }))));
  const labels = confirmedIds.length ? ((await sql`
    SELECT l.room_day_id, l.window_id, l.engine, w.start_ms, w.end_ms, l.segments_json
      FROM diarize_window_label l JOIN bench_window w ON w.id = l.window_id
     WHERE l.room_day_id = ANY(${confirmedIds}::text[])`) as Array<Record<string, unknown>>) : [];
  writeFileSync(`${outdir}/labels.json`, JSON.stringify(labels.map((r) => ({ ...r, start_ms: Number(r.start_ms), end_ms: Number(r.end_ms) }))));
  console.log(`SEGMENTER_INPUTS level_samples=${levels.length} label_rows=${labels.length}`);
  const byDoc = new Map<string, number>();
  for (const r of out.filter((x) => x.confirmed)) byDoc.set(r.top_clinician_id ?? "", (byDoc.get(r.top_clinician_id ?? "") ?? 0) + 1);
  for (const [doc, n] of byDoc) if (n > 1) console.log(`MULTI_ROOM_DOCTOR ${doc} confirmed_in=${n} room-days — build_truth assigns each consult by attributed voice`);
  for (const r of out) console.log("ROOM", r.room_day_id, JSON.stringify(r.room), `turns=${r.turns}`, `attributed=${r.attributed}`, `top_share=${r.top_share}`, r.confirmed ? "CONFIRMED" : "unmapped");
  console.log(`ROOMS_DONE room_days=${out.length} confirmed=${out.filter((r) => r.confirmed).length}`);
}

async function replay() {
  const conf = JSON.parse(readFileSync(`${outdir}/confirmed.json`, "utf8")) as { room_days: Confirmed[] };
  const targets = conf.room_days.filter((r) => r.confirmed);
  const startedAt = new Date();
  const arms: Record<"acoustic" | "fused" | "fused-e61", Record<string, unknown>> = { acoustic: {}, fused: {}, "fused-e61": {} };
  const summaries: Record<string, unknown> = {};
  let failed = 0;
  for (const t of targets) {
    const t0 = Date.now();
    try {
      const r = await runFusionShadowForRoomDay({ room_id: t.room_id, room_day_id: t.room_day_id, ist_date: date! });
      if (!r.ok) { failed++; summaries[t.room_day_id] = { ok: false, error: r.error }; console.log("REPLAY", t.room_day_id, "FAILED", r.error); continue; }
      const [ac, fu] = await Promise.all([readRun(r.acoustic_run_id), readRun(r.fused_run_id)]);
      if (!ac || !fu) { failed++; console.log("REPLAY", t.room_day_id, "FAILED run_readback"); continue; }
      const jev = new Set(((fu.params.jev_origin ?? []) as Array<{ start_ms: number; end_ms: number }>).map((x) => `${x.start_ms}-${x.end_ms}`));
      const iv = (hs: typeof ac.hypotheses) => hs.map((h) => ({ id: h.id, start_ms: h.start_ms, end_ms: h.end_ms, origin: jev.has(`${h.start_ms}-${h.end_ms}`) ? "jev" : "acoustic" }));
      const meta = { room: t.room, date, energy_gap: false };
      arms.acoustic[t.room_day_id] = { ...meta, run_id: ac.id, encounters: iv(ac.hypotheses).map(({ origin: _o, ...e }) => e) };
      arms.fused[t.room_day_id] = { ...meta, run_id: fu.id, encounters: iv(fu.hypotheses).filter((e) => e.origin === "acoustic") };
      arms["fused-e61"][t.room_day_id] = { ...meta, run_id: fu.id, encounters: iv(fu.hypotheses) };
      summaries[t.room_day_id] = { ok: true, probes: r.summary.probes, jev: r.summary.jev, fusion: r.summary.fusion, proposals: r.summary.proposals };
      console.log("REPLAY", t.room_day_id, "ok", JSON.stringify({ fusion: r.summary.fusion, proposals: r.summary.proposals }), `${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      failed++; console.log("REPLAY", t.room_day_id, "THREW", (e as Error)?.name);
    }
  }
  for (const [arm, rds] of Object.entries(arms)) {
    writeFileSync(`${outdir}/hyp-${arm}.json`, JSON.stringify({
      source: arm === "acoustic" ? "acoustic" : "fused", arm, fusion_version: FUSION_VERSION, start_p: START_P,
      transcript_version: TRANSCRIPT_VERSION,
      smoother_version: "encounter-clock-smooth-v1", shadow_version: "encounter-clock-shadow-v2",
      note: "One v2 replay per room-day; the three arms share one Jev sample. fused = the acoustic-origin intervals of the fused run (E-6); fused-e61 = all of them.",
      room_days: rds }, null, 1));
  }
  const tok = (await sql`SELECT coalesce(sum(input_tokens), 0)::bigint AS t, count(*)::int AS n FROM jev_decision
                           WHERE subject_type = 'probe' AND created_at >= ${startedAt.toISOString()}`) as Array<{ t: string; n: number }>;
  const totals = { room_days: targets.length, failed, jev_decision_rows: tok[0]?.n ?? 0, jev_input_tokens: Number(tok[0]?.t ?? 0),
    jev_cost_usd_est: Number(tok[0]?.t ?? 0) * JEV_INPUT_TOKEN_COST_USD };
  writeFileSync(`${outdir}/replay-summary.json`, JSON.stringify({ started_at: startedAt.toISOString(), totals, room_days: summaries }, null, 1));
  console.log("REPLAY_DONE", JSON.stringify(totals));
  if (failed) process.exit(3);
}

async function check() {
  const one = (await sql`SELECT 1 AS ok`) as Array<{ ok: number }>;
  const n = (await sql`SELECT count(*)::int AS n FROM room_day WHERE ist_date = ${date}::date`) as Array<{ n: number }>;
  console.log(`CHECK_DB ok=${one[0]?.ok === 1} room_days_for_date=${n[0]?.n}`);
}

const run = mode === "rooms" ? rooms : mode === "replay" ? replay : mode === "check" ? check : null;
if (!run) { console.log("STAGE_FAIL bad_mode"); process.exit(2); }
run().catch((e) => { console.log("STAGE_FAIL", mode, (e as Error)?.name, String((e as Error)?.message ?? "").replace(/postgres(ql)?:\/\/\S+/g, "<url>").slice(0, 160)); process.exit(1); });
