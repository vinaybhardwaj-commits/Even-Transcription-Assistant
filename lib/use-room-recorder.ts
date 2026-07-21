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
 */

import * as React from "react";

const CHUNK_MS = 5 * 60 * 1000; // D1: 5-minute chunks
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;

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

// ---------------------------------------------------------------------------
// IndexedDB store — db `eta-bench`, store `chunks`, key `{session_id}:{idx}`
// ---------------------------------------------------------------------------

const DB_NAME = "eta-bench";
const DB_VERSION = 1;
const STORE = "chunks";

export type BenchChunkRecord = {
  key: string; // `${session_id}:${idx}`
  session_id: string;
  idx: number;
  blob: Blob;
  content_type: string;
  started_at: number; // ms epoch
  ended_at: number; // ms epoch
  duration_ms: number;
  gap_before_ms: number;
  ts: number;
};

function chunkKey(sessionId: string, idx: number): string {
  return `${sessionId}:${idx}`;
}

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

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type RoomRecorderState = "idle" | "recording" | "paused" | "ending" | "ended" | "error";

export type RoomRecorderStatus = {
  state: RoomRecorderState;
  error: string | null;
  mimeType: string | undefined;
  /** 0-based index of the chunk currently being recorded. */
  currentIdx: number;
  /** ms into the current chunk. */
  chunkElapsedMs: number;
  /** ms since the day started (wall clock, includes pauses). */
  dayElapsedMs: number;
  dayStartedAt: number | null;
  pausedAt: number | null;
  /** chunks verified in R2 (this browser session, incl. recovered). */
  archivedCount: number;
  archivedBytes: number;
  /** chunks held locally awaiting verified upload. */
  queuedCount: number;
  lastVerifiedAt: number | null;
  /** unverified chunks found in IndexedDB from a previous session. */
  recoveredPending: number;
  offline: boolean;
  micLost: boolean;
  storageBlocked: boolean;
};

type QueueItem = BenchChunkRecord;

export function useRoomRecorder(opts?: { onError?: (e: Error) => void }) {
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

  const sessionIdRef = React.useRef<string | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const recRef = React.useRef<MediaRecorder | null>(null);
  const idxRef = React.useRef(0);
  const chunkStartedAtRef = React.useRef<number>(0);
  const lastChunkEndedAtRef = React.useRef<number | null>(null);
  const rotateTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeLockRef = React.useRef<{ release: () => Promise<void> } | null>(null);
  const stateRef = React.useRef<RoomRecorderState>("idle");
  const optsRef = React.useRef(opts);
  React.useEffect(() => {
    optsRef.current = opts;
  }, [opts]);
  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);

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

  // ---- upload pipeline ----

  const verifyDone = React.useCallback((item: QueueItem) => {
    queueRef.current = queueRef.current.filter((q) => q.key !== item.key);
    setQueuedCount(queueRef.current.length);
    setArchivedCount((n) => n + 1);
    setArchivedBytes((b) => b + item.blob.size);
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
   */
  const uploadOne = React.useCallback(async (item: QueueItem): Promise<void> => {
    const presignRes = await fetch("/api/bench/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: item.session_id,
        idx: item.idx,
        content_type: item.content_type,
      }),
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
      body: JSON.stringify({
        session_id: item.session_id,
        idx: item.idx,
        content_type: item.content_type,
        started_at: new Date(item.started_at).toISOString(),
        ended_at: new Date(item.ended_at).toISOString(),
        duration_ms: item.duration_ms,
        size_bytes: item.blob.size,
        gap_before_ms: item.gap_before_ms,
      }),
    });
    if (!rowRes.ok) throw new Error(`chunk_row_failed_${rowRes.status}`);
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

  // ---- recorder cycle ----

  /**
   * Stop the active MediaRecorder and resolve with its single consolidated
   * blob (recorder started without timeslice → dataavailable fires once,
   * at stop, with a self-contained playable file).
   */
  const finalizeRecorder = React.useCallback((): Promise<Blob | null> => {
    const rec = recRef.current;
    recRef.current = null;
    if (!rec || rec.state === "inactive") return Promise.resolve(null);
    return new Promise((resolve) => {
      let blob: Blob | null = null;
      rec.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) blob = e.data;
      };
      rec.onstop = () => resolve(blob);
      try {
        rec.stop();
      } catch {
        resolve(blob);
      }
    });
  }, []);

  const startRecorderSegment = React.useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const mt = pickMime();
    setMimeType(mt);
    const rec = mt ? new MediaRecorder(stream, { mimeType: mt }) : new MediaRecorder(stream);
    rec.onerror = (ev: Event) => {
      const msg =
        (ev as unknown as { error?: { message?: string } }).error?.message ?? "recorder_error";
      emitError(msg);
    };
    recRef.current = rec;
    rec.start(); // NO timeslice — one blob on stop (D1)
    chunkStartedAtRef.current = Date.now();
  }, [emitError]);

  /** Finalize the current segment into the queue; gap vs previous chunk end. */
  const finalizeIntoQueue = React.useCallback(async (): Promise<void> => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    const startedAt = chunkStartedAtRef.current;
    const blob = await finalizeRecorder();
    const endedAt = Date.now();
    if (!blob || blob.size === 0) return; // nothing captured (e.g. instant end)
    const idx = idxRef.current;
    idxRef.current = idx + 1;
    setCurrentIdx(idxRef.current);
    const prevEnd = lastChunkEndedAtRef.current;
    const gapBeforeMs = prevEnd === null ? 0 : Math.max(0, startedAt - prevEnd);
    lastChunkEndedAtRef.current = endedAt;
    enqueue({
      key: chunkKey(sessionId, idx),
      session_id: sessionId,
      idx,
      blob,
      content_type: blob.type || mimeType || "audio/webm",
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: endedAt - startedAt,
      gap_before_ms: gapBeforeMs,
      ts: startedAt,
    });
  }, [enqueue, finalizeRecorder, mimeType]);

  const scheduleRotate = React.useCallback(() => {
    if (rotateTimerRef.current) clearTimeout(rotateTimerRef.current);
    rotateTimerRef.current = setTimeout(() => {
      void (async () => {
        if (stateRef.current !== "recording") return;
        // Seam: finalize then restart immediately on the SAME stream.
        await finalizeIntoQueue();
        if (stateRef.current !== "recording") return;
        startRecorderSegment();
        scheduleRotate();
      })();
    }, CHUNK_MS);
  }, [finalizeIntoQueue, startRecorderSegment]);

  const startDay = React.useCallback(
    async (sessionId: string, deviceId?: string): Promise<void> => {
      if (stateRef.current === "recording" || stateRef.current === "paused") return;
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: { ideal: 1 },
            sampleRate: { ideal: 16000 },
          },
        });
        streamRef.current = stream;
        const track = stream.getAudioTracks()[0];
        if (track) {
          track.onended = () => setMicLost(true);
          track.onmute = () => setMicLost(true);
          track.onunmute = () => setMicLost(false);
        }
        sessionIdRef.current = sessionId;
        idxRef.current = 0;
        setCurrentIdx(0);
        lastChunkEndedAtRef.current = null;
        setDayStartedAt(Date.now());
        setPausedAt(null);
        setMicLost(false);
        setState("recording");
        stateRef.current = "recording";
        startRecorderSegment();
        scheduleRotate();
        void requestWakeLock();
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
    },
    [emitError, requestWakeLock, scheduleRotate, startRecorderSegment],
  );

  /** IRB pause: recorder stopped (a real capture gap), partial chunk uploaded. */
  const pauseDay = React.useCallback(async (): Promise<void> => {
    if (stateRef.current !== "recording") return;
    if (rotateTimerRef.current) clearTimeout(rotateTimerRef.current);
    setState("paused");
    stateRef.current = "paused";
    setPausedAt(Date.now());
    await finalizeIntoQueue();
  }, [finalizeIntoQueue]);

  const resumeDay = React.useCallback((): void => {
    if (stateRef.current !== "paused") return;
    setState("recording");
    stateRef.current = "recording";
    setPausedAt(null);
    startRecorderSegment(); // next chunk's gap_before_ms = pause length
    scheduleRotate();
  }, [scheduleRotate, startRecorderSegment]);

  /** End Day: final partial chunk into the queue; stream torn down. */
  const endDay = React.useCallback(async (): Promise<void> => {
    if (stateRef.current !== "recording" && stateRef.current !== "paused") return;
    if (rotateTimerRef.current) clearTimeout(rotateTimerRef.current);
    setState("ending");
    stateRef.current = "ending";
    await finalizeIntoQueue();
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
    streamRef.current = null;
    try {
      await wakeLockRef.current?.release();
    } catch {
      /* noop */
    }
    wakeLockRef.current = null;
  }, [finalizeIntoQueue]);

  /** Called by the client once the queue is fully drained after endDay. */
  const markEnded = React.useCallback(() => {
    setState("ended");
    stateRef.current = "ended";
  }, []);

  React.useEffect(() => {
    return () => {
      if (rotateTimerRef.current) clearTimeout(rotateTimerRef.current);
      try {
        streamRef.current?.getTracks().forEach((t) => t.stop());
      } catch {
        /* noop */
      }
    };
  }, []);

  const now = Date.now();
  void tick; // tick only exists to drive re-render
  const status: RoomRecorderStatus = {
    state,
    error,
    mimeType,
    currentIdx,
    chunkElapsedMs:
      state === "recording" ? Math.max(0, now - chunkStartedAtRef.current) : 0,
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
  };

  return { status, startDay, pauseDay, resumeDay, endDay, markEnded };
}
