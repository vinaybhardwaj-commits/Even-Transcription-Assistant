"""hum_diagnostic.py: POST-HOC diagnostic (written after results.json was opened, not pre-registered) for the one refused window the primary detector flagged.
Average magnitude spectrum of the whole 900 s window (1024-sample Hann frames, hop 512, 16 kHz): the strongest bin's frequency, its ratio to the median bin, the share of frames whose strongest bin is that
bin (+-1), and the share of energy in 300-3400 Hz. A steady narrow tone with little speech-band energy is what mains/fan hum looks like. Numbers only. Run with /home/eta/vad/venv/bin/python."""
import os, sys
import numpy as np
import refused_logic as R
import measure as M


def spec(wid, path, keymap):
    rec = M.ensure_timing(R.read_json(os.path.join(R.HOME, path)), keymap)
    buf, cov = M.window_audio(rec, np)
    x = buf.astype("float64") / 32768.0
    n, hop = 1024, 512
    nfr = (len(x) - n) // hop
    idx = np.arange(n)[None, :] + hop * np.arange(nfr)[:, None]
    S = np.abs(np.fft.rfft(x[idx] * np.hanning(n), axis=1))
    mean = S.mean(axis=0)
    f = np.fft.rfftfreq(n, 1 / M.SR)
    pk = int(np.argmax(mean[3:]) + 3)
    med = float(np.median(mean[3:]))
    top = np.argmax(S[:, 3:], axis=1) + 3
    sb = (f >= 300) & (f <= 3400)
    return dict(window_id=wid, peak_hz=round(float(f[pk]), 1), peak_over_median=round(float(mean[pk] / med), 1),
                strongest_bin_stable_frames=round(float(np.mean(np.abs(top - pk) <= 1)), 3), speech_band_energy_share=round(float((S[:, sb] ** 2).sum() / (S ** 2).sum()), 3),
                covered_s=round(R.total(cov), 1))


def path_of(wid):
    for root in R.ROOTS:
        for dp, _dn, fn in os.walk(os.path.join(R.HOME, root)):
            if wid + ".json" in fn:
                return os.path.relpath(os.path.join(dp, wid + ".json"), R.HOME)


if __name__ == "__main__":
    km = M.chunk_time_map()
    for wid in sys.argv[1:]:
        print(spec(wid, path_of(wid), km))
