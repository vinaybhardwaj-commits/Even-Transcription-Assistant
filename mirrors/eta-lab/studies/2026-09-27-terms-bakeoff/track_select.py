"""STEP 3 track selection: pick a window's track for (engine, config_hash) by latest status=ok, NOT by version,
so a reviewed v2 retry of a failed v1 track (eta-refuter-2 #7070) is what gets read."""


def select_latest_ok(manifest, layer, engine, config_hash):
    ok = [t for t in manifest.get("tracks", [])
          if (t.get("layer"), t.get("engine"), t.get("config_hash")) == (layer, engine, config_hash)
          and t.get("status") == "ok"]
    return max(ok, key=lambda t: (t.get("finished_at") or "", t.get("version") or ""), default=None)
