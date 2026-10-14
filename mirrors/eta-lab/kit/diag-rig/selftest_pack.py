#!/usr/bin/env python3
"""Room self-test stimulus PACK (W34.4) for the Room Recorder app's `self_test` bench command. INVENTED speech only, ElevenLabs clips reused from the
frozen cache (no new spend when the digital1 clips exist), 48 kHz mono WAV, every file sha256-pinned in selftest_pack.json.
Composite `selftest_sequence_48k.wav` (what the app plays, in this fixed order; the scorer aligns on the 1 kHz tone):
  2.0 s lead silence (noise floor) | tone 1 kHz 2.0 s @ -12 dBFS RMS | 1.0 s | log sweep 100 Hz-8 kHz 5.0 s @ -12 dBFS RMS | 3.0 s decay
  | canary word x3 (1.0 s gaps) | 1.0 s | 6 call-and-response pairs (en x2, hi x2, kn x2; call S1, 0.6 s, response S2; 1.2 s gaps) | 3.0 s tail silence
Speech is normalised to -20 dBFS active RMS. The app logs the system volume it played at; that is the only playback parameter left free."""
import argparse
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import phrases  # noqa: E402
import tts  # noqa: E402
import wavio  # noqa: E402

SR = 48000
TONE_HZ, TONE_S, TONE_DB = 1000.0, 2.0, -12.0
SWEEP_F0, SWEEP_F1, SWEEP_S, SWEEP_DB = 100.0, 8000.0, 5.0, -12.0
SPEECH_DB = -20.0
LEAD_S, GAP_TONE_SWEEP_S, DECAY_S, GAP_CANARY_S, GAP_CALL_S, GAP_PAIR_S, TAIL_S = 2.0, 1.0, 3.0, 1.0, 0.6, 1.2, 3.0
PAIRS = (("en", 0), ("en", 1), ("hi", 0), ("hi", 1), ("kn", 0), ("kn", 1))    # (language, which of the dialogue's first two Q/A pairs)
PACK_ID = "selftest-room-v2"
PAD_S, SWEEP_TAIL_S, PEAK_DB = 0.25, 3.0, -6.0


def log_sweep(f0, f1, dur, sr, level_dbfs):
    """Exponential (log) sweep, RMS level_dbfs, 5 ms fades. phase = 2 pi f0 L (exp(t/L) - 1), L = dur / ln(f1/f0)."""
    L = dur / math.log(f1 / f0)
    n = int(round(dur * sr))
    x = [math.sin(2 * math.pi * f0 * L * (math.exp(i / sr / L) - 1)) for i in range(n)]
    g = wavio.db(level_dbfs) / wavio.rms(x)
    return wavio.fade([v * g for v in x], 5, sr)


def tone(freq, dur, sr, level_dbfs):
    return wavio.fade(wavio.tone(freq, dur, level_dbfs, sr), 10, sr)


def active_rms_db(x, sr):
    return 20 * math.log10(max(wavio.rms_active(x, sr), 1e-9))


def normalise(x, sr, level_db):
    g = wavio.db(level_db) / max(wavio.rms_active(x, sr), 1e-9)
    return [max(-0.999, min(0.999, v * g)) for v in x]


def up48(x16):
    return wavio.resample_linear(x16, 16000, SR)


def _pair_turns(lang, which):
    turns = [t for t in phrases.DIALOGUES["dlg_%s_2" % lang]]           # (speaker, lang, idx): the dialogue's turns 0/1 and 2/3 are question/answer pairs
    call, resp = turns[2 * which], turns[2 * which + 1]
    return (call[0], lang, phrases.phrase(lang, call[2])), (resp[0], lang, phrases.phrase(lang, resp[2]))


def build_pack(out_dir, cache_dir, max_new_chars=3000, mode="elevenlabs"):
    """Layout the Room Recorder app loads (scribe #4230): <out_dir>/pack.json (pack_version 1, stimuli[] in PLAY ORDER: tone, sweep, canary x3, phrases) +
    the WAVs beside it (mono 48 kHz int16, peak ~ -6 dBFS, 0.25 s silence at head and tail; the sweep file carries a 3.0 s tail so its decay is on tape).
    The scorer's own manifest is selftest_pack.json (reference levels, signal offsets, hashes); pack.json stays minimal as specified."""
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    os.makedirs(os.path.join(out_dir, "ref"), mode=0o700, exist_ok=True)
    from generate import Router
    router = Router(mode, cache_dir)
    tts_meta, stimuli, ref = [], [], {}

    def peak_norm(x, peak_dbfs=PEAK_DB):
        g = wavio.db(peak_dbfs) / max(max(abs(v) for v in x), 1e-9)
        return [v * g for v in x]

    def add(sid, kind, fname, sig, head=PAD_S, tail=PAD_S, lang=None, truth=None, write_file=True):
        x = wavio.silence(head, SR) + sig + wavio.silence(tail, SR)
        if write_file:
            p = os.path.join(out_dir, fname)
            sha = wavio.write_wav(p, x, SR)
            os.chmod(p, 0o600)
        else:
            sha = wavio.sha256_file(os.path.join(out_dir, fname))
        st = dict(id=sid, kind=kind, file=fname, sha256=sha, duration_s=round(len(x) / SR, 3))
        if lang:
            st["lang"] = lang
        if truth:
            st["truth"] = truth
        stimuli.append(st)
        ref[sid] = dict(file=fname, signal_start_s=head, signal_dur_s=round(len(sig) / SR, 3), duration_s=round(len(x) / SR, 3), head_pad_s=head, tail_pad_s=tail,
                        rms_dbfs=round(20 * math.log10(max(wavio.rms(sig), 1e-9)), 2), active_rms_dbfs=round(active_rms_db(sig, SR), 2),
                        peak_dbfs=round(20 * math.log10(max(abs(v) for v in sig)), 2))

    add("tone-1k", "tone", "tone-1k.wav", peak_norm(tone(TONE_HZ, TONE_S, SR, -9.0)))
    add("sweep", "sweep", "sweep.wav", peak_norm(log_sweep(SWEEP_F0, SWEEP_F1, SWEEP_S, SR, -9.0)), tail=SWEEP_TAIL_S)
    cx16, cm = router.clip("en", "S1", phrases.CANARY)
    tts_meta.append(cm)
    c48 = peak_norm(up48(cx16))
    wavio.write_wav(os.path.join(out_dir, "ref", "canary_16k.wav"), cx16, 16000)
    os.chmod(os.path.join(out_dir, "ref", "canary_16k.wav"), 0o600)
    for i in (1, 2, 3):
        add("canary-%d" % i, "canary", "canary.wav", c48, lang="en", truth=phrases.CANARY, write_file=(i == 1))
    for n, (lang, which) in enumerate(PAIRS, 1):
        (cs, cl, ctext), (rs, rl, rtext) = _pair_turns(lang, which)
        for role, (spk, l, text) in (("call", (cs, cl, ctext)), ("resp", (rs, rl, rtext))):
            x16, m = router.clip(l, spk, text)
            tts_meta.append(m)
            add("ph%02d-%s-%s" % (n, lang, role), "phrase", "ph%02d-%s-%s.wav" % (n, lang, role), peak_norm(up48(x16)), lang=l, truth=text)
    spent = sum(b.spent for b in router.tts.values())
    if spent > max_new_chars:
        raise SystemExit("pack spent %d new chars (> %d)" % (spent, max_new_chars))
    pj = os.path.join(out_dir, "pack.json")
    with open(pj, "w") as f:
        json.dump(dict(pack_version=1, stimuli=stimuli), f, indent=1, ensure_ascii=False)
    os.chmod(pj, 0o600)
    man = dict(pack_id=PACK_ID, sr=SR, pack_json_sha256=wavio.sha256_file(pj), stimuli=ref, order=[s["id"] for s in stimuli],
               files={s["file"]: s["sha256"] for s in stimuli}, ref_canary_16k_sha256=wavio.sha256_file(os.path.join(out_dir, "ref", "canary_16k.wav")),
               sweep=dict(f0_hz=SWEEP_F0, f1_hz=SWEEP_F1, duration_s=SWEEP_S, start_in_file_s=PAD_S, end_in_file_s=PAD_S + SWEEP_S, kind="exponential (log)"),
               tone=dict(freq_hz=TONE_HZ, duration_s=TONE_S), padding_s=PAD_S,
               tts=[{k: m[k] for k in ("backend", "voice", "model", "lang", "audio_sha256", "cached", "synthetic_fallback")} for m in tts_meta],
               new_chars_spent=spent, phraseset_sha=phrases.PHRASESET_SHA, content="invented speech only; no patient text")
    body = json.dumps(man, sort_keys=True, ensure_ascii=False)
    man["pack_sha256"] = __import__("hashlib").sha256(body.encode("utf-8")).hexdigest()
    mp = os.path.join(out_dir, "selftest_pack.json")
    with open(mp, "w") as f:
        json.dump(man, f, indent=1, ensure_ascii=False, sort_keys=True)
    os.chmod(mp, 0o600)
    return man


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--cache", default=os.path.expanduser("~/eta-data/diag-rig/tts-cache"))
    ap.add_argument("--tts", default="elevenlabs", choices=["elevenlabs", "fake"])
    a = ap.parse_args()
    os.environ.setdefault("DIAGRIG_EL_V3_LANGS", "kn,te,ml")
    m = build_pack(a.out, a.cache, mode=a.tts)
    print(json.dumps({k: m[k] for k in ("pack_id", "pack_sha256", "pack_json_sha256", "new_chars_spent")}))
