#!/bin/bash
# M2.3: how long after boot the pinned USB mic's PCM node appears, and where a multi-user.target service would start
# relative to it. Reads the persistent journal, so it works retroactively for any recorded boot: no unit, no root.
# usage: tools/u2-boot-enum-probe.sh [BOOT_INDEX] [VID:PID]   (0 = current boot, -1 = previous, …)
set -u
b=${1:-0}
vid_pid=${2:-0d8c:0134}
vid=${vid_pid%%:*}; pid=${vid_pid##*:}

echo "boot $b: $(journalctl --list-boots 2>/dev/null | awk -v b="$b" '$1 == b {print $2, $3, $4, $5}')"
k=$(journalctl -k -b "$b" -o short-monotonic 2>/dev/null)
j=$(journalctl -b "$b" -o short-monotonic 2>/dev/null)
mono() { sed -n 's/^\[ *\([0-9.]*\)\].*/\1/p' <<< "$1" | head -1; }

# journalctl -k is NOT kernel-only: systemd in the initrd logs via /dev/kmsg, so its lines are interleaved here.
# A fixed -B window around the descriptor line therefore misses the port line. Find the port from the match instead.
usb_line=$(grep -m1 "idVendor=$vid, idProduct=$pid" <<< "$k")
port=$(sed -n 's/.* kernel: \(usb [0-9][0-9.-]*\):.*/\1/p' <<< "$usb_line")
port_line=""
[ -n "$port" ] && port_line=$(grep -m1 "$port: new .* USB device number" <<< "$k")
snd_line=$(grep -m1 "registered new interface driver snd-usb-audio" <<< "$k")

# Anchor targets to PID 1. The per-user manager reaches sound.target and graphical-session-pre.target too, and a
# loose "Reached target .*graphical" matches the user manager's line first, which is several seconds early.
tgt() { grep -m1 "systemd\[1\]: Reached target $1" <<< "$j"; }
snd_t=$(tgt "sound.target"); mu=$(tgt "multi-user.target"); gfx=$(tgt "graphical.target")

# The PCM capture node itself. devtmpfs nodes are recreated every boot, so birth time is readable for the current
# boot only; for an older boot the snd-usb-audio line below is the closest proxy the journal retains.
node=""; t_node=""
for f in /proc/asound/card*/usbid; do
    [ -r "$f" ] && [ "$(cat "$f" 2>/dev/null)" = "$vid_pid" ] || continue
    n=${f%/usbid}; n=${n##*/card}; node="/dev/snd/pcmC${n}D0c"
done
if [ "$b" = "0" ] && [ -n "$node" ] && [ -e "$node" ]; then
    a_m=$(mono "$(head -1 <<< "$k")")
    a_w=$(journalctl -k -b "$b" -o short-unix 2>/dev/null | head -1 | cut -d' ' -f1)
    birth=$(date -d "$(stat -c %w "$node")" +%s.%N 2>/dev/null)
    [ -n "$birth" ] && [ -n "$a_w" ] && t_node=$(awk -v x="$birth" -v w="$a_w" -v m="$a_m" 'BEGIN{printf "%.6f", x-(w-m)}')
fi

# ${v:+a}${v:-b} would print a AND the raw value when v is set; pick one branch explicitly.
fld() { printf "  %-34s %s\n" "$1" "${2:-$3}"; }
fld "USB device detected (kernel):" "${port_line:+t=$(mono "$port_line") s  ($port)}" "(the mic did not enumerate in this boot)"
fld "descriptor read ($vid_pid):"   "${usb_line:+t=$(mono "$usb_line") s}" "(no descriptor line)"
fld "snd-usb-audio driver registered:" "${snd_line:+t=$(mono "$snd_line") s}" "(driver not registered)"
fld "PCM node ${node:-(card not present)}:" "${t_node:+t=$t_node s  (devtmpfs birth)}" "(current boot only)"
fld "sound.target reached:"      "${snd_t:+t=$(mono "$snd_t") s}" "(not reached)"
fld "multi-user.target reached:" "${mu:+t=$(mono "$mu") s}" "(not reached)"
fld "graphical.target reached:"  "${gfx:+t=$(mono "$gfx") s}" "(not reached)"
echo "  (a service WantedBy=multi-user.target starts at the multi-user line; compare it with the PCM node line above)"

# Was this boot preceded by an unclean shutdown, and did the journal lose anything?
echo "  previous-boot cleanliness:"
found=0
while IFS= read -r line; do
    [ -n "$line" ] && { printf "    %s\n" "$line"; found=1; }
done < <(journalctl -b "$b" -o short-iso 2>/dev/null |
         grep -iE "corrupted or uncleanly shut down|recovering journal|Dirty bit is set|orphan" |
         sed 's/^[^ ]* [^ ]* //' | head -8)
[ "$found" = 0 ] && echo "    (no unclean-shutdown marker: previous shutdown was clean)"
prev=$((b - 1))
last_prev=$(journalctl -b "$prev" -o short-iso-precise 2>/dev/null | tail -1 | cut -d' ' -f1)
first_this=$(journalctl -b "$b" -o short-iso-precise 2>/dev/null | head -1 | cut -d' ' -f1)
printf "    %-30s %s\n" "last entry of boot $prev:" "${last_prev:-(none)}"
printf "    %-30s %s\n" "first entry of boot $b:" "${first_this:-(none)}"
printf "    %-30s %s\n" "journals renamed by journald:" "$(ls /var/log/journal/*/*.journal~ 2>/dev/null | wc -l) file(s)"
printf "    %-30s %s\n" "journalctl --verify:" "$(journalctl --verify 2>&1 | grep -c '^PASS') PASS, $(journalctl --verify 2>&1 | grep -ciE '^(FAIL|WARN)') FAIL/WARN"
