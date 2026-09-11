# ETA B2-A REFUTER VERDICT — Room Recorder 0.1.20 — 11 Sep 2026

**ACCEPT.** `74a79ea`, diff `47733a2..HEAD`.

**Files** ⊆ Allowed + ruled `TapeFormat.swift`. **Suite** `563 tests in 45 suites passed`, exit 0.
**Zip** (`ditto -x -k`): leaf verify exit 0; DR = 0.1.19 zip's; CDHash `d652d47d…604ef6d`; plist 0.1.20; `anchor trusted` 0/0/0; sha256 `83278526…ab9c` = release.json, 0.1.20, `74a79ea`.

1. No. `RoomConfiguration.swift:560 guard assigned == "stable", updateChannel != "stable"`; wrong type → nil (`BenchClient.swift:216 try?`).
2. No. `RoomEngine.swift:990 justEnded = previousSessionWasOpen && !open`; `RoomSelfUpdate.swift:810 if sessionIsOpen {` still defers.
3. No. `TapeWriter.swift:427 sampleCount == 0 ? nil :`.
4. No. `RoomEngine.swift:3092 number != fileNumber || size < consumed`, `:3106 data.starts(with: anchor)` → reread from 0.
5. No. Sweep only inside `:1135 [ ! -d "$RESIDENT" ] && [ -d "$PREVIOUS" ]`, after the restore `mv`; `:1150` guards.
6. No. `InstallPollFields.swift:274 kept.count == inputDevicesMax { break }`, `:269 uid.utf16.count <= inputDeviceUIDMax`.
7. Yes, both. 0.1.19 `TapeFormat.swift:166 decoder.decode(IndexRecord.self, …)`, synthesized Codable both revisions: unknown keys ignored, absent optionals nil; HEAD `:222/:225 if let`. Compiled both revisions, cross-read: exit 0 each way.

**Flag, non-blocking:** server caps `input_devices` at 16,384 chars (`lib/room-install.ts:920`); app has no total cap.
