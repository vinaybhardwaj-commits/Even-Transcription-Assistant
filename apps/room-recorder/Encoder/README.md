# Room Recorder Encoder

This directory pins the only production-helper candidate permitted by the Build B design:
upstream FFmpeg `n9.0.1` linked statically with upstream libopus `1.6.1` for thin arm64 macOS
15 or later.

`source-lock.json` and its shell-native build mirror freeze archive URLs, sizes and SHA-256 values.
The build refuses to proceed when the two lock representations disagree. The retained FFmpeg detached
signature verifies against the retained upstream release key fingerprint
`FCF986EA15E6E293A5644F10B4322F04D67658D8`. Xiph publishes the libopus archive SHA-256 in its
checksum file and release page but does not publish a detached signature beside this archive; the
lock records that limitation explicitly.

Build a fresh unsigned candidate from this directory's parent:

```sh
Encoder/build-ffmpeg.sh
```

The script downloads only absent source archives, rejects hash/size mismatches, verifies the FFmpeg
signature in an isolated keyring, and refuses to replace an existing artifact. The output under
`.build/encoder-candidate` contains the thin helper, complete source archives, notices, build inputs,
relink material, dependency audit and an explicit `production_ready:false` provenance record.

This is not production authorization. The command remains a candidate until independent playback and
production-wire smoke pass. Distribution remains blocked on legal review and the final in-house
certificate; the final app and nested helper must be signed with that same identity.
