> *Filed by AI from cost research against `origin/main` at 4896b68, 2026-11-01, at the maintainer's request: cut the loop's token cost without lowering the quality of its output. Line numbers are as of that commit.*

## Agent Brief

**Category:** enhancement

**Summary:** A verification review (one that follows a fix round) puts the PR's whole diff in its prompt, though it only judges the last round's findings and the commits since. Give it those commits' diff inline, and the rest of the diff on disk.

**Current behaviour:**
- `PR_DIFF: context.diff` (`review/review.ts:481`) is the full three-dot diff on every review.
- `review/review-round.ts:187-216` already knows `afterFixRound` and whether there are commits since the last review; the prompt (`review/prompt.md:99-125`) asks for a verification pass.
- #341 fixes this for PRD slice rounds only. An ordinary PR is not covered.

**Desired behaviour:**
- When `afterFixRound` is true and the commits since the last reviewed head are known, `# PR DIFF` holds the diff of those commits, plus the full hunks of every file they touch, plus `git diff --stat` of the whole PR. The brief says the rest of the diff is `git diff <base>...HEAD` for any file.
- Findings are still anchored against the whole PR's diff lines (`diffLines` unchanged).
- Where the since-head range cannot be read, the prompt keeps the whole diff and `howChecked` says so.
- First reviews and final reviews are unchanged.

**Acceptance criteria:**
- [ ] A verification review's prompt diff section is smaller than the full diff for a PR whose fix round touched one file; test on two fixtures.
- [ ] A first review's and a final review's prompt carry the full diff; test.
- [ ] A finding on a line outside the scoped diff but in the PR's diff is still placed on the line; test.
- [ ] Where the range is unreadable, the full diff is used and `howChecked` says why; test.
- [ ] Golden-PR eval: a seeded regression in a file the fix round touched is still found (compared with the #634 baseline); the PR reports the eval result and the prompt size before and after from the usage ledger.

**Out of scope:** slice rounds (#341); the 4 MiB read limit.

**Blocked by:** #614 (edits the same prompt section) and #637 for the measurement.
