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

**Suggested changes.** A comment may contain a ` ```suggestion ` block — the reviewer's exact
proposed replacement for the lines the comment is anchored to. Treat it as a strong signal of
intent and usually correct, but **not** as authoritative: check it against the surrounding code
before applying, and decline it like any other comment if it is wrong. A suggestion is more
dangerous than prose precisely because it looks ready to apply — a confident reviewer working
from a false premise produces a tidy patch that is still wrong.

**Outdated anchors.** A comment marked *outdated* was written against code that has since
changed. Its line numbers point at the old state, so re-read the current code before deciding
whether the point still stands. It often already has been addressed.

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

# REPLYING TO THREADS

After the work, you will be asked to report one outcome per review thread you were shown —
whether you **addressed** it or **declined** it, and a short reply explaining which. Those
replies are posted publicly into the threads, and addressed threads are then resolved, so write
them for the person who left the comment.

The test is **"is anything still outstanding?"**, not "did I personally change something?". A
comment that an earlier commit already satisfied is **addressed** — say so and let it close. Use
**declined** only when you disagree or are deliberately not acting, so the thread stays open for
a human to push back on.

Keep track as you go of which thread each change answers; you cannot resolve a thread you never
decided about.

Do not push. Do not edit labels. Do not create GitHub comments or reviews yourself. Do not
resolve review threads yourself. The workflow does all of that from your reported outcomes.

When complete, output `<promise>COMPLETE</promise>`.
