/**
 * scripts/load-warehouse-fixture.ts — load a warehouse extract into the SCRATCH graph
 * (ETA Fuse slice 3, 21 Aug 2026).
 *
 * THIS SCRIPT CARRIES NO DATA. It reads a fixture path given on the command line. The one
 * fixture committed beside it (fixtures/warehouse/synthetic-19-aug.json) is synthetic and its
 * uids are fake; every other fixtures/warehouse/*.json is gitignored, because a real extract
 * holds `individual_uid` and a real extract is never committed.
 *
 * What it does, and the whole of what it does:
 *
 *   for each event, in time order, one at a time:
 *     POST <base-url>/api/brain/cues
 *       { room_id, room_day_id, type, at, payload, source: 'warehouse', source_ref }
 *
 * It is a client of the ONE cue door, exactly like scribe_replay_write is. It issues no SQL,
 * holds no pool, and knows nothing about the schema beyond the shape of that body. Everything
 * that protects a clinic day is on the other side of the door and is not restated here:
 *
 *   · `room_day_id` present  → the route takes the day BY ID and re-reads `scratch` inside the
 *     lock. Not a scratch day → 409 not_a_scratch_day and nothing is written. That is the
 *     guard, and this script cannot weaken it — the worst a wrong --map can do is get refused.
 *   · `source: 'warehouse'` + `source_ref` → 0047's PARTIAL unique index
 *     (source_ref, type, at) WHERE source = 'warehouse' absorbs a re-run through the route's
 *     ON CONFLICT DO NOTHING, and the route reports it as already_existed rather than an error.
 *     Running this twice writes nothing the second time. A run that died half way is finished
 *     by running it again.
 *
 * NO REPO IMPORTS, on purpose, and this is a real constraint rather than a style choice:
 * importing @/lib/brain/scratch would pull in @/lib/db, which builds a Neon handle from env at
 * module load — a CLI would then need the database URLs it has no business holding. So the two
 * things this script needs from that module (the id prefixes) are re-derived below and asserted
 * against it in tests/unit/warehouse-join.test.ts, which imports both and compares. Being
 * import-free also means it runs under `node` alone (Node ≥22.18 strips types) with no tsx,
 * no ts-node, and no new devDependency — package.json is not touched by this build.
 *
 * Usage:
 *   BRAIN_SERVICE_TOKEN=… node scripts/load-warehouse-fixture.ts \
 *     --fixture fixtures/warehouse/synthetic-19-aug.json \
 *     --base-url https://even-transcription-assistant.vercel.app \
 *     --map opd-7=rd_scratch_qyzghzaf_20260819,cardiology=rd_scratch_xxxxxxxx_20260819
 *
 * It prints COUNTS ONLY. No individual_uid, no payload, no token, ever reaches stdout or
 * stderr — the per-event line names the type and the source_ref and nothing else, and
 * source_ref is a warehouse row id, not a person.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Ids — mirrored from lib/brain/scratch.ts (see the no-imports note above).
// tests/unit/warehouse-join.test.ts imports BOTH and asserts they agree, so this
// copy cannot drift silently.
// ---------------------------------------------------------------------------

export const SCRATCH_ROOM_PREFIX = "room_scratch_";
export const SCRATCH_ROOM_DAY_PREFIX = "rd_scratch_";

/** `rd_scratch_qyzghzaf_20260819` → `room_scratch_qyzghzaf`; null if it is not a scratch day id. */
export function scratchRoomIdForDay(roomDayId: string): string | null {
  // The trailing _YYYYMMDD is the date scratchRoomDayIdFor() appended; everything between the
  // prefix and it is the real room's suffix. Anchored at both ends: a live `rd_…` id, or a
  // typo, yields null rather than a plausible-looking room that does not exist.
  const m = /^rd_scratch_(.+)_(\d{8})$/.exec(roomDayId);
  if (!m || !m[1]) return null;
  return `${SCRATCH_ROOM_PREFIX}${m[1]}`;
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

export type WarehouseEvent = {
  /** map key — the real room this event belongs to, e.g. 'opd-7'. Never a room id. */
  room: string;
  /** cue type: pqm_called | consult_start | dx_event | pulse_note (open set — not enforced). */
  type: string;
  /** ISO timestamp, the warehouse's own clock. */
  at: string;
  /** the warehouse row's id — 0047's natural key, and what makes a re-run a no-op. */
  source_ref: string;
  payload?: Record<string, unknown>;
};

/**
 * The four warehouse signals the Brain PRD §6 names. Listed for the report and the fixture,
 * and deliberately NOT enforced: cue.type is an open set by design (0042 declares it with no
 * CHECK), so refusing an unknown type here would be this script inventing a constraint the
 * database does not have. A typo shows up instead as its own line in the by-type counts.
 */
export const WAREHOUSE_CUE_TYPES = ["pqm_called", "consult_start", "dx_event", "pulse_note"] as const;

export type LoaderArgs = { fixture: string; baseUrl: string; map: Record<string, string> };
export type Refusal = { error: string; detail?: string };

/**
 * `opd-7=rd_a,cardiology=rd_b` → { 'opd-7': 'rd_a', cardiology: 'rd_b' }.
 *
 * TAGGED result rather than `Record<string, string> | Refusal`: a Refusal is structurally a
 * Record<string, string>, so that union does not narrow on `"error" in x` and the compiler is
 * right to reject it. `ok` makes the discriminant real.
 */
export function parseMap(raw: string): { ok: true; map: Record<string, string> } | Refusal {
  const map: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const s = pair.trim();
    if (!s) continue;
    const eq = s.indexOf("=");
    if (eq <= 0 || eq === s.length - 1) return { error: "bad_map_entry", detail: s };
    const key = s.slice(0, eq).trim();
    const dayId = s.slice(eq + 1).trim();
    if (!dayId.startsWith(SCRATCH_ROOM_DAY_PREFIX)) return { error: "map_target_not_scratch", detail: `${key}=${dayId}` };
    if (!scratchRoomIdForDay(dayId)) return { error: "map_target_malformed", detail: `${key}=${dayId}` };
    if (map[key]) return { error: "duplicate_map_key", detail: key };
    map[key] = dayId;
  }
  if (Object.keys(map).length === 0) return { error: "empty_map" };
  return { ok: true, map };
}

export function parseArgs(argv: string[]): LoaderArgs | Refusal {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? String(argv[i + 1]) : null;
  };
  const fixture = get("--fixture");
  if (!fixture) return { error: "fixture_required", detail: "--fixture <path>" };
  // No default base-url on purpose: a default would eventually point a real extract at
  // whatever host was convenient. Naming it is one flag and removes the whole class.
  const baseUrl = get("--base-url");
  if (!baseUrl) return { error: "base_url_required", detail: "--base-url <origin>" };
  const rawMap = get("--map");
  if (!rawMap) return { error: "map_required", detail: "--map opd-7=<room_day_id>,…" };
  const parsed = parseMap(rawMap);
  if ("error" in parsed) return parsed;
  return { fixture, baseUrl, map: parsed.map };
}

/** Accepts `{ events: [...] }` or a bare `[...]` — a real extract may be either. */
export function readEvents(doc: unknown): WarehouseEvent[] | Refusal {
  const raw = Array.isArray(doc) ? doc : (doc as { events?: unknown } | null)?.events;
  if (!Array.isArray(raw)) return { error: "fixture_has_no_events" };
  return raw as WarehouseEvent[];
}

/**
 * Everything that can be known before a single request goes out. Both refusals the brief names
 * are here, and both are checked over the WHOLE fixture before anything is written: a fixture
 * that is wrong at event 40 must not leave 39 cues behind it.
 */
export function validateFixture(events: WarehouseEvent[], map: Record<string, string>): Refusal | null {
  if (events.length === 0) return { error: "fixture_empty" };
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const where = `event ${i}`;
    if (!e || typeof e !== "object") return { error: "event_not_an_object", detail: where };
    if (typeof e.room !== "string" || !e.room) return { error: "event_room_required", detail: where };
    if (typeof e.type !== "string" || !e.type) return { error: "event_type_required", detail: where };
    if (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) return { error: "event_at_invalid", detail: where };
    // No source_ref means no natural key, which means a re-run would double-write it.
    if (typeof e.source_ref !== "string" || !e.source_ref) return { error: "event_source_ref_required", detail: `${where} (${e.room}/${e.type})` };
    if (!map[e.room]) return { error: "room_not_in_map", detail: e.room };
    if (e.payload !== undefined && (typeof e.payload !== "object" || e.payload === null || Array.isArray(e.payload))) {
      return { error: "event_payload_must_be_object", detail: where };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The load
// ---------------------------------------------------------------------------

export type LoadResult = {
  ok: boolean;
  total: number;
  written: number;
  already_existed: number;
  failed: number;
  by_type: Record<string, number>;
  /** type + source_ref only — never a payload, never a uid. */
  failures: Array<{ type: string; source_ref: string; error: string }>;
  stopped_early?: boolean;
};

/** Same rule as scribe_replay_write: three failures in a row is a broken door, not bad luck. */
export const MAX_CONSECUTIVE_FAILURES = 3;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export async function loadWarehouseFixture(opts: {
  events: WarehouseEvent[];
  map: Record<string, string>;
  baseUrl: string;
  token: string;
  fetchImpl?: FetchLike;
  onProgress?: (line: string) => void;
}): Promise<LoadResult> {
  const doFetch = (opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));
  const url = new URL("/api/brain/cues", opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`).toString();

  // Time order, stably: the warehouse's own clock decides, and equal timestamps keep fixture
  // order so a re-run of the same file issues the same requests in the same sequence.
  const ordered = opts.events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => Date.parse(a.e.at) - Date.parse(b.e.at) || a.i - b.i)
    .map((x) => x.e);

  const out: LoadResult = { ok: true, total: ordered.length, written: 0, already_existed: 0, failed: 0, by_type: {}, failures: [] };

  // Resolve every mapped day to its scratch room BEFORE the first request. parseMap already
  // rejects a malformed target, but this function is exported and callable with a map that
  // never went through it — and the failure mode without this check is the worst kind: a body
  // with a null room_id, which the route answers room_id_required, one event at a time, for
  // the whole fixture. Refuse the whole run instead, having written nothing.
  const roomIds: Record<string, string> = {};
  for (const [room, dayId] of Object.entries(opts.map)) {
    const roomId = scratchRoomIdForDay(dayId);
    if (!roomId) {
      out.ok = false;
      out.failed = ordered.length;
      out.failures.push({ type: "-", source_ref: "-", error: "map_target_malformed" });
      opts.onProgress?.(`  ✗ map_target_malformed — ${room}=${dayId}; nothing written`);
      return out;
    }
    roomIds[room] = roomId;
  }

  let consecutive = 0;

  for (const e of ordered) {
    const roomDayId = opts.map[e.room]!;
    const roomId = roomIds[e.room]!; // resolved above, never null here
    const body = {
      room_id: roomId,
      room_day_id: roomDayId,
      type: e.type,
      at: new Date(e.at).toISOString(),
      payload: e.payload ?? {},
      source: "warehouse",
      source_ref: e.source_ref,
    };

    let ok = false;
    let error = "";
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token}` },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; already_existed?: boolean } | null;
      if (res.ok && j?.ok) {
        ok = true;
        if (j.already_existed === true) out.already_existed++;
        else out.written++;
        out.by_type[e.type] = (out.by_type[e.type] ?? 0) + 1;
      } else {
        error = j?.error ?? `http_${res.status}`;
      }
    } catch (err) {
      error = String((err as Error)?.message ?? err).slice(0, 120);
    }

    if (ok) {
      consecutive = 0;
    } else {
      out.failed++;
      consecutive++;
      out.failures.push({ type: e.type, source_ref: e.source_ref, error });
      opts.onProgress?.(`  ✗ ${e.type} ${e.source_ref} — ${error}`);
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
        out.stopped_early = true;
        opts.onProgress?.(`  … stopping after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
        break;
      }
    }
  }

  out.ok = out.failed === 0;
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    console.error(`refused: ${args.error}${args.detail ? ` — ${args.detail}` : ""}`);
    return 2;
  }
  const token = process.env.BRAIN_SERVICE_TOKEN;
  if (!token) {
    console.error("refused: service_token_not_configured — set BRAIN_SERVICE_TOKEN");
    return 2;
  }

  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(args.fixture, "utf8"));
  } catch (e) {
    console.error(`refused: fixture_unreadable — ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    return 2;
  }
  const events = readEvents(doc);
  if ("error" in events) {
    console.error(`refused: ${events.error}`);
    return 2;
  }
  const bad = validateFixture(events, args.map);
  if (bad) {
    console.error(`refused: ${bad.error}${bad.detail ? ` — ${bad.detail}` : ""}`);
    return 2;
  }

  console.log(`fixture ${args.fixture}: ${events.length} events → ${Object.keys(args.map).length} scratch day(s) at ${args.baseUrl}`);
  for (const [room, dayId] of Object.entries(args.map)) console.log(`  ${room} → ${dayId} (${scratchRoomIdForDay(dayId)})`);

  const r = await loadWarehouseFixture({
    events,
    map: args.map,
    baseUrl: args.baseUrl,
    token,
    onProgress: (l) => console.error(l),
  });

  console.log(`written ${r.written}  already-existed ${r.already_existed}  failed ${r.failed}  of ${r.total}`);
  console.log(`by type: ${Object.entries(r.by_type).map(([t, n]) => `${t}=${n}`).join("  ") || "(none)"}`);
  if (r.stopped_early) console.log(`STOPPED EARLY after ${MAX_CONSECUTIVE_FAILURES} consecutive failures — re-run to resume; nothing already written is written twice`);
  return r.ok ? 0 : 1;
}

// Run only when invoked directly, so the test can import every function above without the
// script trying to talk to a brain.
const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  main().then(
    (code) => { process.exitCode = code; },
    (e) => { console.error(`crashed: ${String((e as Error)?.message ?? e).slice(0, 200)}`); process.exitCode = 1; },
  );
}
