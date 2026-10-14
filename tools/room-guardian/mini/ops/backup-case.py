#!/usr/bin/env python3
"""backup-case.py open|close -- opens or closes the `backup_failed` case (room `mini`) in the alert case store. Never touches the bus: the router
job pages within one tick. Called by pgdump.sh. Usage: backup-case.py open | close"""
import os, sys, time
HOME = os.environ.get("GUARDIAN_HOME", os.path.expanduser("~/oc/fleet-access/guardian"))
sys.path.insert(0, os.path.join(HOME, "app", "router"))
import alert_router

store = alert_router.default_store(HOME)
router = alert_router.Router(store, None, time.time)
if sys.argv[1:] == ["open"]:
    router.on_row(None, {"id": store.alloc_local_id(), "kind": "backup_failed", "room_ids": ["mini"], "room_name": "mini (nightly pg_dump)"})
elif sys.argv[1:] == ["close"]:
    router.close_room(None, "mini", "backup ok", kind="backup_failed")
else:
    sys.exit("usage: backup-case.py open|close")
