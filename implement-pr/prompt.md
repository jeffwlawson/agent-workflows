# TASK

Address the review feedback on pull request #{{PR_NUMBER}}.

You are on branch `{{BRANCH}}`, already checked out at the PR head.

# REVIEW SUMMARIES

{{REVIEW_SUMMARIES}}

# INLINE COMMENTS

{{INLINE_COMMENTS}}

# CONVERSATION

{{CONVERSATION}}

# DIFF TO MAIN

```diff
{{DIFF_TO_MAIN}}
```

# HOW TO RESPOND TO FEEDBACK

Read `CONTEXT.md` and `CLAUDE.md` first, then the files the comments refer to.

For each piece of feedback, decide honestly:

- **Address it** — the comment is right. Make the change.
- **Decline it** — the comment is wrong, or already handled elsewhere. Do not change the code.
  Explain why in your commit message.
- **Partially address it** — take the correct part, explain the rest.

Do not make a change you believe is wrong just because a comment asked for it. A reviewer can be
mistaken; your job is the correct end state, not compliance. Equally, do not dismiss a comment
because addressing it is inconvenient.

Feedback that asks you to *verify* something (for example "confirm the corpus job stays green")
is a request to check and report in your commit message, not necessarily to change code.

# CONSTRAINTS

Stay within the scope of this PR and its linked issue. If a comment asks for something that
belongs in a separate change, say so rather than expanding the PR.

Rules are pure (no I/O, no network, no clock — the clock is injected via `RuleContext`), return
`Diagnostic[]`, and are registered in `src/rules/index.ts` ordered by id.

Run `npm run verify` before committing. It must pass.

# COMMIT

Make one or more commits on `{{BRANCH}}` with conventional commit messages. The message is the
only place your reasoning is recorded, so state what you addressed and what you declined, with
the reason.

If nothing genuinely needs changing, make no commit and say so.

Do not push. Do not edit labels. Do not create GitHub comments or reviews. Do not resolve review
threads. The workflow handles all of that.

When complete, output `<promise>COMPLETE</promise>`.
