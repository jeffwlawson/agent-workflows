---
source: >-
  PR #601, the maintainer's pre-merge check at bceed0c (this case's head), which found both: https://github.com/jeffwlawson/agent-workflows/pull/601#pullrequestreview-5726373286, its body and inline comments, badges as text and HTML comments taken out.
expect:
  "01": pass
  "02": pass
---

Pre-merge check: all 8 of #597's criteria are met and verify passes (5718 tests). One Medium blocks the merge, because it breaks the next planned use of this door (#602). Two Lows can ride along in the same round.

1. **Medium: `/held` refuses a read-only request** (`service/job.ts`, `parseHeldRequest`, about line 394). It returns 400 when `instance` is missing. #602's `upgrade.sh` must ask the worker what it holds without announcing an instance: any instance it sent would drop the whole queue. Make `instance` optional. Absent means read only: report what is held, drop nothing. Add a test for each case, and a line in the deployment doc's door description.
2. **Low: no replay guard on a door that now changes state.** `asked` is parsed but never checked for freshness. A captured signed request from an earlier instance can be replayed at any time to drop every queued job. That is denial of service only (labels stay stranded until the next scan; no token is minted). Refuse requests whose `asked` is older than a few minutes, or in the future beyond clock skew.
3. **Low: an older dispatcher's job gets the wrong refusal.** In `service/worker.ts` (about line 2264), `parseJob` runs before the version check. A job from an older dispatcher is refused with a 400 about `instance` instead of the 409 naming the version mismatch. Check the version first.
