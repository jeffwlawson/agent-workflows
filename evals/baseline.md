# Baseline

The golden-PR evals for the `review` and `fix` prompts, run by hand against the prompts as they
stand at the revisions named below (#634). It records where each grader sat in one session; it is
not the before a prompt change is measured against, since the protocol runs its before and its
after in the same session (`README.md`, *Comparing a before and an after: the protocol*). The
`review` section was taken on 2026-11-02 with 3 runs per case; the `fix` section was taken on
2026-11-03 with 6 runs, after the fix graders were repaired to read the working-tree diff (#716),
and is the only fix record taken on the graders as they now stand.

- **`review` run:** 2026-11-02, from `0226bf92e98a`, the `main` commit that last changed either prompt (#610).
  `07e016a`, the v0.9.10 release commit, holds the same two prompt files.
- **Command:** `node scripts/eval-prompts.ts review --model claude-opus-5-5 --max-cost-usd 60`; three runs per case.
- **`review` model:** claude-opus-5-5. **Claude Code:** 2.1.307. **Cost:** $9.76. **Prompt:** `review/prompt.md` blob `cdeb260a5a2a`.
- **`fix` run:** 2026-11-03, from `15beba09ffac` (the pull request head of #722, whose merge is `038257c`), with `fix/prompt.md` blob `388e1cf8ee9b`, the prompt on `main` after #700. `node scripts/eval-prompts.ts fix --model claude-opus-5-5 --max-cost-usd 25 --runs 6`. claude-opus-5-5, Claude Code 2.1.307, **cost $11.46**, no run errored.

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

Graded on the working-tree diff each run prints in its final message (`README.md`, *What a fix replay
cannot exercise*). Grader 01 passed 1 of 26 runs under the earlier wording that asked for a commit,
which a fix replay cannot make; those older fix reports are not comparable with this one. Graders 02
and 03 are at the ceiling, so this baseline can show a regression in them but not an improvement.

| Case | PR | Runs | Grader | Passed | Rate |
| --- | --- | --- | --- | --- | --- |
| rescue-deleted-before-open | #570 | 6 | 01: The diff in the final message changes `implement/publish.ts` so that the rescue branch is… | 5/6 | 83% |
| rescue-deleted-before-open | #570 | 6 | 02: The diff in the final message adds or updates a test that fails if the rescue is deleted … | 6/6 | 100% |
| rescue-deleted-before-open | #570 | 6 | 03: The diff in the final message touches nothing the finding did not ask for: beyond the del… | 6/6 | 100% |
