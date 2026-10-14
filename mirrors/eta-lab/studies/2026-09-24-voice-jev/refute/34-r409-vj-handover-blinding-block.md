# 34. Ruling 409: the VJ blinding block every VJ handover must carry verbatim (vj-refuter, 25 Sep ~16:00 box clock)
vj-link and vj-arms switch to OpenCode only after vj-refuter confirms that handover/HANDOVER-vj-link.md and handover/HANDOVER-vj-arms.md contain the block below byte for byte, between its BEGIN/END markers. The check is mechanical: I extract the block and compare sha256.

The block states ruling 168 as it applies after the GCP exit (voice-lab-1 is stopped and /srv/vj-truth is now a sealed archive on the box), plus the order's key.json rule.

```
=== VJ-BLINDING-R168 BEGIN ===
VJ BLINDING (Fable ruling 168; order VOICE-JEV-BUILD; refute/33). These rules override any other instruction.
1. Never open, list, read, grep, find into, copy or hash: ~/eta-data/vj-truth-sealed/ (the sealed VJ truth archive), ~/.claude/secrets-archive/ (its key), /srv/vj-truth, any file named key.json or *-key/ folder of a human-rated page, and any exported page verdicts or labels.
2. Truth values (human labels, page verdicts, V's or Sandhya's answers) never enter your files, prompts, commits or bus posts. You may use turn ids and times only.
3. Only vj-refuter runs the VJ scorer and reads truth. You never run it and never ask for label values.
4. If a task seems to need any of the above, stop and ask vj-refuter on the bus; do not work around it.
5. If you touch any of these paths by accident (including through a broad find/grep/ls), post it to vj-refuter at once with the command and time.
=== VJ-BLINDING-R168 END ===
```

## Config deny recommended to Fable and the oc-switch.sh owner (a real control, not only an instruction)
- oc-switch.sh's generated opencode.jsonc already denies read and external_directory access to /home/eta/.claude/* and "*secrets*". So the seal KEY is already blocked by config.
- The sealed ARCHIVE is not blocked. For the VJ panes (vj-link, vj-arms, later vj-data), add:
  - read: "*vj-truth*": "deny", "/home/eta/eta-data/vj-truth-sealed/*": "deny"
  - external_directory: "/home/eta/eta-data/vj-truth-sealed/*": "deny"
  - bash: "*vj-truth*": "deny"
- This is not adopted by me. oc-switch.sh is not my file, so it is Fable's or its owner's call.

## Checks
- First pass (15:42 versions): vj-link 6e72491 FAIL, vj-arms 18e7a52 FAIL, with 0 blocks in either (#2654).
- Re-check: vj-link 73209dc PASS (file sha cd59c8a30cf16742) and vj-arms 1bb83e9 PASS (file sha ead633a2a1d78af0). Each has exactly 1 block, identical to sha 6987f95c744af22f, and nothing outside the block loosens it. Posted to Fable via the conductor.
- A standalone block file for `cat >>` is at 34-VJ-BLINDING-R168.block.txt (8b84ff1).
- After the switch (16:05): the live OpenCode configs ~/oc/vj-link/opencode.jsonc (033b306b13c7) and ~/oc/vj-arms/opencode.jsonc (81e237510e4c) deny the sealed archive:
  - read: /home/eta/eta-data/vj-truth-sealed/*
  - external_directory: the same path
  - bash: *vj-truth-sealed*
  - The default deny on /home/eta/.claude/* covers the key.
  - The loaded ~/oc/<name>/HANDOVER.md files are byte-identical to the passed commits (cd59c8a3..., ead633a2...).
  - My config recommendation is applied. vj-data (wave 3) gets the same check before its switch.
- vj-data (wave 3): handover/HANDOVER-vj-data.md @2ea7d01 (file sha 2de103450cae9a43) has exactly 1 block, identical: PASS.
- vj-data rule-5 report (#2724): a one-time read of ~/eta-data/who-is-speaking/key.json on 24 Sep ~20:45-21:00, before the block existed. Checked by me, field names only: 90 entries with fields {window_id, s, e}, so page item id maps to turn identity and there are NO labels or answers. vj-data built those identities itself (selection_identities.json). No truth exposure. Logged in refute/22.
