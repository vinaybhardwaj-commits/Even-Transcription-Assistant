#!/usr/bin/env python3
"""tools/nemotron-worker/worker.py — the box worker for SHADOW Nemotron diarization (epic #23, ticket a).

Loop: heartbeat every 60 s; GET /api/diarize/nemotron/pending (claims, 15-min lease) → fetch the presigned clip into a
private temp dir and hash it → decode to 16 kHz mono → Nemotron (under ~/gpu.lock) → delete the audio → POST
/api/diarize/nemotron/ingest. The routes are app/api/diarize/nemotron/*/route.ts on main; the body is the closed
shape of lib/diarize-nemotron/validate.ts checkIngest (PRD §7.1). Nothing here changes them.

Standard library only, so the client loop is testable anywhere; the GPU engine (engine_nemo.py) is imported only
when the worker really runs.

NEVER LOGGED: clip URLs, the token, turns, audio paths. Logs and the status file carry ids, codes, counts, timings.

Backoff: 404 disabled / 503 not_configured / 503 db / clip_sign / 401 / 5xx / network → sleep 30 s doubling to 15 min
(±20 % jitter), reset on the first 200. 409, duplicate, 403 blind_room_day, 404 unknown_window → move on.
SIGTERM/SIGINT: no new claim; a window already fetched is finished and posted; then exit 0. A window still waiting
for the GPU when the stop comes is abandoned unposted (its lease lapses and the server offers it again).
"""
from __future__ import annotations

import argparse
import collections
import fcntl
import hashlib
import json
import logging
import os
import random
import shutil
import signal
import socket
import stat
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from dataclasses import dataclass, field
from typing import Callable, Optional

log = logging.getLogger("nemotron-worker")

MAX_SPEAKERS = 8  # validate.ts MAX_SPEAKERS
MAX_TURNS = 5000  # validate.ts MAX_TURNS
WORKER_ID_OK = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
HB_TOKEN_OK = WORKER_ID_OK | set(" :/")


# ---------------------------------------------------------------------------------------------------------------
# Canonical JSON + hashes — byte-identical to validate.ts canonicalJson for ints, bools, ASCII strings.
# ---------------------------------------------------------------------------------------------------------------

def canonical_json(v) -> str:
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def config_hash(config: dict) -> str:
    return sha256_hex(canonical_json(config))


# ---------------------------------------------------------------------------------------------------------------
# Turns: model segments (seconds, any label) → validate.ts turns ([start_ms, end_ms, "spkN"], sorted, in range).
# ---------------------------------------------------------------------------------------------------------------

class TurnsError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def to_turns(segments, audio_ms: int) -> list:
    """Seconds → integer ms clamped to [0, audio_ms]; zero-length spans dropped; sorted by (start, end, label);
    labels renamed spk0, spk1, … in order of first speech. Deterministic, so a re-run of the same clip posts the
    same payload and the server answers `duplicate`, not `conflict`."""
    rows = []
    for start_s, end_s, label in segments:
        s = max(0, min(audio_ms, int(round(float(start_s) * 1000))))
        e = max(0, min(audio_ms, int(round(float(end_s) * 1000))))
        if e > s:
            rows.append((s, e, str(label)))
    rows.sort(key=lambda r: (r[0], r[1], r[2]))
    names: dict = {}
    out = []
    for s, e, label in rows:
        if label not in names:
            names[label] = f"spk{len(names)}"
        out.append([s, e, names[label]])
    if len(names) > MAX_SPEAKERS:
        raise TurnsError("too_many_speakers")
    if len(out) > MAX_TURNS:
        raise TurnsError("too_many_turns")
    return out


# ---------------------------------------------------------------------------------------------------------------
# HTTP. Every failure becomes (status, code); a URL or token never reaches an exception message or a log line.
# ---------------------------------------------------------------------------------------------------------------

class Api:
    def __init__(self, base_url: str, token: str, timeout_s: float = 30.0):
        self.base = base_url.rstrip("/")
        self._token = token
        self.timeout_s = timeout_s

    def call(self, method: str, path: str, body: Optional[dict] = None) -> tuple:
        """(http_status, json_or_{}). Status 0 = network failure."""
        data = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("authorization", f"Bearer {self._token}")
        if data is not None:
            req.add_header("content-type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as r:
                return r.status, _json_or_empty(r.read(2_000_000))
        except urllib.error.HTTPError as e:
            try:
                payload = _json_or_empty(e.read(64_000))
            except Exception:
                payload = {}
            return e.code, payload
        except Exception:
            return 0, {"error": "network"}


def _json_or_empty(raw: bytes) -> dict:
    try:
        v = json.loads(raw.decode("utf-8"))
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}


class FetchError(Exception):
    pass


def fetch_clip(url: str, dest: str, max_bytes: int, timeout_s: float) -> tuple:
    """Stream the presigned GET to `dest`, hashing as it goes. (sha256 hex, bytes). FetchError carries no URL."""
    h = hashlib.sha256()
    n = 0
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=timeout_s) as r, open(dest, "wb") as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                n += len(chunk)
                if n > max_bytes:
                    raise FetchError("clip_too_large")
                h.update(chunk)
                f.write(chunk)
    except FetchError:
        raise
    except urllib.error.HTTPError as e:
        raise FetchError(f"http_{e.code}") from None
    except Exception:
        raise FetchError("network") from None
    if n == 0:
        raise FetchError("empty_clip")
    return h.hexdigest(), n


class DecodeError(Exception):
    pass


def ffmpeg_decode(src: str, wav: str) -> int:
    """Decode to 16 kHz mono s16 WAV; returns audio_ms. DecodeError on any failure (terminal: decode_failed)."""
    r = subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", src, "-ar", "16000", "-ac", "1",
                        "-c:a", "pcm_s16le", wav], capture_output=True, timeout=600)
    if r.returncode != 0:
        raise DecodeError("ffmpeg")
    try:
        with wave.open(wav, "rb") as w:
            ms = (w.getnframes() * 1000) // w.getframerate()
    except Exception:
        raise DecodeError("wav") from None
    if ms <= 0:
        raise DecodeError("no_audio")
    return ms


# ---------------------------------------------------------------------------------------------------------------
# GPU manners: wait for free VRAM before claiming; hold ~/gpu.lock (the box's per-job convention) only around
# inference, refcounted so concurrency > 1 shares one lock instead of deadlocking on it.
# ---------------------------------------------------------------------------------------------------------------

def nvidia_free_mib() -> Optional[int]:
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=memory.total,memory.used", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=15)
        total, used = (int(x.strip()) for x in r.stdout.splitlines()[0].split(","))
        return total - used
    except Exception:
        return None


def nvidia_gpu_name() -> str:
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True, timeout=15)
        return safe_token(r.stdout.splitlines()[0].strip()) or "unknown"
    except Exception:
        return "unknown"


class GpuGate:
    def __init__(self, slots: int, lock_path: Optional[str], stop: threading.Event, poll_s: float = 2.0):
        self.sem = threading.Semaphore(slots)
        self.lock_path = lock_path
        self.stop = stop
        self.poll_s = poll_s
        self._mu = threading.Lock()
        self._held = 0
        self._fd: Optional[int] = None

    def acquire(self) -> bool:
        """False when a stop came while waiting (the caller abandons the window)."""
        while not self.sem.acquire(timeout=self.poll_s):
            if self.stop.is_set():
                return False
        if not self.lock_path:
            return True
        while True:
            with self._mu:
                if self._held > 0:
                    self._held += 1
                    return True
                fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o664)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self._fd, self._held = fd, 1
                    return True
                except BlockingIOError:
                    os.close(fd)
            if self.stop.wait(self.poll_s):
                self.sem.release()
                return False

    def release(self) -> None:
        if self.lock_path:
            with self._mu:
                self._held -= 1
                if self._held == 0 and self._fd is not None:
                    fcntl.flock(self._fd, fcntl.LOCK_UN)
                    os.close(self._fd)
                    self._fd = None
        self.sem.release()


# ---------------------------------------------------------------------------------------------------------------
# The worker
# ---------------------------------------------------------------------------------------------------------------

@dataclass
class Config:
    base_url: str
    worker_id: str
    machine: str = "box"
    concurrency: int = 1
    rate_per_hour: int = 60
    idle_poll_s: float = 60.0
    heartbeat_s: float = 60.0
    backoff_min_s: float = 30.0
    backoff_max_s: float = 900.0
    min_free_vram_mib: int = 2048
    vram_poll_s: float = 30.0
    gpu_lock: Optional[str] = None
    tmp_root: Optional[str] = None
    max_clip_bytes: int = 300 * 1024 * 1024
    fetch_timeout_s: float = 180.0
    ingest_retries: int = 4
    state_file: Optional[str] = None


class Backoff:
    def __init__(self, lo: float, hi: float, rng: Callable[[], float] = random.random):
        self.lo, self.hi, self.rng, self.cur = lo, hi, rng, 0.0

    def next(self) -> float:
        self.cur = self.lo if self.cur == 0 else min(self.hi, self.cur * 2)
        return self.cur * (0.8 + 0.4 * self.rng())

    def reset(self) -> None:
        self.cur = 0.0


def safe_token(s: str, limit: int = 128) -> str:
    return "".join(c for c in s if c in HB_TOKEN_OK)[:limit]


class Worker:
    def __init__(self, cfg: Config, api: Api, engine, *, stop: Optional[threading.Event] = None,
                 clock: Callable[[], float] = time.time, sleep: Optional[Callable[[float], bool]] = None,
                 free_vram: Callable[[], Optional[int]] = nvidia_free_mib, decode: Callable[[str, str], int] = ffmpeg_decode,
                 fetch: Callable[..., tuple] = fetch_clip, gpu_name: Callable[[], str] = nvidia_gpu_name,
                 retry_sleep: Callable[[float], None] = time.sleep):
        self.cfg, self.api, self.engine = cfg, api, engine
        self.stop = stop or threading.Event()
        self.clock = clock
        self.sleep = sleep or (lambda s: self.stop.wait(s))  # True = woken by stop
        self.free_vram, self.decode, self.fetch, self.gpu_name = free_vram, decode, fetch, gpu_name
        self.retry_sleep = retry_sleep
        self.backoff = Backoff(cfg.backoff_min_s, cfg.backoff_max_s)
        self.gpu = GpuGate(max(1, cfg.concurrency), cfg.gpu_lock, self.stop)
        self.started: collections.deque = collections.deque()  # window start times, for the rate cap
        self.done: collections.deque = collections.deque()  # (time, result) for windows_24h
        self.counts = collections.Counter()
        self.in_flight = 0
        self.last_ok_at: Optional[str] = None
        self.last_error_code: Optional[str] = None
        self.state = "starting"
        self._mu = threading.Lock()

    # -- shared pieces ------------------------------------------------------------------------------------------

    def _body(self, w: dict, *, status: str, error_code, audio_ms: int, clip_sha256, turns: list) -> dict:
        return {
            "window_id": w["window_id"], "room_day_id": w["room_day_id"], "engine": "nemotron",
            "model": self.engine.model, "model_rev": self.engine.model_rev, "config": self.engine.config,
            "config_hash": config_hash(self.engine.config), "worker_id": self.cfg.worker_id, "machine": self.cfg.machine,
            "audio_ms": audio_ms, "clip_sha256": clip_sha256, "status": status, "error_code": error_code, "turns": turns,
        }

    def write_state(self, **extra) -> None:
        if not self.cfg.state_file:
            return
        with self._mu:
            snap = {"state": self.state, "pid": os.getpid(), "worker_id": self.cfg.worker_id,
                    "model": self.engine.model, "model_rev": self.engine.model_rev, "config_hash": config_hash(self.engine.config),
                    "counts": dict(self.counts), "in_flight": self.in_flight, "last_ok_at": self.last_ok_at,
                    "last_error_code": self.last_error_code, "updated_at": _iso(self.clock()), **extra}
        tmp = self.cfg.state_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump(snap, f, sort_keys=True)
        os.replace(tmp, self.cfg.state_file)

    def _note(self, result: str, error_code: Optional[str] = None) -> None:
        with self._mu:
            self.counts[result] += 1
            self.done.append(self.clock())
            if error_code:
                self.last_error_code = error_code

    # -- one window ---------------------------------------------------------------------------------------------

    def process(self, w: dict) -> str:
        """Fetch, decode, infer, delete the audio, post. Returns the outcome code (for counts and tests)."""
        t0 = time.monotonic()
        wid = w["window_id"]
        tmp = tempfile.mkdtemp(prefix="nemo-w-", dir=self.cfg.tmp_root)
        os.chmod(tmp, 0o700)
        sha, audio_ms, turns, fail, timing = None, 0, [], None, {}
        try:
            src, wav = os.path.join(tmp, "clip.bin"), os.path.join(tmp, "clip.wav")
            try:
                sha, nbytes = self.fetch(w["clip_url"], src, self.cfg.max_clip_bytes, self.cfg.fetch_timeout_s)
            except FetchError as e:
                fail = "fetch_failed"
                log.warning("window=%s attempt=%s fetch_failed reason=%s", wid, w.get("attempt"), e)
            if fail is None:
                try:
                    audio_ms = self.decode(src, wav)
                except DecodeError:
                    fail, audio_ms = "decode_failed", 0
            if fail is None:
                if not self.gpu.acquire():
                    log.info("window=%s abandoned_on_stop (lease will lapse)", wid)
                    self._note("abandoned")
                    return "abandoned"
                t1 = time.monotonic()
                try:
                    segments = self.engine.diarize(wav)
                except Exception as e:  # never str(e): an engine message could carry a path
                    fail = "gpu_oom" if "out of memory" in repr(e).lower() else "infer_failed"
                    log.warning("window=%s %s type=%s", wid, fail, type(e).__name__)
                finally:
                    self.gpu.release()
                    timing["infer_s"] = round(time.monotonic() - t1, 2)
                if fail is None:
                    try:
                        turns = to_turns(segments, audio_ms)
                    except TurnsError as e:
                        fail, turns = e.code, []
        finally:
            shutil.rmtree(tmp, ignore_errors=True)  # audio gone before anything is posted

        if fail is not None:
            body = self._body(w, status="failed", error_code=fail, audio_ms=audio_ms if fail != "decode_failed" else 0,
                              clip_sha256=sha, turns=[])
        else:
            body = self._body(w, status="ok" if turns else "empty", error_code=None, audio_ms=audio_ms, clip_sha256=sha, turns=turns)
        outcome = self.post_ingest(body)
        spk = len({t[2] for t in turns})
        log.info("window=%s attempt=%s status=%s outcome=%s turns=%d spk=%d audio_s=%d infer_s=%s wall_s=%.1f",
                 wid, w.get("attempt"), body["status"], outcome, len(turns), spk, audio_ms // 1000,
                 timing.get("infer_s", "-"), time.monotonic() - t0)
        self._note(outcome, fail)
        if body["status"] != "failed" and outcome in ("stored", "duplicate"):
            with self._mu:
                self.last_ok_at = _iso(self.clock())
        return outcome

    def post_ingest(self, body: dict) -> str:
        """Retries only what can succeed on retry (network, 5xx). Keeps trying even after a stop: a result in hand
        is never dropped mid-write. Returns the server's result or error code."""
        for i in range(self.cfg.ingest_retries + 1):
            status, out = self.api.call("POST", "/api/diarize/nemotron/ingest", body)
            if status == 200:
                return str(out.get("result", "ok"))
            code = str(out.get("error") or f"http_{status}")
            if status in (400, 401, 403, 404, 409, 413):
                return code
            if i < self.cfg.ingest_retries:
                self.retry_sleep(min(60.0, 5.0 * (3 ** i)))  # NOT cut short by a stop
        return "ingest_gave_up"

    # -- the loop -----------------------------------------------------------------------------------------------

    def _rate_room(self) -> int:
        now = self.clock()
        while self.started and self.started[0] <= now - 3600:
            self.started.popleft()
        return self.cfg.rate_per_hour - len(self.started)

    def _wait(self, s: float, state: str) -> bool:
        """Sleep s; True if a stop came."""
        self.state = state
        self.write_state(sleep_s=round(s, 1))
        return self.sleep(s)

    def step(self) -> bool:
        """One claim cycle. False when the worker should exit."""
        if self.stop.is_set():
            return False
        room = self._rate_room()
        if room <= 0:
            return not self._wait(self.started[0] + 3600 - self.clock() + 1, "rate_capped")
        free = self.free_vram()
        if free is not None and free < self.cfg.min_free_vram_mib:
            log.info("vram_short free_mib=%d need_mib=%d", free, self.cfg.min_free_vram_mib)
            return not self._wait(self.cfg.vram_poll_s, "waiting_vram")
        limit = max(1, min(self.cfg.concurrency, room, 8))
        q = urllib.parse.urlencode({"worker_id": self.cfg.worker_id, "limit": limit})
        status, out = self.api.call("GET", f"/api/diarize/nemotron/pending?{q}")
        if status != 200:
            code = str(out.get("error") or f"http_{status}")
            self.last_error_code = code
            d = self.backoff.next()
            log.info("pending status=%d code=%s backoff_s=%.0f", status, code, d)
            return not self._wait(d, f"backoff:{code}")
        self.backoff.reset()
        windows = [w for w in out.get("windows", []) if isinstance(w, dict)]
        if not windows:
            return not self._wait(self.cfg.idle_poll_s, "idle")
        self.state = "working"
        for _ in windows:
            self.started.append(self.clock())
        with self._mu:
            self.in_flight = len(windows)
        self.write_state()
        if self.cfg.concurrency <= 1:
            for w in windows:
                self.process(w)
                with self._mu:
                    self.in_flight -= 1
        else:
            threads = [threading.Thread(target=self._process_and_count, args=(w,), daemon=False) for w in windows]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        return not self.stop.is_set()

    def _process_and_count(self, w: dict) -> None:
        try:
            self.process(w)
        finally:
            with self._mu:
                self.in_flight -= 1

    def heartbeat_once(self) -> int:
        now = self.clock()
        with self._mu:
            while self.done and self.done[0] <= now - 86400:
                self.done.popleft()
            body = {"worker_id": self.cfg.worker_id, "host": safe_token(socket.gethostname()) or "unknown",
                    "gpu": self.gpu_name(), "model_rev": self.engine.model_rev, "config_hash": config_hash(self.engine.config),
                    "queue_depth": self.in_flight, "windows_24h": len(self.done)}
            if self.last_ok_at:
                body["last_ok_at"] = self.last_ok_at
            if self.last_error_code:
                body["last_error_code"] = self.last_error_code
        status, out = self.api.call("POST", "/api/diarize/nemotron/heartbeat", body)
        if status != 200:
            log.info("heartbeat status=%d code=%s", status, out.get("error") or "-")
        return status

    def heartbeat_loop(self) -> None:
        hb = Backoff(self.cfg.heartbeat_s, self.cfg.backoff_max_s)
        while not self.stop.is_set():
            ok = self.heartbeat_once() == 200
            if ok:
                hb.reset()
            if self.stop.wait(self.cfg.heartbeat_s if ok else hb.next()):
                break

    def run(self) -> int:
        hb = threading.Thread(target=self.heartbeat_loop, name="heartbeat", daemon=True)
        hb.start()
        log.info("start worker_id=%s model=%s model_rev=%s config_hash=%s concurrency=%d rate_per_hour=%d",
                 self.cfg.worker_id, self.engine.model, self.engine.model_rev, config_hash(self.engine.config),
                 self.cfg.concurrency, self.cfg.rate_per_hour)
        while self.step():
            pass
        self.state = "stopped"
        self.write_state()
        log.info("stop counts=%s", json.dumps(dict(self.counts), sort_keys=True))
        return 0


def _iso(t: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


# ---------------------------------------------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------------------------------------------

def read_token(path: str) -> str:
    """The bearer from a file that must be a regular file, owned by us, mode 0600 or tighter."""
    st = os.stat(path)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise SystemExit(f"token file must be a regular file owned by this user with mode 0600 (got {oct(st.st_mode & 0o777)})")
    tok = open(path).read().strip()
    if not tok or any(c.isspace() for c in tok):
        raise SystemExit("token file is empty or malformed")
    return tok


def default_worker_id() -> str:
    wid = "box-" + "".join(c for c in socket.gethostname().split(".")[0] if c in WORKER_ID_OK)
    return wid[:64]


def main(argv=None) -> int:
    env = os.environ.get
    home = os.path.expanduser("~")
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--base-url", default=env("NEMOTRON_BASE_URL"), help="e.g. https://evenscribe.app (required)")
    p.add_argument("--token-file", default=env("NEMOTRON_TOKEN_FILE", f"{home}/.config/eta-nemotron/token"))
    p.add_argument("--worker-id", default=env("NEMOTRON_WORKER_ID") or default_worker_id())
    p.add_argument("--concurrency", type=int, default=int(env("NEMOTRON_CONCURRENCY", "1")))
    p.add_argument("--rate-per-hour", type=int, default=int(env("NEMOTRON_RATE_PER_HOUR", "60")))
    p.add_argument("--min-free-vram-mib", type=int, default=int(env("NEMOTRON_MIN_FREE_VRAM_MIB", "2048")))
    p.add_argument("--gpu-lock", default=env("NEMOTRON_GPU_LOCK", f"{home}/gpu.lock"), help="'' disables the lock")
    p.add_argument("--tmp-root", default=env("NEMOTRON_TMP_ROOT"))
    p.add_argument("--state-file", default=env("NEMOTRON_STATE_FILE", f"{home}/.local/state/eta-nemotron/status.json"))
    p.add_argument("--finetune-ckpt", default=env("NEMOTRON_FINETUNE_CKPT"), help="a .nemo fine-tune; unset = STOCK model")
    p.add_argument("--device", default=env("NEMOTRON_DEVICE", "cuda"))
    a = p.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%Y-%m-%dT%H:%M:%S%z")
    if not a.base_url or not a.base_url.startswith(("https://", "http://127.0.0.1", "http://localhost")):
        raise SystemExit("--base-url (or NEMOTRON_BASE_URL) is required: https://… or a localhost test server")
    if not a.worker_id or set(a.worker_id) - WORKER_ID_OK or len(a.worker_id) > 64:
        raise SystemExit("bad --worker-id")
    token = read_token(a.token_file)
    if a.state_file:
        os.makedirs(os.path.dirname(a.state_file), mode=0o700, exist_ok=True)

    import engine_nemo  # the GPU stack loads only here
    engine = engine_nemo.NemotronEngine(device=a.device, finetune_ckpt=a.finetune_ckpt)

    cfg = Config(base_url=a.base_url, worker_id=a.worker_id, concurrency=max(1, a.concurrency),
                 rate_per_hour=max(1, a.rate_per_hour), min_free_vram_mib=a.min_free_vram_mib,
                 gpu_lock=a.gpu_lock or None, tmp_root=a.tmp_root, state_file=a.state_file)
    stop = threading.Event()
    worker = Worker(cfg, Api(cfg.base_url, token), engine, stop=stop)

    def _on_signal(signum, _frame):
        log.info("signal=%d stopping after the current window", signum)
        stop.set()

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    return worker.run()


if __name__ == "__main__":
    raise SystemExit(main())
