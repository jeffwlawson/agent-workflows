This review follows a fix round, so this section holds **what changed since the last review**, which read `bbb7761`, rather than the whole pull request. The rest of the pull request's diff is on disk: `git diff main...HEAD` reads it, and `git diff main...HEAD -- <file>` one file of it. Read it wherever a judgement needs more than is here. A finding may be anchored on any line the pull request changes, not only on the lines shown here.

The whole pull request, `git diff --stat main...HEAD`:

```text
{{PR_STAT}}
```

The commits since `bbb7761`, `git diff bbb7761 HEAD`:

```diff
{{SINCE_DIFF}}
```

Below that, the pull request's whole diff of each file those commits touch that it changes (`engine/git.ts`, `service/worker-live.ts`), `git diff main...HEAD` limited to them.
