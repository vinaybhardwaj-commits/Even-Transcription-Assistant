# Install and Fleet PRD — R3-5 addendum: the leaf pin alone

**11 September 2026. Amends R3-5 (Build R3 addendum, 8 Sep). Ships in 0.1.18.**

## R3-5, amended
The pinned requirement is the certificate leaf hash alone:
`= certificate leaf = H"187dd424fb866204111113d60c6f88a21d098edb"`. `anchor trusted and` is removed from the app's
step 6b, the swap script's step 8.5 and both `build-bundle.sh` verifies: one string.

## Why
1. **The certificate is self-signed.** Its subject and issuer are both `CN=EvenScribe Room Recorder Code Signing 1, C=IN`,
   so the leaf is the anchor and the leaf hash already pins the exact certificate.
2. **`anchor trusted` consults each Mac's trust settings.** On Room 4.1 the full requirement failed on its own bundle,
   and without the clause it passed. The 0.1.17 `test` offer failed there at 12:45 IST as `signature_mismatch`.
3. **Trust settings cannot be set remotely.** `security add-trusted-cert` over SSH is refused: "no user interaction was
   possible".

## Unchanged
- The expected signer is compiled into the app, never served.
- The sha256 and size checks, and `codesign --verify --strict --deep`.
- The designated requirement, so the TCC microphone grant carries across versions.
- Nothing wider: no `anchor apple generic`, no team id.
