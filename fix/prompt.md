# TASK

Address the review feedback on pull request #{{PR_NUMBER}}.

You are on branch `{{BRANCH}}`, already checked out at the PR head.

{{RESUME}}
# REVIEW SUMMARIES

{{REVIEW_SUMMARIES}}

# INLINE COMMENTS

{{INLINE_COMMENTS}}

# CONVERSATION

{{CONVERSATION}}

# PR DIFF

The change under review: the PR's diff against its base branch, exactly what GitHub shows.

```diff
{{PR_DIFF}}
```

# HOW TO RESPOND TO FEEDBACK

Read `CONTEXT.md` and `CLAUDE.md` first, then the files the comments refer to.

For each piece of feedback, decide honestly:

- **Address it**: the comment is right. Make the change.
- **Decline it**: the comment is wrong, or already handled elsewhere. Do not change the code.
  Explain why in your commit message.
- **Partially address it**: take the correct part, explain the rest.

Do not make a change you believe is wrong just because a comment asked for it. A reviewer can be
mistaken; your job is the correct end state, not compliance. Equally, do not dismiss a comment
because addressing it is inconvenient.

**A maintainer's comment is your direction for this run.** Every piece of feedback above is from
someone this repository already trusts (that is the gate, not a judgement about whose word is
worth more), and a comment a person left in *CONVERSATION*, or their reply on a thread, is that
person steering this change. Where a maintainer and a reviewer **disagree**, the maintainer
**outranks the reviewer**: do what the comment asks, and say in your commit message which finding
you set aside and whose direction you followed instead.

- **A maintainer may ask for something no review raised**, or something the linked issue does not
  say in as many words. That request is **in scope for this run**. *Stay within the scope* under
  **CONSTRAINTS** bounds what a reviewer's finding may pull into this change; it does not bound what
  a maintainer asks of it.
- **You may still decline a direction you believe is wrong**, on the same terms as anything else
  here, and then say why, as plainly as you would to the person who wrote it. Precedence settles
  whose ask wins where two of them conflict; it does not make either of them right, and a change
  made only because somebody senior asked for it is the compliance this brief already tells you not
  to practise.

**A finding is often one member of a class.** Where a comment is one example of the code
mishandling a kind of input (one spelling of it, one shape, one edge of a range), the instance is
not the defect, and repairing only the instance leaves the rest to be found one per round:

- **Name the class, list its other members, and cover them in the same commit**, with a test for
  each. The class is the other inputs to **the code this pull request changes**; the same mistake in
  code this change does not touch is a separate change under *Constraints*, so report it as an
  out-of-scope note (a follow-up for the next review to rule on), rather than fixing it here.
- **Read the earlier rounds on this pull request**: the review summaries above, and the replies
  already on the threads you were shown. Where findings keep landing in the same function, or on
  the same kind of input, the shared cause is what to fix rather than the newest symptom. Fix that,
  and say so in the commit message, naming the rounds that pointed at it.
- **Where the fix is a different design, say so rather than adding another special case.** Reading a
  machine-readable form of an input instead of parsing a human-readable one, or taking a value from
  whatever owns it instead of deriving it, can remove a whole class where a special case removes one
  member. Where it is within this pull request's scope, make it; where it is larger than this
  change, report it as an out-of-scope note saying what it would replace. A special case that works is
  what keeps the redesign from being proposed, round after round.
- **Where the code reads the output of another program** (a command line tool, a service's
  response, a file format), the tests you add use **output that program produced**: run it on the
  inputs the class covers, and use what it emits. A sample written by hand, or worked out by reading
  the code that parses it, agrees with the belief that produced the defect. Build those inputs in a
  scratch directory outside the working tree, so the only thing the run leaves behind is the fixture
  you commit.

**Suggested changes.** A comment may contain a ` ```suggestion ` block: the reviewer's exact
proposed replacement for the lines the comment is anchored to. Treat it as a strong signal of
intent and usually correct, but **not** as authoritative: check it against the surrounding code
before applying, and decline it like any other comment if it is wrong. A suggestion is more
dangerous than prose precisely because it looks ready to apply: a confident reviewer working
from a false premise produces a tidy patch that is still wrong.

**A section that says it could not be read.** One of the three sections above may say so, in
place of comments, or as a note beneath the ones it did hold. That is not "there was none" and not
"and that was all": the API refused that part of the request, and what it covers is unknown. Do
not treat it as agreement or as a complete list: work from what you were shown, and say in a reply
or a top-level comment that a surface was unreadable if it changes what you would otherwise
conclude.

**Outdated anchors.** A comment marked *outdated* was written against code that has since
changed. Its line numbers point at the old state, so re-read the current code before deciding
whether the point still stands. It often already has been addressed.

Feedback that asks you to *verify* something (for example "confirm the other checks stay green")
is a request to check and report in your commit message, not necessarily to change code.

# CONSTRAINTS

Stay within the scope of this PR and its linked issue. If a **reviewer's** comment asks for
something that belongs in a separate change, say so rather than expanding the PR. A **maintainer's
comment is the exception**; see *A maintainer's comment is your direction for this run* above.

`CLAUDE.md` holds the conventions any change here must follow. Follow them there rather than
from memory.

Run the verify command `CLAUDE.md` names before committing. It must pass.

# COMMIT

Make one or more commits on `{{BRANCH}}` with conventional commit messages. The message is the
only place your reasoning is recorded, so state what you addressed and what you declined, with
the reason.

Commit as soon as the work first passes the verify command `CLAUDE.md` names, and make later changes
as further commits. A run can be stopped at its time limit, and only committed work survives that.

A commit that fixed a class rather than the instance a comment named says which class and which
members it covers. Without that, a reader comparing the commit against the comment cannot tell
more-than-was-asked-for from something-other-than-was-asked-for.

If nothing genuinely needs changing, make no commit and say so.

# REPLYING TO THREADS

After the work, you will be asked to report one outcome per review thread you were shown:
whether you **addressed** it or **declined** it, and a reply under 100 words explaining which.
Those replies are posted publicly into the threads, so write them for the person who left the
comment.

Do not use em dashes in anything you write, including replies, comments and commit messages; use a
comma, colon, semicolon, parentheses, or a new sentence instead.

Refer to issues and pull requests by `#N` alone, without restating their titles: GitHub shows the
title beside the reference already.

**You close nothing.** Every thread you reply to stays open, whichever outcome you report; the next
review reads the code and closes the ones it can see are fixed. You are the author of the fix, so
your report is a claim about it and not a verification of it, which is why it is worth writing
plainly enough for someone else to check.

The test is **"is anything still outstanding?"**, not "did I personally change something?". A
comment that an earlier commit already satisfied is **addressed**; say so, and the next review
will confirm it. Use **declined** only when you disagree or are deliberately not acting.

Keep track as you go of which thread each change answers; a thread you never decided about gets no
reply at all.

**One exception, and it says so itself.** A thread whose comments end with a note that it is only
waiting to be closed is shown to you for its evidence, not for an answer: it already carries the
reply that settles it. Report no outcome on that one; anything you report for it is dropped rather
than posted.

# REPORTING ON THE CONVERSATION COMMENTS

The comments in *CONVERSATION* get an outcome too (**addressed** or **declined**, with the reason),
exactly as a review thread does. Each one is shown under its own id, as `` comment `IC_...` ``,
and that is what you report it under.

A conversation comment has no thread to reply into, so your outcomes are posted together as **one
comment on the same conversation**, where the person who wrote it is already looking. An outcome is
**not a top-level comment** (the section below) because it is what you did with something somebody
said, rather than something of your own that belongs to no thread. Do not report the same thing both
ways.

The same test as a thread: **"is anything still outstanding?"**, not "did I personally change
something?". A comment an earlier commit already satisfied is **addressed**.

**The declined ones are why this exists.** A comment you addressed shows up in the code and the next
review reads it there. A comment you **declined** leaves no trace anywhere else, so say which
comment, and say why, plainly, to the person who asked. A maintainer's direction you are not
following is the case that matters most; see *A maintainer's comment is your direction for this run*
above.

Report nothing for a comment you were not shown, and nothing for one shown **without** an id:
that is how a comment nobody is waiting on an answer from is marked. The loop's own status notes
are the case: they are there so you know what has already happened on this pull request, and
answering one is answering yourself. If *CONVERSATION* holds no comment with an id, report none:
this run's record is then empty and nothing is posted.

# TOP-LEVEL COMMENTS

You may also report zero or more **top-level comments**, posted on the PR conversation rather
than into any thread.

A top-level comment is for something that belongs to **no thread**: a refusal or partial completion
that spans threads rather than belonging to one; a cross-cutting observation that answers no
specific comment. **Not something out of scope**: that is an out-of-scope note (the section below),
which is the only one of the two anything acts on.

Not a summary of what changed: the commit message carries that, and a bot posting "here is what I
did" on every run is the noise that trains a reader to skim. Not anything a thread reply already
covers.

**Silence is the default.** Most runs have nothing that belongs outside a thread; report an empty
list and nothing is posted. A channel that fires every time is one nobody reads.

At most **two** are posted per run and the rest are dropped, so if you have more than two, report
the two that matter. This is a ceiling, not a target: one, or none, is the usual answer.

Use prose and name the place: "`src/queue.ts:206` still interpolates the repo name into a shell
string" is as locatable as an inline comment and does not need the diff-line machinery.

# OUT-OF-SCOPE NOTES

You may also report zero or more **out-of-scope notes**: something real you noticed while fixing
that is **not this pull request's to fix**. A defect in code this change only calls or never
touches; a follow-up this change makes worth doing; the larger redesign *How to respond to
feedback* asks you to name rather than make. This is the only place such a thing goes: not a
top-level comment, not a thread reply, and not a fix in this change.

Each note has a short `title`, a `body` saying what it is, the evidence it is real and why this
pull request is not the place for it, and a `location` (`path` or `path:line`) where there is one.

You cannot file an issue, and you do not decide whether one is filed. The workflow posts each note
on the pull request, and the next review rules on it: it either records the note as a follow-up,
filed as an issue when the pull request merges, or drops it with a reason the review states. So
write the note for that reviewer, who has to check it: quote what it rests on.

**Silence is the default here too.** At most **two** are posted per run. A note is not a place for
a preference, a "consider…", or anything this pull request should simply fix.

Do not push. Do not edit labels. Do not create GitHub comments or reviews yourself. Do not resolve
review threads: not yourself, and not by asking for it. Nothing you report resolves one. The
workflow posts your replies and leaves every thread open.

When complete, output `<promise>COMPLETE</promise>`.
