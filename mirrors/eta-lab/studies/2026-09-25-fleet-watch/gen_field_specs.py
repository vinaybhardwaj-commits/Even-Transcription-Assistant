#!/usr/bin/env python3
"""gen_field_specs.py — builds the proxy's per-view FIELD ALLOWLISTS from live field-NAME trees (names and types only, never values; ~/fleet-watch/field-trees.json written by a names-only probe).
A key is dropped at generation time if its NAME is free-text/identity/link-shaped (DENY) or contains 'url'. The result is pasted into scribe_fleet_mcp.py as an explicit literal, so a reviewer reads exactly what passes.
usage: gen_field_specs.py [field-trees.json]   -> prints the FIELD_SPECS literal"""
import json, os, sys
DENY = {"slug", "label", "mic_label", "notes", "text", "transcript", "payload", "payloads", "last_cue", "cue", "error", "home", "base_url_env", "operator_notes", "blob_url", "presigned_get", "tab_id", "mic_status", "room_slug", "include_scratch", "releases", "env_set", "hint", "input_device_name", "published_by"}
DENY_PATHS = {"tape_lane.state"}   # generated free-form string; unclassified stays off until scribe clears it
KEEP_TOP = {"scribe_rooms:list", "scribe_rooms:now", "scribe_rooms:fleet", "scribe_system:map", "scribe_system:stores", "scribe_system:stt_engines", "scribe_system:stt_routing", "scribe_system:stt_tripwires",
            "scribe_health:all", "scribe_sessions:list"}

def spec(t, path=""):
    if isinstance(t, dict):
        return {k: spec(v, (path + "." + k).lstrip(".")) for k, v in t.items() if k not in DENY and "url" not in k.lower() and not any((path + "." + k).lstrip(".").endswith(d) for d in DENY_PATHS)}
    if isinstance(t, list):
        e = t[0] if t else "<empty>"
        return [spec(e, path + "[]")] if isinstance(e, dict) else True
    return True

trees = json.load(open(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/fleet-watch/field-trees.json")))
out = {k: spec(v) for k, v in trees.items() if k in KEEP_TOP and isinstance(v, (dict, list))}
print(json.dumps(out, indent=None, sort_keys=True))
