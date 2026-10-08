#!/usr/bin/env python3
"""Re-implementation of RoomSelfTest.swift SelfTestPack.load (apps/room-recorder, rr-0.1.25) plus the limits the build adds.

The Swift loader (all of it, in order): pack.json exists; it parses to a JSON object; pack_version is the Int 1; `stimuli` is a non-empty array of
objects; for EACH entry: id a non-empty string, unique; kind one of tone|sweep|canary|phrase (anything else refuses the whole pack); file a non-empty
string without "/" or ".."; sha256 a 64-char hex string (case-insensitive); the file is readable and its SHA-256 equals sha256. duration_s, lang and truth
are optional and only passed through. Nothing is played from a pack that fails any check.

Beyond the loader (policy, because build-bundle.sh copies `pack.json` + `*.wav` only and AVAudioPlayer plays what it is given): every file ends in .wav and is
RIFF/WAVE PCM s16 mono 16 kHz; duration_s (when present) matches the file within 50 ms; total <= 90 s; at least one of each kind; canary and phrase carry
lang and truth; no .wav sits in the folder that pack.json does not list (it would ship unpinned).
Usage: validate_pack.py <pack_dir>   exit 0 = ok, 1 = refused (reasons on stdout).
"""
import hashlib
import json
import os
import struct
import sys

SUPPORTED_VERSION = 1
KINDS = {"tone", "sweep", "canary", "phrase"}
MAX_TOTAL_S = 90.0
RATE = 16000
HEX = set("0123456789abcdefABCDEF")


def read_wav(data: bytes):
    """-> (channels, rate, bits, frames) or None when it is not a plain PCM RIFF/WAVE."""
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return None
    o, fmt, frames = 12, None, None
    while o + 8 <= len(data):
        cid, size = data[o:o + 4], struct.unpack("<I", data[o + 4:o + 8])[0]
        body = o + 8
        if cid == b"fmt " and size >= 16:
            tag, ch, rate, _, _, bits = struct.unpack("<HHIIHH", data[body:body + 16])
            fmt = (tag, ch, rate, bits)
        elif cid == b"data":
            frames = min(size, len(data) - body)
        o = body + size + (size & 1)
    if not fmt or frames is None or fmt[0] != 1:
        return None
    ch, rate, bits = fmt[1], fmt[2], fmt[3]
    return ch, rate, bits, frames // max(1, ch * bits // 8)


def validate(directory: str, policy: bool = True):
    """-> (errors, stimuli). errors empty = the Swift loader accepts it and (policy=True) the limits hold. policy=False is the loader alone."""
    errs = []
    mp = os.path.join(directory, "pack.json")
    if not os.path.isfile(mp):
        return ["missingPack"], []
    try:
        root = json.load(open(mp, "rb"))
        if not isinstance(root, dict):
            raise ValueError
    except Exception:
        return ["unreadablePack"], []
    v = root.get("pack_version")
    if isinstance(v, bool) or not isinstance(v, int) or v != SUPPORTED_VERSION:
        return [f"unknownPackVersion({v if isinstance(v, int) and not isinstance(v, bool) else -1})"], []
    entries = root.get("stimuli")
    if not isinstance(entries, list) or not entries or not all(isinstance(e, dict) for e in entries):
        return ["emptyPack"], []
    seen, out, total = set(), [], 0.0
    for e in entries:
        i = e.get("id")
        bad = lambda: errs.append(f"badEntry({i if isinstance(i, str) and i else '?'})")
        name, sha, kind = e.get("file"), e.get("sha256"), e.get("kind")
        if not (isinstance(i, str) and i and i not in seen and isinstance(kind, str) and kind in KINDS and isinstance(name, str) and name
                and "/" not in name and ".." not in name and isinstance(sha, str) and len(sha) == 64 and all(c in HEX for c in sha)):
            bad()
            return errs, out  # the Swift loader throws at the first bad entry
        seen.add(i)
        try:
            data = open(os.path.join(directory, name), "rb").read()
        except OSError:
            errs.append(f"hashMismatch({i})")
            return errs, out
        if hashlib.sha256(data).hexdigest() != sha.lower():
            errs.append(f"hashMismatch({i})")
            return errs, out
        out.append(e)
        if not policy:
            continue
        # --- beyond the loader ---
        if not name.endswith(".wav"):
            errs.append(f"policy: {i} file is not .wav (build-bundle.sh copies *.wav only)")
        w = read_wav(data)
        if w is None or w[:3] != (1, RATE, 16):
            errs.append(f"policy: {i} is not PCM s16 mono {RATE} Hz WAV")
        else:
            dur = w[3] / RATE
            total += dur
            d = e.get("duration_s")
            if d is not None and (isinstance(d, bool) or not isinstance(d, (int, float)) or abs(d - dur) > 0.05):
                errs.append(f"policy: {i} duration_s {d} != measured {dur:.3f}")
        if kind in ("canary", "phrase") and not (isinstance(e.get("lang"), str) and e["lang"] and isinstance(e.get("truth"), str) and e["truth"]):
            errs.append(f"policy: {i} ({kind}) needs lang and truth")
    if not policy:
        return errs, out
    if total > MAX_TOTAL_S:
        errs.append(f"policy: total {total:.1f} s > {MAX_TOTAL_S:.0f} s")
    for k in sorted(KINDS - {e["kind"] for e in out}):
        errs.append(f"policy: no {k} stimulus")
    listed = {e["file"] for e in out}
    for f in sorted(os.listdir(directory)):
        if f.endswith(".wav") and f not in listed:
            errs.append(f"policy: {f} is in the folder but not in pack.json (it would ship unpinned)")
    return errs, out


def pack_sha256(directory: str) -> str:
    return hashlib.sha256(open(os.path.join(directory, "pack.json"), "rb").read()).hexdigest()


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    errs, out = validate(argv[1])
    if errs:
        print("REFUSED")
        for e in errs:
            print(" ", e)
        return 1
    print(f"OK {len(out)} stimuli; pack.json sha256 {pack_sha256(argv[1])}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
