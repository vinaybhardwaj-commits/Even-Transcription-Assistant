"""Set (b) window list for the scored run: every clinical1 stimulus, one window per wav file.

window_id matches reb's real `suite-clinical1` REB room exactly (confirmed by reading
/home/eta/eta-data/reb/2026-09-27/suite-clinical1/'s actual directory listing, ADDENDUM-20/21) - the wav's
basename with the extension stripped, e.g. "clin_en_1", "clin_en_1__babble_snr5". This is what lets the scored
HF Job's output be committed as a NEW track into the SAME live window dev-ingest already wrote whisper-auto/
whisper-cap2/sravaani tracks into, rather than a separate room.
"""
import os

ROOM_ID = "suite-clinical1"
IST_DATE = "2026-09-27"  # reb's real suite-clinical1 room date, confirmed by reading its manifests (ADDENDUM-20)


def list_set_b_windows(stimuli_dir):
    """-> sorted list of {"window_id", "audio_file", "room_id", "ist_date"} dicts, one per *.wav in stimuli_dir.
    audio_file is the bare basename (what must exist under the HF Job's AUDIO_ROOT mount once uploaded) - this
    function only lists what's on local disk, it does not upload anything."""
    if not os.path.isdir(stimuli_dir):
        raise FileNotFoundError(f"set (b) stimuli dir not found: {stimuli_dir}")
    windows = []
    for name in sorted(os.listdir(stimuli_dir)):
        if not name.endswith(".wav"):
            continue
        window_id = name[: -len(".wav")]
        windows.append({
            "window_id": window_id, "audio_file": name,
            "room_id": ROOM_ID, "ist_date": IST_DATE,
        })
    return windows


if __name__ == "__main__":
    import json
    import sys

    stimuli_dir = sys.argv[1] if len(sys.argv) > 1 else "/home/eta/eta-data/diag-rig/stimuli/clinical1"
    windows = list_set_b_windows(stimuli_dir)
    print(json.dumps(windows), file=sys.stdout)
    print(f"# {len(windows)} windows", file=sys.stderr)
