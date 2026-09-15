#!/bin/bash
# U1 step 4: take the Yoga's sound card away for real, then give it back. NEEDS ROOT.
# Unbinds the ASoC machine driver (skl_hda_dsp_generic), which removes card 0 and every /dev/snd/pcmC0D* node, waits
# DOWN seconds, then binds it again. An open capture stream sees ENODEV; the card returns as sofhdadsp with the same PCMs.
# usage: sudo tools/u1-device-cycle.sh [DOWN_SECONDS]   (default 5)
set -eu
down=${1:-5}
drv=/sys/bus/platform/drivers/skl_hda_dsp_generic
dev=skl_hda_dsp_generic
[ -e "$drv/$dev" ] || { echo "$dev is not bound to $drv; nothing to cycle" >&2; exit 1; }
echo "$(date +%T.%N) unbinding $dev"
echo "$dev" > "$drv/unbind"
ls /dev/snd/pcmC0D6c 2>/dev/null && echo "WARNING: pcmC0D6c still present" || echo "$(date +%T.%N) card removed (pcmC0D6c gone)"
sleep "$down"
echo "$(date +%T.%N) binding $dev"
echo "$dev" > "$drv/bind"
for i in $(seq 1 50); do [ -e /dev/snd/pcmC0D6c ] && break; sleep 0.1; done
ls -la /dev/snd/pcmC0D6c && cat /proc/asound/cards
