# ORBOX design v2

Status: **design only. Nothing bought, nothing installed, nothing tested on hardware yet.**
Date: Sat 26 Sep 2026. Successor to `~/fable/ORBOX-DESIGN.md` (v1). Pool A lane:
no personal or clinical recordings of any kind — invented/public material only.
This is a shopping-and-architecture note for a recording box in an empty-room
test.

**V ruling amendment, Tue 29 Sep 2026 (Fable #6990, D-2/D-3/D-5):** the ORBOX
video stream is the **robotic surgical device's telemetry display** — not video
of a person in the room; consent for it is already settled by V, and no
consent flow belongs in this design. The room carries **both** microphones and
speakers. Nothing may be bought, built or sent to a vendor until V says so.
(This note is paperwork.)

## 0. What this revision did

v1 marked every product fact UNVERIFIED. v2 opened public web sources on
26 Sep 2026 and either replaced a claim with a dated cited fact or kept it
UNVERIFIED with what is now known. Prices are single quotes read from one
listing at one moment; they are not quotations and they move daily.

Three material corrections to v1:

1. **The 4-input interface costs ~₹20,000, not ₹3,000–12,000.** The Behringer
   UMC404HD is the verified reference at ₹18,999 (Amazon.in, 26 Sep 2026). The
   ₹3–12k band in v1 does not buy any verified 4-input class-compliant device.
2. **The webcam that meets the spec floor is ~₹9,000, not ₹1,500–4,000.** The
   Logitech C920 lists at ₹8,945 (Amazon.in, 26 Sep 2026). Cheaper UVC webcams
   exist but none verified for the spec floor (see §2.1).
3. **4 TB backup HDDs are ~₹16,000, not ₹3,500–7,000 (at list price).** Amazon.in
   lists ₹15,999 (26 Sep 2026); historical average is ₹11,443 and sale lows were
   ₹4.9–7.5k, so bide for sale events. Storage pricing is inflated vs v1's bands.

## 1. What the ORBox has to do (unchanged from v1)

1. **Record the surgical device's telemetry display and several microphones** as
   **separate streams**.
2. Put all streams on **one workable common timeline** (manifest + clap sync,
   linear drift fit — §5 of v1 carries over; the empty-OT test plan in §5 here
   is the plan that validates it).
3. Master held locally, handed to the lab; viewer gets a derived copy only.
4. No mid-session clinician decisions; no silent failure.

## 2. Verified hardware facts (with sources and dates)

Everything in v2 that supersedes v1 is dated. Access date for every price:
**26 Sep 2026** unless the source itself carries another date.

### 2.1 Webcam — Logitech C920 / C920s (VERIFIED: UVC on Linux, mic on Linux)

- UVC driver support in-kernel since 3.2 for USB ID 046d:082d
  (linux-hardware.org device entry; LKDDb rows for uvc_driver.c).
- The C920 exposes its microphone as a **separate USB Audio interface** on the
  same physical device — Linux sees `card: HD Pro Webcam C920` via
  `snd_usb_audio`, and `arecord` records from it
  (askubuntu.com/questions/1128694, 2019; mic on/off control script for Ubuntu
  24.04.1 confirmed by Logitech-support walkthrough).
- **Caution (verified)**: several C920 firmware variants ship broken USB
  frame-timestamps; the uvcvideo driver carries `UVC_QUIRK_INVALID_DEVICE_SOF`
  added Mar 2024 for C920, and a Jun 2026 kernel patch (046d:08e5 variant) also
  adds `NO_FORCE_QUALITY` + `DROP_STREAM_ERR` fixes for truncated MJPEG frames
  (LKML patches). Consequence: do not rely on the webcam's USB timestamps;
  rely on the launcher clock + claps (v1 §4.3/§5.1), which this design already
  does. Prefer recording over YUYV or MJPEG on a kernel ≥ 6.9 that carries the
  quirk set.
- C920s variant = same sensor line, adds privacy shutter, **dual stereo mics**,
  1080p30 (logitech.com product page).
- **Price: ₹8,945** — Amazon.in listing B006JH8T3S, sold by Clicktech Retail
  (Amazon fulfilled), in stock, listing shows Aug 2026 reviews (26 Sep 2026).
  A third-party Delhi outlet listed C920s at ₹3,847 (logitechindia.co.in,
  Nov 2025 page) — plausibly grey; treat as spot quote, not the reference.
- Still true from v1: manual exposure/focus lock is what the spec floor wants;
  verify with `v4l2-ctl --list-ctrls` **on the physical unit** before purchase.
  UNVERIFIED: no cheaper (~₹2–4k) webcam is verified for UVC + Linux mic +
  manual-ctrl trio. The C920 is the safe buy; a cheap one is a lottery ticket.

### 2.2 Four-input USB interface — Behringer UMC404HD (VERIFIED: Linux class-compliant)

- Class-compliant: Behringer's manual states Mac-class compliance and Linux
  users confirm "no driver, appears as UMC404HD 192k / U192k" — ALSA capture
  shows **4 channels, S32_LE (24-in-32), 44.1k–192 kHz**, MIDI
  (ardour.org forum thread 2020 with `/proc/asound/U192k/stream0` dump;
  linux-hardware.org device entry 1397:0509 supported since kernel 2.6).
- Works under **PipeWire Pro Audio profile** (Arch forum thread, May 2025).
- Power: ships with a 5 V PSU; **can run on bus power** for light loads
  (LinuxMusicians 2020 / Ardour 2020 threads) — for four phantom-powered
  condensers behaviour must be bench-tested (still UNVERIFIED) and the PSU is
  the fallback (this de-risks v1's §3.3 hum concern; hum likely irrelevant if
  it runs off its own PSU brick).
- Spec (behringer.com product page): 4x4, 24-bit/192 kHz, 4 Midas preamps,
  +48 V phantom per pair, combi XLR/TRS, zero-latency direct monitoring.
- **India price: ₹18,999** (Amazon.in B00QHURLHM, 26 Sep 2026); other stores:
  ₹21,499 (proaudiobrands.com), ₹21,999 (sangeethmahal.com), ₹23,000
  (Bharat Music House, Lajpat Nagar). **Plan on ₹19–23k.**

### 2.3 Main close mic — TONOR TC-777 (VERIFIED: Linux plug-and-play, 48 kHz available)

- USB 2.0, plug-and-play, no driver; **tested working out of the box on Ubuntu
  Linux** (randommomentania.com review, Jul 2020; christcenteredgamer review).
- Sample rate: enumerates at **44.1/48 kHz, 16-bit, mono**
  (mictests.com review 2022 shows 48000 Hz / 16-bit / 1 ch; vendor/reviews
  disagree on 44.1-only vs 44.1+48k — resolution: treat 48 kHz/16-bit as
  available but confirm with `arecord -D <dev> --dump-hw-params` on receipt).
- **Memory correction to v1: it is 16-bit, not 24-bit**, and it has **no
  headphone jack** (no zero-latency monitoring on the mic itself) — v1's
  audio-storage table should read 48k/16-bit for this stream (0.35 GB/h mono).
- S/N: Amazon.in lists 80 dB; an independent review measured 56 dB S/N
  (christcenteredgamer). UNVERIFIED which is right; expect the worse case.
- **Price: ₹1,999** (Amazon.in B07WLWN2ZT, sold by Cocoblu, 26 Sep 2026);
  historic low ₹1,849 (May 2026, cheapestinindia tracker).

### 2.4 Directional room mic — Boya BY-BM3032 (VERIFIED model + price; interface caveat)

- Super-cardioid shotgun, adjustable gain (−10/0/+20 dB), 3-step HPF
  (0/75/150 Hz), battery powered (~30 h, 2 AA), **output 3.5 mm TRS — not XLR**
  (Bajaao/Tarana product pages).
- Interface caveat: goes into the UMC404HD combi input via a 3.5 mm
  TRS→6.35 mm TRS patch; **phantom must be OFF on that channel**. Level into a
  preamp from a 3.5 mm consumer output is workable but unbench-passed —
  UNVERIFIED.
- **Price: ₹5,399** (bajaao.com; taranamusical.com same, 26 Sep 2026; MRP
  ₹15,999 shown at 48–66% discount — the discount ladder is the normal Boya
  retail pattern in India, not a distress price).

### 2.5 Table/room omni — Behringer ECM8000 (VERIFIED: stands in for a "boundary" mic at this budget)

- True XLR boundary/PZM mics in India at budget prices: UNVERIFIED (none
  surfaced). The ECM8000 is the classic cheap XLR omni; it is a measurement
  mic, omnidirectional, XLR, runs on +15–48 V phantom
  (behringer.com; pasystem.in; devmusical.com). Mount it on a small stand on
  the table, or tape it flat — do not call it a boundary mic.
- **Price: ₹4,799** (VPLAK, incl. taxes); ₹3,999 at Bajaao but **out of
  stock**; ₹5,224 (pasystem.in); ₹5,939 (devmusical.com). **Plan on ₹4–6k.**

### 2.6 Wired lavaliers (v1 §3.1) — one fact corrected, one price kept UNVERIFIED

- BY-M1 (₹949, Amazon.in B076B8G5D8, 26 Sep 2026) is **3.5 mm TRRS with a
  battery module for camera mode** — it does **not** feed an XLR/TRS interface
  input cleanly. v1's "XLR/TRS lavaliers" floor stands; the BY-M1 fails it.
- The XLR lav that matches the brief: **Boya BY-M8OD** — omni, XLR 3-pin,
  needs 48 V phantom, 2 m cable (product pages / 6ave specs). India price:
  **UNVERIFIED**; a single Delhi aggregator quote shows ₹7,733 (e-trovato
  listing, no date). Band ₹4–7.7k each until a real store page confirms.

### 2.7 Wireless directional option — Hollyland Lark M2 (VERIFIED model + India direct-store price)

- Lark M2: 2.4 GHz, 48 kHz/24-bit, camera-version receiver has a 3.5 mm
  output; Hollyland India's own store lists the **Camera version ₹11,999 /
  Combo ₹12,999 / Type-C ₹9,999** (in.hollyland.com, 26 Sep 2026); Amazon.in
  ₹11,998–11,999 (26 Sep 2026). Comparisons: DJI Mic 2 ~₹28–32k, Rode GO II
  ~₹25–28k (chaotechh.com review, Mar 2026).
- v1's design rule survives verification unchanged: if bought, the receiver's
  3.5 mm output must land on a **UMC404HD input** (so it rides the interface
  clock) — receiver output level (line vs mic) and docking **still
  UNVERIFIED**; bench-test before purchase.

### 2.8 Storage — (VERIFIED prices, both financially larger than v1)

| Item | Spec | Price (26 Sep 2026) |
|---|---|---|
| Samsung T7 1TB (external master) | USB 3.2 Gen2, ≤1050/1000 MB/s | ₹21,999–23,999 Amazon.in; MDC ₹22,280; sale floors ₹7,499 (deal tracker, Oct 2024) |
| Seagate Expansion 4TB portable (backup) | 2.5", 5400 rpm | ₹15,999 Amazon.in B08ZJFH7Y1; avg ₹11,443, sales ₹4.9–7.5k; VijaySales ₹14,449 |
| Seagate Expansion 4TB desktop (backup alt) | 3.5", 7200 rpm | ₹15,799 Amazon.in; older listings ₹12.5–12.7k |

- CMR vs SMR for the specific backup SKU: **still UNVERIFIED** (Seagate does
  not label the enclosure shells; the Expansion portable line is widely
  believed to include SMR at 4 TB — worth one spec-sheet read or a
  `smartctl`/profile check on receipt before it is trusted for streams of
  multi-GB writes; for one-shot after-session copies SMR risk is degraded-lite,
  but the desktop 7200 rpm unit is the safer default).

### 2.9 Host — small N100 mini PC (price volatile; Ubuntu explicitly supported)

- Beelink S12 Pro (N100, 16 GB, 500 GB NVMe): Amazon.in listing explicitly
  states **"supports installation of Ubuntu system"** (listing B0BVR3HTKF);
  Ethernet 1000 M, 4+1 USB 3.2, dual HDMI. Cope with the capture stack easily.
- **Price trap (verified)**: the current Amazon.in listing shows ₹61,850
  (pricehistory.app, 4 Sep 2026) — historically the same unit was ₹29,309
  (May 2025 low) with average ₹40,391. **Plan ₹30–45k for a new N100 16 GB;
  treat the ₹61.85k moment as price distortion, not the market.**
- UNVERIFIED: any specific competing model (GMKtec/Ninkear/etc.) for Ubuntu
  quirk-freedom (USB controller reset behavior under sustained capture load).

### 2.10 Power + network + monitoring (prices verified)

| Item | Price (26 Sep 2026) | Source |
|---|---|---|
| APC BX600C-IN 600 VA / 360 W UPS | ₹4,299 list; avg ₹3,486 over history | Amazon.in / pricehistory.app |
| TP-Link TL-SG1008D 8-port gigabit switch | ₹2,999 (avg ₹2,000); Omada ES208G ₹1,699 at Moglix | pricehistory.app / moglix |
| Sony MDR-XB450 closed headphones (monitor use) | ₹1,899 (Sony MRP ₹2,190 incl. taxes) | sony.co.in where-to-buy page / Flipkart |
| (better) ATH-M20x | ₹4,299–4,498 | Flipkart / Amazon.in |
| Powered USB 3.0 hub | **UNVERIFIED** band ₹800–3,000 | v1 |
| PCIe/combi 3.5mm adapters, cable set | **UNVERIFIED** band ~₹1,000 | — |

## 3. Two bundles (lean / full), rupee totals

Prices below are the dated quotes from §2. Lines marked *(NV)* are
UNVERIFIED planning bands.

### 3.1 LEAN — 4 stream paths, 2 room mics, no wireless

Reference design: C920 (video + witness mic), TC-777 (main), UMC404HD with
BM3032 on input 1 and ECM8000 on input 2, **inputs 3–4 deliberately empty**
(mic count is v1's open question — defer it, the channels are there).

| Line | Item | ₹ |
|---|---|---|
| Host | Beelink S12 Pro N100/16/500 *(price distressed; plan band 30–45k)* | 30,000 (NV) |
| Video | Logitech C920 | 8,945 |
| Main mic | TONOR TC-777 | 1,999 |
| Interface | Behringer UMC404HD | 18,999 |
| Room mic 1 | Boya BY-BM3032 shotgun (+ TRS patch lead) | 5,399 |
| Room mic 2 | Behringer ECM8000 (table omni) | 4,799 |
| Monitor | Sony MDR-XB450 | 1,899 |
| Master storage | 1 TB NVMe M.2 internal (host slot) | 5,500 (NV) |
| Backup storage | Seagate Expansion 4 TB ×1 | 15,999 |
| Network | TP-Link SG1008D switch + 2 patch leads | 2,999 |
| Power | APC BX600C-IN UPS | 4,299 |
| Harness | powered hub, adapters, USB lead spare (NV) | 2,500 |
| | **LEAN TOTAL** | **₹103,337** |
| | **LEAN TOTAL, host reused** | **₹73,337** |

Range with honest bands: host ₹30–61.85k, storage oscillates between sale
floors and list price → **lean ≈ ₹72k–1.03 lakh** (host reused, low band) up
to ₹1.35 lakh (worst-case list price + host). Note both bundles now sit ABOVE v1's "₹45,000" floor
because interface/webcam/HDD lines corrected upward — the ₹45k floor was
already only reachable with host + unknown-quality gear.

### 3.2 FULL — adds 2 XLR lapels, wireless pair, second backup, bigger master

Same as lean, plus:

| Line | Item | ₹ |
|---|---|---|
| Wireless | Hollyland Lark M2 Camera version (rec → UMC404HD input 3) | 11,999 |
| Lapels | 2 × Boya BY-M8OD XLR lav (need 48 V) *(price UNVERIFIED, 7.7k each Delhi quote)* | 15,466 (NV) |
| Backup #2 | Seagate 4 TB (two copies before age-out, per v1 §7.1) | 15,999 |
| Master | 2 TB class NVMe/SSD instead of 1 TB | +4,500 (NV) |
| | **FULL DELTA** | **+₹47,964** |
| | **FULL TOTAL (incl. lean+host)** | **₹151,301** |
| | **FULL TOTAL, host reused** | **₹121,301** |

Round-number statement for the decisions memo: **lean ≈ ₹1.03–1.35 lakh; full
≈ ₹1.21–1.5 lakh**. Buying storage/backup during a Big-Birthday-class sale
event respects the only verified rock-bottom prices (₹7.5k SSD, ₹4.9k HDD)
and saves ₹25k+. No purchase is authorised by this document (v1 status
carries over). Totals corrected 29 Sep 2026 to make the listed lines sum
exactly (was a ₹995 slip in the earlier stated totals).

### 3.3 Bundle notes

- Wireless stays **optional** in the full bundle for the reason v1 gave, which
  v2 confirmed is not yet de-risked: receiver level/balancing into the
  interface is UNVERIFIED. Buy last, bench first.
- The FULL bundle's ₹120–150k is still inside v1's own ₹45k–1.5 lakh envelope
  only because v1's envelope was coarse; nothing about the design grew.
- Zero-cost softeners: the TC-777 doubles as a talkback/test mic, the webcam
  mic as the witness — no extra purchase for the redundancy rule (v1 §5.3).

## 4. Empty-OT test plan — one page, SELFTEST sound, 60-minute drift probe

Purpose: prove the box (any bundle) behaves in an **empty OT with no people
present** before any session with one. Everything the test plays is
invented/synthetic: pure tones, a fixed canary word, hand claps. Candidate
sounds vocabulary:

- **Tone** (`SELFTEST-TONE`): 1 kHz sine at phone/tablet loudness, played from
  the subject position, 30 s. Checks: each channel hears it (level sanity),
  right channel map (shotgun ≠ table ≠ lapel ≠ main), no clipping at session
  gain, and (India, 50 Hz mains) a hum check — noise floor at 50/100/150 Hz
  must stay ≥ 30 dB below the tone envelope in each channel.
- **Canary word** (`SELFTEST-CANARY`): one fixed nonsense-word phrase, e.g.
  *"pilot lantern fourteen"*, spoken 3× at head, mid, tail. Checks: speech is
  intelligible on every stream, becomes a searchable text marker afterwards
  (post-transcode of derived copy — no human subject required), and marks
  sample-rate sanity (e.g. playback of a 440 Hz tone before each phrase flags
  speed errors audibly).
- **Clap** (`SELFTEST-CLAP`): one loud hand clap, waist height, 1 m from
  subject position, at head / mid (+30 min) / tail (60 min). This is the sync
  skeleton (v1 §4.4, §5.1).

Procedure (single page to print and tape to the box):

```
T-15  Power on: mini PC, interface (PSU brick), webcam, mic; wait 5 min thermal settle.
T-10  Start launcher; confirm all 4 stream cards + watchdog file-growth green.
T-5   TONE 30 s at subject position.  Check meter on each channel: present, unclipped.
T-4   CLAP once.              [head sync]
T-3   CANARY ×3 ("pilot lantern fourteen"), from subject position.
T-0   RECORDERS ON via launcher (recorder start printed into manifest).
+30   CLAP once. CANARY ×3.   [mid sync / drift bracket]
+60   CLAP once. CANARY ×3.   [tail sync]
+62   RECORDERS OFF. Checksum all files. Manifest complete (v1 §4.3 fields).
+65   rsync to lab; verify checksums; record test session in log as SELFTEST.
```

Acceptance checks (each must pass before the box is trusted):

| # | Check | Pass condition | Run on |
|---|---|---|---|
| 1 | Files exist & grew | every stream file non-empty; watchdog log shows growth at ≥1-checkpoint per minute | local |
| 2 | Lengths agree | pairwise stream duration delta ≤ 2 s | local |
| 3 | Tone land | tone RMS ≥ −55 dBFS on every channel; no channel above full-scale | ffmpeg / sox |
| 4 | Hum scan | 50/100/150 Hz peaks ≥ 30 dB below tone RMS | sox spectrogram |
| 5 | Canary legible | canary phrase produces a clean readable opportunity in every stream's audio after alignment | lab |
| 6 | Clap sharp | each clap found by cross-correlation in all audio + webcam mic | sync script |
| 7 | Linear fit | from 3 claps, `audio_time = a + b·video_time` fit; predicted mid-clap residual ≤ 33 ms (1 frame @30fps) | sync script |
| 8 | Drift budget | worst pairwise rate-ratio error \|b−1\| ≤ 100 ppm (pairs vs the ±50 ppm-per-clock budget) | sync script |
| 9 | Derived copy | 720p derived + timecode plays; playback duration equals master duration | lab |

Failure paths: check 7–8 fail → tighten the mid-clap cadence (every 20 min) or
resample at 15-min intervals; check 4 fail → move interface to its own PSU
brick (v1 §3.3; the UMC404HD has one); check 3 low on one channel only →
re-run with gain re-set. Report the measured ppm values as the number that
sizes all future sessions — they replace v1's ±50 ppm assumption.

## 5. Decisions V must make (plain words, one line each)

1. **Purchase**: approve a bundle and a rupee ceiling; lean ≈ ₹1.0–1.35 lakh
   with host (≈ ₹72k if the host is reused), full ≈ ₹1.2–1.5 lakh. Until V
   decides, no purchase happens.
2. **Host**: reuse an existing PC or buy the Beelink N100? This is the single
   biggest line (₹30k or zero). Needs an answer because the SSD/storage plan
   follows from it.
3. **Room mics**: 2 (lean) or 4 (full with lapels, plus the wireless slot)?
   The interface has 4 inputs; channels can be left empty.
4. **Wireless**: buy the Lark M2 pair only if the bench test (receiver
   3.5 mm → interface input at sane level) passes first.
5. **Consent**: SETTLED (V ruling D-3, 29 Sep 2026). The video stream is the
   surgical device's telemetry display, not a recording of a person, and V has
   settled consent for it. No consent flow appears in this design and it is not
   an open decision. Where the test plan mentions anything being captured, it
   captures only the device display and ambient room audio.
6. **Retention**: how long do masters and derived copies live (30 days? 1
   year? forever?) — it sets the backup drive count and the lab-side policy.
   v1's §6.3 table brackets 1 month at ~1.1 TB and 3 months at ~3.2 TB.
7. **Viewers**: who may open a derived link, do links expire and after how
   long, and is there any view log (even a count). Rule already fixed in v1:
   no inbound port-forwarding, ever; live view only from the lab side, if at
   all — V decides whether Tier-1 live view (teaching/supervision) is in.

## 6. Sources (all accessed 26 Sep 2026 unless dated inline)

1. linux-hardware.org — Logitech C920 (046d:082d) kernel support entry.
2. LKML patch, Oleksandr Natalenko, 25 Mar 2024 — UVC quirk INVALID_DEVICE_SOF for C920.
3. LKML patch 2/2, Pol Fernández, 29 Jun 2026 — C920 (046d:08e5) entry, NO_FORCE_QUALITY, DROP_STREAM_ERR.
4. askubuntu.com/questions/1128694 — C920 microphone enumerated via snd_usb_audio; mic control script guide (tested Ubuntu 24.04.1).
5. logitech.com — C920s product page (1080p30, dual mics, privacy shutter).
6. behringer.com — U-PHORIA UMC404HD product page (4x4, 24bit/192k, Midas preamps, +48V).
7. ardour.org forum + linuxmusicians.com threads (2020) + archlinux.org forum (May 2025) — UMC404HD Linux behaviour: ALSA 4-ch S32_LE 44.1–192k, U192k name, bus-power vs PSU, PipeWire Pro Audio profile.
8. tonormic.com — TC-777 product page (plug and play).
9. randommomentania.com TC-777 review (Jul 2020) — tested working on Ubuntu 20.04; christcenteredgamer review (48k, S/N 56 dB); mictests.com review (48000 Hz, 16-bit, 1 ch).
10. Amazon.in B07WLWN2ZT — TC-777 ₹1,999 (Cocoblu) + ₹4,498 etc. as of 26 Sep 2026. pricehistory/cheapestinindia history: low ₹1,849 May 2026.
11. Amazon.in B00QHURLHM — UMC404HD ₹18,999; proaudiobrands ₹21,499; sangeethmahal ₹21,999; bharatmusichouse ₹23,000.
12. Amazon.in B006JH8T3S — C920 ₹8,945 (Clicktech) — 26 Sep 2026.
13. bajaao.com — Boya BY-BM3032 ₹5,399; taranamusical same.
14. low-XLR-omni: vplak (₹4,799), bajaao (₹3,999, out of stock), pasystem (₹5,224), devmusical (₹5,939) — ECM8000.
15. Amazon.in B076B8G5D8 / pricehistory — BY-M1 ₹949 (26 Sep 2026). Product pages — M8OD XLR omni lapel specs, 48 V phantom; e-trovato aggregator Delhi ₹7,733 (no date — UNVERIFIED).
16. in.hollyland.com — Lark M2 store prices: Camera ₹11,999 / Combo ₹12,999 / Type-C ₹9,999 (26 Sep 2026). Amazon.in ₹11,998–11,999. chaotechh.com (Mar 2026) — DJI Mic 2 / Rode GO II comparisons.
17. Amazon.in B087DFLF9S / B087DF1L2J — Samsung T7 1TB ₹21,999/23,999; mdcomputers ₹22,280; pricehistory.app — historic low ₹7,499 (Oct 2024).
18. Amazon.in B08ZJFH7Y1 — Seagate Expansion 4TB portable ₹15,999; pricehistory.app — avg ₹11,443, sales to ₹4,899; vijaysales ₹14,449; amazon.in B092R6S16L desktop 4TB ₹15,799.
19. Amazon.in B0BVR3HTKF / pricehistory.app — Beelink S12 Pro N100: current ₹61,850 (4 Sep 2026),historic low ₹29,309 (May 2025); listing says supports Ubuntu installation.
20. Amazon.in B016XVRKZM / pricehistory.app — APC BX600C-IN ₹4,299 (avg ₹3,486).
21. pricehistory.app / moglix — TP-Link SG1008D ₹2,999 (avg ₹2,000), Omada ES208G ₹1,699.
22. sony.co.in MDR-XB450 where-to-buy (MRP ₹2,190 incl. taxes); Flipkart ₹1,899.ATH-M20x ₹4,299–4,498 (Flipkart/Amazon.in).
23. linux-hardware.org — Behringer UMC404HD device entry 1397:0509.

## 7. Related

- Predecessor: `~/fable/ORBOX-DESIGN.md` (v1).
- Order: Fable W29.1, 26 Sep 2026. Design artifact only; procures nothing.
