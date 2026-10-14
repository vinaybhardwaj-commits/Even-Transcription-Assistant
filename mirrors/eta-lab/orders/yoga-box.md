# RULINGS — the three calls in your §5-6 — 20 Sep 07:30

Good corrections, and volunteering both of them unprompted is worth more than the install itself.
Noted: the multi-day estimate was wrong (an hour), the onnxruntime pin did not fix the ONNX load
(HF's symlinked cache did, via HF_HUB_DISABLE_SYMLINKS=1), and the model download had silently
aborted at 5.4 MB of 2438 MB. That last one is the kind of failure that would have been blamed on
the model for a week.

## 1. Inbound reachability — DO THIS FIRST, before anything else
One curl from the Mini to the Yoga, both engines, `/healthz` then a real `/inference` on a short
clip. Until that passes, everything else here is theory: binding 0.0.0.0 and an inactive firewall
prove the Yoga is willing, not that the Mini can reach it. Tailscale ACLs, MTU on the tunnel, and
the Mini's own egress are all untested in that direction.

If it fails, stop and report. Do not start debugging persistence for a service nothing can reach.

## 2. Persistence — YES, but only after reachability passes
A systemd user unit, mirroring the Mini's launchd RunAtLoad/KeepAlive. nohup is fine for a test
and wrong for anything we route production work to — the first reboot would silently remove half
our transcription capacity, and nobody would notice until the Indic queue backed up.

Do not enable lingering beyond what the unit needs.

## 3. The speed comparison — ACCEPTED as load-dependent, and say so in the report
You are right that the Mini was serving live production throughout, so the figures are not a
clean capability comparison. Record them as load-dependent and do NOT let anyone quote them as
Yoga-versus-Mini capability. I have already made the error of dividing a contended number by an
uncontended one once today — 24x that was really 10.4x — and I am not repeating it.

If we ever route real Indic traffic here, we re-measure with both boxes in a known state.

## 4. The sravaani 900 s failure — agreed, not a blocker
It fails identically on the Mini, the size limit is baked into the model's own TorchScript export
upstream, and the router never sends more than 30 s. Record it and move on.

## 5. The torch version gap — keep it visible
Mini runs 2.12.0 (indic) and 2.8.0 (sravaani); Yoga runs 2.14.0+cpu on both, because Python 3.14
only has cp314 wheels for 2.14.0. Same weights, same transformers, different torch. You said the
Step 3 sanity check exists to catch exactly this and you would report it alongside the numbers
rather than bury it — that is exactly right, and it is now the most important thing that check
does. If the edit distance comes back non-trivial, torch is the first suspect.

## Unchanged
The recorder stays untouched — `room_7egw2my6` keeps its open session and you do not take the box
down without telling me first. Counts and timings only in the report; no transcript text, names
or room labels.
