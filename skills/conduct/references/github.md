# GitHub access

`gh` runs unsandboxed: inside the shell sandbox it answers 401. Where GraphQL is refused (a Claude Code cloud session), `gh issue view`, `gh pr view` and `gh pr merge` fail too: use REST through `gh api repos/<owner>/<repo>/…`. Read issues as `gh api issues/<n>` and `issues/<n>/comments`; bare `gh issue view --comments` has dropped comments before. `issues-to-prd`'s `references/github.md` holds the reads and writes for staging (issues, sub-issues, edges, verifying a PRD natively); `merge-check`'s `references/environment.md` holds a check's. Below is what conducting adds.

## Reads

| Need | REST |
|---|---|
| What is ready | `issues?state=open&labels=ready-for-agent&per_page=100` |
| What is in flight | `issues?state=open&labels=agent:implement` (and each other trigger label), `actions/runs?status=in_progress` |
| Open pull requests, their heads, drafts and labels | `pulls?state=open&per_page=100` |
| A pull request's files, for conflicts | `pulls/<n>/files` |
| When a label went on | `issues/<n>/events` |
| The fix rounds spent | the `agent-fix-round` statuses in `commits/<sha>/status` |

Watching goes through `scripts/snapshot` and `scripts/wait-until`, not these: they make conditional requests, which cost nothing while nothing changed.

## Trigger labels

**One trigger label per call, and nothing else in it:**

```bash
gh api -X POST repos/<owner>/<repo>/issues/<n>/labels -f 'labels[]=agent:implement'
```

The same call adds `agent:fix` (on the pull request) or `agent:merge`. A trigger has started no job, with no error and no comment, after an edit that also changed other labels, and again when it was added alone (the loop's #774: the first webhook delivery after a quiet stretch timed out).

**See it start.** Note the item's comment count first, then watch for the run's start comment, which carries the run's link:

```bash
skills/conduct/scripts/wait-until 10 '.[0].comments > <count>' <n>
```

For a PRD, watch its next sub-issue; the run comments there. A refusal comments too (`**agent:implement didn't run:** …`), and adds `agent:blocked`: read it. With no comment after about 7 minutes, the service's redelivery poll has not recovered the delivery either: remove the label, wait 5 seconds, add it again, alone. On the service, a re-add while the job is held is skipped, so the toggle cannot start it twice.

**After a refusal**, fix its cause, then remove `agent:blocked` and add the trigger again, in two calls.

## Merging

**Arm**, where the maintainer said arm: the head must still be the one checked, then add `agent:merge` alone:

```bash
test "$(gh api repos/<owner>/<repo>/pulls/<n> --jq .head.sha)" = <full-40-character-sha> \
  && gh api -X POST repos/<owner>/<repo>/issues/<n>/labels -f 'labels[]=agent:merge'
```

**Squash**, where the maintainer said merge, with the head guard, so a head that moved after the check refuses:

```bash
gh api -X PUT repos/<owner>/<repo>/pulls/<n>/merge -f merge_method=squash -f sha=<full-40-character-sha>
```

Write the SHA out literally, all 40 characters, from the check's own record: a short or a computed SHA has been refused by the permission classifier and by the guard.

**A draft is marked ready first.** A loop pull request the review left as a draft ("needs a closer look") cannot merge: `gh pr ready <n>`. Ready for review has no REST route; where GraphQL is refused, the 403 names the route to use.

**Behind its base**: `agent:update-branch`, alone. A clean merge of the base carries the verdict and any arm on; a conflict resolution is code no check has seen, so check the new head before deciding.

Then read the pull request back (`pulls/<n>`: `merged`, `merge_commit_sha`) before saying it merged, and give its issues a moment to close before relying on it.

## Findings and fix rounds

Post merge-check's findings as **one review** on the head, then add `agent:fix` alone:

```bash
gh api -X POST repos/<owner>/<repo>/pulls/<n>/reviews -f commit_id=<sha> -f event=COMMENT -F body=@<file>
```

Each finding: the file and line, what is wrong, what done looks like. Where the finding is the brief's own mistake, say so, and give the corrected criterion with its reason: the fix agent reads the review, and the brief alone would send it back to the mistake.
