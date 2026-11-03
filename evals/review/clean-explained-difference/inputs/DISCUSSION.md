### Conversation

**@jeffwlawson** · comment `IC_kwDOTzVKqM8AAAABiQnOCw`
## Prompt sizes, measured on merged pull requests, and one change for the fix round

The acceptance criterion on prompt size is asked for "from the usage ledger". There is no ledger entry for a verification pass on this code yet, so these are the bytes `readPromptDiff` would put in the prompt, computed with git on three merged pull requests that had fix rounds: the whole pull request's diff (`git diff <base>...<tip>`) against `stat + since + diff of the touched files`, with "since" taken from the commit the first review read to the last fix commit.

| Pull request | Whole diff | Scoped prompt (stat + since + touched files) | Scoped / whole |
| --- | --- | --- | --- |
| #662 | 13,794 | 567 + 2,521 + 4,372 = 7,460 (2 files) | 54% |
| #664 | 16,167 | 370 + 3,711 + 3,711 = 7,792 (2 files) | 48% |
| #658 | 136,824 | 2,746 + 71,277 + 110,742 = 184,765 (20 files) | **135%** |

Where the fix round touches a few files, the scoped prompt is about half the size. Where it touches many, the scoped prompt is **larger** than the whole diff, because the since-diff and the whole-PR diff of the same files overlap. (#658 had two fix rounds, and a real verification pass reads only the commits since the previous review, so its true figure is smaller than this one-step measure. The overlap is the point, not the 135%.)

### For the fix round (not an eval, a code change)

In `readPromptDiff` (`review/review-diff.ts`), when the scoped form is built, compare its size with the whole diff's and **return the whole diff when the scoped form is not smaller**: `stat.length + since.length + diff.length >= whole.length` gives `{ kind: "whole", diff: whole }`. A prompt that is no smaller than the whole gains nothing and costs the reviewer the full context less. Keep the rest as it is.

- Add the case to `tests/review/review-diff.test.ts`: a fixture where the fix round touches most of the pull request's files, expected to return the whole diff, beside the existing one-file fixture that is still scoped.
- Say in the `Prompt diff:` log line in `review/review.ts` when this happens, with both sizes (for example "the whole pull request's, N bytes, because the scoped form would be M bytes").
- The brief's "Where the range is unreadable..." behaviour is unchanged; this case needs no `howChecked` note, because nothing was left out.

### The criterion this does not meet

"A seeded regression in a file the fix round touched is still found" (golden-PR eval). The eval cases replay old first reviews, so none takes a verification pass, and a before and after run would measure the unchanged whole-diff path. Do not try to meet it in this pull request. The maintainer will decide whether to merge without it; the cases that would reach this path are tracked in a follow-up issue.

### On the linked issue

**@jeffwlawson-agent-loop[bot]:**
**`agent:implement` started:** [Workflow run](https://github.com/apps/jeffwlawson-agent-loop#job-914964cf-bc79-42a9-a538-c062f6aaa104)

---

**@jeffwlawson-agent-loop[bot]:**
**`agent:implement` opened PR #698:** [Workflow run](https://github.com/apps/jeffwlawson-agent-loop#job-914964cf-bc79-42a9-a538-c062f6aaa104)
