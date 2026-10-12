#!/usr/bin/env python3
import json, os, subprocess, sys, tempfile, time
H = os.path.dirname(os.path.abspath(__file__))
T = tempfile.mkdtemp(); os.environ["FAKE_TOTAL"] = f"{T}/total"; os.environ["FAKE_PID"] = f"{T}/pid"; S = f"{T}/status"; EV = f"{T}/ev.jsonl"
RUN = "   0 [Device         ]: USB-Audio\n/proc/asound/card0/pcm0c/sub0/status:state: RUNNING\n"
IDLE = "   0 [Device         ]: USB-Audio\n/proc/asound/card0/pcm0c/sub0/status:closed\n"
OTHER = "   0 [Headphones     ]: bcm\n/proc/asound/card0/pcm0c/sub0/status:state: RUNNING\n"
def setst(t): open(S + ".tmp", "w").write(t); os.replace(S + ".tmp", S)
setst(IDLE)
p = subprocess.Popen([sys.executable, f"{H}/follower.py", "--status-cmd", f"grep -q UNREACH {S} && exit 1; cat {S}",
    "--out", f"{T}/rec", "--events", EV, "--arecord", f"{sys.executable} {H}/fake_arecord.py",
    "--piece-s", "2", "--stats-s", "2", "--poll-s", "0.2", "--unreach-hold-s", "3", "--retry-s", "0.5", "--timesync-s", "1000"])
def ev(): return [json.loads(l) for l in open(EV)] if os.path.exists(EV) else []
def n(name): return len([e for e in ev() if e["event"] == name])
def recording(): return n("start") + n("split") > n("stop")  # approximate
res = []
def chk(name, ok): res.append(ok); print(("PASS " if ok else "FAIL ") + name)
time.sleep(1)
chk("idle: no start", n("start") == 0)
setst(OTHER); time.sleep(1); chk("non-TONOR RUNNING ignored", n("start") == 0)
setst(RUN); time.sleep(1); chk("start on RUNNING", n("start") == 1)
c0 = n("orb3_state_change"); setst(IDLE)
while n("orb3_state_change") == c0: time.sleep(0.01)  # one poll saw idle
setst(RUN); time.sleep(1.5)
chk("1-poll blip does not stop", n("stop") == 0)
setst(IDLE); time.sleep(1.5); chk("stop after 2 idle polls", n("stop") == 1)
setst(RUN); time.sleep(1); s0 = n("start"); setst("UNREACH\n"); time.sleep(1.5)
chk("unreachable <60s(3s mock): keeps state", n("stop") == 1 and n("orb3_unreachable") == 0)
time.sleep(3.5); chk("unreachable hold elapsed: stop + log", n("orb3_unreachable") == 1 and n("stop") == 2)
setst(RUN); time.sleep(1.5); chk("recovers and restarts", n("start") == s0 + 1)
time.sleep(7)
pieces = [e for e in ev() if e["event"] == "piece"]
chk("pieces logged with file/epoch_ns/frames/sha256", len(pieces) >= 3 and all({"file","epoch_ns","frames","sha256"} <= set(e) for e in pieces))
chk("each piece has a .sha256 sidecar", all(os.path.exists(e["file"] + ".sha256") for e in pieces))
# arecord dies inside the unreachable hold (3 s): restarted because ORB3 was last seen recording
s1 = n("start"); setst("UNREACH\n"); time.sleep(0.6); os.kill(int(open(f"{T}/pid").read()), 9); time.sleep(1.5)
chk("dead arecord in hold is restarted", n("start") == s1 + 1 and n("arecord_exit") >= 1 and n("orb3_unreachable") == 1)
setst(RUN); time.sleep(1)
p.terminate(); p.wait(); time.sleep(0.2)
chk("clean exit on SIGTERM", p.returncode == 0)
ps = [e for e in ev() if e["event"] == "piece"]
ps.sort(key=lambda e: e["epoch_ns"])
chk("full pieces are exactly piece-s * 48000 frames", all(e["frames"] == 96000 for e in ps[:-1] if e["frames"] >= 96000) and any(e["frames"] == 96000 for e in ps))
chk("nothing left in .work", not any(f.endswith(".wav") for _, _, fs in os.walk(f"{T}/rec/.work") for f in fs))
chk("poll_ms on orb3_state_change", all("poll_ms" in e for e in ev() if e["event"] == "orb3_state_change"))
chk("poll_stats event has n/median/p95/max", any(e["event"] == "poll_stats" and {"n","median_ms","p95_ms","max_ms"} <= set(e) for e in ev()))
# no-gap: total frames in pieces == frames arecord recorded (+-1)
T3 = tempfile.mkdtemp(); os.environ["FAKE_TOTAL"] = f"{T3}/total"; open(f"{T3}/st", "w").write(RUN)
g = subprocess.Popen([sys.executable, f"{H}/follower.py", "--status-cmd", f"cat {T3}/st", "--out", f"{T3}/rec", "--events", f"{T3}/ev",
    "--arecord", f"{sys.executable} {H}/fake_arecord.py", "--piece-s", "2", "--poll-s", "0.2", "--timesync-s", "1000"])
time.sleep(7.3); g.terminate(); g.wait(); time.sleep(0.2)
evs = [json.loads(l) for l in open(f"{T3}/ev")]
fr = sum(e["frames"] for e in evs if e["event"] == "piece"); tot = int(open(f"{T3}/total").read())
print("no-gap frames:", fr, "recorded:", tot, "pieces:", len([e for e in evs if e["event"] == "piece"]))
ps = sorted([e for e in evs if e["event"] == "piece"], key=lambda e: e["epoch_ns"])
cont = [(b["epoch_ns"] - a["epoch_ns"]) - a["frames"] * 1e9 / 48000 for a, b in zip(ps, ps[1:])]
chk("epoch_ns continuity across pieces (+-1 ns)", len(cont) >= 3 and all(abs(c) <= 1 for c in cont))
chk("300 s split (2 s here): total frames == recorded +-1 frame", abs(fr - tot) <= 1 and len([e for e in evs if e["event"] == "piece"]) >= 3)
# slow poll: 3 s poll must not stretch cadence beyond 3 s
T2 = tempfile.mkdtemp(); stamps = f"{T2}/stamps"
open(f"{T2}/st", "w").write(IDLE)
q = subprocess.Popen([sys.executable, f"{H}/follower.py", "--status-cmd", f"date +%s.%N >> {stamps}; sleep 3; cat {T2}/st",
    "--out", f"{T2}/rec", "--events", f"{T2}/ev", "--poll-s", "2", "--timesync-s", "1000", "--poll-timeout", "4"])
time.sleep(13); q.terminate(); q.wait()
ts = [float(x) for x in open(stamps).read().split()]
gaps = [b - a for a, b in zip(ts, ts[1:])]
print("slow-poll gaps:", [round(g, 2) for g in gaps])
chk("3 s poll: cadence 3.0-3.4 s (not 5 s)", len(gaps) >= 3 and all(3.0 <= g <= 3.4 for g in gaps))
print("events:", [e["event"] for e in ev()])
sys.exit(0 if all(res) else 1)
