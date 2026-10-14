#!/usr/bin/env python3
"""W39 A2 step 2: join per-window acoustics (window_acoustics.jsonl) with transcript-quality
metadata (window_transcript_meta.json), derive quality labels, and report per-room + pooled
effect sizes (point-biserial r, Cohen's d, and a small multivariate logistic regression via
IRLS - no ML library dependency). Numbers only; no transcript text is read (only lengths and
already-derived language/outcome labels from Neon).
"""
import json, os, math
import numpy as np

W = os.path.expanduser("~/eta-data/acoustics/work")
NFFT = 1024
SR = 48000

WHISPER_NAME_TO_ISO = {"english": "en", "hindi": "hi", "kannada": "kn", "tamil": "ta", "telugu": "te",
                       "malayalam": "ml", "marathi": "mr", "bengali": "bn", "gujarati": "gu",
                       "punjabi": "pa", "urdu": "ur", "odia": "od", "oriya": "od"}
INDIC = {"hi", "kn", "ta", "te", "ml", "mr", "bn", "gu", "pa", "ur", "od"}

def norm_lang(raw):
    if not raw: return None
    l = str(raw).strip().lower()
    if l in ("", "auto", "und", "unknown"): return None
    base = l.split("-")[0].split("_")[0]
    return WHISPER_NAME_TO_ISO.get(base, base)

def confusability(probe, full, sarvam):
    codes = [c for c in (norm_lang(probe), norm_lang(full), norm_lang(sarvam)) if c is not None]
    n = len(codes)
    if n == 0: return None
    if n == 1: return 0
    distinct = set(codes)
    if len(distinct) == 1: return 0
    if n == 3 and len(distinct) == 3: return 3
    buckets = {("english" if c == "en" else ("indic" if c in INDIC else "other")) for c in codes}
    if len(buckets) > 1: return 2
    return 1

def spectral_from_psd(psd, n_samples):
    if not psd: return {}
    P = np.array(psd)
    f = np.linspace(0, 24000, len(P))
    band = lambda a, b: (f >= a) & (f < b)
    ref = P[band(300, 3000)]
    if ref.size == 0 or ref.mean() <= 0: return {}
    ref_db = 10 * np.log10(ref.mean())
    hf = P[band(4000, 8000)]
    tilt_sel = band(200, 4000)
    if hf.size == 0 or tilt_sel.sum() < 4: return {}
    slope = float(np.polyfit(np.log2(f[tilt_sel]), 10 * np.log10(np.maximum(P[tilt_sel], 1e-20)), 1)[0])
    return {"tilt": slope, "hf_rel_db": float(10 * np.log10(hf.mean()) - ref_db)}

def load():
    meta = {r["subject_id"]: r for r in json.load(open(f"{W}/window_transcript_meta.json"))}
    rows = []
    for l in open(f"{W}/window_acoustics.jsonl"):
        a = json.loads(l)
        m = meta.get(a["subject_id"])
        if m is None or a.get("error"):
            continue
        row = {"subject_id": a["subject_id"], "room_id": a["room_id"]}
        row["noise_med"] = a.get("noise_med_raw")
        row["noise_p10"] = a.get("noise_p10_raw")
        row["speech_dbfs"] = a.get("speech_dbfs")
        row["snr"] = (a["speech_dbfs"] - a["noise_med_raw"]) if (a.get("speech_dbfs") is not None and a.get("noise_med_raw") is not None) else None
        row["clip_pct"] = a.get("clip_share_999", 0) * 100
        row["zero_pct"] = a.get("zero_sample_share", 0) * 100
        row["vad_speech_frac"] = a.get("vad_speech_s", 0) / max(a.get("dur_s", 900), 1)
        sp = spectral_from_psd(a.get("psd_speech"), a.get("psd_speech_n"))
        row["tilt"] = sp.get("tilt")
        row["hf_rel_db"] = sp.get("hf_rel_db")
        # labels
        outcome = m.get("outcome")
        len_orig = m.get("len_orig") or 0
        row["empty"] = 1 if (outcome in ("no_engine", "engine_no_text")) or len_orig == 0 else 0
        uc = m.get("units_collapsed") or 0
        ld = m.get("lines_dropped") or 0
        row["collapse"] = 1 if (uc > 0 or ld > 0) else 0
        conf = confusability(m.get("probe_language"), m.get("full_window_language"), m.get("sarvam_language"))
        row["lang_mismatch"] = 1 if (conf is not None and conf >= 2) else 0
        row["error"] = 1 if m.get("error") else 0
        row["any_issue"] = 1 if (row["empty"] or row["collapse"] or row["lang_mismatch"] or row["error"]) else 0
        rows.append(row)
    return rows

def pb_r(x, y):
    x = np.array(x, float); y = np.array(y, float)
    ok = ~np.isnan(x)
    x, y = x[ok], y[ok]
    if len(x) < 8 or y.std() == 0 or x.std() == 0: return None, len(x)
    return float(np.corrcoef(x, y)[0, 1]), len(x)

def cohens_d(x, y):
    x = np.array(x, float); y = np.array(y, float)
    ok = ~np.isnan(x)
    x, y = x[ok], y[ok]
    a, b = x[y == 1], x[y == 0]
    if len(a) < 4 or len(b) < 4: return None
    sp = math.sqrt(((len(a) - 1) * a.var(ddof=1) + (len(b) - 1) * b.var(ddof=1)) / max(len(a) + len(b) - 2, 1))
    if sp == 0: return None
    return float((a.mean() - b.mean()) / sp)

def logistic_irls(X, y, iters=50):
    """PURE numpy IRLS logistic regression (with intercept). X: (n,k) already standardized."""
    n, k = X.shape
    Xb = np.hstack([np.ones((n, 1)), X])
    beta = np.zeros(k + 1)
    for _ in range(iters):
        z = Xb @ beta
        p = 1 / (1 + np.exp(-np.clip(z, -30, 30)))
        w = np.clip(p * (1 - p), 1e-6, None)
        W = w
        try:
            XtWX = (Xb * W[:, None]).T @ Xb + 1e-6 * np.eye(k + 1)
            XtWz = Xb.T @ (W * z + (y - p))
            beta_new = np.linalg.solve(XtWX, XtWz)
        except np.linalg.LinAlgError:
            break
        if np.allclose(beta_new, beta, atol=1e-8): beta = beta_new; break
        beta = beta_new
    return beta

FEATURES = ["noise_med", "snr", "clip_pct", "zero_pct", "vad_speech_frac", "tilt", "hf_rel_db"]
LABELS = ["empty", "collapse", "lang_mismatch", "any_issue"]

def effect_sizes(rows, features=FEATURES, labels=LABELS):
    out = {}
    for lab in labels:
        y = [r[lab] for r in rows]
        out[lab] = {"n": len(rows), "positive": int(sum(y)), "positive_pct": round(100 * sum(y) / len(rows), 1) if rows else None, "features": {}}
        for feat in features:
            x = [r[feat] if r[feat] is not None else np.nan for r in rows]
            r, n = pb_r(x, y)
            d = cohens_d(x, y)
            out[lab]["features"][feat] = {"r": round(r, 3) if r is not None else None, "cohens_d": round(d, 3) if d is not None else None, "n": n}
    return out

def multivariate(rows, features, label):
    X, y = [], []
    for r in rows:
        if all(r[f] is not None for f in features):
            X.append([r[f] for f in features]); y.append(r[label])
    if len(y) < 30 or sum(y) < 5 or sum(y) > len(y) - 5:
        return {"n": len(y), "positive": int(sum(y)) if y else 0, "note": "insufficient data for a stable fit"}
    X = np.array(X, float); y = np.array(y, float)
    mu, sd = X.mean(0), X.std(0); sd[sd == 0] = 1
    Xs = (X - mu) / sd
    beta = logistic_irls(Xs, y)
    return {"n": len(y), "positive": int(y.sum()),
           "intercept": round(float(beta[0]), 3),
           "coef_per_1sd": {f: round(float(b), 3) for f, b in zip(features, beta[1:])},
           "odds_ratio_per_1sd": {f: round(float(math.exp(b)), 3) for f, b in zip(features, beta[1:])}}

def main():
    rows = load()
    out = {"n_windows_joined": len(rows), "features": FEATURES, "labels": LABELS,
          "pooled": effect_sizes(rows), "by_room": {}}
    for lab in LABELS:
        out["pooled"].setdefault(lab, {})
        out["pooled"][lab]["multivariate"] = multivariate(rows, [f for f in FEATURES if f not in ("hf_rel_db",)], lab)
    by_room = {}
    for r in rows: by_room.setdefault(r["room_id"], []).append(r)
    for room, rr in by_room.items():
        if len(rr) < 15:
            out["by_room"][room] = {"n": len(rr), "note": "too few joined windows for per-room effect sizes"}
            continue
        out["by_room"][room] = effect_sizes(rr)
        out["by_room"][room]["n"] = len(rr)
    json.dump(out, open(f"{W}/a2_effect_sizes.json", "w"), indent=1)
    os.chmod(f"{W}/a2_effect_sizes.json", 0o640)
    print("n_windows_joined", len(rows))
    print(json.dumps(out["pooled"], indent=1)[:3000])

if __name__ == "__main__":
    main()
