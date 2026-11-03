# Baseline

The golden-PR evals for the `review` and `fix` prompts, run once by hand against the prompts as they
stand in v0.9.10 (#634). A change to the review prompt is measured against this: the same cases, the
same `--runs` and the same `--model`, both reports in the pull request (`README.md`, *Comparing a
before and an after*). The `fix` section is not a before report for anything run since #716 (see
below); a change to the fix prompt needs a new fix baseline first.

- **Run:** 2026-11-02, from `0226bf92e98a`, the `main` commit that last changed either prompt (#610).
  `07e016a`, the v0.9.10 release commit, holds the same two prompt files.
- **Command:** `node scripts/eval-prompts.ts review --model claude-opus-5-5 --max-cost-usd 60` and
  `node scripts/eval-prompts.ts fix --model claude-opus-5-5 --max-cost-usd 20`; three runs per case.
- **Model:** claude-opus-5-5. **Claude Code:** 2.1.307. **Cost:** $9.76 for `review`, $4.86 for `fix`.
- **Prompts:** `review/prompt.md` blob `cdeb260a5a2a`, `fix/prompt.md` blob `699278db27cb`.

Misses are part of the baseline: several graders pass in none of their runs. The tables are the
runner's own reports, unedited; it cuts each grader's text at 80 characters, and the full text is in
the grader's file under `review/` or `fix/`.

## `review`

| Case | PR | Runs | Grader | Passed | Rate |
| --- | --- | --- | --- | --- | --- |
| clean-doctor-service-guard | #566 | 3 | 01: The review raises no finding that asks for a change before merge. Follow-ups and notes fo… | 3/3 | 100% |
| clean-doctor-service-guard | #566 | 3 | 02: The review recommends approval. | 3/3 | 100% |
| persisted-checkout-token | #572 | 3 | 01: The review raises a finding that the checkout in `.github/workflows/publish.yml` leaves i… | 1/3 | 33% |
| persisted-checkout-token | #572 | 3 | 02: The finding about the checkout's persisted credential is one to fix before merge, not a f… | 1/3 | 33% |
| persisted-checkout-token | #572 | 3 | 03: The review raises a finding that the install check against the registry can be skipped fo… | 0/3 | 0% |
| rescue-deleted-before-open | #570 | 3 | 01: The review raises a finding that `implement/publish.ts` deletes the rescue branch after t… | 3/3 | 100% |
| rescue-deleted-before-open | #570 | 3 | 02: The review raises, as a finding or a follow-up, that a run which set a rescue aside (beca… | 0/3 | 0% |
| rescue-deleted-before-open | #570 | 3 | 03: The review does not recommend approval: it asks for at least one change before merge. | 3/3 | 100% |
| restart-order | #577 | 3 | 01: The review raises a finding that `deploy/unraid/upgrade.sh` goes on to restart the dispat… | 0/3 | 0% |
| restart-order | #577 | 3 | 02: The review raises a finding that the recovery advice printed when the install on Unraid f… | 0/3 | 0% |
| restart-order | #577 | 3 | 03: The review raises a finding that the download with `curl -L` can follow a redirect from h… | 0/3 | 0% |
| restart-order | #577 | 3 | 04: The review does not recommend approval: it asks for at least one change before merge. | 2/3 | 67% |

**False-finding rate** (clean cases):

- **clean-doctor-service-guard:** 0 of 3 completed runs raised a false finding (0%).

## `fix`

**Not comparable with a fix run made since #716.** These runs were graded by the earlier fix
graders, which read the trace for "the committed change"; a fix replay cannot commit, so they graded
something the run could not produce. Since #716 the graders read the working-tree diff printed in
the final message (`README.md`, *What a fix replay cannot exercise*). Kept as the record of what was
run; a new fix baseline, on the current graders and from the same prompt blob, is needed before a
fix-prompt change can be measured.

| Case | PR | Runs | Grader | Passed | Rate |
| --- | --- | --- | --- | --- | --- |
| rescue-deleted-before-open | #570 | 3 | 01: The run commits a change to `implement/publish.ts` that deletes the rescue branch only af… | 0/3 | 0% |
| rescue-deleted-before-open | #570 | 3 | 02: The committed change adds or updates a test that fails if the rescue is deleted before th… | 2/3 | 67% |
| rescue-deleted-before-open | #570 | 3 | 03: The committed change touches nothing the finding did not ask for: beyond the deletion's o… | 3/3 | 100% |
