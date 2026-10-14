# ORBOX kit list for vendor quote

Status: **paperwork only.** Nothing bought, nothing ordered, no vendor
contacted, nothing built (V ruling D-5, 29 Sep 2026). Task T-ORBOX-5, per V
rulings D-2..D-5 (Fable #6990): itemised kit list for a quote; the room carries
**both microphones and speakers** (D-2); the video stream is the **robotic
surgical device's telemetry display**, not a recording of a person, and consent
is already settled (D-3) — no consent item exists here; keep holding on build
(D-5). Prices are dated single quotes, 26 Sep 2026 unless re-noted; anything
without a dated quote is **UNVERIFIED**.

Base: `~/oc/orbox/ORBOX-DESIGN-v2.md` as amended 29 Sep 2026 (same directory).

## 0. What changed vs the design-v2 bundles

1. The v2 bundles priced microphones only. This list re-prices for D-2 by
   adding a **speakers** line to each bundle (lean: 1 powered pair; full: 2
   pairs on opposite sides of the OT).
2. The v2 "webcam" video line is re-titled by D-3: the authoritative video
   stream is now an **HDMI→USB (UVC) telemetry capture card** taking the
   surgical device's display output. A UVC capture card adds another USB clock
   device; v2's manifest + head/mid/tail-clap sync discipline applies to it
   unchanged (the empty-OT test plan already measures drift per stream).
3. The Logitech C920 line from v2 §2.1 is **retained as the carry-over
   room/side camera and free second-microphone witness** — the base bundles
   carried it, its mic stays the independent redundancy witness, and its
   widest view documents the room being instrumented. Strike it from the
   quote if V drops the room camera; the totals note that variant.
4. Correction to v2 while re-deriving totals: v2's stated LEAN total ₹102,342
   should read **₹103,337** (the listed lines sum to that; a ₹995
   transcription slip). v2 has been corrected in the same pass; this document
   uses corrected arithmetic throughout.

## A. Microphones (D-2)

| # | Item | Qty | Spec floor | Purpose | Unit ₹ (status, date) |
|---|------|-----|-----------|---------|----------------------|
| A1 | Behringer U-Phoria UMC404HD | 1 | 4 combi XLR/TRS inputs, 24-bit/48 kHz+, class-compliant USB Audio, own PSU, 4 preamps, switchable +48 V, TRS/RCA playback outs | One clock for all room mics (v2 §2.2); also drives room speakers from its playback outs | 18,999 (quoted, Amazon.in B00QHURLHM, 26 Sep 2026) |
| A2 | TONOR TC-777 | 1 | USB 2.0 UAC, Linux plug-and-play, 48 kHz/16-bit mono, cardioid | Main close mic | 1,999 (quoted, Amazon.in B07WLWN2ZT, 26 Sep 2026) |
| A3 | Boya BY-BM3032 super-cardioid shotgun | 1 | Battery-powered condenser, gain −10/0/+20 dB, HPF 0/75/150 Hz, 3.5 mm TRS output into a UMC404HD combi input via TRS patch lead (phantom OFF) | Directional mic, subject side | 5,399 (quoted, bajaao.com, 26 Sep 2026) |
| A4 | Behringer ECM8000 XLR omni | 1 | XLR, +15–48 V phantom, flat-response omni, table-stand mount | Table/room reference mic (interface ch 2) | 4,799 (quoted, vplak.com, 26 Sep 2026; ₹3,999 at Bajaao when restocked) |
| A5 | Boya BY-M8OD XLR lapel | 2 | XLR 3-pin, +48 V phantom, 2 m cable, omni, brass body | Hands-free lapels on interface ch 3–4 (FULL only) | 7,733 each (UNVERIFIED — single Delhi aggregator listing, no date; get counter-quotes) |
| A6 | Logitech C920 UVC webcam | 1 | 1080p30 UVC, manual exposure/focus via v4l2-ctl, dual stereo mics via snd_usb_audio | Carry-over room/side camera + free second mic as the independent witness path (v2 §2.1) | 8,945 (quoted, Amazon.in B006JH8T3S, 26 Sep 2026) |
| A7 | Hollyland Lark M2 Camera version (2 TX + camera RX with 3.5 mm out) | 1 | 2.4 GHz, 48 kHz/24-bit; RX 3.5 mm output fed into a UMC404HD input so it rides the interface clock (output level must be bench-passed first — UNVERIFIED) | Wireless directional option for the far side (FULL only, bought last per v2 §2.7) | 11,999 (quoted, in.hollyland.com, 26 Sep 2026) |

Microphone sub-totals: LEAN (A1–A4 + A6) = **40,141**; FULL (A1–A7) = **67,606**.

## B. Speakers (D-2 — new scope)

| # | Item | Qty | Spec floor | Purpose | Unit ₹ (status, date) |
|---|------|-----|-----------|---------|----------------------|
| B1 | Edifier R1280DB powered bookshelf pair | 1 pair (LEAN), 2 pairs (FULL) | Active 2.0, 42 W RMS, wired line inputs (RCA/3.5 mm + optical), volume control on set, mains switch; no network features needed — wired input only (leave Bluetooth unused) | Room audio out around the OT: playback of channel checks, SELFTEST tones, lab-side audio. Fed line-level from the UMC404HD's playback outs; powered from the UPS's surge-only path, not the battery path | 13,490 / pair (quoted, Amazon.in B06XGG6MFV, 26 Sep 2026; Flipkart same list) |
| B2 | TRS 6.35 mm → RCA mono lead pair | 1 set per speaker pair | 2 × shielded TRS→RCA leads, 1–2 m | Interface playback outs → speaker line inputs | 300 / set (UNVERIFIED band 300–600) |

Speakers sub-totals: LEAN (1 pair + 1 lead set) = **13,790**; FULL (2 pairs + 2 lead sets) = **27,580**.

## C. Telemetry video capture (D-3 — new scope)

| # | Item | Qty | Spec floor | Purpose | Unit ₹ (status, date) |
|---|------|-----|-----------|---------|----------------------|
| C1 | PiBOX India VC-303 GEN3 HDMI→USB 3.0 capture (LEAN line) | 1 | UVC/UAC 1.0, vendor-claimed plug-and-play on Linux, MS2130, 1080p@60 capture MJPEG+YUV, HDMI input up to 4K@30 | Telemetry: the surgical device's display output → host over USB 3.0 as a standard UVC device. Adds one more USB clock; v2's manifest + clap sync covers it like any other stream | 762 excl GST (quoted, pibox.in, 29 Sep 2026; ≈ 899 incl 18% GST) |
| C2 | PiBOX India VC-305-D PRO HDMI→USB 3.0 capture (FULL, replaces C1) | 1 | MS2131, USB capture 1080p@60 / 2K@30, **4K@30 HDMI loop-out** so the OT's local display keeps its feed while the box records; 3.5 mm mic in; SPDIF out | Same as C1 plus a built-in loop-out tee (so no separate splitter is needed) | 1,355 excl GST (quoted, pibox.in, 29 Sep 2026; ≈ 1,599 incl 18% GST) |
| C3 | High-speed HDMI lead + (LEAN only) 1×2 HDMI splitter with EDID hold | 1 each | HDMI 1.4+, 2 m; splitter needed in LEAN only because C1 has no loop-out | Device output → capture card while the physical display keeps its feed | 500 both (UNVERIFIED band 400–1,000) |
| C4 | HDMI/display adapters to match what the device actually outputs | 1 | As determined at install (mini-HDMI/proprietary — UNVERIFIED until seen) | Connect the device's display output | 800 (UNVERIFIED band 300–800) |

Capture sub-totals: LEAN (C1 + C3) = **1,399**; FULL (C2 + C3 + C4) = **2,899**.

## D. Compute, storage, power, network (carried over from v2, re-listed for the quote)

| # | Item | Qty | Spec | Unit ₹ (status, date) |
|---|------|-----|------|----------------------|
| D1 | Beelink S12 Pro mini PC (N100, 16 GB, 500 GB NVMe) | 1 | 4C/4T, USB 3, gigabit; vendor page states Ubuntu install supported; extra M.2 + 2.5" bay | 30,000 (band; current Amazon.in listing ₹61,850 dated 4 Sep 2026 is distorted — historic low ₹29,309, May 2025) |
| D2 | 1 TB NVMe M.2 internal SSD (2 TB in FULL) | 1 | Sustained write comfortably ≥ the ~6 GB/h master rate | 5,500 (UNVERIFIED band; +4,500 for the 2 TB step-up, UNVERIFIED) |
| D3 | Seagate Expansion 4 TB external HDD (off-box copy before a session counts as done) | 1 (LEAN) / 2 (FULL) | 2.5" portable or 3.5" desktop; the specific drive's CMR-vs-SMR status remains UNVERIFIED until checked on receipt | 15,999 (quoted, Amazon.in B08ZJFH7Y1, 26 Sep 2026; sale floors ₹4.9–7.5k) |
| D4 | Sony MDR-XB450 headphones | 1 | Closed, wired, 3.5 mm | 1,899 (quoted, sony.co.in / Flipkart, 26 Sep 2026) |
| D5 | TP-Link TL-SG1008D 8-port gigabit switch + 2 patch leads | 1 | Unmanaged gigabit | 2,999 (quoted, pricehistory / Amazon.in, 26 Sep 2026) |
| D6 | APC BX600C-IN 600 VA UPS | 1 | 360 W, line-interactive | 4,299 (quoted, Amazon.in, 26 Sep 2026) |
| D7 | Harness: powered USB 3.0 hub, spare USB leads, labelling, velcro | 1 set | Individually switchable hub ports | 2,500 (UNVERIFIED band) |

D-subtotals: LEAN (D1–D7, D3 ×1) = **63,196**; FULL (D3 ×2, D2 2 TB +4,500) = **83,695** (incl. host both).

## E. Totals per bundle

| Bundle | What it carries | Total |
|---|---|---|
| **LEAN, host included** | A1–A4 + A6; B1 ×1 + B2 ×1; C1 + C3; D1–D7 | **₹118,526** (₹88,526 host reused) |
| **FULL, host included** | LEAN + A5 ×2 + A7 + B1 ×1 pair more + B2 ×1 more + C2 replacing C1 (+₹700) + C4 + D3 ×1 more + 2 TB master step-up | **₹181,780** (₹151,780 host reused) |
| Optional variant: host reused and the C920 room-camera line dropped | LEAN minus A6 | ₹79,581 |

Cross-check (lean, incl. host): A 40,141 + B 13,790 + C 1,399 + D 63,196 = 118,526 ✓.
Cross-check (full, incl. host): A 67,606 + B 27,580 + C 2,899 + D 83,695 = 181,780 ✓.

Range statements for the decisions memo: **lean ≈ ₹1.19 lakh** (host reused:
₹0.89 lakh), **full ≈ ₹1.82 lakh** (host reused: ₹1.52 lakh). The two biggest
swing bands remain the host (₹30–61.85k listed, judged flag not market) and
storage (₹16k list vs ₹5–7.5k sale floors). Nothing was ordered, built or sent
anywhere (D-5); this list exists so a vendor quote can be filled in when V
opens the purchase.

## F. Notes for whoever fills the vendor quote (paperwork statements, not purchases)

1. Every price carries its quote date and needs a fresh quote at purchase.
2. Items flagged UNVERIFIED need a counter-quote or shop confirmation.
3. Bench items before commit: UMC404HD phantom budget + PSU behaviour with four
   condensers (v2 §2.2); Lark M2 receiver level into the interface (v2 §2.7);
   the specific 4 TB drive's recording profile (v2 §2.8); TC-777 enumerating at
   48 kHz (v2 §2.3).
4. The speakers are consumer sets used wired-only; if a pro powered pair at a
   comparable price shows up in the counter-quote, it may be substituted — the
   spec floor only asks for powered, wired, line-level inputs.
5. The video path per D-3 records only the surgical device's display output.
   No person is filmed, no consent item exists, and the design doc's §5
   decision list carries the settled status.

## G. Sources

Items carried over from design-v2: see `ORBOX-DESIGN-v2.md` §6 (23 dated
sources, 26 Sep 2026). New on 29 Sep 2026:

1. Amazon.in B06XGG6MFV + Flipkart — Edifier R1280DB ₹13,490/pair (accessed 29 Sep 2026).
2. pibox.in — PiBOX VC-303 GEN3 ₹761.86 excl GST; VC-305-D PRO ₹1,355.08 excl GST; MS2130/MS2131 chipset, UVC/UAC 1.0, plug-and-play claims incl. Linux (accessed 29 Sep 2026).
3. Alternates noted for the quote: Tobo HDMI capture 1080p30 ₹699 (Amazon.in B09LSYGZ3W); Elgato Cam Link 4K ₹8,399 (vlebazaar.in); Behringer MS16 pair ₹19.4–23k (Sound by Broot / MusicVille / VPLAK) — dearer than the Edifier pair for the same job, so not in the totals.
