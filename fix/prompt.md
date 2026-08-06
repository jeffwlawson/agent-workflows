# TASK

Address the review feedback on pull request #{{PR_NUMBER}}.

You are on branch `{{BRANCH}}`, already checked out at the PR head.

# REVIEW SUMMARIES

{{REVIEW_SUMMARIES}}

# INLINE COMMENTS

{{INLINE_COMMENTS}}

# CONVERSATION

{{CONVERSATION}}

# PR DIFF

The change under review — the PR's diff against its base branch, exactly what GitHub shows.

```diff
{{PR_DIFF}}
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

Feedback that asks you to *verify* something (for example "confirm the other checks stay green")
is a request to check and report in your commit message, not necessarily to change code.

# CONSTRAINTS

Stay within the scope of this PR and its linked issue. If a comment asks for something that
belongs in a separate change, say so rather than expanding the PR.

`CLAUDE.md` holds the conventions any change here must follow. Follow them there rather than
from memory.

Run `npm run verify` before committing. It must pass.

# COMMIT

Make one or more commits on `{{BRANCH}}` with conventional commit messages. The message is the
only place your reasoning is recorded, so state what you addressed and what you declined, with
the reason.

If nothing genuinely needs changing, make no commit and say so.

# REPLYING TO THREADS

After the work, you will be asked to report one outcome per review thread you were shown —
whether you **addressed** it or **declined** it, and a reply under 100 words explaining which.
Those replies are posted publicly into the threads, and addressed threads are then resolved, so
write them for the person who left the comment.

The test is **"is anything still outstanding?"**, not "did I personally change something?". A
comment that an earlier commit already satisfied is **addressed** — say so and let it close. Use
**declined** only when you disagree or are deliberately not acting, so the thread stays open for
a human to push back on.

Keep track as you go of which thread each change answers; you cannot resolve a thread you never
decided about.

# TOP-LEVEL COMMENTS

You may also report zero or more **top-level comments** — posted on the PR conversation rather
than into any thread.

A top-level comment is for something that belongs to **no thread**. Out-of-scope findings noticed
while fixing; a refusal or partial completion that spans threads rather than belonging to one; a
cross-cutting observation that answers no specific comment.

Not a summary of what changed — the commit message carries that, and a bot posting "here is what I
did" on every run is the noise that trains a reader to skim. Not anything a thread reply already
covers.

**Silence is the default.** Most runs have nothing that belongs outside a thread; report an empty
list and nothing is posted. A channel that fires every time is one nobody reads.

At most **two** are posted per run and the rest are dropped, so if you have more than two, report
the two that matter. This is a ceiling, not a target — one, or none, is the usual answer.

Use prose and name the place — "`shared/pr-feedback.ts:206` still interpolates `GH_REPO` into a
shell string" is as locatable as an inline comment and does not need the diff-line machinery.

You may say a follow-up issue is needed. You cannot file it, and the workflow will not: filing is
a separate, human-labelled step. Say what the issue would be and stop there.

Do not push. Do not edit labels. Do not create GitHub comments or reviews yourself. Do not
resolve review threads yourself. The workflow does all of that from your reported outcomes.

When complete, output `<promise>COMPLETE</promise>`.
