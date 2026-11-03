---
source: >-
  PR #572, the maintainer's pre-merge check at 3586dd7 (this case's head), which found both: https://github.com/jeffwlawson/agent-workflows/pull/572#pullrequestreview-5725315382, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": pass
  "02": pass
  "03": pass
---

Pre-merge check: one medium finding blocks the merge, and three low ones are worth fixing in the same round. Verify passed on this head (5519 tests). A tokenless install of a locally packed tarball works offline.

**Low: stale text in `README.md:146`.** It still calls a version already on the registry a "no-op". The publish job now does Release work on that path.

## Inline comments

### On `.github/workflows/publish.yml`

**Medium: the checkout persists a token that can now push.** `actions/checkout` writes its token into `.git/config`, and this job now runs with `contents: write`. Every later step could push with it, including dependency install scripts during `npm ci` (esbuild has one). Set `persist-credentials: false` on the checkout (line 55), as the other workflows in this repo do. If a later step genuinely needs git auth, move the Release work into a job of its own that runs no install.

### On `.github/workflows/publish.yml`

**Low: the registry install check (line 258) can be skipped for good.** If the Release step fails after the publish, a re-run sees `already-published == 'true'`, so this check never runs for that version. It only reads, so drop its `if:`, or move it ahead of this Release step.

### On `CLAUDE.md`

**Low: placement and line length.** This line runs to about 161 characters, and the sentence about runtime dependencies with install scripts now ends the Release paragraph, where it doesn't belong. Keep it with the bundled-tree paragraph, and wrap the line to the file's width.
