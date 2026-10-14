# GitHub Support request — DRAFT, NOT SENT

Purge cached unreachable objects after a PHI history rewrite. **V sends this**; it is written
out here so nothing has to be reconstructed from memory, and so the blob SHAs are exact.

Send via <https://support.github.com/request> · category *Account or repository* → *Data
removal*. Do not paste the clinical values into the ticket; the SHAs are enough for Support
to act, and the ticket itself should not become a second copy.

---

**Subject:** Purge unreachable objects containing patient data after history rewrite — vinaybhardwaj-commits/Even-CDMSS

Hello,

We removed protected health information from a public repository by rewriting history. The
rewrite and force-push are complete and the objects are unreachable from every ref, but they
are still served by SHA through the API and the web UI. Please purge the cached views and
garbage-collect the unreachable objects.

**Repository:** `vinaybhardwaj-commits/Even-CDMSS` (public, 0 forks)

**Blobs to purge — these are the objects that contain the data:**

| Blob SHA | Path it was committed at | Size |
|---|---|---|
| `407e2dc1dfcdbc30b9267dbebe806939d4d32ac4` | `scripts/probe-vitals-live.mjs` | 3,165 B |
| `7e7b599e0d94bc9a63f157cb313673058c52c107` | `scripts/probe-antibiotic-class.mjs` | 4,545 B |

**Commits that carried them — all five are now unreachable:**

`4b29621305ca7f61ee251beba857b18c8b5ba112`
`039a01dc5f180a9ea2e977a35a92099dbe30d525`
`fe906c5f9d0028761439482f657e368228251a4c`
`3b8bf388f95b343f4f310e3bb6199762d7578847`
`bb568f74d7a3b8269b0827fc9bb4eb6cf87e3138`

**What we already did:**

- Rewrote `refs/heads/main` with a path-scoped filter over `a751507..bb568f7`, stripping both
  files from all five commits. New tip `1c4921d`. The base commit `a751507` and everything
  before it are untouched.
- Force-pushed `main` with `--force-with-lease`.
- Deleted the branch `feature/preop-b8-extraction`, which carried the same blobs.
- Deleted the local `refs/original/` backup refs.
- Confirmed no other branch in the repository contains either path, and that the repository
  has no forks and no pull request referencing these commits.

**What still resolves, and is why we are writing:** both blob SHAs above return content
through `GET /repos/:owner/:repo/git/blobs/:sha`, and all five commit SHAs still resolve
through `GET /repos/:owner/:repo/commits/:sha`.

**What the files contained:** a production record identifier from our clinical database
together with clinical values for that record — vital signs in one file, a prescribed
medication in the other. No credentials, no API keys, no tokens. The exposure window on the
public repository was approximately 09:28–11:20 IST on 27 August 2026.

Please confirm once the objects are no longer retrievable.

Thank you,
Vinay Bhardwaj

---

## After Support confirms

1. **Re-verify** — both should 404:
   ```
   gh api repos/vinaybhardwaj-commits/Even-CDMSS/git/blobs/407e2dc1dfcdbc30b9267dbebe806939d4d32ac4
   gh api repos/vinaybhardwaj-commits/Even-CDMSS/commits/4b29621305ca7f61ee251beba857b18c8b5ba112
   ```
2. **Treat the three record identifiers as disclosed regardless.** `xdhcyEVRoR92roH17NPt`,
   `8Oehy1cxK0jhex3mPNDT`, `XMhf7f3VEfvAV5AIhhYz`. A purge removes the copy GitHub serves; it
   cannot remove a copy somebody already took. Nothing here is rotatable — no secret was
   exposed — so the remaining question is a records one, not a credentials one, and it is
   V's to route.
3. **Anyone who pulled `main` between 09:28 and 11:20 IST still has the blobs locally.** Their
   `git fetch --prune` will not remove them; `git gc --prune=now` after fetching will.
