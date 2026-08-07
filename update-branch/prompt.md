# TASK

PR #{{PR_NUMBER}} (branch `{{BRANCH}}`) conflicts with its base branch, `{{BASE_REF}}`. A
`git merge origin/{{BASE_REF}} --no-edit` has already been run and left the working tree conflicted.
Resolve every conflict, commit the merge, and describe what you did.

# THE PR

{{PR_CONTEXT}}

# CONFLICTED FILES

```
{{CONFLICTED_FILES}}
```

# WORKING TREE

```
{{MERGE_STATUS}}
```

# RESOLUTION POLICY

Read `CONTEXT.md` and `CLAUDE.md` first.

**Always resolve. Never `git merge --abort`.** Leaving the merge unfinished fails the run and the
branch is left untouched, which is worse than an imperfect resolution you have flagged.

For each conflict:

1. **Understand both sides before choosing.** `git log -p <path>` on each side shows how they got
   there; commit messages usually state the intent. A conflict is two intents meeting, and you
   cannot reconcile intents you have not read.
2. **Preserve both wherever possible.** Where they are genuinely incompatible, favour the one
   matching this PR's stated goal, and say in your comment what you traded away.
3. **Reconcile, do not invent.** This is not the place for new behaviour. If a clean resolution
   seems to need logic that exists on neither side, that is a signal you have misread one of
   them — go back to step 1. If it still holds, take the smallest defensible option and flag the
   uncertainty prominently.

Watch for conflicts that are textually trivial but semantically real: two rules registered in
`src/rules/index.ts`, or the same helper moved on one side and edited on the other. Taking "both"
compiles and is still wrong.

# VERIFY

Run `npm run verify` after resolving. It must pass before you commit.

If it cannot pass, fix what you can, commit anyway so the work is not lost, and make the failure
the **first line** of your comment — a silently broken merge is far worse than a declared one.

# COMMIT

Commit the merge on `{{BRANCH}}`. Keep the default merge-commit subject, but replace the body
with a summary of each non-trivial resolution and why.

Do not push. Do not edit labels. Do not create GitHub comments — your comment is returned as
structured output and posted by the workflow.

When complete, output `<promise>COMPLETE</promise>`.
