#!/usr/bin/env python3
"""mcrec: multichannel recorder for ORB3 (ORDERS-O19). Python 3 + numpy + ffmpeg + alsa-utils only.

  mcrec.py run     --config mcrec.json
  mcrec.py mark    --config mcrec.json "<label>"
  mcrec.py package --config mcrec.json --from "2026-10-15 14:00" --to "2026-10-15 14:05" --out DIR

Layout of out_dir: <place>.pcm (s16le mono 48 kHz, high-passed at 80 Hz, append-only), <place>.idx.jsonl,
marks.jsonl, events.jsonl (start, gain, drift, drop, gap, reopen), mcrec.log.

idx fields (one row per 1 s of audio, written at the end of the second; overlap names follow ORB2 tape.idx):
  wall_ns, mono_ns   time of the last sample of the window (block arrival)
  byte_offset        pcm file size after the window (end offset)
  frames             frames in the window (48000, fewer for a partial window flushed at a drop)
  rms, peak          of the written (high-passed) signal, full scale = 1.0
  clip_count         raw samples with |x| >= 0.999 (before the high-pass)
  infra_rms          rms below 20 Hz of the raw signal (before the high-pass)
  drift_ppm          least-squares frames-vs-monotonic drift since this device was (re)opened, null until 10 s
"""
import sys, os, json, time, math, glob, re, argparse, subprocess, threading, signal, bisect, datetime as dt
import numpy as np

RATE = 48000
GAIN_MAX = 41                      # hard ceiling, not configurable
CLIP_LEVEL = 0.999
CLAP_PEAK = 0.5
CLAP_WINDOW_NS = 50_000_000
CLAP_REFRACTORY_NS = 1_000_000_000
REOPEN_EVERY_NS = 2_000_000_000
DRIFT_LOG_NS = 60_000_000_000
DRIFT_MIN_SPAN_S = 10.0
STALL_S = 3.0
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


class ConfigError(Exception): pass
class SourceGone(Exception): pass
class DeviceMissing(Exception): pass


# ---------------------------------------------------------------- filters
def _biquad(kind, fc, rate=RATE):
    w0 = 2 * math.pi * fc / rate; c = math.cos(w0); al = math.sin(w0) / (2 * (1 / math.sqrt(2)))
    if kind == "hp": b = [(1 + c) / 2, -(1 + c), (1 + c) / 2]
    else: b = [(1 - c) / 2, 1 - c, (1 - c) / 2]
    a0 = 1 + al
    return [x / a0 for x in b], [1.0, -2 * c / a0, (1 - al) / a0]


class Biquad:
    """2nd-order Butterworth, transposed direct form II, state kept across blocks."""
    def __init__(self, kind, fc, rate=RATE):
        (self.b0, self.b1, self.b2), (_, self.a1, self.a2) = _biquad(kind, fc, rate)
        self.z1 = self.z2 = 0.0

    def run(self, x):
        b0, b1, b2, a1, a2, z1, z2 = self.b0, self.b1, self.b2, self.a1, self.a2, self.z1, self.z2
        out = [0.0] * len(x); i = 0
        for v in x.tolist():
            y = b0 * v + z1; z1 = b1 * v - a1 * y + z2; z2 = b2 * v - a2 * y; out[i] = y; i += 1
        self.z1, self.z2 = z1, z2
        return np.asarray(out)


# ---------------------------------------------------------------- config
def load_config(path):
    c = json.load(open(path)) if isinstance(path, str) else dict(path)
    c.setdefault("rate", RATE); c.setdefault("block_frames", 4800); c.setdefault("hpf_hz", 80.0)
    c.setdefault("infra_hz", 20.0); c.setdefault("hpf", True)
    if c["rate"] != RATE: raise ConfigError("rate must be 48000 (no resampling anywhere)")
    if RATE % c["block_frames"]: raise ConfigError("block_frames must divide 48000")
    mics = c.get("mics") or []
    if not 1 <= len(mics) <= 4: raise ConfigError("1 to 4 mics required")
    if "out_dir" not in c: raise ConfigError("out_dir required")
    places = set()
    for m in mics:
        for k in ("place", "port"):
            if k not in m: raise ConfigError("mic needs place and port")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", m["place"]): raise ConfigError("bad place label")
        if m["place"] in places: raise ConfigError("duplicate place")
        places.add(m["place"])
        g = m.get("gain", GAIN_MAX)
        if not isinstance(g, int) or g > GAIN_MAX or g < 0: raise ConfigError(f"gain {g} refused (max {GAIN_MAX})")
        m["gain"] = g
    return c


# ---------------------------------------------------------------- devices
def resolve_port(port, sys_root="/sys/class/sound"):
    """USB port path (e.g. 'usb3/3-4/3-4:1.0') -> ALSA card number. Raises DeviceMissing."""
    want = port.strip("/")
    for d in sorted(glob.glob(os.path.join(sys_root, "card*"))):
        m = re.fullmatch(r"card(\d+)", os.path.basename(d))
        if not m: continue
        try: real = os.path.realpath(os.path.join(d, "device"))
        except OSError: continue
        if ("/" + real.strip("/") + "/").find("/" + want + "/") >= 0: return int(m.group(1))
    raise DeviceMissing(port)


class Mixer:
    """amixer wrapper. set() refuses > GAIN_MAX and returns the value read back."""
    def __init__(self, run=None): self._run = run or self._amixer
    @staticmethod
    def _amixer(args):
        return subprocess.run(["amixer"] + args, capture_output=True, text=True, timeout=10, check=True).stdout
    def get(self, card):
        out = self._run(["-c", str(card), "sget", "Mic"])
        m = re.search(r"^\s*(?:Mono|Front Left|Front Right):\s*Capture\s+(\d+)\b", out, re.M)
        if not m: raise RuntimeError("cannot parse amixer output")
        return int(m.group(1))
    def set(self, card, value):
        if value > GAIN_MAX: raise ConfigError(f"gain {value} refused (max {GAIN_MAX})")
        self._run(["-c", str(card), "sset", "Mic", str(int(value))])
        return self.get(card)


class ArecordSource:
    """raw s16le 48 kHz mono from `arecord -D hw:N,0`; hw: never resamples, a bad rate fails the open."""
    def __init__(self, card, block_frames):
        self.n = block_frames * 2
        self.p = subprocess.Popen(["arecord", "-q", "-D", f"hw:{card},0", "-f", "S16_LE", "-r", str(RATE), "-c", "1", "-t", "raw"],
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        self.fd = self.p.stdout.fileno()
    def read(self):
        import select
        buf = b""; end = time.monotonic() + STALL_S + self.n / (2 * RATE)
        while len(buf) < self.n:
            left = end - time.monotonic()
            if left <= 0 or not select.select([self.fd], [], [], left)[0]: raise SourceGone("stall")
            d = os.read(self.fd, self.n - len(buf))
            if not d: raise SourceGone("eof")
            buf += d
        return buf
    def close(self):
        try: self.p.kill(); self.p.wait(timeout=3)
        except Exception: pass


class Env:
    """Everything the workers touch outside themselves; tests replace it."""
    def __init__(self, cfg, resolve=None, mixer=None, opener=None, mono_ns=None, wall_ns=None, log=None):
        self.cfg = cfg
        self.resolve = resolve or resolve_port
        self.mixer = mixer or Mixer()
        self.opener = opener or (lambda card, mic: ArecordSource(card, cfg["block_frames"]))
        self.mono_ns = mono_ns or time.monotonic_ns
        self.wall_ns = wall_ns or time.time_ns
        self._log = log
        self.lock = threading.Lock()
    def event(self, kind, **kw):
        row = dict(kind=kind, wall_ns=self.wall_ns(), mono_ns=self.mono_ns(), **kw)
        with self.lock:
            with open(os.path.join(self.cfg["out_dir"], "events.jsonl"), "a") as f: f.write(json.dumps(row) + "\n")
            line = f"{dt.datetime.now(IST).isoformat(timespec='seconds')} {kind} {json.dumps(kw)}"
            with open(os.path.join(self.cfg["out_dir"], "mcrec.log"), "a") as f: f.write(line + "\n")
            if self._log: self._log(line)
        return row
    def append_jsonl(self, name, row):
        with self.lock, open(os.path.join(self.cfg["out_dir"], name), "a") as f: f.write(json.dumps(row) + "\n")


# ---------------------------------------------------------------- claps
class ClapDetector:
    def __init__(self, env, places):
        self.env, self.places = env, list(places); self.pending = {}; self.lock = threading.Lock()
    def report(self, place, sample_off, mono_ns, active):
        """active: set of places currently recording. A clap needs >=2 active mics, all of them within 50 ms."""
        with self.lock:
            self.pending = {p: e for p, e in self.pending.items() if mono_ns - e[1] <= CLAP_WINDOW_NS}
            self.pending[place] = (sample_off, mono_ns)
            need = set(active) | {place}
            if len(need) < 2 or not need <= set(self.pending): return None
            ev = {p: self.pending[p] for p in need}
            ts = [e[1] for e in ev.values()]
            if max(ts) - min(ts) > CLAP_WINDOW_NS: return None
            self.pending = {}
        row = dict(wall_ns=self.env.wall_ns(), mono_ns=min(ts), label="clap",
                   byte_offset={p: e[0] * 2 for p, e in ev.items()}, sample_offset={p: e[0] for p, e in ev.items()})
        self.env.append_jsonl("marks.jsonl", row)
        return row


# ---------------------------------------------------------------- one mic
class MicWorker:
    def __init__(self, env, mic, claps, active):
        self.env, self.mic, self.claps, self.active = env, mic, claps, active
        c = env.cfg; self.place = mic["place"]; self.bf = c["block_frames"]
        base = os.path.join(c["out_dir"], self.place)
        self.pcm_path, self.idx_path = base + ".pcm", base + ".idx.jsonl"
        self.pcm = open(self.pcm_path, "ab"); self.idx = open(self.idx_path, "a")
        self.hpf = Biquad("hp", c["hpf_hz"]) if c["hpf"] else None
        self.lpf = Biquad("lp", c["infra_hz"])
        self.src = None; self.next_try = 0; self.card = None; self.gap_from = None; self.last_end = None
        self.frames_total = self.pcm.tell() // 2
        self.win = None; self._reset_win(); self.last_clap = -10**18; self.drift_next = None
        self._reset_drift()

    def _reset_win(self): self.win = dict(frames=0, ss=0.0, infra=0.0, peak=0.0, clip=0)
    def _reset_drift(self):
        self.d_n = 0; self.d_mx = self.d_my = self.d_cxx = self.d_cxy = 0.0; self.d_x0 = self.d_y0 = None; self.d_mx_span = 0.0

    def drift_ppm(self):
        if self.d_n < 2 or self.d_cxx <= 0: return None
        if self.d_mx_span < DRIFT_MIN_SPAN_S: return None
        return (self.d_cxy / self.d_cxx / RATE - 1) * 1e6

    def _drift_add(self, mono_ns, frames_after):
        if self.d_x0 is None: self.d_x0, self.d_y0 = mono_ns, frames_after; self.d_mx_span = 0.0
        x = (mono_ns - self.d_x0) / 1e9; y = float(frames_after - self.d_y0)
        self.d_n += 1; dx = x - self.d_mx; self.d_mx += dx / self.d_n
        dy = y - self.d_my; self.d_my += dy / self.d_n
        self.d_cxx += dx * (x - self.d_mx); self.d_cxy += dx * (y - self.d_my); self.d_mx_span = x

    # -- open / drop
    def _try_open(self):
        env = self.env; now = env.mono_ns()
        if now < self.next_try: return False
        self.next_try = now + REOPEN_EVERY_NS
        try:
            self.card = env.resolve(self.mic["port"])
            rb = env.mixer.set(self.card, self.mic["gain"])
            env.event("gain", place=self.place, card=self.card, set=self.mic["gain"], read_back=rb, **({} if rb == self.mic["gain"] else {"warning": "mismatch"}))
            self.src = env.opener(self.card, self.mic)
        except (DeviceMissing, SourceGone, OSError, subprocess.SubprocessError, RuntimeError) as e:
            self.src = None; return False
        env.event("open" if self.gap_from is None else "reopen", place=self.place, card=self.card, port=self.mic["port"])
        self._reset_drift(); self.drift_next = None
        return True

    def _drop(self, why):
        if self.src is not None:
            try: self.src.close()
            except Exception: pass
        self.src = None
        if self.gap_from is None:
            self.gap_from = dict(wall_ns=self.last_end[0] if self.last_end else self.env.wall_ns(),
                                 mono_ns=self.last_end[1] if self.last_end else self.env.mono_ns(), byte_offset=self.pcm.tell())
            self._flush_win(self.gap_from["wall_ns"], self.gap_from["mono_ns"])
            self.env.event("drop", place=self.place, why=why, byte_offset=self.pcm.tell())
        self.next_try = self.env.mono_ns() + REOPEN_EVERY_NS

    # -- main step; returns True if it did useful work
    def step(self):
        if self.src is None:
            if not self._try_open(): return False
        try: data = self.src.read()
        except (SourceGone, OSError) as e:
            self._drop(str(e) or "gone"); return False
        mono = self.env.mono_ns(); wall = self.env.wall_ns()
        n = len(data) // 2
        if n == 0: self._drop("empty"); return False
        self.process(np.frombuffer(data[:n * 2], dtype="<i2"), wall, mono)
        return True

    def process(self, raw, wall, mono):
        env = self.env; n = len(raw); dur_ns = int(n * 1e9 / RATE)
        if self.gap_from is not None:
            g = self.gap_from; start_w, start_m = wall - dur_ns, mono - dur_ns
            env.event("gap", place=self.place, wall_start_ns=g["wall_ns"], wall_end_ns=start_w, mono_start_ns=g["mono_ns"],
                      mono_end_ns=start_m, byte_offset=g["byte_offset"], gap_s=round((start_w - g["wall_ns"]) / 1e9, 3))
            self.gap_from = None
        x = raw.astype(np.float64) / 32768.0
        infra = self.lpf.run(x)
        y = self.hpf.run(x) if self.hpf else x
        out = np.clip(np.rint(y * 32768.0), -32768, 32767).astype("<i2")
        off_frames = self.pcm.tell() // 2
        self.pcm.write(out.tobytes()); self.pcm.flush()
        yf = out.astype(np.float64) / 32768.0
        w = self.win; w["frames"] += n; w["ss"] += float(np.dot(yf, yf)); w["infra"] += float(np.dot(infra, infra))
        w["peak"] = max(w["peak"], float(np.max(np.abs(yf)))); w["clip"] += int(np.count_nonzero(np.abs(x) >= CLIP_LEVEL))
        self.frames_total += n; self.last_end = (wall, mono)
        self._drift_add(mono, self.frames_total)
        # clap onset: first |x| > 0.5 in the written signal
        hit = np.flatnonzero(np.abs(yf) > CLAP_PEAK)
        if len(hit):
            i = int(hit[0]); sm = mono - int((n - i) * 1e9 / RATE)
            if sm - self.last_clap > CLAP_REFRACTORY_NS:
                self.last_clap = sm
                self.claps.report(self.place, off_frames + i, sm, self.active())
        if w["frames"] >= RATE: self._flush_win(wall, mono)
        if self.drift_next is None: self.drift_next = mono + DRIFT_LOG_NS
        elif mono >= self.drift_next:
            self.drift_next = mono + DRIFT_LOG_NS
            env.event("drift", place=self.place, ppm=self._r(self.drift_ppm()), frames=self.frames_total)

    @staticmethod
    def _r(v): return None if v is None else round(v, 3)

    def _flush_win(self, wall, mono):
        w = self.win
        if w["frames"] == 0: return
        f = w["frames"]
        row = dict(wall_ns=wall, mono_ns=mono, byte_offset=self.pcm.tell(), frames=f, rms=round(math.sqrt(w["ss"] / f), 6),
                   peak=round(w["peak"], 6), clip_count=w["clip"], infra_rms=round(math.sqrt(w["infra"] / f), 6),
                   drift_ppm=self._r(self.drift_ppm()), rate_hz=RATE)
        self.idx.write(json.dumps(row) + "\n"); self.idx.flush(); self._reset_win()

    def is_recording(self): return self.src is not None
    def close(self):
        if self.src is not None:
            try: self.src.close()
            except Exception: pass
        self._flush_win(*(self.last_end or (self.env.wall_ns(), self.env.mono_ns())))
        self.pcm.close(); self.idx.close()


# ---------------------------------------------------------------- recorder
class Recorder:
    def __init__(self, cfg, env=None):
        self.cfg = cfg; os.makedirs(cfg["out_dir"], exist_ok=True)
        self.env = env or Env(cfg, log=lambda s: print(s, flush=True))
        self.claps = ClapDetector(self.env, [m["place"] for m in cfg["mics"]])
        self.workers = []
        for m in cfg["mics"]:
            self.workers.append(MicWorker(self.env, m, self.claps, self._active))
        self.stop = threading.Event()
        self.env.event("start", mics=[m["place"] for m in cfg["mics"]], rate=RATE, hpf_hz=cfg["hpf_hz"] if cfg["hpf"] else None)
    def _active(self): return {w.place for w in self.workers if w.is_recording()}
    def _loop(self, w):
        while not self.stop.is_set():
            try:
                if not w.step(): self.stop.wait(0.2)
            except Exception as e:                      # never let one mic stop the others
                self.env.event("error", place=w.place, err=repr(e)); w._drop("error"); self.stop.wait(0.5)
    def run(self):
        ts = [threading.Thread(target=self._loop, args=(w,), daemon=True) for w in self.workers]
        for t in ts: t.start()
        for s in (signal.SIGTERM, signal.SIGINT): signal.signal(s, lambda *_: self.stop.set())
        while not self.stop.wait(0.5): pass
        for t in ts: t.join(timeout=5)
        for w in self.workers: w.close()


# ---------------------------------------------------------------- mark
def add_mark(cfg, label):
    out = cfg["out_dir"]
    offs = {m["place"]: (os.path.getsize(os.path.join(out, m["place"] + ".pcm")) if os.path.exists(os.path.join(out, m["place"] + ".pcm")) else 0) for m in cfg["mics"]}
    row = dict(wall_ns=time.time_ns(), mono_ns=time.monotonic_ns(), label=label, byte_offset=offs)
    with open(os.path.join(out, "marks.jsonl"), "a") as f: f.write(json.dumps(row) + "\n")
    return row


# ---------------------------------------------------------------- package
def parse_ist(s):
    s = s.strip().replace("T", " ")
    for f in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try: return dt.datetime.strptime(s, f).replace(tzinfo=IST)
        except ValueError: pass
    raise ConfigError(f"bad IST time {s!r}")

def _jl(path):
    if not os.path.exists(path): return []
    return [json.loads(l) for l in open(path) if l.strip()]

class Timeline:
    """wall_ns -> frame offset in the pcm, from idx rows (start and end anchor per row; gaps map to a flat offset)."""
    def __init__(self, rows):
        W, F = [], []
        for r in rows:
            fe = r["byte_offset"] // 2; fs = fe - r["frames"]; we = r["wall_ns"]; ws = we - int(r["frames"] * 1e9 / RATE)
            for w, f in ((ws, fs), (we, fe)):
                if W and w < W[-1]: w = W[-1]
                if F and f < F[-1]: f = F[-1]
                W.append(w); F.append(f)
        self.W, self.F = W, F
    def at(self, t_ns):
        if not self.W: return 0
        if t_ns <= self.W[0]: return self.F[0]
        if t_ns >= self.W[-1]: return self.F[-1]
        i = bisect.bisect_right(self.W, t_ns) - 1
        w0, w1, f0, f1 = self.W[i], self.W[i + 1], self.F[i], self.F[i + 1]
        return f0 if w1 == w0 else int(round(f0 + (t_ns - w0) / (w1 - w0) * (f1 - f0)))

def package(cfg, t0, t1, out):
    rec = cfg["out_dir"]; lo, hi = int(t0.timestamp() * 1e9), int(t1.timestamp() * 1e9)
    if hi <= lo: raise ConfigError("--to must be after --from")
    for d in ("media", "tracks"): os.makedirs(os.path.join(out, d), exist_ok=True)
    events = _jl(os.path.join(rec, "events.jsonl")); marks = _jl(os.path.join(rec, "marks.jsonl"))
    env_rows, chans, sources = [], [], []
    for m in cfg["mics"]:
        p = m["place"]; rows = _jl(os.path.join(rec, p + ".idx.jsonl")); tl = Timeline(rows)
        a, b = tl.at(lo), tl.at(hi); pcm = os.path.join(rec, p + ".pcm")
        a = max(0, min(a, os.path.getsize(pcm) // 2)); b = max(a, min(b, os.path.getsize(pcm) // 2))
        flac = os.path.join(out, "media", p + ".flac"); target = int(round((hi - lo) * RATE / 1e9))
        ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", str(RATE), "-ac", "1", "-i", "-", "-af", f"atrim=end_sample={target}", "-c:a", "flac", flac],
                              stdin=subprocess.PIPE)
        # zero-fill: gaps (and any uncovered head/tail) become digital silence so every mic's flac is exactly the window long
        zeros = lambda n: b"\0" * (2 * n); filled = 0; wrote = 0
        mygaps = sorted((e for e in events if e["kind"] == "gap" and e.get("place") == p and e["wall_end_ns"] >= lo and e["wall_start_ns"] <= hi),
                        key=lambda e: e["byte_offset"])
        def out_(buf):
            nonlocal wrote
            ff.stdin.write(buf); wrote += len(buf) // 2
        with open(pcm, "rb") as f:
            if tl.W and lo < tl.W[0]:
                n = min(target, int(round((tl.W[0] - lo) * RATE / 1e9))); out_(zeros(n)); filled += n
            pos = a
            def copy(upto):
                nonlocal pos
                f.seek(pos * 2); left = (upto - pos) * 2
                while left > 0:
                    d = f.read(min(left, 1 << 20))
                    if not d: break
                    out_(d); left -= len(d)
                pos = max(pos, upto)
            for g in mygaps:
                at = max(a, min(b, g["byte_offset"] // 2)); copy(at)
                n = int(round((min(g["wall_end_ns"], hi) - max(g["wall_start_ns"], lo)) * RATE / 1e9))
                if n > 0: out_(zeros(n)); filled += n
            copy(b)
            if wrote < target: out_(zeros(target - wrote)); filled += target - wrote
        ff.stdin.close()
        if ff.wait() != 0: raise RuntimeError("ffmpeg failed for " + p)
        win = [r for r in rows if lo <= r["wall_ns"] <= hi]
        for r in win:
            env_rows.append(dict(place=p, wall_ns=r["wall_ns"], mono_ns=r["mono_ns"], frames=r["frames"], rms=r["rms"], peak=r["peak"],
                                 clip_count=r["clip_count"], infra_rms=r["infra_rms"], drift_ppm=r.get("drift_ppm")))
        drift = next((r["drift_ppm"] for r in reversed(win) if r.get("drift_ppm") is not None), None)
        gains = [e for e in events if e["kind"] == "gain" and e.get("place") == p and e["wall_ns"] <= hi]
        gain = gains[-1] if gains else None
        chans.append(dict(place=p, port_path=m["port"], media=f"media/{p}.flac", sample_rate=RATE, channels=1, frames=b - a,
                          gain_set=gain and gain["set"], gain_read_back=gain and gain["read_back"], drift_ppm=drift, flac_frames=target, zero_filled_frames=filled, highpass_hz=cfg["hpf_hz"] if cfg["hpf"] else None))
        sources.append(dict(id=p, path=f"media/{p}.flac", sample_rate=RATE, channels=1, byte_offset_start=a * 2, byte_offset_end=b * 2,
                            clock="wall_ns from idx, NTP-synced"))
    env_rows.sort(key=lambda r: (r["wall_ns"], r["place"]))
    with open(os.path.join(out, "tracks", "environment.jsonl"), "w") as f:
        for r in env_rows: f.write(json.dumps(r) + "\n")
    open(os.path.join(out, "tracks", "transcript.jsonl"), "w").close()
    gaps = [dict(place=e["place"], wall_start_ns=e["wall_start_ns"], wall_end_ns=e["wall_end_ns"], byte_offset=e["byte_offset"], gap_s=e["gap_s"], zero_filled=True)
            for e in events if e["kind"] == "gap" and e["wall_end_ns"] >= lo and e["wall_start_ns"] <= hi]
    iso = lambda e, tz: dt.datetime.fromtimestamp(e / 1e9, tz).isoformat(timespec="seconds")
    man = dict(window_start_ist=iso(lo, IST), window_end_ist=iso(hi, IST), window_start_utc=iso(lo, dt.timezone.utc), window_end_utc=iso(hi, dt.timezone.utc),
               sample_rate=RATE, channels=chans, sources=sources, gaps=gaps,
               marks=[mk for mk in marks if lo <= mk["wall_ns"] <= hi], recorder="mcrec.py")
    json.dump(man, open(os.path.join(out, "manifest.json"), "w"), indent=1)
    json.dump(dict(window_start_ist=man["window_start_ist"], window_end_ist=man["window_end_ist"], window_start_utc=man["window_start_utc"],
                   window_end_utc=man["window_end_utc"], SIMULATED=False), open(os.path.join(out, "meta.json"), "w"), indent=1)
    return man


def main(argv=None):
    ap = argparse.ArgumentParser(prog="mcrec.py"); sub = ap.add_subparsers(dest="cmd", required=True)
    for n in ("run", "mark", "package"): s = sub.add_parser(n); s.add_argument("--config", required=True)
    sub.choices["mark"].add_argument("label")
    pk = sub.choices["package"]; pk.add_argument("--from", dest="t0", required=True); pk.add_argument("--to", dest="t1", required=True); pk.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    try: cfg = load_config(a.config)
    except ConfigError as e: sys.exit(f"mcrec: config refused: {e}")
    if a.cmd == "run": Recorder(cfg).run()
    elif a.cmd == "mark": print(json.dumps(add_mark(cfg, a.label)))
    else: man = package(cfg, parse_ist(a.t0), parse_ist(a.t1), a.out); print(f"packaged {len(man['channels'])} channels -> {a.out}")

if __name__ == "__main__":
    main()
