# W1 ORB2 health report (read-only scout, 7 Oct 2026)

Collected 14:40 IST 7 Oct 2026 over `ssh orb2`. Facts only; fixes untouched.

## 1. Services / host
- room-recorder: active | room-bench: active | orb-netwatch.timer: active | orb-softdog: active
- uptime: up 1 day 23:52, load 0.31 / 0.24 / 0.19
- df /: 233G total, 18G used, 204G free (9%)
- tailscale (self, first line): <tailscale-ip> vinay-orb2 (linux)

## 2. status.json (fields named key/token/secret: none present)
- session_id: bs_99bzkp32 | state: recording | pending_piece_count: 0
- updated_at: 2026-10-07T09:10:11Z (= 14:40 IST, same minute as this check)
- error fields: none present

## 3. tape.pcm growth (60 s apart)
- 5,793,132,014 → 5,795,052,814 = 1,920,800 B / 60 s = **32,013 B/s** (order expects ~32,000) — healthy

## 4. tape.idx today since 06:00 IST (per 30 min; records / median rms / max peak / % zero_ratio>0.9)
- 06:00 1412 / 0.0017 / 0.07 / 0.0   06:30 1412 / 0.0015 / 0.06 / 0.0
- 07:00 1412 / 0.0017 / 0.60 / 0.0   07:30 1412 / 0.0036 / 1.00 / 0.0
- 08:00 1411 / 0.0030 / 0.51 / 0.0   08:30 1412 / 0.0030 / 0.39 / 0.0
- 09:00 1412 / 0.0202 / 1.00 / 0.0   09:30 1411 / 0.0072 / 1.00 / 0.0
- 10:00 1412 / 0.0023 / 1.00 / 0.0   10:30 1412 / 0.0015 / 1.00 / 0.0
- 11:00 1412 / 0.0022 / 0.21 / 0.0   11:30 1411 / 0.0027 / 0.31 / 0.0
- 12:00 1412 / 0.0016 / 0.24 / 0.0   12:30 1412 / 0.0028 / 1.00 / 0.0
- 13:00 1412 / 0.0019 / 0.20 / 0.0   13:30 1411 / 0.0020 / 0.07 / 0.0
- 14:00 1412 / 0.0025 / 0.34 / 0.0   14:30 614 / 0.0019 / 0.05 / 0.0 (partial, to ~14:41 IST)
- Record cadence: ~1,412 per 30 min ≈ 1.27 s/record (order says ~1.3 s — consistent)
- rms field semantics (scale, dB or linear): UNVERIFIED. Peak hitting exactly 1.0000 in
  7 slots: UNVERIFIED whether that is clipping or per-record normalisation.

## 5. orb-netwatch journal today
- Oct 07 00:16:49 UTC unreachable (gw=10.10.8.1) 1 min → recovered 00:17:59 (= 05:46 IST)
- Oct 07 06:13:49 UTC unreachable (gw=10.10.8.1) 1 min → recovered 06:14:59 (= 11:43 IST)
- No other entries today.

## Flags (facts, no fixes)
- F1: all four services active; recorder writing at the expected rate; zero dead-air slots today.
- F2: repeated max_peak == 1.0000 in 7 of 18 slots — needs a bench check of the peak scale (UNVERIFIED).
- F3: two 1-minute gateway drops today, both auto-recovered; no pattern established (single day).
