"""DIAG-RIG stimulus generator: WAV (16 kHz mono int16) + truth JSON next to it (lab-mover's sidecar contract).
Stimuli: tones (sweep + fixed at levels), silence patterns (exact zero / dither floor / mute-unplug), canary, call-and-response
dialogues (2-3 speakers; en/hi/kn/te/ta + code-mixed), background beds at set SNRs. One suite dir holds everything + suite.json
(sha of every file, the phrase-set sha, TTS provenance). All randomness is seeded; TTS clips come from the cache."""
import hashlib
import json
import os
import subprocess

import clinical
import phrases
import tts
import wavio
from wavio import SR

GAP_S = 0.6
LEAD_S = 1.0
SNRS = (20, 10, 5, 0, -5)
FIXED_TONES = (250, 1000, 4000)
TONE_LEVELS = (-60, -40, -20, -6)
BEDS = ("fan", "ac_hum", "babble", "door", "phone_ring")


class Router:
    """Per-language TTS routing. mode: fake | google | elevenlabs (EL for its supported langs, google for the rest)."""

    def __init__(self, mode, cache_dir, voices=None):
        self.mode = mode
        self.tts = {}
        for b in ({"fake"} if mode == "fake" else {"google"} | ({"elevenlabs"} if mode == "elevenlabs" else set())):
            self.tts[b] = tts.Tts(b, cache_dir, voices=(voices or {}).get(b))

    def clip(self, lang, speaker, text):
        b = "fake" if self.mode == "fake" else ("elevenlabs" if self.mode == "elevenlabs" and tts.lang_base(lang) in tts.el_langs() else "google")
        return self.tts[b].clip(lang, speaker, text)

    def chars_used(self):
        """Per-backend chars spent by THIS run, plus the shared ledger total (the 60k cap counts the total)."""
        out = {k: v.spent for k, v in self.tts.items()}
        out["ledger_total"] = max((v._ledger() for v in self.tts.values()), default=0)
        return out


def _sec(n):
    return n / SR


def _ms(n):
    return int(round(1000 * n / SR))


class Builder:
    def __init__(self, outdir, router, seed=20260926):
        self.out, self.router, self.seed = outdir, router, seed
        os.makedirs(outdir, mode=0o700, exist_ok=True)
        self.items = []

    def _write(self, sid, x, kind, events, **extra):
        p = os.path.join(self.out, sid + ".wav")
        sha = wavio.write_wav(p, x)
        os.chmod(p, 0o600)
        truth = dict(stimulus_id=sid, kind=kind, sr=SR, duration_s=round(_sec(len(x)), 3), audio_sha256=sha,
                     phraseset_sha=phrases.PHRASESET_SHA, events=events, **extra)
        tp = os.path.join(self.out, sid + ".truth.json")
        with open(tp, "w") as f:
            json.dump(truth, f, indent=1, ensure_ascii=False, sort_keys=True)
        os.chmod(tp, 0o600)
        self.items.append(dict(stimulus_id=sid, kind=kind, audio_sha256=sha, truth_sha256=_sha_file(tp)))
        return truth

    # ---- tones + silence
    def tones(self, sid="tones"):
        x, ev = wavio.silence(LEAD_S), []
        def add(kind, sig, **kw):
            nonlocal x
            ev.append(dict(type=kind, start_ms=_ms(len(x)), end_ms=_ms(len(x) + len(sig)), **kw))
            x = x + wavio.fade(sig) + wavio.silence(0.5)
        for lv in TONE_LEVELS:
            add("sweep", wavio.sweep(100, 8000, 4.0, lv), level_dbfs=lv, f0=100, f1=8000)
            for f in FIXED_TONES:
                add("tone", wavio.tone(f, 2.0, lv), level_dbfs=lv, freq_hz=f)
        return self._write(sid, x, "tones", ev)

    def canary(self, sid="canary", reps=3):
        clip, meta = self.router.clip("en", "S1", phrases.CANARY)
        x, ev = wavio.silence(LEAD_S), []
        for _ in range(reps):
            ev.append(dict(type="canary", start_ms=_ms(len(x)), end_ms=_ms(len(x) + len(clip)), text=phrases.CANARY, lang="en", speaker="S1"))
            x = x + clip + wavio.silence(GAP_S * 3)
        return self._write(sid, x, "canary", ev, tts=[meta])

    def silence_pattern(self, sid="silence"):
        """speech-like reference bursts around exact-zero (mute) and dither-floor (unplug) blocks; time-to-detect is scored from these."""
        burst = wavio.fade(wavio.tone(440, 3.0, -25))
        x, ev = wavio.silence(0.0), []
        def add(kind, sig):
            nonlocal x
            ev.append(dict(type=kind, start_ms=_ms(len(x)), end_ms=_ms(len(x) + len(sig))))
            x = x + sig
        add("burst", burst)
        add("silence_zero", wavio.silence(20))
        add("burst", burst)
        add("silence_dither", wavio.dither(20, -90, self.seed))
        add("burst", burst)
        add("silence_dither", wavio.dither(20, -60, self.seed + 1))
        add("burst", burst)
        return self._write(sid, x, "silence", ev)

    # ---- dialogues
    @staticmethod
    def resolve(name):
        """-> ([(spk, lang, text)], items|None): a phrases.DIALOGUES name (index turns) or a clinical name clin_<lang>_<k>."""
        if name.startswith("clin_"):
            _, lang, k = name.split("_", 2)
            n, turns, items = clinical.build(lang, int(k) - 1)
            return turns, items
        return [(s, l, phrases.phrase(l, i)) for s, l, i in phrases.DIALOGUES[name]], None

    def _assemble(self, turns):
        x, ev, metas = wavio.silence(LEAD_S), [], []
        for spk, lang, text in turns:
            clip, meta = self.router.clip(lang, spk, text)
            ev.append(dict(type="turn", speaker=spk, lang=lang, text=text, start_ms=_ms(len(x)), end_ms=_ms(len(x) + len(clip))))
            metas.append(meta)
            x = x + clip + wavio.silence(GAP_S)
        return x, ev, metas

    def dialogue(self, name):
        turns, items = self.resolve(name)
        x, ev, metas = self._assemble(turns)
        extra = dict(clinical_items=items, clinical_sha=clinical.CLINICAL_SHA, text_review="Malayalam frames are unreviewed by a native reader") if items else {}
        return self._write(name, x, "dialogue", ev, tts=metas, n_speakers=len({e["speaker"] for e in ev}), **extra)

    def noisy(self, dlg, bed, snr):
        sid = "%s__%s_snr%d" % (dlg, bed, snr)
        turns, items = self.resolve(dlg)
        x, ev, metas = self._assemble(turns)
        pool, src = None, None
        if bed == "babble":
            pool, src = self.babble_pool(dlg)
        b = wavio.bed(bed, _sec(len(x)), self.seed, speech_pool=pool)
        y = wavio.mix_at_snr(x, b, snr)
        extra = dict(bed_sources=src) if src else {}
        if items:
            extra.update(clinical_items=items, clinical_sha=clinical.CLINICAL_SHA)
        return self._write(sid, y, "noisy_dialogue", ev, tts=metas, n_speakers=len({e["speaker"] for e in ev}), bed=bed, snr_db=snr, base=dlg, **extra)

    def babble_pool(self, dlg):
        """Crowd babble must not contain the scored dialogue's words or voices (else transcribed babble scores as hits and the diarizer hears
        target speakers in the noise): other speaker ids (S4/S5) and phrases from OTHER languages than the dialogue's. Provenance goes in truth."""
        turns, _ = self.resolve(dlg)
        used_speakers = {s for s, _, _ in turns}
        used_texts = {t for _, _, t in turns}
        dlg_langs = {tts.lang_base(l) for _, l, _ in turns}
        pool, src = [], []
        for spk in ("S4", "S5"):
            assert spk not in used_speakers
            for lang in ("ta", "en", "hi"):
                if lang in dlg_langs:
                    continue
                for i in (0, 1):
                    text = phrases.phrase(lang, i)
                    assert text not in used_texts
                    c, m = self.router.clip(lang, spk, text)
                    pool.append(c)
                    src.append(dict(speaker=spk, lang=lang, voice=m["voice"], audio_sha256=m["audio_sha256"]))
                break
        return pool, src


def _sha_file(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def git_sha():
    try:
        return subprocess.run(["git", "-C", os.path.dirname(os.path.abspath(__file__)), "rev-parse", "--short=12", "HEAD"],
                              capture_output=True, text=True, timeout=10).stdout.strip() or None
    except Exception:
        return None


SUITES = {
    "nightly": dict(dialogues=list(phrases.DIALOGUES), noisy=[("dlg_en_2", "fan", 10), ("dlg_en_2", "babble", 5), ("dlg_en_2", "ac_hum", 0), ("dlg_hi_2", "fan", 10)]),
    "full": dict(dialogues=list(phrases.DIALOGUES), noisy=[(d, b, s) for d in ("dlg_en_2",) for b in BEDS for s in SNRS]),
    # W33.1: 8 cases x 8 modes, clean + fan10 + babble5 (variants reuse the cached clips). Only dialogues (no tones/canary/silence).
    "clinical": dict(clinical=True, dialogues=[n for n, _t, _i in clinical.all_dialogues()], noisy=[(n, b, s) for n, _t, _i in clinical.all_dialogues() for b, s in (("fan", 10), ("babble", 5))]),
    "smoke": dict(dialogues=["dlg_en_2", "dlg_hi_2"], noisy=[("dlg_en_2", "fan", 10)]),
}


def build_suite(name, outdir, mode, cache_dir, voices=None):
    if name not in SUITES:
        raise SystemExit("unknown suite %r (have %s)" % (name, ", ".join(SUITES)))
    if not phrases.KANGLISH_APPROVED and any("knen" in d for d in SUITES[name]["dialogues"]) and mode != "fake":
        raise SystemExit("Kanglish list is not yet approved by V (phrases.KANGLISH_APPROVED): refusing a real-TTS run that includes it")
    b = Builder(outdir, Router(mode, cache_dir, voices))
    if not SUITES[name].get("clinical"):
        b.tones()
        b.silence_pattern()
        b.canary()
    for d in SUITES[name]["dialogues"]:
        b.dialogue(d)
    for d, bed, snr in SUITES[name]["noisy"]:
        b.noisy(d, bed, snr)
    man = dict(suite=name, tts_mode=mode, phraseset_sha=phrases.PHRASESET_SHA, clinical_sha=clinical.CLINICAL_SHA if SUITES[name].get("clinical") else None, rig_git=git_sha(), chars_used=b.router.chars_used(), items=b.items)
    with open(os.path.join(outdir, "suite.json"), "w") as f:
        json.dump(man, f, indent=1)
    os.chmod(os.path.join(outdir, "suite.json"), 0o600)
    man["manifest_sha256"] = _sha_file(os.path.join(outdir, "suite.json"))
    return man
