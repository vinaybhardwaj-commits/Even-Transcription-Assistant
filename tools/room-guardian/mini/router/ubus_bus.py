"""ubus_bus.py -- router bus over ubus (Phase 0 build; the C4 template posts to the eta-bus). Same interface as router_relay.RouterBus:
post(subject, body, priority, thread_id), thread_messages(thread_id) -> [{"from","subject","body"}], close().
Talks to the ubus stdio MCP shim as handle room-guardian. Routing (to, ackers, test label, wake) comes from etc/router.json, read on every
construction, so switching from TEST routing to production routing needs no restart. Metadata only is logged, never subject or body text."""
import hashlib, json, os, select, subprocess, time

HOME = os.environ.get("GUARDIAN_HOME", os.path.expanduser("~/oc/fleet-access/guardian"))
SHIM = os.environ.get("UBUS_MCP", os.path.expanduser("~/.local/ubus-mcp/bin/ubus-mcp"))
HANDLE = os.environ.get("UBUS_HANDLE_NAME", "room-guardian")
MACHINE = os.environ.get("UBUS_MACHINE") or __import__("socket").gethostname().split(".")[0].lower()   # ubus machine label; no host name in code (G7)
PRIO = {"urgent": "high", "high": "high", "normal": "normal", "low": "low"}   # ubus_send enum is low|normal|high


class UbusError(Exception):
    pass


def load_cfg(path=None):
    path = path or os.path.join(HOME, "etc", "router.json")
    with open(path) as f:
        c = json.load(f)
    cfg = {"to": list(c["to"]), "ackers": list(c["ackers"]), "subject_prefix": str(c.get("subject_prefix", "")), "wake": bool(c.get("wake", False)),
           # FR1 2.4 d' (all default off / empty; only a literal true turns a flag on)
           "consult_open_publish": c.get("consult_open_publish") is True, "start_day_after_boot": c.get("start_day_after_boot") is True,
           "capture_closed_counts_quiet": c.get("capture_closed_counts_quiet") is not False, "open_session_requires_levels": c.get("open_session_requires_levels") is not False, "consult_windows_enabled": c.get("consult_windows_enabled") is True, "post_open_overrides_url_close": c.get("post_open_overrides_url_close") is not False,   # fable 17:16: default true
           "consult_room_map": dict(c["consult_room_map"]) if isinstance(c.get("consult_room_map"), dict) else {},
           "consult_db_url_file": c.get("consult_db_url_file") if isinstance(c.get("consult_db_url_file"), str) else None,
           "start_day_cmd": [str(a) for a in c["start_day_cmd"]] if isinstance(c.get("start_day_cmd"), list) else []}
    stray = sorted(set(cfg["ackers"]) - set(cfg["to"]))
    if stray:    # gate C2: an acker who never receives the page cannot see the instruction to ack; refuse the whole config
        raise ValueError(f"router.json: ackers not in to: {', '.join(stray)}")
    return cfg


class UbusBus:
    def __init__(self, cfg=None, timeout=30):
        self.cfg = cfg or load_cfg()
        env = {k: v for k, v in os.environ.items() if not k.startswith("HERDR") and k != "CLAUDECODE"}
        env["UBUS_HANDLE"] = HANDLE
        self.p = subprocess.Popen([SHIM], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True)
        self.timeout, self.n = timeout, 0
        self._rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "room-guardian", "version": "1"}})
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self._tool("ubus_register", {"handle": HANDLE, "machine": MACHINE, "runtime": "other", "owner": "fable", "orchestrator": "herdr-lead"})

    def _send(self, o):
        self.p.stdin.write(json.dumps(o) + "\n"); self.p.stdin.flush()

    def _rpc(self, method, params):
        self.n += 1; rid = self.n
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        end = time.time() + self.timeout
        while time.time() < end:
            r, _, _ = select.select([self.p.stdout], [], [], 1)
            if not r:
                continue
            line = self.p.stdout.readline()
            if not line:
                raise UbusError("ubus shim closed")
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if o.get("id") == rid:
                if "error" in o:
                    raise UbusError(str(o["error"])[:200])
                return o["result"]
        raise UbusError(f"ubus call {method} timed out")

    def _tool(self, name, args):
        res = self._rpc("tools/call", {"name": name, "arguments": args})
        text = (res.get("content") or [{}])[0].get("text", "")
        if res.get("isError"):
            raise UbusError(f"{name}: {text[:200]}")
        try:
            out = json.loads(text)
        except ValueError:
            raise UbusError("non-JSON reply")
        if isinstance(out, dict) and out.get("ok") is False:
            raise UbusError(f"{name}: {str(out.get('error', 'refused'))[:200]}")
        return out

    def post(self, subject, body, priority, thread_id):
        subject = (self.cfg["subject_prefix"] + subject)[:200]
        key = hashlib.sha256(f"{thread_id}\n{subject}\n{body}".encode()).hexdigest()[:40]   # identical message twice (crash replay) is one send; batch subjects repeat, bodies differ
        self._tool("ubus_send", {"handle": HANDLE, "to": self.cfg["to"], "subject": subject, "body": body, "thread_id": thread_id,
                                 "priority": PRIO.get(priority, "normal"), "wake": self.cfg["wake"], "idempotency_key": key})

    def thread_messages(self, thread_id):
        try:
            return self._tool("ubus_thread", {"handle": HANDLE, "thread_id": thread_id}).get("messages", [])
        except UbusError as e:
            if "forbidden" in str(e):          # ubus answers "forbidden" for a thread this handle is not yet a party to (none exists): no messages
                return []
            raise

    def close(self):
        try:
            self.p.stdin.close(); self.p.terminate(); self.p.wait(timeout=5)
        except Exception:
            pass
