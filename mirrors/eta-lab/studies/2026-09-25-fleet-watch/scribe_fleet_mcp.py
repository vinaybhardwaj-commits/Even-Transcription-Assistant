#!/usr/bin/env python3
"""scribe_fleet_mcp.py — "scribe-fleet": a small LOCAL stdio MCP server (Fable ruling 401 G0). It ALONE holds the Scribe read token (read from its file by kit/clip_fetch_mcp.py at call time; never in argv, env,
config text, logs or replies). OpenCode is given THIS server and never the remote Scribe MCP, so the LLM never holds the token and can only reach what is allowed here:
  scribe_rooms (view list|now|fleet, detail summary), scribe_system (map|stores|stt_engines|stt_routing|stt_tripwires, detail summary), scribe_health (aspect all only),
  scribe_sessions (view list only; NOT replay). scribe_session_tape is REFUSED ENTIRELY (ruling 402: its manifest returns presigned audio links on the read scope; the WRAPPER alone reads it, for the exact-zero rule).
Every include_* argument is refused when truthy and dropped otherwise (so it is false on the door); any other argument not listed for the tool is refused. Every reply is SCRUBBED before it leaves:
presigned_get / any *url* key, label, mic_label, notes, payload keys and any string value that looks like a URL are removed (the READ-scope session manifest returns 1-hour presigned audio links: found 25 Sep).
MCP over stdio, newline-delimited JSON-RPC 2.0 (protocol 2024-11-05): initialize, notifications/initialized, ping, tools/list, tools/call.
"""
import datetime as dt, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "..", "kit")]

ALLOW = {
    "scribe_rooms": {"args": {"view", "detail", "room", "room_id", "room_slug", "ist_date"}, "enums": {"view": {"list", "now", "fleet"}, "detail": {"summary"}}, "required": {"view"},
                     "doc": "Rooms, read-only: view=list (room list), now (per-room now-picture: recording, last piece, kiosk flags), fleet (per-room recorder facts: app version, mic/device state, flags)."},
    "scribe_system": {"args": {"view", "detail", "days", "engine"}, "enums": {"view": {"map", "stores", "stt_engines", "stt_routing", "stt_tripwires"}, "detail": {"summary"}}, "required": {"view"},
                      "doc": "System facts, read-only: map, stores, stt_engines, stt_routing, stt_tripwires."},
    "scribe_health": {"args": {"aspect"}, "enums": {"aspect": {"all"}}, "required": set(), "doc": "Health probes, read-only (aspect all only). The all/stt probes run a real whisper call: do not call more than once per 15 minutes."},
    "scribe_sessions": {"args": {"view", "ist_date", "limit", "room_id", "room_slug", "status"}, "enums": {"view": {"list"}, "status": {"recording", "paused", "ended"}}, "required": {"view"},
                        "doc": "Bench sessions list, read-only (no replay)."},
}
DROP_KEYS = {"presigned_get", "label", "mic_label", "notes", "payload", "payloads", "operator_notes"}

# PER-VIEW FIELD ALLOWLISTS (ruling 402 / refuter-2 C1): only the fields named here reach the model; anything else, including a renamed or NEW field, is dropped (fail closed). Generated from live field NAMES by
# gen_field_specs.py (names and types only) with free-text, identity, cue and link-shaped names denied. True = pass the value (a scalar or a list of scalars; a nested object under a True leaf is dropped); {..} / [..] = descend.
FIELD_SPECS = json.loads('''{"scribe_health:all": {"brain": {"config": {"db_env_set": true, "missing": true, "token_env_set": true, "ws_available": true}, "db": {"latency_ms": true, "ok": true}, "now": true, "ok": true, "service": true, "version": true}, "listeners": [{"age_ms": true, "last_poll_at": true, "listening": true, "name": true, "paused": true, "recording": true, "recording_session_id": true, "room_id": true}], "now": true, "ok": true, "pyannote": {"configured": true, "device": true, "latency_ms": true, "models": [{"<scalar>": true}], "ok": true}, "region": true, "service_pools": {"configured": [{"<scalar>": true}], "invalid": true}, "services": {"app_db": {"latency_ms": true, "ok": true}, "kb_db": {"latency_ms": true, "ok": true}, "ollama": {"latency_ms": true, "ok": true}, "r2": {"latency_ms": true, "ok": true}, "resend": {"latency_ms": true, "ok": true}, "whisper": {"age_s": true, "cached": true, "checked_at": true, "latency_ms": true, "ok": true, "probe_ms": true, "transcription": true}}, "sha": true, "stt": {"engines": [{"display_name": true, "enabled": true, "fanout_enabled": true, "id": true, "latency_ms": true, "ok": true, "virtual": true}]}}, "scribe_rooms:fleet": {"now": true, "rooms": [{"assigned_pending": true, "disk_level": true, "install": {"app_version": true, "assigned_channel": true, "build_sha": true, "channel_locked": true, "install_id": true, "last_seen_at": true, "mic_state": true, "session_open": true, "state_flags": true, "update_channel": true}, "not_delivering_minutes": true, "room": {"id": true, "name": true}, "state": true, "version_hint": true}]}, "scribe_rooms:list": {"rooms": [{"created_at": true, "enabled": true, "id": true, "last_session_at": true, "last_session_status": true, "name": true}]}, "scribe_rooms:now": {"freshness_window_ms": true, "ist_date": true, "rooms": [{"flags": {"ended_at_lies": true, "kiosk_not_listening": true, "stalled": true, "tape_without_cues": true}, "last_piece_at": true, "listener_state": true, "not_delivering_minutes": true, "page_open": true, "paused_disagrees": true, "paused_listener": true, "paused_session": true, "recording": true, "recording_session_id": true, "room": {"id": true, "name": true}, "room_state": {"drift_since": true, "flags": true, "level": true, "start_available": true, "state": true}, "stalled_age_ms": true, "tape_lane": {"enabled": true, "level": true}}], "stall_window_minutes": true}, "scribe_sessions:list": {"sessions": [{"backup_chunk_count": true, "backup_verified_count": true, "chunk_count": true, "ended_at": true, "gap_count": true, "gap_ms": true, "id": true, "last_any_chunk_at": true, "last_chunk_at": true, "primary_lost_count": true, "primary_restored_count": true, "room_id": true, "room_name": true, "started_at": true, "status": true, "total_bytes": true, "verified_count": true}]}, "scribe_system:map": {"flags": {"NEXT_PUBLIC_ETA_AUDIO_WATCHDOG": true, "NEXT_PUBLIC_ETA_BACKGROUND_PROCESSING": true, "NEXT_PUBLIC_ETA_DEEPGRAM_RECONNECT": true, "NEXT_PUBLIC_ETA_HEADER_GUARD": true, "NEXT_PUBLIC_ETA_INDIC_LIVE_BOX": true, "NEXT_PUBLIC_ETA_LANG_ROUTER": true, "NEXT_PUBLIC_ETA_LIVE_FLASH": true, "NEXT_PUBLIC_ETA_LIVE_SINK": true, "NEXT_PUBLIC_ETA_MIC_PREFLIGHT": true, "NEXT_PUBLIC_ETA_NOTEGEN": true, "NEXT_PUBLIC_ETA_SAFARI_STREAMING_GUARD": true, "NEXT_PUBLIC_ETA_TRIM_LIVE_BUFFERS": true}, "health": {"brain": {"config": {"db_env_set": true, "missing": true, "token_env_set": true, "ws_available": true}, "db": {"latency_ms": true, "ok": true}, "now": true, "ok": true, "service": true, "version": true}, "listeners": [{"age_ms": true, "last_poll_at": true, "listening": true, "name": true, "paused": true, "recording": true, "recording_session_id": true, "room_id": true}], "now": true, "ok": true, "pyannote": {"configured": true, "device": true, "latency_ms": true, "models": [{"<scalar>": true}], "ok": true}, "region": true, "service_pools": {"configured": [{"<scalar>": true}], "invalid": true}, "services": {"app_db": {"latency_ms": true, "ok": true}, "kb_db": {"latency_ms": true, "ok": true}, "ollama": {"latency_ms": true, "ok": true}, "r2": {"latency_ms": true, "ok": true}, "resend": {"latency_ms": true, "ok": true}, "whisper": {"age_s": true, "cached": true, "checked_at": true, "latency_ms": true, "ok": true, "probe_ms": true, "transcription": true}}, "sha": true, "stt": {"engines": [{"display_name": true, "enabled": true, "fanout_enabled": true, "id": true, "latency_ms": true, "ok": true, "virtual": true}]}}}, "scribe_system:stores": {"bench": {"chunks_by_upload_state": {"verified": {"bytes": true, "count": true}}, "consult_marks": true, "sessions": true, "sessions_by_status": {"ended": true, "recording": true}}, "brain": {"cues_today": true, "room_days_today": true, "scratch_cues_today": true, "scratch_room_days_today": true}, "encounters": {"today_ist": true, "total": true}, "ist_date": true, "stt": {"engines_enabled": true}}, "scribe_system:stt_engines": {"engines": [{"adapter_key": true, "capabilities_json": {"async": true, "languages": [{"<scalar>": true}], "stages": [{"<scalar>": true}], "streaming": true, "tiers": [{"<scalar>": true}], "translates": true}, "cost_per_min_usd": true, "display_name": true, "enabled": true, "fanout_enabled": true, "id": true, "is_paid": true, "sort_order": true}]}, "scribe_system:stt_routing": {"buckets": [{"<scalar>": true}], "engines": [{"capabilities_json": {"async": true, "languages": [{"<scalar>": true}], "stages": [{"<scalar>": true}], "streaming": true, "tiers": [{"<scalar>": true}], "translates": true}, "display_name": true, "enabled": true, "id": true}], "routing": [{"engine_id": true, "language_bucket": true, "stage": true, "updated_at": true}], "stages": [{"<scalar>": true}]}, "scribe_system:stt_tripwires": {"days": true, "engines": [{"audio_seconds": true, "chars": true, "chars_per_audio_second": true, "empty_runs": true, "empty_transcript_rate": true, "engine": true, "engine_mix": {"indicconformer": true, "sravaani": true, "whisper": true}, "errors": true, "language_mix": {"bn": true, "en": true, "gu": true, "hi": true, "kn": true, "ml": true, "mr": true, "pa": true, "ta": true, "te": true, "und": true}, "runs": true, "runs_with_timeline": true, "spans": true}]}}''')


def view_key(name, args):
    if name == "scribe_health":
        return "scribe_health:" + args.get("aspect", "all")
    return name + ":" + args["view"]


def project(o, sp):
    """Keep only what the allowlist names. Dict spec: named keys only. List spec: apply to each element. True: scalars and lists of scalars only."""
    if sp is True:
        if isinstance(o, (str, int, float, bool)) or o is None:
            return o
        if isinstance(o, list):
            return [x for x in o if isinstance(x, (str, int, float, bool)) or x is None]
        return None
    if isinstance(sp, dict):
        return {k: project(o[k], v) for k, v in sp.items() if isinstance(o, dict) and k in o}
    if isinstance(sp, list):
        return [project(x, sp[0]) for x in o] if isinstance(o, list) else []
    return None


def paths(o, p=""):
    """Field NAMES only (never values) of a projected reply, for the proxy's own log."""
    if isinstance(o, dict):
        for k, v in o.items():
            yield from paths(v, p + "." + k)
    elif isinstance(o, list):
        for x in o[:1]:
            yield from paths(x, p + "[]")
    else:
        yield p.lstrip(".")


def log_fields(key, data):
    d = os.environ.get("FLEET_WATCH_HOME", os.path.expanduser("~/fleet-watch"))
    try:
        with open(os.path.join(d, "proxy-fields.jsonl"), "a") as f:
            f.write(json.dumps({"ts": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "view": key, "fields": sorted(set(paths(data)))}) + "\n")
    except Exception:
        pass


_SIMPLE = re.compile(r"^[A-Za-z0-9 _.:\-]{1,80}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def typed_ok(k, v):
    """Free-typed arguments must be plain strings/ints of a simple shape: a dict, list, bool or an odd string is refused, never forwarded."""
    if k in ("days", "limit"):
        return isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 200
    if k == "ist_date":
        return isinstance(v, str) and bool(_DATE.match(v))
    if k == "session_id":
        return isinstance(v, str) and bool(_SIMPLE.match(v))
    return isinstance(v, str) and bool(_SIMPLE.match(v))       # room, room_id, room_slug, engine


def check_call(name, args):
    """-> (ok, cleaned_args | reason)."""
    spec = ALLOW.get(name)
    if spec is None:
        return False, "tool %s is not available" % name
    if not isinstance(args, dict):
        return False, "arguments must be an object"
    out = {}
    for k, v in args.items():
        if k.lower().startswith("include_"):
            if v:
                return False, "%s is not allowed" % k
            continue                                    # a false include_* is dropped: the door default is false
        if k not in spec["args"]:
            return False, "argument %s is not allowed for %s" % (k, name)
        if k in spec["enums"] and v not in spec["enums"][k]:
            return False, "%s=%r is not allowed for %s" % (k, v, name)
        if k not in spec["enums"] and not typed_ok(k, v):
            return False, "argument %s has a value of the wrong type or shape" % k
        out[k] = v
    missing = spec["required"] - set(out)
    if missing:
        return False, "missing argument(s): %s" % ", ".join(sorted(missing))
    return True, out


def scrub(o):
    if isinstance(o, dict):
        return {k: scrub(v) for k, v in o.items() if k not in DROP_KEYS and "url" not in k.lower()}
    if isinstance(o, list):
        return [scrub(x) for x in o]
    if isinstance(o, str):
        o = re.sub(r"https?://\S+", "[url removed]", o, flags=re.I)         # an embedded link anywhere in a string is removed too
        o = re.sub(r"(?i)\S*(://|x-amz|signature=|[?&;]sig=|\bsig=|r2\.cloudflarestorage|amazonaws|presign)\S*", "[url removed]", o)
        o = re.sub(r"(?i)(^|\s)//\S+|\bdata:\S+|\S*[?&;](signature|sig|token|expires|awsaccesskeyid|access_token|key)=\S*", lambda m: (m.group(1) or "") + "[url removed]", o)   # //host/..., data: URIs, any signed/token query
        return o
    return o


def tool_list():
    tools = []
    for n, s in ALLOW.items():
        props = {}
        for a in sorted(s["args"]):
            p = {"type": "integer"} if a in ("days", "limit") else {"type": "string"}
            if a in s["enums"]:
                p["enum"] = sorted(s["enums"][a])
            props[a] = p
        tools.append({"name": n, "description": s["doc"], "inputSchema": {"type": "object", "properties": props, "required": sorted(s["required"]), "additionalProperties": False}})
    return tools


def handle(msg, call):
    """One JSON-RPC message -> response dict or None (notification). call(name, args) -> dict is the read-only door."""
    mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if mid is None:
        return None
    def ok(r): return {"jsonrpc": "2.0", "id": mid, "result": r}
    def err(c, m): return {"jsonrpc": "2.0", "id": mid, "error": {"code": c, "message": m}}
    if method == "initialize":
        return ok({"protocolVersion": params.get("protocolVersion", "2024-11-05"), "capabilities": {"tools": {}}, "serverInfo": {"name": "scribe-fleet", "version": "1"}})
    if method == "ping":
        return ok({})
    if method == "tools/list":
        return ok({"tools": tool_list()})
    if method == "tools/call":
        good, res = check_call(params.get("name"), params.get("arguments") or {})
        if not good:
            return ok({"content": [{"type": "text", "text": "refused: " + res}], "isError": True})
        try:
            key = view_key(params["name"], res)
            sp = FIELD_SPECS.get(key)
            if sp is None:
                return ok({"content": [{"type": "text", "text": "refused: no field allowlist for " + key}], "isError": True})
            data = scrub(project(call(params["name"], res), sp)); log_fields(key, data)
        except Exception as ex:
            return ok({"content": [{"type": "text", "text": "door error: %s" % type(ex).__name__}], "isError": True})
        return ok({"content": [{"type": "text", "text": json.dumps(data, separators=(",", ":"))}], "isError": False})
    return err(-32601, "method not found")


def main():
    import clip_fetch_mcp
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            resp = handle(json.loads(line), clip_fetch_mcp.call)
        except Exception:
            resp = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
        if resp is not None:
            sys.stdout.write(json.dumps(resp, separators=(",", ":")) + "\n"); sys.stdout.flush()


if __name__ == "__main__":
    main()
