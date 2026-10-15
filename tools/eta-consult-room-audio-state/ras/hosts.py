"""Rooms whose host Mac runs macOS 26 (Voice Isolation can be on). The manifest and kiosk-health rows carry no OS version,
so this is a config list: edit it here. voice_isolation_gated is only emitted for these rooms; the frame statistics are
computed for every room (tools/vi_report.py) so a control-room hit is visible rather than hidden by this list.
OS versions come from FLEET (claude/ETA-MAC26-VOICE-ISOLATION-FIX-07-OCT-2026.md): OPD 4 and OPD 5 are macOS 26."""
MACOS26_ROOMS = {"room_ux92qpws": "OPD 4", "room_4ggnkg5x": "OPD 5"}


def macos26_rooms():
    return set(MACOS26_ROOMS)
