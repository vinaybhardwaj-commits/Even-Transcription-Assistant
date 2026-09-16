#!/usr/bin/env python3
"""A local stand-in for the EvenScribe Bench, for dry-running room-bench end to end with no server and no token.

    tools/bench-stub.py PORT STATE_DIR

It speaks the endpoints room-bench uses, with the shapes INFERRED from the Mac source — so it proves room-bench is
self-consistent with that inference, NOT that the inference matches the live server. Control endpoints:

    POST /_stub/enqueue   {"id": ..., "kind": ..., "args": ...}   queue a command for the next poll
    POST /_stub/fail-ack  {"id": ..., "times": N}                 answer that command's next N acks with 500
    POST /_stub/retire                                            answer every later poll 409 RETIRED
    GET  /_stub/state                                             everything the stub saw, as JSON

Uploaded media is written to STATE_DIR/objects/<key>.webm. It holds only what room-bench sent the stub.
"""
import json
import os
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1])
STATE_DIR = sys.argv[2]
BOOTSTRAP = "BOOT-DRY-RUN"
SESSION_TOKEN = "stub-session-token"
os.makedirs(os.path.join(STATE_DIR, "objects"), exist_ok=True)

lock = threading.Lock()
state = {
    "enrols": 0, "polls": [], "acks": [], "commands": [], "sessions": {}, "patches": [], "presigns": [], "puts": [],
    "heads": [], "chunks": [], "fail_ack": {}, "retired": False, "unauthenticated": 0,
}
delivered_unacked = {}


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send(self, status, body=None, headers=None):
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def authed(self):
        ok = self.headers.get("Cookie") == f"eta_room_session={SESSION_TOKEN}"
        if not ok:
            state["unauthenticated"] += 1
            self.send(401, {"error": {"code": "UNAUTHENTICATED", "message": "no session"}})
        return ok

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(url.query))
        with lock:
            if url.path == "/_stub/state":
                return self.send(200, state)
            if not self.authed():
                return
            if url.path == "/api/bench/sessions/active":
                live = [s for s in state["sessions"].values() if s["status"] in ("recording", "paused")]
                if not live:
                    return self.send(200, {"ok": True, "resumable": False, "session": None, "handover_pending": False, "tab_gone": False})
                s = live[-1]
                return self.send(200, {"ok": True, "resumable": True, "session": s, "next_idx": {"primary": s["next_idx"], "backup": 0},
                                       "handover_pending": False, "tab_gone": False})
            if url.path == "/api/bench/commands":
                state["polls"].append(q)
                if state["retired"]:
                    return self.send(409, {"error": {"code": "RETIRED", "message": "superseded by a newer enrolment"}})
                commands = [c for c in state["commands"] if c["id"] not in [a["id"] for a in state["acks"] if a["landed"]]]
                return self.send(200, {"ok": True, "room_id": "room_stub", "now": now_iso(), "commands": commands})
        self.send(404, {"error": {"code": "NOT_FOUND"}})

    def do_HEAD(self):
        url = urllib.parse.urlparse(self.path)
        with lock:
            if url.path.startswith("/store/head/"):
                key = url.path[len("/store/head/"):]
                state["heads"].append(key)
                path = os.path.join(STATE_DIR, "objects", key + ".webm")
                if not os.path.exists(path):
                    return self.send(404)
                return self._head_ok(path)
        self.send(404)

    def _head_ok(self, path):
        self.send_response(200)
        self.send_header("Content-Length", str(os.path.getsize(path)))
        self.end_headers()

    def do_PUT(self):
        url = urllib.parse.urlparse(self.path)
        data = self.body()
        with lock:
            if url.path.startswith("/store/put/"):
                key = url.path[len("/store/put/"):]
                with open(os.path.join(STATE_DIR, "objects", key + ".webm"), "wb") as f:
                    f.write(data)
                state["puts"].append({"key": key, "bytes": len(data), "content_type": self.headers.get("Content-Type"),
                                      "cookie": self.headers.get("Cookie")})
                return self.send(200, {})
        self.send(404)

    def do_PATCH(self):
        url = urllib.parse.urlparse(self.path)
        data = json.loads(self.body() or b"{}")
        with lock:
            if not self.authed():
                return
            if url.path.startswith("/api/bench/sessions/"):
                sid = urllib.parse.unquote(url.path.rsplit("/", 1)[1])
                s = state["sessions"].get(sid)
                if not s:
                    return self.send(404, {"error": {"code": "NO_SESSION"}})
                state["patches"].append({"id": sid, **data})
                s["status"] = {"pause": "paused", "resume": "recording", "end": "ended"}[data["action"]]
                return self.send(200, {"ok": True})
        self.send(404)

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        raw = self.body()
        data = json.loads(raw or b"{}")
        with lock:
            if url.path == "/_stub/enqueue":
                state["commands"].append({"id": data["id"], "kind": data["kind"], "args": data.get("args"), "created_at": now_iso()})
                return self.send(200, {"ok": True})
            if url.path == "/_stub/fail-ack":
                state["fail_ack"][data["id"]] = data["times"]
                return self.send(200, {"ok": True})
            if url.path == "/_stub/retire":
                state["retired"] = True
                return self.send(200, {"ok": True})
            if url.path == "/api/room-recorder/enrol":
                if self.headers.get("Cookie"):
                    return self.send(400, {"error": {"code": "COOKIE_ON_ENROL", "message": "enrol must not carry a session"}})
                if data.get("token") != BOOTSTRAP:
                    return self.send(401, {"error": {"code": "TOKEN_INVALID", "message": "unknown, expired or spent"}})
                state["enrols"] += 1
                return self.send(200, {"install_id": f"inst_stub_{state['enrols']}", "room_slug": "stub-room", "room_name": "Stub Room",
                                       "session": {"token": SESSION_TOKEN, "expires_at": "2027-09-16T00:00:00Z"}})
            if not self.authed():
                return
            if url.path == "/api/bench/sessions":
                sid = f"sess_{len(state['sessions']) + 1}"
                s = {"id": sid, "room_id": "room_stub", "label": data.get("label"), "mic_label": data.get("mic_label"),
                     "status": "recording", "started_at": now_iso(), "next_idx": 0}
                state["sessions"][sid] = s
                return self.send(200, {"session": s})
            if url.path.startswith("/api/bench/commands/") and url.path.endswith("/ack"):
                cid = urllib.parse.unquote(url.path.split("/")[4])
                remaining = state["fail_ack"].get(cid, 0)
                if remaining > 0:
                    state["fail_ack"][cid] = remaining - 1
                    state["acks"].append({"id": cid, "body": data, "landed": False})
                    return self.send(500, {"error": {"code": "STUB_FAIL"}})
                state["acks"].append({"id": cid, "body": data, "landed": True})
                return self.send(200, {"ok": True, "id": cid, "status": "acked" if data.get("ok") else "failed"})
            if url.path == "/api/bench/upload-url":
                state["presigns"].append(data)
                key = f"{data['session_id']}-{data['idx']}"
                base = f"http://127.0.0.1:{PORT}"
                return self.send(200, {"url": f"{base}/store/put/{key}", "head_url": f"{base}/store/head/{key}", "key": key,
                                       "method": "PUT", "content_type": data["content_type"], "expires_in_seconds": 900})
            if url.path == "/api/bench/chunks":
                state["chunks"].append(data)
                s = state["sessions"].get(data["session_id"])
                if s:
                    s["next_idx"] = max(s["next_idx"], data["idx"] + 1)
                key = f"{data['session_id']}-{data['idx']}"
                return self.send(200, {"ok": True, "key": key, "upload_state": "verified"})
        self.send(404, {"error": {"code": "NOT_FOUND"}})


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
