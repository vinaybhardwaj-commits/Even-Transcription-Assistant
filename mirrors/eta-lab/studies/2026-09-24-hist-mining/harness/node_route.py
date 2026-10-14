#!/usr/bin/env python3
"""node_route.py — HIST harness piece 2 (hist-miner, ruling 146). Runs ON a HIST node. One window -> one router job -> raw router result.
Request shape = production's room-window job as reproduced by the refuter-verified stt_parity.py: POST /route/job {audio_url, candidates "en,kn,hi,ta,te,ml,mr,bn", translate false, window_s 180},
poll GET /route/job/<id> every 5 s until state done|failed. The audio is served from a LOOPBACK http server on the node (the node holds no R2 key). Text is written only to --out (0600); stdout has
state/elapsed/counts only. The audio file is deleted afterwards. Exit 0 = job ran (done or failed, see the JSON); nonzero = harness error.
  node_route.py --router http://127.0.0.1:8283 --audio /path/w.webm --out /path/result.json [--timeout 1800]
  node_route.py --selftest    (stub router, no real service)"""
import argparse, functools, http.server, json, os, shutil, socketserver, sys, tempfile, threading, time
import requests

CANDIDATES = "en,kn,hi,ta,te,ml,mr,bn"

def serve(directory):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    class Q(handler.func): 
        def log_message(self, *a): pass
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), functools.partial(Q, directory=directory)); srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

def run_job(router, audio_url, timeout=1800, poll_s=5, translate=False):
    t0 = time.time()
    r = requests.post(router.rstrip("/") + "/route/job", json={"audio_url": audio_url, "candidates": CANDIDATES, "translate": bool(translate), "window_s": 180}, timeout=30)
    if r.status_code >= 400: return {"ok": False, "error": f"submit_http_{r.status_code}"}, time.time() - t0
    jid = r.json().get("job_id")
    if not jid: return {"ok": False, "error": "no_job_id"}, time.time() - t0
    while time.time() - t0 < timeout:
        time.sleep(poll_s)
        try: j = requests.get(f"{router.rstrip('/')}/route/job/{jid}", timeout=30).json()
        except Exception as e: j = {"ok": False, "error": f"poll_{type(e).__name__}"}   # a transient poll error is retried until the timeout
        if j.get("state") in ("done", "failed"): return j, time.time() - t0
    return {"ok": False, "error": f"timeout_{timeout}s"}, time.time() - t0

def main(a, poll_s=5):
    d = tempfile.mkdtemp(prefix="histwin-"); os.chmod(d, 0o700)
    name = "w" + os.path.splitext(a.audio)[1]; shutil.copy(a.audio, os.path.join(d, name)); os.chmod(os.path.join(d, name), 0o600)
    srv = serve(d)
    try:
        j, el = run_job(a.router, f"http://127.0.0.1:{srv.server_address[1]}/{name}", a.timeout, poll_s, getattr(a, "translate", False))
    finally:
        srv.shutdown(); shutil.rmtree(d, ignore_errors=True)
        try: os.unlink(a.audio)          # the window is patient voice: deleted whatever happened
        except OSError: pass
    ok = j.get("state") == "done"
    with open(a.out + ".tmp", "w") as f: json.dump({"ok": ok, "elapsed_s": round(el, 1), "router": a.router, "result": j}, f, ensure_ascii=False)
    os.chmod(a.out + ".tmp", 0o600); os.replace(a.out + ".tmp", a.out)
    print(json.dumps({"ok": ok, "state": j.get("state"), "error": (j.get("error") or "")[:80] or None, "elapsed_s": round(el, 1),
                      "chars": len(j.get("transcript_native") or ""), "segments": len(j.get("segments") or [])}))
    return 0

def selftest():
    calls = {"n": 0, "body": None, "fetched": None}
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def _j(self, o, code=200):
            b = json.dumps(o).encode(); self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
        def do_POST(self):
            calls["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"]))); calls["fetched"] = requests.get(calls["body"]["audio_url"], timeout=5).content[:4]
            self._j({"ok": True, "job_id": "j1"})
        def do_GET(self):
            calls["n"] += 1
            self._j({"ok": True, "state": "running"} if calls["n"] < 2 else {"ok": True, "state": "done", "transcript_native": "synthetic text", "segments": [1, 2], "language_timeline": {"spans": []}})
    stub = socketserver.TCPServer(("127.0.0.1", 0), H); threading.Thread(target=stub.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory() as t:
        audio = os.path.join(t, "w.webm"); open(audio, "wb").write(b"RIFFfake"); out = os.path.join(t, "r.json")
        ns = argparse.Namespace(router=f"http://127.0.0.1:{stub.server_address[1]}", audio=audio, out=out, timeout=30)
        main(ns, poll_s=0.2)
        b = calls["body"]; r = json.load(open(out))
        assert b["translate"] is False and b["candidates"] == CANDIDATES and b["window_s"] == 180, b      # the DEFAULT is untouched
        assert calls["fetched"] == b"RIFF", "the router must be able to fetch the audio from the loopback server"
        assert r["ok"] and r["result"]["transcript_native"] == "synthetic text" and oct(os.stat(out).st_mode & 0o777) == "0o600"
        assert not os.path.exists(audio), "the window must be deleted after the job"
        audio2 = os.path.join(t, "w2.webm"); open(audio2, "wb").write(b"RIFFfake"); calls["n"] = 0
        main(argparse.Namespace(router=f"http://127.0.0.1:{stub.server_address[1]}", audio=audio2, out=os.path.join(t, "r2.json"), timeout=30, translate=True), poll_s=0.2)
        assert calls["body"]["translate"] is True and calls["body"]["candidates"] == CANDIDATES and calls["body"]["window_s"] == 180, calls["body"]      # only translate changes
    stub.shutdown(); print("selftest OK: production request shape (and --translate flips only that field), audio fetched over loopback, polled to done, result 0600, window deleted")

if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest()
    else:
        p = argparse.ArgumentParser(); p.add_argument("--router", required=True); p.add_argument("--audio", required=True); p.add_argument("--out", required=True); p.add_argument("--timeout", type=int, default=1800); p.add_argument("--translate", action="store_true", help="ask the router for transcript_english in the same pass (default OFF = the production room-window shape)")
        sys.exit(main(p.parse_args()))
