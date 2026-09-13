# ETA C2 — open item: doctor self-enrol accepts a disabled doctor's valid token

Status: OPEN. Recorded, not fixed, by order (C2 merge-and-deploy, 13 Sep 2026).

## The defect
`POST /{slug}/api/voice/enroll` (`app/[slug]/api/voice/enroll/route.ts`) authorises on the doctor
login cookie alone: `verifyDoctorJwt` plus a slug match. It never reads `clinician.status` or
`deleted_at`. A doctor who is disabled or deleted after signing in keeps a valid token until it
expires, and with it can still:
- have clips embedded on the Mini `/enroll` (compute on the shared service),
- store audio in R2 and `voice_sample` rows,
- recompute their `voice_print` centroid (`storeEnrollmentSession` → `recomputeCentroid`).

## Why it is contained
Nothing that matches voices will offer that centroid. Every matching reader filters to
`status = 'active' AND deleted_at IS NULL` as of C2 (`0f27b8c` on release-b1):
- room diarize — `loadClinicianCentroids`, `lib/stt/diarize-window.ts`
- encounter diarize — `loadActiveClinicianCentroid`, used by the process route
- live identify — `app/[slug]/api/voice/identify/route.ts` re-checks status on every call (403)

The operator view `scribe_list_voiceprints` shows such a row with `matchable: false`.

## A second, related gap in the same route (also recorded, not fixed)
The route writes the samples and centroid first, then inserts its `voice_print.enroll` audit row in
a separate statement inside `try { … } catch { /* audit best-effort */ }`. A failed audit insert is
swallowed. That is the same untrailed-biometric-write shape C2 closed on the curated enrolment
endpoint (`POST /api/admin/voiceprints/load`), where the voiceprint, its sample and its audit row
are now one statement and a refused audit row refuses the voiceprint. Here, samples and a centroid
can land with no trail, and the route still answers success.

## What a fix would need (for the Orchestrator to rule on)
- The same active re-check identify now does, before any clip is embedded.
- The audit row atomic with the writes, or the route refusing to report success without it.
- The same active question for the admin enrol and retrain routes (admin-cookie, so an operator
  choice, not a token-outlives-disable problem).
