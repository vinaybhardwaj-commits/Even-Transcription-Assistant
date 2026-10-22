"""ubus_bus.py -- router bus over ubus (Phase 0 build; the C4 template posts to the eta-bus). Same interface as router_relay.RouterBus:
post(subject, body, priority, thread_id), thread_messages(thread_id) -> [{"from","subject","body"}], close().
Talks to the ubus stdio MCP shim as handle room-guardian, session h:room-guardian (FR1 D7-2: the session of the existing live row, so
nothing is renamed; set, never inherited; checked with ubus_whoami before anything is sent). thread_messages raises UbusDenied on forbidden / not_registered. Routing (to, ackers, test label, wake) comes from etc/router.json, read on every
construction, so switching from TEST routing to production routing needs no restart. Metadata only is logged, never subject or body text."""
import hashlib, json, os, select, subprocess, time

HOME = os.environ.get("GUARDIAN_HOME", os.path.expanduser("~/oc/fleet-access/guardian"))
SHIM = os.environ.get("UBUS_MCP", os.path.expanduser("~/.local/ubus-mcp/bin/ubus-mcp"))
HANDLE = os.environ.get("UBUS_HANDLE_NAME", "room-guardian")
MACHINE = os.environ.get("UBUS_MACHINE") or __import__("socket").gethostname().split(".")[0].lower()   # ubus machine label; no host name in code (G7)
PRIO = {"urgent": "high", "high": "high", "normal": "normal", "low": "low"}   # ubus_send enum is low|normal|high


SESSION, RUNTIME, OWNER, ORCHESTRATOR = "h:room-guardian", "other", "fable", "guardian-lead"   # FR1 D7-2: the live row's session; a fixed session makes the shim identity deterministic (no hook cache read)


class UbusError(Exception):
    pass


class UbusIdentityError(UbusError):
    """ubus_whoami did not answer handle room-guardian, registered, or ubus_register was refused. Nothing is sent; the router raises the ROUTER SILENT line."""
    def __init__(self, handle, registered=None):
        if registered is None:
            # FR1 D7-3: a register failure or other identity fault, handle is already the reason string
            self.identity = str(handle)[:80]
            super().__init__(self.identity)
        else:
            # a whoami mismatch
            self.identity = str(handle)[:60]
            super().__init__(f"identity {self.identity}" + (" registered=false" if registered is False else ""))
        self.registered = registered


class UbusDenied(UbusError):
    """ubus answered forbidden or not_registered for a read. The router counts it as "no ack yet" and backs that case off."""
    denied = True


def shim_env(base=None):
    """The shim's environment: the caller's, minus herdr and Claude Code markers, with the five identity vars set unconditionally (never inherited)."""
    env = {k: v for k, v in (os.environ if base is None else base).items() if not k.startswith("HERDR") and k != "CLAUDECODE"}
    env.update({"UBUS_HANDLE": HANDLE, "UBUS_SESSION": SESSION, "UBUS_RUNTIME": RUNTIME, "UBUS_OWNER": OWNER, "UBUS_ORCHESTRATOR": ORCHESTRATOR})
    return env


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
        self.p = subprocess.Popen([SHIM], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=shim_env(), text=True)
        self.timeout, self.n = timeout, 0
        try:
            self._rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "room-guardian", "version": "1"}})
            self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})
            try:
                self._tool("ubus_register", {"handle": HANDLE, "machine": MACHINE, "runtime": RUNTIME, "session": SESSION, "owner": OWNER, "orchestrator": ORCHESTRATOR})
            except UbusError as e:
                # FR1 D7-3: a refused or failed register is an identity fault
                raise UbusIdentityError(f"register {str(e)[:80]}")
            got = self._tool("ubus_whoami", {})
            who = got.get("handle") if isinstance(got, dict) else None
            self.identity = {"handle": who, "registered": got.get("registered") if isinstance(got, dict) else None}
            if who != HANDLE or self.identity["registered"] is False:   # FR1 D7: never send under another name (the 22 Oct ubus-refuter twin), nor unregistered
                raise UbusIdentityError(who, self.identity["registered"])
        except Exception:
            self.close()
            raise

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
            if "forbidden" in str(e) or "not_registered" in str(e):   # a thread this handle is not a party to, or a lost registration: the router counts it as no ack yet
                raise UbusDenied(str(e)[:200])
            raise

    def close(self):
        try:
            self.p.stdin.close(); self.p.terminate(); self.p.wait(timeout=5)
        except Exception:
            pass
