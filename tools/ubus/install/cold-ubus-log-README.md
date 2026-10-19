# ubus cold log

This folder is the only durable copy of the ubus archive (D6).

- Volume: `/Volumes/Time Machine`
- Required volume UUID: `06934966-C7D8-4B5B-9326-9C91C0FDADCD`
- Path: `/Volumes/Time Machine/cold/ubus-log/YYYY/MM/DD/`
- Files: `ubus-YYYYMMDD-HH.jsonl` and `MANIFEST-YYYY-MM-DD.json`
- Retention: keep forever. Do not delete, rsync, or copy to a second disk.
- The hot spool on the internal disk is a working buffer. ubus drops spool copies 7 days after a verified flush. It never deletes cold files.

ubus writes here only after `diskutil info -plist` reports that UUID and the volume is writable, and only when `cold_root` is inside the mount. A mismatch or an unmount leaves the segment on the hot spool and alerts `grok:minibot` plus a Mini Ops handoff project `ubus-archive`.

The log holds ids, counts, paths, and hashes. It does not hold message bodies.
