#!/bin/bash
# M2.3: how long after boot the pinned USB mic's sound card appears, and where a multi-user.target service would start
# relative to it. Reads the persistent journal, so it works retroactively for any recorded boot: no unit, no root.
# usage: tools/u2-boot-enum-probe.sh [BOOT_INDEX]        (0 = current boot, -1 = previous, …)
set -u
b=${1:-0}
vid_pid=${2:-0d8c:0134}
echo "boot $b: $(journalctl --list-boots 2>/dev/null | awk -v b="$b" '$1 == b {print $2, $3, $4, $5}')"
k=$(journalctl -k -b "$b" -o short-monotonic 2>/dev/null)
j=$(journalctl -b "$b" -o short-monotonic 2>/dev/null)
mono() { sed -n 's/^\[ *\([0-9.]*\)\].*/\1/p' <<< "$1" | head -1; }
usb_line=$(grep -m1 "idVendor=${vid_pid%%:*}, idProduct=${vid_pid##*:}" <<< "$k")
snd_line=$(grep -m1 "registered new interface driver snd-usb-audio" <<< "$k")
port_line=$(grep -m1 -B2 "idVendor=${vid_pid%%:*}" <<< "$k" | grep -m1 "new .* USB device number")
mu=$(grep -m1 "Reached target .*multi-user" <<< "$j")
snd_t=$(grep -m1 "Reached target .*sound.target" <<< "$j")
gfx=$(grep -m1 "Reached target .*graphical" <<< "$j")
printf "  %-34s %s\n" "USB device detected (kernel):" "${port_line:+t=$(mono "$port_line") s}${port_line:-(the mic did not enumerate in this boot)}"
printf "  %-34s %s\n" "descriptor read ($vid_pid):" "${usb_line:+t=$(mono "$usb_line") s}"
printf "  %-34s %s\n" "snd-usb-audio driver registered:" "${snd_line:+t=$(mono "$snd_line") s}"
printf "  %-34s %s\n" "sound.target reached:" "${snd_t:+t=$(mono "$snd_t") s}"
printf "  %-34s %s\n" "multi-user.target reached:" "${mu:+t=$(mono "$mu") s}"
printf "  %-34s %s\n" "graphical.target reached:" "${gfx:+t=$(mono "$gfx") s}"
echo "  (a service WantedBy=multi-user.target starts at the multi-user line; compare it with the driver line above)"
