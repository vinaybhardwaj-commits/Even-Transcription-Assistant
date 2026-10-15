"""Synthetic fixtures: virtual clock + fake devices driving real MicWorkers lockstep, block by block."""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import mcrec

RATE = 48000
BASE_WALL = 1_792_000_000_000_000_000      # fixed epoch ns, so IST windows are exact
BASE_MONO = 5_000_000_000_000


def t_arr(n, rate=RATE): return np.arange(n) / rate

def noise(n, seed=7, amp=0.2): return np.random.default_rng(seed).uniform(-amp, amp, n)

def to_i16(x): return np.clip(np.rint(np.asarray(x) * 32768), -32768, 32767).astype("<i2")

def clap(sig, at, amp=0.9, n=240):
    sig = sig.copy(); sig[at:at + n] = amp * np.exp(-np.arange(n) / 60.0) * np.sign(np.sin(np.arange(n) * 0.9) + 1e-9); sig[at] = amp
    return sig


class Clock:
    def __init__(self): self.t = 0.0
    def mono(self): return BASE_MONO + int(round(self.t * 1e9))
    def wall(self): return BASE_WALL + int(round(self.t * 1e9))


class FakeDevice:
    def __init__(self, signal_i16, port, card, ppm=0.0, down=None):
        self.sig, self.port, self.card, self.ppm = signal_i16, port, card, ppm
        self.down = [down] if isinstance(down, tuple) else list(down or [])                    # (t0, t1) seconds, or a list of them
        self.k = 0; self.t = 0.0
    def is_down(self): return any(a <= self.t < b for a, b in self.down)


class FakeSource:
    def __init__(self, dev, bf): self.dev, self.bf = dev, bf
    def read(self):
        d = self.dev
        if d.is_down(): raise mcrec.SourceGone("unplugged")
        blk = d.sig[d.k * self.bf:(d.k + 1) * self.bf]
        if len(blk) == 0: raise mcrec.SourceGone("eof")
        return blk.tobytes()
    def close(self): pass


class FakeMixer:
    def __init__(self): self.vals = {}; self.calls = []
    def run(self, args):
        card = int(args[1])
        if args[2] == "sset": self.calls.append((card, int(args[4]))); self.vals[card] = int(args[4])
        return ("Simple mixer control 'Mic',0\n  Capabilities: cvolume cswitch\n  Capture channels: Mono\n  Limits: Capture 0 - 62\n"
                f"  Mono: Capture {self.vals.get(card, 0)} [66%] [on]\n")


class Sim:
    def __init__(self, tmp, devices, mics=None, **cfgover):
        self.dev = {d.port: d for d in devices}
        cfg = dict(out_dir=str(tmp), block_frames=4800, mics=mics or [dict(place=f"p{i}", port=d.port, gain=41) for i, d in enumerate(devices)])
        cfg.update(cfgover); self.cfg = mcrec.load_config(cfg)
        self.clock = Clock(); self.mixer = FakeMixer()
        def resolve(port):
            d = self.dev[port]
            if d.is_down(): raise mcrec.DeviceMissing(port)
            return d.card
        env = mcrec.Env(self.cfg, resolve=resolve, mixer=mcrec.Mixer(self.mixer.run), mono_ns=self.clock.mono, wall_ns=self.clock.wall,
                        opener=lambda card, mic: FakeSource(self.dev[mic["port"]], self.cfg["block_frames"]))
        self.rec = mcrec.Recorder(self.cfg, env)
        self.bf = self.cfg["block_frames"]

    def restart(self, at_s):
        """Whole-recorder restart: a new Recorder on the same files and env at time at_s (the next run(start=at_s) continues from there)."""
        self.clock.t = at_s; self.rec = mcrec.Recorder(self.cfg, self.rec.env)

    def run(self, seconds, start=0.0):
        """Drive blocks from `start` to `seconds` (source time); workers are closed at the end of each call."""
        for k in range(int(round(start * RATE / self.bf)), int(round(seconds * RATE / self.bf))):
            for w in self.rec.workers:
                d = self.dev[w.mic["port"]]; d.k = k; d.t = (k + 1) * self.bf / (RATE * (1 + d.ppm * 1e-6))
                self.clock.t = d.t; w.step()
        for w in self.rec.workers: w.close()

    def idx(self, place): return [json.loads(l) for l in open(os.path.join(self.cfg["out_dir"], place + ".idx.jsonl"))]
    def pcm(self, place): return np.fromfile(os.path.join(self.cfg["out_dir"], place + ".pcm"), dtype="<i2")
    def jl(self, name):
        p = os.path.join(self.cfg["out_dir"], name)
        return [json.loads(l) for l in open(p)] if os.path.exists(p) else []
