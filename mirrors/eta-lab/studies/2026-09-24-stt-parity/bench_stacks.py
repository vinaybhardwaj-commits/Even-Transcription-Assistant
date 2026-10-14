#!/usr/bin/env python3
"""Ruling 124 throughput: N routers on one CPU node each pull 900 s windows from a shared queue; rate = total audio seconds / makespan.
Run ON the CPU node. Audio files in a directory; served over loopback http; production request shape (translate=false). Numbers only."""
import sys, os, time, json, threading, queue, http.server, socketserver, functools, requests
clips_dir, ports, n = sys.argv[1], [int(p) for p in sys.argv[2].split(",")], int(sys.argv[3])
files = sorted(f for f in os.listdir(clips_dir) if f.endswith(".webm"))
files = (files * ((n // len(files)) + 1))[:n]
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=clips_dir); H.log_message = lambda *a, **k: None
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 18898), H); srv.allow_reuse_address = True
threading.Thread(target=srv.serve_forever, daemon=True).start()
q = queue.Queue(); [q.put(f) for f in files]
res = []; lock = threading.Lock(); T0 = time.time()
def worker(port):
    while True:
        try: f = q.get_nowait()
        except queue.Empty: return
        t0 = time.time()
        r = requests.post(f"http://127.0.0.1:{port}/route/job", json={"audio_url": f"http://127.0.0.1:18898/{f}", "candidates": "en,kn,hi,ta,te,ml,mr,bn", "translate": False, "window_s": 180}, timeout=30).json()
        jid = r.get("job_id"); state = "nojob"
        while jid:
            time.sleep(5); j = requests.get(f"http://127.0.0.1:{port}/route/job/{jid}", timeout=30).json(); state = j.get("state")
            if state in ("done", "failed"): break
        with lock: res.append((port, f[-14:], state, round(time.time() - t0, 1)))
ths = [threading.Thread(target=worker, args=(p,)) for p in ports]
[t.start() for t in ths]; [t.join() for t in ths]
mk = time.time() - T0
ok = [r for r in res if r[2] == "done"]
print(f"routers={len(ports)} windows={len(files)} done={len(ok)} makespan={mk:.0f}s per-window wall: mean {sum(r[3] for r in ok)/max(1,len(ok)):.0f}s")
print(f"throughput = {900*len(ok)/mk:.0f} audio-s per s = {900*len(ok)/mk:.1f} audio-hours per wall-hour")
print(sorted(res))
