"use client";

/**
 * use-room-recorder — Room Bench capture hook (Room-Bench PRD §3.3, D1/D8).
 *
 * Mirrors lib/use-media-recorder's conventions (mime preference order, state
 * machine, error surfaces) but with the bench chunk cycle instead of 250ms
 * timeslice fragments:
 *
 *   - One getUserMedia stream for the whole day (same audio constraints as
 *     useMediaRecorder).
 *   - A NEW MediaRecorder per 5-minute chunk, started with NO timeslice:
 *     stop → single self-contained playable WebM blob → restart immediately
 *     (D1; seam target <500ms — the stream stays open so the seam is just
 *     recorder stop/start).
 *   - Durability (D8): every finalized chunk is held in memory AND IndexedDB
 *     (db `eta-bench`, store `chunks`, key `{session_id}:{idx}`) until its
 *     R2 upload is VERIFIED (client HEAD + server-side re-verify inside
 *     POST /api/bench/chunks). Only then are local copies released.
 *   - Retry: exponential backoff 5s → 60s cap, forever, oldest-first.
 *   - gap_before_ms records true capture dead time (pause/crash windows),
 *     never upload lag.
 *   - Recovery: on mount, unverified IndexedDB chunks (any session) are
 *     re-queued oldest-first and drained automatically.
 *
 * The room surface makes NO transcription/vendor connections — capture and
 * upload only (PRD §3.3).
 *
 * Kickoff B (Ambient Brain PRD §9) additions — instrumentation + hookup only,
 * the chunk cycle above is unchanged: `getStream()` lets the flag-gated live
 * sink (lib/use-live-sink) attach a second MediaRecorder to the same stream;
 * `onSeam` / `onRecorderError` report rotation seam timing and archive
 * recorder errors; `[bench-seam]` is logged on every rotation (flag on or off).
 *
 * Kickoff K-B — dual-mic capture + primary failsafe:
 *   - TWO lanes share ONE chunk/durability/upload machinery. The PRIMARY lane is
 *     today's USB-mic path, byte-identical on the wire (no `source` field sent,
 *     same IndexedDB keys, same R2 names). The BACKUP lane (`source:'backup'`,
 *     second getUserMedia on an explicit deviceId — built-in mic by default) runs
 *     in LOCKSTEP with start/pause/resume/end and every 5-min rotation (R7), in
 *     its own try/catch domain with its own recorder/stream refs: a backup
 *     failure is an event + retry-with-backoff and is structurally incapable of
 *     touching the primary (R4/R8/R12).
 *   - PRIMARY FAILSAFE (R5): track `ended` + `devicechange` listeners + a
 *     lightweight silence watchdog (RMS≈0 for ~60 s). On trip: flush the current
 *     primary segment, `mic_primary_lost` event (via onEvent → POST
 *     /api/bench/events), status.primaryMic = 'lost' (or 'silent' when the device
 *     is still present), re-acquire loop with backoff. On recovery: same session,
 *     primary resumes at the next idx (gap_before_ms records the dead time),
 *     `mic_primary_restored`. The session id never changes.
 */

import * as React from "react";
import { LIVE_SINK } from "@/lib/live-flags";
import { CHUNK_DISAGREEMENT_FIELD, ENDED_DISAGREES } from "@/lib/bench-bus-constants";
import {
  idbChunkKey,
  pickDefaultBackupDevice,
  rmsOfBytes,
  runLockstep,
  SilenceWatchdog,
  uploadBodies,
  type BenchMicEventKind,
  type ChunkSource,
} from "@/lib/bench-dual";
import { primaryFallbackEvents, seedStartIdx } from "@/lib/bench-resume-core";

const CHUNK_MS = 5 * 60 * 1000; // D1: 5-minute chunks
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const REACQUIRE_MIN_MS = 5_000; // primary/backup device re-acquire loop
const REACQUIRE_MAX_MS = 30_000;
const WATCHDOG_TICK_MS = 1_000;
// FU4: a rejoined session has no tap, so the watchdog's AudioContext can stay suspended and
// the silence failsafe would be silently dead. If it is still not running this long after
// the rejoin, say so (event + kiosk chip) instead of monitoring nothing.
const WATCHDOG_ARM_CHECK_MS = 10_000;

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
];

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 16000 },
};

// ---------------------------------------------------------------------------
// IndexedDB — db `eta-bench`; store `chunks` (key `{session_id}:{idx}`, backup
// `{session_id}:backup:{idx}`); store `settings` (K-B: persisted device choices)
// ---------------------------------------------------------------------------

const DB_NAME = "eta-bench";
const DB_VERSION = 2; // v2 (K-B): adds the `settings` store; `chunks` untouched
const STORE = "chunks";
const SETTINGS_STORE = "settings";

export type BenchChunkRecord = {
  key: string; // `${session_id}:${idx}` (primary) | `${session_id}:backup:${idx}`
  session_id: string;
  idx: number;
  /** K-B: absent on records written before dual-mic → primary */
  source?: ChunkSource;
  blob: Blob;
  content_type: string;
  started_at: number; // ms epoch
  ended_at: number; // ms epoch
  duration_ms: number;
  gap_before_ms: number;
  ts: number;
};

function isClient(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isClient()) {
      reject(new Error("indexeddb_not_available"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb_open_failed"));
    req.onblocked = () => reject(new Error("idb_blocked"));
  });
}

async function idbPut(rec: BenchChunkRecord): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const req = tx.objectStore(STORE).put(rec);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error("put_failed"));
    });
  } finally {
    db.close();
  }
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const req = tx.objectStore(STORE).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error("delete_failed"));
    });
  } finally {
    db.close();
  }
}

async function idbListAll(): Promise<BenchChunkRecord[]> {
  if (!isClient()) return [];
  const db = await openDb();
  try {
    return await new Promise<BenchChunkRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).openCursor();
      const rows: BenchChunkRecord[] = [];
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          rows.push(cursor.value as BenchChunkRecord);
          cursor.continue();
        } else {
          rows.sort((a, b) => a.ts - b.ts);
          resolve(rows);
        }
      };
      req.onerror = () => reject(req.error ?? new Error("scan_failed"));
    });
  } finally {
    db.close();
  }
}

/** K-B: persisted kiosk settings (e.g. the chosen backup device). Fail-safe: null on error. */
export async function loadBenchSetting<T = unknown>(key: string): Promise<T | null> {
  try {
    const db = await openDb();
    try {
      return await new Promise<T | null>((resolve, reject) => {
        const tx = db.transaction(SETTINGS_STORE, "readonly");
        const req = tx.objectStore(SETTINGS_STORE).get(key);
        req.onsuccess = () => resolve((req.result as { value?: T } | undefined)?.value ?? null);
        req.onerror = () => reject(req.error ?? new Error("get_failed"));
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function saveBenchSetting(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(SETTINGS_STORE, "readwrite");
        const req = tx.objectStore(SETTINGS_STORE).put({ key, value, ts: Date.now() });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error("put_failed"));
      });
    } finally {
      db.close();
    }
  } catch {
    /* settings are a convenience — never fatal */
  }
}

export const BACKUP_DEVICE_SETTING = "backup_device_id";
/** FU3: the chosen primary mic, persisted by the start screen's select — a rejoined tape
 *  must reopen the room's microphone, not the browser default. */
export const PRIMARY_DEVICE_SETTING = "primary_device_id";
export { pickDefaultBackupDevice };

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type RoomRecorderState = "idle" | "recording" | "paused" | "ending" | "ended" | "error";
export type PrimaryMicState = "active" | "lost" | "silent";
export type BackupMicState = "off" | "acquiring" | "active" | "error";

export type RoomRecorderStatus = {
  state: RoomRecorderState;
  error: string | null;
  mimeType: string | undefined;
  /** 0-based index of the chunk currently being recorded (primary lane). */
  currentIdx: number;
  /** ms into the current chunk. */
  chunkElapsedMs: number;
  /** ms since the day started (wall clock, includes pauses). */
  dayElapsedMs: number;
  dayStartedAt: number | null;
  pausedAt: number | null;
  /** primary chunks verified in R2 (this browser session, incl. recovered; a rejoin
   *  seeds it with the count the server already holds — P5-3c). */
  archivedCount: number;
  archivedBytes: number;
  /** chunks (both lanes) held locally awaiting verified upload. */
  queuedCount: number;
  lastVerifiedAt: number | null;
  /** unverified chunks found in IndexedDB from a previous session. */
  recoveredPending: number;
  offline: boolean;
  micLost: boolean;
  storageBlocked: boolean;
  // ---- K-B ----
  primaryMic: PrimaryMicState;
  primaryLostAt: number | null;
  primaryLostReason: string | null;
  backupMic: BackupMicState;
  backupError: string | null;
  backupIdx: number;
  backupArchivedCount: number;
  backupArchivedBytes: number;
  /** FU4: the silence watchdog's AudioContext never started running after a rejoin —
   *  mic monitoring is NOT armed until someone taps the screen. */
  watchdogSuspended: boolean;
};

type QueueItem = BenchChunkRecord;

/**
 * Archive chunk seam (Kickoff B instrumentation): the recorder restart gap at a
 * 5-minute rotation — `seam_ms` = next rec.start() − previous rec.stop() call;
 * `stop_latency_ms` = how long stop() took to deliver the blob. Logged as
 * `[bench-seam]` on every rotation (flag on OR off — the go/no-go compares both).
 */
export type ArchiveSeamEvent = { idx: number; seam_ms: number; stop_latency_ms: number };

export type BenchMicEvent = { kind: BenchMicEventKind; at: number; payload: Record<string, unknown> };

type Lane = {
  source: ChunkSource;
  stream: MediaStream | null;
  rec: MediaRecorder | null;
  idx: number;
  chunkStartedAt: number;
  lastChunkEndedAt: number | null;
  stopCalledAt: number;
  /** requested device (null = browser default) */
  deviceId: string | null;
};

const newLane = (source: ChunkSource): Lane => ({
  source,
  stream: null,
  rec: null,
  idx: 0,
  chunkStartedAt: 0,
  lastChunkEndedAt: null,
  stopCalledAt: 0,
  deviceId: null,
});

function stopTracks(stream: MediaStream | null) {
  try {
    stream?.getTracks().forEach((t) => t.stop());
  } catch {
    /* noop */
  }
}

export function useRoomRecorder(opts?: {
  onError?: (e: Error) => void;
  /** Kickoff B: per-rotation seam timing (live-sink instrumentation). */
  onSeam?: (s: ArchiveSeamEvent) => void;
  /** Kickoff B: archive MediaRecorder error (the live sink sacrifices itself on it). */
  onRecorderError?: (message: string) => void;
  /** K-B: mic-story events (mic_primary_lost / restored, mic_backup_*) — the kiosk posts them. */
  onEvent?: (e: BenchMicEvent) => void;
  /**
   * ENDED DISAGREES — the server accepted the chunk and told us the SESSION is over.
   *
   * Fired at most ONCE per hook life, from the upload drain. The chunk upload is the only channel
   * that reaches a tab which is not reloading, and a tab that never reloads holding the session id
   * in its own memory is exactly what bs_g3dwud4p was: told nothing, it kept recording into an
   * ended session for six hours. The caller is expected to flush and stop — never to start
   * anything new.
   */
  onSessionEndedByServer?: (disagreement: string) => void;
}) {
  const [state, setState] = React.useState<RoomRecorderState>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [mimeType, setMimeType] = React.useState<string | undefined>(undefined);
  const [tick, setTick] = React.useState(0); // 1s cadence re-render while active
  const [archivedCount, setArchivedCount] = React.useState(0);
  const [archivedBytes, setArchivedBytes] = React.useState(0);
  const [queuedCount, setQueuedCount] = React.useState(0);
  const [lastVerifiedAt, setLastVerifiedAt] = React.useState<number | null>(null);
  const [recoveredPending, setRecoveredPending] = React.useState(0);
  const [offline, setOffline] = React.useState(false);
  const [micLost, setMicLost] = React.useState(false);
  const [storageBlocked, setStorageBlocked] = React.useState(false);
  const [currentIdx, setCurrentIdx] = React.useState(0);
  const [dayStartedAt, setDayStartedAt] = React.useState<number | null>(null);
  const [pausedAt, setPausedAt] = React.useState<number | null>(null);
  // K-B
  const [primaryMic, setPrimaryMic] = React.useState<PrimaryMicState>("active");
  const [primaryLostAt, setPrimaryLostAt] = React.useState<number | null>(null);
  const [primaryLostReason, setPrimaryLostReason] = React.useState<string | null>(null);
  const [backupMic, setBackupMic] = React.useState<BackupMicState>("off");
  const [backupError, setBackupError] = React.useState<string | null>(null);
  const [backupIdx, setBackupIdx] = React.useState(0);
  const [backupArchivedCount, setBackupArchivedCount] = React.useState(0);
  const [backupArchivedBytes, setBackupArchivedBytes] = React.useState(0);
  const [watchdogSuspended, setWatchdogSuspended] = React.useState(false);

  const sessionIdRef = React.useRef<string | null>(null);
  const primaryRef = React.useRef<Lane>(newLane("primary"));
  const backupRef = React.useRef<Lane>(newLane("backup"));
  const rotateTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeLockRef = React.useRef<{ release: () => Promise<void> } | null>(null);
  const stateRef = React.useRef<RoomRecorderState>("idle");
  const optsRef = React.useRef(opts);
  React.useEffect(() => {
    optsRef.current = opts;
  }, [opts]);
  /** ENDED DISAGREES fires once. The queue keeps draining after it, and every remaining chunk
   *  carries the same flag — the room needs telling once, not once per chunk. */
  const endedByServerRef = React.useRef(false);
  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // K-B failsafe machinery (primary)
  const primaryLostRef = React.useRef(false); // device gone — lane torn down, re-acquire loop running
  const primarySilentRef = React.useRef(false); // watchdog tripped, device still present
  const reacquireTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const reacquireBackoffRef = React.useRef(REACQUIRE_MIN_MS);
  const watchdogRef = React.useRef<SilenceWatchdog>(new SilenceWatchdog());
  const watchdogCtxRef = React.useRef<AudioContext | null>(null);
  const watchdogTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  // K-B backup lane
  const backupWantedRef = React.useRef(false); // a backup device was chosen for this day
  const backupErroredRef = React.useRef(false); // an error event was emitted; next success → restored
  const backupRetryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const backupBackoffRef = React.useRef(REACQUIRE_MIN_MS);

  // Upload queue — memory copies; IndexedDB is the crash-durable twin.
  const queueRef = React.useRef<QueueItem[]>([]);
  const recoveredKeysRef = React.useRef<Set<string>>(new Set());
  const drainingRef = React.useRef(false);
  const backoffRef = React.useRef(BACKOFF_MIN_MS);

  const emitError = React.useCallback((msg: string) => {
    setError(msg);
    try {
      optsRef.current?.onError?.(new Error(msg));
    } catch {
      /* noop */
    }
  }, []);

  const emitEvent = React.useCallback((kind: BenchMicEventKind, payload: Record<string, unknown> = {}) => {
    const e: BenchMicEvent = { kind, at: Date.now(), payload };
    try {
      console.info("[bench-mic]", kind, JSON.stringify(payload));
    } catch {
      /* noop */
    }
    try {
      optsRef.current?.onEvent?.(e);
    } catch {
      /* an event sink must never hurt capture */
    }
  }, []);

  // ---- online/offline ----
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    setOffline(!navigator.onLine);
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // ---- 1s ticker while a day is open (drives timers in the UI) ----
  React.useEffect(() => {
    if (state !== "recording" && state !== "paused" && state !== "ending") return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  // ---- wake lock (kiosk screen must stay on) ----
  const requestWakeLock = React.useCallback(async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
      };
      if (!nav.wakeLock) return;
      wakeLockRef.current = await nav.wakeLock.request("screen");
    } catch {
      // Not fatal — the operator is told to keep the tab open anyway.
    }
  }, []);

  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => {
      if (
        document.visibilityState === "visible" &&
        (stateRef.current === "recording" || stateRef.current === "paused")
      ) {
        void requestWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [requestWakeLock]);

  // ---- upload pipeline (shared by both lanes) ----

  const verifyDone = React.useCallback((item: QueueItem) => {
    queueRef.current = queueRef.current.filter((q) => q.key !== item.key);
    setQueuedCount(queueRef.current.length);
    if (item.source === "backup") {
      setBackupArchivedCount((n) => n + 1);
      setBackupArchivedBytes((b) => b + item.blob.size);
    } else {
      setArchivedCount((n) => n + 1);
      setArchivedBytes((b) => b + item.blob.size);
    }
    setLastVerifiedAt(Date.now());
    if (recoveredKeysRef.current.delete(item.key)) {
      setRecoveredPending((n) => (n > 0 ? n - 1 : 0));
    }
    void idbDelete(item.key).catch(() => {
      /* stale IDB copy is re-deduped server-side via ON CONFLICT */
    });
  }, []);

  /**
   * Upload one chunk: presign → (HEAD-skip) → PUT → HEAD-verify → POST
   * /api/bench/chunks (server re-verifies size against R2 before writing the
   * verified row). Throws on any failure — caller retries with backoff.
   * Primary bodies carry NO `source` (today's wire format); backup adds source:'backup'.
   */
  const uploadOne = React.useCallback(async (item: QueueItem): Promise<void> => {
    const bodies = uploadBodies({
      session_id: item.session_id,
      idx: item.idx,
      source: item.source ?? "primary",
      content_type: item.content_type,
      started_at: item.started_at,
      ended_at: item.ended_at,
      duration_ms: item.duration_ms,
      gap_before_ms: item.gap_before_ms,
      size_bytes: item.blob.size,
    });
    const presignRes = await fetch("/api/bench/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodies.presign),
    });
    if (!presignRes.ok) throw new Error(`presign_failed_${presignRes.status}`);
    const presign = (await presignRes.json()) as {
      already_verified?: boolean;
      url?: string;
      head_url?: string;
      key?: string;
    };
    if (presign.already_verified) return; // chunk row already verified server-side

    if (!presign.url || !presign.head_url) throw new Error("presign_malformed");

    // Skip the PUT when a retry finds the object already fully uploaded
    // (bench/ objects are never overwritten — D6).
    let alreadyUploaded = false;
    try {
      const h0 = await fetch(presign.head_url, { method: "HEAD" });
      if (h0.ok) {
        const len = Number(h0.headers.get("content-length") ?? "-1");
        if (len === item.blob.size) alreadyUploaded = true;
      }
    } catch {
      /* fall through to PUT */
    }

    if (!alreadyUploaded) {
      const put = await fetch(presign.url, {
        method: "PUT",
        headers: { "Content-Type": item.content_type },
        body: item.blob,
      });
      if (!put.ok) throw new Error(`put_failed_${put.status}`);

      // D8: client HEAD-verify — existence + size match.
      const head = await fetch(presign.head_url, { method: "HEAD" });
      if (!head.ok) throw new Error(`head_verify_failed_${head.status}`);
      const len = Number(head.headers.get("content-length") ?? "-1");
      if (len >= 0 && len !== item.blob.size) {
        throw new Error(`head_size_mismatch_${len}_${item.blob.size}`);
      }
    }

    const rowRes = await fetch("/api/bench/chunks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodies.row),
    });
    if (!rowRes.ok) throw new Error(`chunk_row_failed_${rowRes.status}`);

    // The chunk landed. Now read what the server said about the SESSION.
    //
    // Deliberately AFTER the ok check and inside its own try: this is the last thing that happens
    // to a chunk that is already durably stored, and a malformed body must never turn a verified
    // upload into a retry. Silence here means "nothing unusual", which is the normal case.
    try {
      const j = (await rowRes.json()) as Record<string, unknown> | null;
      const d = j?.[CHUNK_DISAGREEMENT_FIELD];
      if (d === ENDED_DISAGREES && !endedByServerRef.current) {
        endedByServerRef.current = true;
        optsRef.current?.onSessionEndedByServer?.(ENDED_DISAGREES);
      }
    } catch {
      /* body unreadable — the upload still succeeded, which is what this function is about */
    }
  }, []);

  const drain = React.useCallback(() => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    const loop = async () => {
      for (;;) {
        const item = queueRef.current[0];
        if (!item) break;
        try {
          await uploadOne(item);
          backoffRef.current = BACKOFF_MIN_MS;
          verifyDone(item);
        } catch {
          // Retry forever with backoff (D8) — oldest-first, never drop.
          const wait = backoffRef.current;
          backoffRef.current = Math.min(backoffRef.current * 2, BACKOFF_MAX_MS);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      drainingRef.current = false;
    };
    void loop();
  }, [uploadOne, verifyDone]);

  const enqueue = React.useCallback(
    (rec: BenchChunkRecord) => {
      queueRef.current = [...queueRef.current, rec].sort((a, b) => a.ts - b.ts);
      setQueuedCount(queueRef.current.length);
      void idbPut(rec).catch(() => setStorageBlocked(true));
      drain();
    },
    [drain],
  );

  // ---- recovery: unverified IndexedDB chunks from a previous tab life ----
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await idbListAll();
        if (cancelled || rows.length === 0) return;
        const present = new Set(queueRef.current.map((q) => q.key));
        const fresh = rows.filter((r) => !present.has(r.key));
        if (fresh.length === 0) return;
        for (const r of fresh) recoveredKeysRef.current.add(r.key);
        queueRef.current = [...queueRef.current, ...fresh].sort((a, b) => a.ts - b.ts);
        setQueuedCount(queueRef.current.length);
        setRecoveredPending(fresh.length);
        drain();
      } catch {
        setStorageBlocked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [drain]);

  // ---- recorder cycle (per lane) ----

  /**
   * Stop the lane's active MediaRecorder and resolve with its single consolidated
   * blob (recorder started without timeslice → dataavailable fires once,
   * at stop, with a self-contained playable file).
   */
  const finalizeRecorder = React.useCallback((lane: Lane): Promise<Blob | null> => {
    const rec = lane.rec;
    lane.rec = null;
    if (!rec || rec.state === "inactive") return Promise.resolve(null);
    return new Promise((resolve) => {
      let blob: Blob | null = null;
      rec.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) blob = e.data;
      };
      rec.onstop = () => resolve(blob);
      lane.stopCalledAt = Date.now();
      try {
        rec.stop();
      } catch {
        resolve(blob);
      }
    });
  }, []);

  // forward decl for the backup error handler used inside startRecorderSegment
  const backupFailureRef = React.useRef<(stage: string, message: string) => void>(() => undefined);

  const startRecorderSegment = React.useCallback(
    (lane: Lane) => {
      const stream = lane.stream;
      if (!stream) return;
      const mt = pickMime();
      if (lane.source === "primary") setMimeType(mt);
      const rec = mt ? new MediaRecorder(stream, { mimeType: mt }) : new MediaRecorder(stream);
      rec.onerror = (ev: Event) => {
        const msg =
          (ev as unknown as { error?: { message?: string } }).error?.message ?? "recorder_error";
        if (lane.source === "primary") {
          emitError(msg);
          console.warn("[bench-sink] archive recorder_error", JSON.stringify({ idx: lane.idx, message: msg }));
          try {
            optsRef.current?.onRecorderError?.(msg);
          } catch {
            /* noop */
          }
        } else {
          // Backup lane errors never reach emitError / onRecorderError (R4/R8/R12).
          backupFailureRef.current("recorder", msg);
        }
      };
      lane.rec = rec;
      rec.start(); // NO timeslice — one blob on stop (D1)
      lane.chunkStartedAt = Date.now();
    },
    [emitError],
  );

  /** Finalize the lane's current segment into the queue; gap vs previous chunk end. */
  const finalizeIntoQueue = React.useCallback(
    async (lane: Lane): Promise<void> => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      const startedAt = lane.chunkStartedAt;
      const blob = await finalizeRecorder(lane);
      const endedAt = Date.now();
      if (!blob || blob.size === 0) return; // nothing captured (e.g. instant end)
      const idx = lane.idx;
      lane.idx = idx + 1;
      if (lane.source === "primary") setCurrentIdx(lane.idx);
      else setBackupIdx(lane.idx);
      const prevEnd = lane.lastChunkEndedAt;
      const gapBeforeMs = prevEnd === null ? 0 : Math.max(0, startedAt - prevEnd);
      lane.lastChunkEndedAt = endedAt;
      enqueue({
        key: idbChunkKey(sessionId, idx, lane.source),
        session_id: sessionId,
        idx,
        ...(lane.source === "backup" ? { source: "backup" as const } : {}),
        blob,
        content_type: blob.type || mimeType || "audio/webm",
        started_at: startedAt,
        ended_at: endedAt,
        duration_ms: endedAt - startedAt,
        gap_before_ms: gapBeforeMs,
        ts: startedAt,
      });
    },
    [enqueue, finalizeRecorder, mimeType],
  );

  // ---- K-B backup lane ----

  const clearBackupRetry = () => {
    if (backupRetryTimerRef.current) clearTimeout(backupRetryTimerRef.current);
    backupRetryTimerRef.current = null;
  };

  /** Acquire (or re-acquire) the backup stream and, if the day is recording, start its segment. */
  const acquireBackup = React.useCallback(
    async (reason: string): Promise<void> => {
      const lane = backupRef.current;
      if (!backupWantedRef.current || !lane.deviceId) return;
      if (stateRef.current !== "recording" && stateRef.current !== "paused") return;
      setBackupMic("acquiring");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: lane.deviceId }, ...AUDIO_CONSTRAINTS },
        });
        stopTracks(lane.stream);
        lane.stream = stream;
        const track = stream.getAudioTracks()[0];
        if (track) {
          track.onended = () => backupFailureRef.current("track_ended", "backup_track_ended");
        }
        if (stateRef.current === "recording") startRecorderSegment(lane);
        backupBackoffRef.current = REACQUIRE_MIN_MS;
        setBackupMic("active");
        setBackupError(null);
        if (backupErroredRef.current) {
          backupErroredRef.current = false;
          emitEvent("mic_backup_restored", { reason, idx: lane.idx });
        }
      } catch (e) {
        const name = (e as { name?: string })?.name;
        const msg = e instanceof Error ? e.message : String(e);
        backupFailureRef.current("acquire", `${name ?? "error"}:${msg}`.slice(0, 160));
      }
    },
    [emitEvent, startRecorderSegment],
  );

  // Backup failure = event + retry with backoff. Separate try/catch domain; no primary refs touched.
  backupFailureRef.current = (stage: string, message: string) => {
    const lane = backupRef.current;
    try {
      // Flush whatever the backup recorder had, then drop the dead stream.
      void finalizeIntoQueue(lane).catch(() => undefined);
      stopTracks(lane.stream);
      lane.stream = null;
    } catch {
      /* noop */
    }
    setBackupMic("error");
    setBackupError(`${stage}: ${message}`);
    if (!backupErroredRef.current) {
      backupErroredRef.current = true;
      emitEvent("mic_backup_error", { stage, message, idx: lane.idx });
    }
    if (stateRef.current !== "recording" && stateRef.current !== "paused") return;
    clearBackupRetry();
    const wait = backupBackoffRef.current;
    backupBackoffRef.current = Math.min(backupBackoffRef.current * 2, REACQUIRE_MAX_MS);
    backupRetryTimerRef.current = setTimeout(() => void acquireBackup("retry"), wait);
  };

  // ---- K-B primary failsafe ----

  const watchdogSrcRef = React.useRef<MediaStreamAudioSourceNode | null>(null);

  /** Stop sampling (keeps the day's AudioContext — it was created under the Start click). */
  const stopWatchdog = React.useCallback(() => {
    if (watchdogTimerRef.current) clearInterval(watchdogTimerRef.current);
    watchdogTimerRef.current = null;
    try {
      watchdogSrcRef.current?.disconnect();
    } catch {
      /* noop */
    }
    watchdogSrcRef.current = null;
    watchdogRef.current.reset();
  }, []);

  /** End of day / unmount: also release the AudioContext. */
  const closeWatchdog = React.useCallback(() => {
    stopWatchdog();
    void watchdogCtxRef.current?.close().catch(() => undefined);
    watchdogCtxRef.current = null;
  }, [stopWatchdog]);

  // ---- FU4: a deaf watchdog must say so (rejoin only) ----
  // The AudioContext on a rejoin is created with no user gesture, so it can stay suspended
  // and the tick — correctly — skips every sample (a suspended context reads flat and would
  // fake a silence trip). The tick logic is untouched: this only DETECTS the dead state,
  // reports it once, and arms the context on the first tap.
  const armTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const armPollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const armTapRef = React.useRef<(() => void) | null>(null);

  const clearArmCheck = React.useCallback(() => {
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    armTimerRef.current = null;
    if (armPollRef.current) clearInterval(armPollRef.current);
    armPollRef.current = null;
    if (armTapRef.current && typeof document !== "undefined") {
      document.removeEventListener("pointerdown", armTapRef.current);
      armTapRef.current = null;
    }
    setWatchdogSuspended(false);
  }, []);

  const startArmCheck = React.useCallback(() => {
    clearArmCheck();
    armTimerRef.current = setTimeout(() => {
      const ctx = watchdogCtxRef.current;
      if (ctx && ctx.state === "running") return; // armed itself — nothing to say
      setWatchdogSuspended(true);
      emitEvent("mic_backup_unavailable", { reason: "watchdog_suspended" });
      if (typeof document !== "undefined") {
        const tap = () => {
          void watchdogCtxRef.current?.resume().catch(() => undefined);
        };
        armTapRef.current = tap;
        document.addEventListener("pointerdown", tap);
      }
      armPollRef.current = setInterval(() => {
        const c = watchdogCtxRef.current;
        if (c && c.state === "running") clearArmCheck(); // chip clears once the context runs
      }, WATCHDOG_TICK_MS);
    }, WATCHDOG_ARM_CHECK_MS);
  }, [clearArmCheck, emitEvent]);

  const clearReacquire = () => {
    if (reacquireTimerRef.current) clearTimeout(reacquireTimerRef.current);
    reacquireTimerRef.current = null;
  };

  // forward decls so the watchdog / listeners can call into the loop
  const onPrimaryLostRef = React.useRef<(reason: string) => void>(() => undefined);
  const reacquirePrimaryRef = React.useRef<(reason: string) => Promise<void>>(async () => undefined);

  const startWatchdog = React.useCallback(
    (stream: MediaStream) => {
      stopWatchdog();
      try {
        // ONE AudioContext per day, created under the Start click (autoplay policy); a
        // re-acquired primary just gets a new source node. Never sample a non-running
        // context — a suspended context reads flat 128 and would fake a silence trip.
        let ctx = watchdogCtxRef.current;
        if (!ctx || ctx.state === "closed") {
          const Ctx =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          ctx = new Ctx();
          watchdogCtxRef.current = ctx;
        }
        if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
        const src = ctx.createMediaStreamSource(stream);
        watchdogSrcRef.current = src;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        watchdogRef.current.reset();
        const liveCtx = ctx;
        watchdogTimerRef.current = setInterval(() => {
          if (stateRef.current !== "recording") return; // paused = silence is expected
          if (liveCtx.state !== "running") {
            if (liveCtx.state === "suspended") void liveCtx.resume().catch(() => undefined);
            return;
          }
          try {
            analyser.getByteTimeDomainData(buf);
            const ev = watchdogRef.current.feed(rmsOfBytes(buf), Date.now());
            if (ev === "trip") {
              void (async () => {
                // Is the device still present? If it vanished without an `ended`, treat as lost.
                const lane = primaryRef.current;
                let present = true;
                if (lane.deviceId) {
                  try {
                    const devs = await navigator.mediaDevices.enumerateDevices();
                    present = devs.some((d) => d.kind === "audioinput" && d.deviceId === lane.deviceId);
                  } catch {
                    present = true;
                  }
                }
                if (!present) {
                  onPrimaryLostRef.current("silence_device_missing");
                } else if (!primarySilentRef.current) {
                  primarySilentRef.current = true;
                  setPrimaryMic("silent");
                  setPrimaryLostAt(Date.now());
                  setPrimaryLostReason("silence");
                  emitEvent("mic_primary_lost", { reason: "silence", idx: lane.idx });
                }
              })();
            } else if (ev === "clear" && primarySilentRef.current) {
              primarySilentRef.current = false;
              setPrimaryMic("active");
              setPrimaryLostAt(null);
              setPrimaryLostReason(null);
              emitEvent("mic_primary_restored", { reason: "audio_resumed", idx: primaryRef.current.idx });
            }
          } catch {
            /* analyser hiccup — never fatal */
          }
        }, WATCHDOG_TICK_MS);
      } catch {
        // No AudioContext — the track-ended listener still covers the yank case.
      }
    },
    [emitEvent, stopWatchdog],
  );

  const attachPrimaryListeners = React.useCallback((stream: MediaStream) => {
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    track.onended = () => {
      setMicLost(true);
      onPrimaryLostRef.current("track_ended");
    };
    track.onmute = () => setMicLost(true);
    track.onunmute = () => setMicLost(false);
  }, []);

  /** Primary device gone: flush the current segment, tear the lane down, start the re-acquire loop. */
  onPrimaryLostRef.current = (reason: string) => {
    if (primaryLostRef.current) return;
    primaryLostRef.current = true;
    const lane = primaryRef.current;
    setPrimaryMic("lost");
    setPrimaryLostAt(Date.now());
    setPrimaryLostReason(reason);
    setMicLost(true);
    if (!primarySilentRef.current) emitEvent("mic_primary_lost", { reason, idx: lane.idx, backup: backupWantedRef.current ? backupMic : "off" });
    primarySilentRef.current = false;
    stopWatchdog();
    void finalizeIntoQueue(lane).catch(() => undefined);
    stopTracks(lane.stream);
    lane.stream = null;
    clearReacquire();
    reacquireBackoffRef.current = REACQUIRE_MIN_MS;
    reacquireTimerRef.current = setTimeout(() => void reacquirePrimaryRef.current("retry"), 1_000);
  };

  reacquirePrimaryRef.current = async (reason: string) => {
    if (!primaryLostRef.current) return;
    if (stateRef.current !== "recording" && stateRef.current !== "paused") return;
    const lane = primaryRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...(lane.deviceId ? { deviceId: { exact: lane.deviceId } } : {}), ...AUDIO_CONSTRAINTS },
      });
      lane.stream = stream;
      attachPrimaryListeners(stream);
      primaryLostRef.current = false;
      primarySilentRef.current = false;
      setMicLost(false);
      if (stateRef.current === "recording") startRecorderSegment(lane);
      startWatchdog(stream);
      setPrimaryMic("active");
      setPrimaryLostAt(null);
      setPrimaryLostReason(null);
      emitEvent("mic_primary_restored", { reason, idx: lane.idx });
    } catch {
      clearReacquire();
      const wait = reacquireBackoffRef.current;
      reacquireBackoffRef.current = Math.min(reacquireBackoffRef.current * 2, REACQUIRE_MAX_MS);
      reacquireTimerRef.current = setTimeout(() => void reacquirePrimaryRef.current("retry"), wait);
    }
  };

  // devicechange: a re-plugged USB mic / a returning backup device → try now.
  React.useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.addEventListener) return;
    const onChange = () => {
      if (primaryLostRef.current) {
        clearReacquire();
        void reacquirePrimaryRef.current("devicechange");
      }
      if (backupWantedRef.current && backupRef.current.stream === null) {
        clearBackupRetry();
        void acquireBackup("devicechange");
      }
    };
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
  }, [acquireBackup]);

  // ---- rotation (lockstep, R7) ----

  const scheduleRotate = React.useCallback(() => {
    if (rotateTimerRef.current) clearTimeout(rotateTimerRef.current);
    rotateTimerRef.current = setTimeout(() => {
      void (async () => {
        if (stateRef.current !== "recording") return;
        const P = primaryRef.current;
        const B = backupRef.current;
        try {
          await runLockstep(
            "rotate",
            {
              primary: async () => {
                if (!P.stream) return; // lane is down (lost) — the re-acquire loop owns it
                // Seam: finalize then restart immediately on the SAME stream.
                await finalizeIntoQueue(P);
                if (stateRef.current !== "recording") return;
                startRecorderSegment(P);
                // Seam instrumentation (Kickoff B go/no-go): measured on every rotation,
                // flag on or off, so the two can be compared. Log-only — no behavior change.
                const stopAt = P.stopCalledAt;
                if (stopAt > 0) {
                  const seam: ArchiveSeamEvent = {
                    idx: Math.max(0, P.idx - 1),
                    seam_ms: Math.max(0, P.chunkStartedAt - stopAt),
                    stop_latency_ms: Math.max(0, (P.lastChunkEndedAt ?? stopAt) - stopAt),
                  };
                  console.info("[bench-seam]", JSON.stringify({ ...seam, live_sink_flag: LIVE_SINK }));
                  try {
                    optsRef.current?.onSeam?.(seam);
                  } catch {
                    /* noop */
                  }
                }
              },
              backup: B.stream
                ? async () => {
                    await finalizeIntoQueue(B);
                    if (stateRef.current !== "recording") return;
                    startRecorderSegment(B);
                  }
                : null,
            },
            (verb, err) => backupFailureRef.current(verb, err),
          );
        } catch (e) {
          emitError(e instanceof Error ? e.message : String(e));
        }
        if (stateRef.current === "recording") scheduleRotate();
      })();
    }, CHUNK_MS);
  }, [emitError, finalizeIntoQueue, startRecorderSegment]);

  // ---- session verbs ----

  const startDay = React.useCallback(
    async (sessionId: string, deviceId?: string, backupDeviceId?: string | null): Promise<void> => {
      if (stateRef.current === "recording" || stateRef.current === "paused") return;
      setError(null);
      const P = primaryRef.current;
      const B = backupRef.current;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            ...AUDIO_CONSTRAINTS,
          },
        });
        P.stream = stream;
        P.deviceId = deviceId ?? null;
        attachPrimaryListeners(stream);
        sessionIdRef.current = sessionId;
        P.idx = 0;
        P.lastChunkEndedAt = null;
        P.stopCalledAt = 0;
        setCurrentIdx(0);
        B.idx = 0;
        B.lastChunkEndedAt = null;
        B.rec = null;
        setBackupIdx(0);
        setBackupArchivedCount(0);
        setBackupArchivedBytes(0);
        setDayStartedAt(Date.now());
        setPausedAt(null);
        setMicLost(false);
        primaryLostRef.current = false;
        primarySilentRef.current = false;
        setPrimaryMic("active");
        setPrimaryLostAt(null);
        setPrimaryLostReason(null);
        setState("recording");
        stateRef.current = "recording";
        startRecorderSegment(P);
        scheduleRotate();
        void requestWakeLock();
        startWatchdog(stream);
      } catch (e: unknown) {
        const name = (e as { name?: string })?.name;
        const msg =
          name === "NotAllowedError" || name === "PermissionDeniedError"
            ? "microphone_permission_denied"
            : e instanceof Error
              ? e.message
              : String(e);
        setState("error");
        stateRef.current = "error";
        emitError(msg);
        throw new Error(msg);
      }
      // Backup lane — AFTER the primary is live; its own try/catch domain (never throws up).
      backupErroredRef.current = false;
      backupBackoffRef.current = REACQUIRE_MIN_MS;
      if (backupDeviceId && backupDeviceId !== deviceId) {
        backupWantedRef.current = true;
        B.deviceId = backupDeviceId;
        void acquireBackup("start");
      } else {
        backupWantedRef.current = false;
        B.deviceId = null;
        setBackupMic("off");
        emitEvent("mic_backup_unavailable", { reason: backupDeviceId ? "same_as_primary" : "no_device" });
      }
    },
    [acquireBackup, attachPrimaryListeners, emitError, emitEvent, requestWakeLock, scheduleRotate, startRecorderSegment, startWatchdog],
  );

  /**
   * Remount resume (ETA-REMOUNT-RESUME PRD §3.3/§3.4, D2/D4): rejoin an EXISTING session
   * instead of starting a new one. Chunk counters are SEEDED, never reset — per stream the
   * starting number is the higher of the server's next_idx and one more than the highest
   * number in this kiosk's own unsent IndexedDB queue for the session (the table is unique
   * on session/source/idx and the upload route overwrites on conflict, so counting from
   * zero would write over the tape being joined). Does NOT wait for the recovered queue to
   * drain — the recovery effect uploads it in parallel. The reload gap is recorded by the
   * kiosk_remount_resumed event, not gap_before_ms (D4: lastChunkEndedAt starts null).
   * `paused: true` rejoins in the paused state (stream open, no recorder — the exact shape
   * pauseDay leaves behind, so the existing Resume button works unchanged).
   */
  const resumeSession = React.useCallback(
    async (
      sessionId: string,
      opts: {
        nextPrimaryIdx: number;
        nextBackupIdx: number;
        paused: boolean;
        /** session started_at (ms) so the elapsed clock stays honest across the reload */
        dayStartedAt?: number | null;
        deviceId?: string;
        backupDeviceId?: string | null;
      },
    ): Promise<{ primaryStartIdx: number; backupStartIdx: number }> => {
      if (stateRef.current === "recording" || stateRef.current === "paused") {
        return { primaryStartIdx: opts.nextPrimaryIdx, backupStartIdx: opts.nextBackupIdx };
      }
      setError(null);
      // Highest number in the kiosk's own unsent queue, per stream, for THIS session.
      let localPrimary = -1;
      let localBackup = -1;
      try {
        const rows = await idbListAll();
        for (const r of rows) {
          if (r.session_id !== sessionId) continue;
          if ((r.source ?? "primary") === "backup") localBackup = Math.max(localBackup, r.idx);
          else localPrimary = Math.max(localPrimary, r.idx);
        }
      } catch {
        setStorageBlocked(true); // server numbers alone still protect stored audio
      }
      const primaryStartIdx = seedStartIdx(opts.nextPrimaryIdx, localPrimary);
      const backupStartIdx = seedStartIdx(opts.nextBackupIdx, localBackup);

      const P = primaryRef.current;
      const B = backupRef.current;
      // S3-3: ask the microphone, do not survey the room. A device that opens is present;
      // a device that does not open is absent — no enumeration, no third "blank" answer.
      let primaryFellBack = false;
      try {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
              ...AUDIO_CONSTRAINTS,
            },
          });
        } catch (e) {
          if (!opts.deviceId) throw e;
          // The stored primary did not open — absent. The tape must not die for it.
          primaryFellBack = true;
          stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
        }
        P.stream = stream;
        P.deviceId = primaryFellBack ? null : (opts.deviceId ?? null);
        attachPrimaryListeners(stream);
        sessionIdRef.current = sessionId;
        P.idx = primaryStartIdx;
        P.lastChunkEndedAt = null;
        P.stopCalledAt = 0;
        setCurrentIdx(primaryStartIdx);
        B.idx = backupStartIdx;
        B.lastChunkEndedAt = null;
        B.rec = null;
        setBackupIdx(backupStartIdx);
        // P5-3c: the session already holds chunks — a rejoined kiosk reading "Chunks
        // archived 0" says something untrue. Seed each counter from the SERVER's next
        // number (a 0-based tape holds exactly next_idx chunks), not the seeded start,
        // whose local-queue part is still unverified and counts up as it uploads. Bytes
        // stay unseeded — the resume answer does not carry them.
        setArchivedCount(Number.isFinite(opts.nextPrimaryIdx) ? Math.max(0, Math.trunc(opts.nextPrimaryIdx)) : 0);
        setBackupArchivedCount(Number.isFinite(opts.nextBackupIdx) ? Math.max(0, Math.trunc(opts.nextBackupIdx)) : 0);
        setBackupArchivedBytes(0);
        setDayStartedAt(opts.dayStartedAt ?? Date.now());
        setMicLost(false);
        primaryLostRef.current = false;
        primarySilentRef.current = false;
        setPrimaryMic("active");
        setPrimaryLostAt(null);
        setPrimaryLostReason(null);
        if (opts.paused) {
          setState("paused");
          stateRef.current = "paused";
          setPausedAt(null); // the original pause time did not survive the reload
        } else {
          setState("recording");
          stateRef.current = "recording";
          setPausedAt(null);
          startRecorderSegment(P);
          scheduleRotate();
        }
        void requestWakeLock();
        startWatchdog(stream); // no-ops while paused, same as after pauseDay
        startArmCheck(); // FU4: no tap happened — verify the watchdog context actually runs
      } catch (e: unknown) {
        const name = (e as { name?: string })?.name;
        const msg =
          name === "NotAllowedError" || name === "PermissionDeniedError"
            ? "microphone_permission_denied"
            : e instanceof Error
              ? e.message
              : String(e);
        setState("error");
        stateRef.current = "error";
        emitError(msg);
        throw new Error(msg);
      }
      if (primaryFellBack) {
        // S4-3: a PAIR — lost (the stored device is absent) then restored (the default is
        // recording), so the admin mic badge does not read on-backup for the rest of the day.
        for (const e of primaryFallbackEvents(opts.deviceId ?? null)) emitEvent(e.kind, e.payload);
      }
      // Backup lane — AFTER the primary is live; its own try/catch domain (never throws up).
      backupErroredRef.current = false;
      backupBackoffRef.current = REACQUIRE_MIN_MS;
      const backupDeviceId = opts.backupDeviceId ?? null;
      if (backupDeviceId && backupDeviceId !== (opts.deviceId ?? null)) {
        backupWantedRef.current = true;
        B.deviceId = backupDeviceId;
        void acquireBackup("remount_resume");
      } else {
        backupWantedRef.current = false;
        B.deviceId = null;
        setBackupMic("off");
        emitEvent("mic_backup_unavailable", { reason: backupDeviceId ? "same_as_primary" : "no_device" });
      }
      return { primaryStartIdx, backupStartIdx };
    },
    [acquireBackup, attachPrimaryListeners, emitError, emitEvent, requestWakeLock, scheduleRotate, startArmCheck, startRecorderSegment, startWatchdog],
  );

  /** IRB pause: recorders stopped (a real capture gap), partial chunks uploaded — BOTH lanes. */
  const pauseDay = React.useCallback(async (): Promise<void> => {
    if (stateRef.current !== "recording") return;
    if (rotateTimerRef.current) clearTimeout(rotateTimerRef.current);
    setState("paused");
    stateRef.current = "paused";
    setPausedAt(Date.now());
    const P = primaryRef.current;
    const B = backupRef.current;
    await runLockstep(
      "pause",
      {
        primary: async () => {
          if (P.stream) await finalizeIntoQueue(P);
        },
        backup: B.stream ? async () => finalizeIntoQueue(B) : null,
      },
      (verb, err) => backupFailureRef.current(verb, err),
    ).catch(() => undefined);
  }, [finalizeIntoQueue]);

  const resumeDay = React.useCallback((): void => {
    if (stateRef.current !== "paused") return;
    setState("recording");
    stateRef.current = "recording";
    setPausedAt(null);
    watchdogRef.current.reset(); // silence during a pause is expected, not a trip
    const P = primaryRef.current;
    const B = backupRef.current;
    void runLockstep(
      "resume",
      {
        primary: async () => {
          if (P.stream) startRecorderSegment(P); // next chunk's gap_before_ms = pause length
        },
        backup: backupWantedRef.current
          ? async () => {
              if (B.stream) startRecorderSegment(B);
              else await acquireBackup("resume");
            }
          : null,
      },
      (verb, err) => backupFailureRef.current(verb, err),
    ).catch(() => undefined);
    scheduleRotate();
  }, [acquireBackup, scheduleRotate, startRecorderSegment]);

  /** End Day: final partial chunks into the queue; both streams torn down. */
  const endDay = React.useCallback(async (): Promise<void> => {
    if (stateRef.current !== "recording" && stateRef.current !== "paused") return;
    if (rotateTimerRef.current) clearTimeout(rotateTimerRef.current);
    setState("ending");
    stateRef.current = "ending";
    clearReacquire();
    clearBackupRetry();
    clearArmCheck();
    closeWatchdog();
    const P = primaryRef.current;
    const B = backupRef.current;
    await runLockstep(
      "end",
      {
        primary: async () => {
          if (P.stream) await finalizeIntoQueue(P);
        },
        backup: B.stream ? async () => finalizeIntoQueue(B) : null,
      },
      (verb, err) => backupFailureRef.current(verb, err),
    ).catch(() => undefined);
    stopTracks(P.stream);
    P.stream = null;
    stopTracks(B.stream);
    B.stream = null;
    backupWantedRef.current = false;
    setBackupMic("off");
    try {
      await wakeLockRef.current?.release();
    } catch {
      /* noop */
    }
    wakeLockRef.current = null;
  }, [clearArmCheck, closeWatchdog, finalizeIntoQueue]);

  /** Called by the client once the queue is fully drained after endDay. */
  const markEnded = React.useCallback(() => {
    setState("ended");
    stateRef.current = "ended";
  }, []);

  React.useEffect(() => {
    return () => {
      if (rotateTimerRef.current) clearTimeout(rotateTimerRef.current);
      clearReacquire();
      clearBackupRetry();
      clearArmCheck();
      closeWatchdog();
      stopTracks(primaryRef.current.stream);
      stopTracks(backupRef.current.stream);
    };
  }, [clearArmCheck, closeWatchdog]);

  /** Kickoff B: read-only access to the day's primary stream for the live sink (flag on only). */
  const getStream = React.useCallback((): MediaStream | null => primaryRef.current.stream, []);

  const now = Date.now();
  void tick; // tick only exists to drive re-render
  const status: RoomRecorderStatus = {
    state,
    error,
    mimeType,
    currentIdx,
    chunkElapsedMs:
      state === "recording" ? Math.max(0, now - primaryRef.current.chunkStartedAt) : 0,
    dayElapsedMs: dayStartedAt ? Math.max(0, now - dayStartedAt) : 0,
    dayStartedAt,
    pausedAt,
    archivedCount,
    archivedBytes,
    queuedCount,
    lastVerifiedAt,
    recoveredPending,
    offline,
    micLost,
    storageBlocked,
    primaryMic,
    primaryLostAt,
    primaryLostReason,
    backupMic,
    backupError,
    backupIdx,
    backupArchivedCount,
    backupArchivedBytes,
    watchdogSuspended,
  };

  return { status, startDay, resumeSession, pauseDay, resumeDay, endDay, markEnded, getStream };
}
