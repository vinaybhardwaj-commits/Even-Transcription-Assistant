// W49 P3 (Fable 28 Sep 07:5x, named order): the Room Evidence Bundle view in the /#/win/<key> inspector's Technical-detail
// panel. Reads REB-SPEC-v1.md's layout from the R2 mirror (reb/<ist_date>/<room_id>/<window_id>/{manifest.json,tracks/...}),
// read-only, same RESULTS binding every other route uses (no Neon, no write). Whitelists everything - a track file can carry
// fields we don't know about yet (any new engine is a new track per spec section 3), so nothing but the named fields below
// ever reaches the client, and a track this Worker can't validate is dropped rather than passed through.
//
// eta-refuter-2 #5266 (F1): this MUST match kit/reb/reb.py's Window.tracks(latest_ok=True) exactly, not a lookalike. That
// groups by (layer, engine, config_hash) - NOT just (layer, engine): two configs of the same engine (e.g. a fuser's v0 and
// v0-noETR arms) are different evidence, never one "superseding" the other. Within one group, the pick is the latest ok run
// if any exists; if a LATER run of that SAME config is not ok, it's attached as superseded_by (metadata on the good row),
// never a separate row and never the reverse relation. If no run of the config is ever ok, the latest run (whatever status)
// is the row, so a total failure is visible rather than silently absent.
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,300}$/;   // same shape as serveAudio()'s r2 key check
const STATUS_VALUES = new Set(["ok", "empty", "failed", "skipped"]);
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);

// mirrors reb.py's _parse_finished_at: unparseable/missing sorts as the oldest possible value, never crashes, never wins a tie
function finishedAtMs(v) {
  if (typeof v !== "string" || !v) return -Infinity;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : -Infinity;
}

function deriveLang(entry, rawSegments) {
  const m = /^indic-ctc-([a-z]{2})$/.exec(entry.engine);
  if (m) return m[1];
  if (entry.engine === "whisper-forced-en") return "en";
  for (const s of rawSegments || []) {
    const l = (typeof s?.lang === "string" && s.lang) || (typeof s?.extras?.lid?.detected === "string" && s.extras.lid.detected);
    if (l) return String(l).slice(0, 12);
  }
  return null;
}

function safeEntry(e) {
  return e && typeof e === "object"
    && typeof e.layer === "string" && e.layer.length && e.layer.length <= 40
    && typeof e.engine === "string" && e.engine.length && e.engine.length <= 60
    && typeof e.version === "string" && typeof e.config_hash === "string"
    && typeof e.machine === "string" && STATUS_VALUES.has(e.status)
    && typeof e.path === "string" && PATH_RE.test(e.path) && !e.path.includes("..") && !e.path.includes("//");
}

// eta-refuter-2 #5266 (F2): a track's segments are NOT reliably on the manifest's own t0_ms/t1_ms tape clock, even when
// clock=="tape_utc" - a real dev_clip window (source_kind="dev_clip") was found on the box with clock declared "tape_utc"
// but every segment actually 0-based (clip-local, matching its short duration, not the huge absolute tape_utc t0_ms). The
// declared `clock` field is not trustworthy here; detect clip-local behavior from the DATA (every segment fits inside
// [0, duration]) OR from source_kind (dev_clip/suite_synthetic are expected to be clip-local), whichever fires first, and
// offset by manifest.t0_ms so segments land in the SAME absolute frame the audio player's cursor (onTime) is on. A real
// room_tape window's segment clock is UNVERIFIED (no room_tape window exists in reb yet) - this heuristic is the safe
// default for that case too: absolute epoch-ms segments will never satisfy "every segment fits inside a short duration",
// so a genuinely tape_utc window is never mis-offset.
function clipLocalOffset(sourceKind, t0, t1, allRawSegments) {
  const duration = t1 - t0;
  if (sourceKind === "dev_clip" || sourceKind === "suite_synthetic" || sourceKind === "room_tape") return t0;
  if (duration > 0 && allRawSegments.length && allRawSegments.every((s) => Number.isFinite(s?.t0_ms) && Number.isFinite(s?.t1_ms) && s.t0_ms >= -1 && s.t1_ms <= duration + 1)) return t0;
  return 0;
}

// room_tape: eta-refuter-2 #5633/#5692 measured real windows (35/35 stt, 19/19 diar tracks all inside [0, duration]), so the
// offset is t0 unconditionally. A lone padded/absolute outlier must not flip the whole window: a segment starting before 0 or at/after the
// window end (or more than OUTLIER_MS past it) is dropped, one that merely ends late is clamped to the window end.
export const OUTLIER_MS = 30000;
export function placeRoomTapeSegment(t0, t1, s0, s1) {
  const duration = t1 - t0;
  if (s0 < -1 || s0 >= duration || s0 > duration + OUTLIER_MS) return null;
  return [t0 + Math.max(0, s0), t0 + Math.min(s1, duration)];
}

// window_id/room_id/ist_date are the SAME ones the /timeline inspector route already validated (WID_RE / validRoomDate) -
// this function never sees anything it didn't already check the shape of.
export async function rebModel(env, date, room, windowId) {
  if (!env.RESULTS) return { loaded: false };
  let manifest;
  try {
    const o = await env.RESULTS.get(`reb/${date}/${room}/${windowId}/manifest.json`);
    if (!o) return { loaded: false };
    manifest = JSON.parse(await o.text());
  } catch { return { loaded: false }; }
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.tracks)) return { loaded: false };
  const t0 = Number(manifest.t0_ms), t1 = Number(manifest.t1_ms);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return { loaded: false };
  const sourceKind = typeof manifest.source_kind === "string" ? manifest.source_kind : "room_tape";

  const entries = manifest.tracks.filter(safeEntry).slice(0, 200);
  const groups = new Map();   // "layer\0engine\0config_hash" -> entries[]
  for (const e of entries) {
    const k = `${e.layer}\u0000${e.engine}\u0000${e.config_hash}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const picks = [];   // { entry, supersededBy }
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => finishedAtMs(a.finished_at) - finishedAtMs(b.finished_at));
    const latestOverall = sorted[sorted.length - 1];
    const okEntries = sorted.filter((e) => e.status === "ok");
    if (okEntries.length) {
      const chosen = okEntries[okEntries.length - 1];
      picks.push({ entry: chosen, supersededBy: latestOverall !== chosen ? latestOverall : null });
    } else {
      picks.push({ entry: latestOverall, supersededBy: null });
    }
  }

  // fetch every chosen track's body once, up front, so the clip-local check below sees every segment in the window
  const bodies = new Map();   // entry -> raw segments[]
  for (const { entry: e } of picks) {
    let body = null;
    try { const o = await env.RESULTS.get(`reb/${e.path}`); if (o) body = JSON.parse(await o.text()); } catch { body = null; }
    bodies.set(e, Array.isArray(body?.segments) ? body.segments : []);
  }
  const allRawSegments = [...bodies.values()].flat();
  const offset = clipLocalOffset(sourceKind, t0, t1, allRawSegments);

  const tracks = picks.map(({ entry: e, supersededBy: sb }) => {
    const rawSegs = bodies.get(e) || [];
    const segments = rawSegs.slice(0, 500).map((s) => {
      const s0 = Number(s?.t0_ms), s1 = Number(s?.t1_ms);
      if (!Number.isFinite(s0) || !Number.isFinite(s1) || s1 < s0) return null;
      let a = s0 + offset, b = s1 + offset;
      if (sourceKind === "room_tape") { const p = placeRoomTapeSegment(t0, t1, s0, s1); if (!p) return null; [a, b] = p; }
      return { t0_ms: a, t1_ms: b, text: str(s?.text, 1000) || "" };
    }).filter(Boolean);
    return {
      layer: e.layer, engine: e.engine, model: str(e.model, 120), version: str(e.version, 40) || "",
      config_hash: str(e.config_hash, 16) || "", machine: str(e.machine, 80) || "", status: e.status,
      reason: str(e.reason, 240), started_at: str(e.started_at, 40), finished_at: str(e.finished_at, 40),
      lang: deriveLang(e, rawSegs), segments,
      superseded_by: sb ? { status: sb.status, reason: str(sb.reason, 240), machine: str(sb.machine, 80), finished_at: str(sb.finished_at, 40) } : null,
    };
  });
  tracks.sort((a, b) => (a.layer === b.layer ? (a.engine === b.engine ? a.config_hash.localeCompare(b.config_hash) : a.engine.localeCompare(b.engine)) : a.layer.localeCompare(b.layer)));
  return { loaded: true, t0_ms: t0, t1_ms: t1, tracks };
}
