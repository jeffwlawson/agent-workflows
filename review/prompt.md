# TASK

Review pull request #{{PR_NUMBER}} on branch `{{BRANCH}}`.

PR title: {{PR_TITLE}}
Linked issue: #{{ISSUE_NUMBER}} {{ISSUE_TITLE}}

Review only; the checkout stays as you found it (**BOUNDARIES**, at the end, names the one
exception).

# HOW THIS REVIEW RUNS

The sections below hand you this pull request's state, then say how to report on it. The work, in
order:

1. Read `CONTEXT.md` and the changed files in context, as *WHAT TO CHECK* says, and the diff under
   *PR DIFF*.
2. Rule on every id this brief hands you, in the list its section names: each acceptance criterion
   in `criteria`, each open finding in `verified`, each note the fix run left in `noteRulings`, and
   each carried follow-up with an id in `followUpRulings`; and where commits are listed under the
   criteria, rule on them in `sinceBrief`. A section with nothing in it asks for nothing.
3. Work the eight items under *WHAT TO CHECK* over the diff, and report each problem as one of
   *THE TWO KINDS OF FINDING*, anchored as *WHERE A FINDING IS POSTED* says.
4. Write the fields *WHAT YOU WRITE BESIDE THE FINDINGS* names, and the title and summary where
   *THE TITLE AND THE SUMMARY* says this review writes them.

**The review is complete when** each of these holds; a reader checks what you return against each:

- every id handed to you has a ruling;
- every item under *WHAT TO CHECK* has been worked, and every hit item 6 found has been ruled on;
- every finding is anchored at something this pull request changed, and names what it rests on;
- `howChecked` is written.

Then output `<promise>COMPLETE</promise>`.

# WHAT THIS PULL REQUEST IS

{{PULL_REQUEST_KIND}}

# LINKED ISSUE

{{LINKED_ISSUE}}

# ACCEPTANCE CRITERIA

The linked issue's acceptance criteria (the latest triage brief supersedes the body's list), each
under the id a ruling names it by:

{{ACCEPTANCE_CRITERIA}}

**Rule on every one of them, by id, in `criteria`.** Check each against the code in front of you,
and a criterion about the pull request itself (its title, its description, what its body says)
against the title at the top of this brief and the body above. Where this review writes the summary,
the summary you write counts as part of the body.

- **`met`**: the change does what it says.
- **`changed`**: the change does not do it as written, **on purpose**, and something says why: the
  pull request's body or summary, a comment in the feedback below, or a reason the code makes plain
  (the thing it asks for turned out to be impossible, or wrong). Give that reason in one line. It is
  not a finding: it is recorded on the review, and the title and summary should describe what was
  actually built.
- **`unmet`**: the change does not do it, and nothing says why. That is a finding to fix before
  merge, and the workflow raises it for you: give a one-line `reason` saying what is missing, a
  `severity`, and a `path` and `line` anchored by the usual rule (at the change nearest to it; a
  line outside the diff in a changed file is posted on the file). Ruling it `unmet` is the whole of
  reporting it.

A criterion you say nothing about is listed as *not checked* on the review, where a reader sees the
gap, so rule on all of them.

**A criterion can name a place the code has since left.** The agent that built this change was
told to name each move it found in the message of the commit that does the work: where the issue
said the thing was, and where it was found. Those messages are not in this brief, so read them with
`git log` over the commits under review (the ones on the pull request's branch that are not on its
base). Where one names a move, read a criterion that names the old place against the new one, but
**only once the code confirms it**: the thing is at the new place, and the old one is gone. A note
the code does not confirm is not evidence, and the criterion is ruled as written.

**A criterion can also mean something else since the brief was written.** Listed here are the
commits since the one the brief says it was read at that touched the files it names: on the base
branch, and on a slice round also the commits on this pull request's branch before this slice. The
commits under review are never among them.

{{SINCE_BRIEF}}

Where any commits are listed, read the ones that could bear on a criterion, and **rule on them in
`sinceBrief`**, in one line: whether any of them changes what a criterion means, naming the
criterion and the commit where one does, or saying none does. The list adds nothing to the verdict
of its own, so rule on the criteria as you would otherwise: a criterion a listed commit made moot
or wrong is `changed`, with that commit as the reason; one the change fails at the code as it now
stands is `unmet`, or a finding, as always; and where the code does not settle which reading of
the issue was meant, that is *the issue itself was wrong or unclear*, in `needsYou` (*WHEN ANOTHER
PASS WILL NOT SETTLE IT* below). Never raise a finding that the brief is out of date: nothing a fix
round can edit would answer it.

# EXISTING FEEDBACK

Feedback already on this PR: earlier review summaries, unresolved inline threads (replies
included), and conversation comments, plus any collaborator comments on the linked issue.
Resolved threads are omitted deliberately: a thread is closed by a review that checked the code and
found the finding fixed, or by a human, so one that is gone is one that is settled. The ones a
**human** closed are listed under *WHAT THE MAINTAINER HAS SETTLED* below, because those carry an
instruction rather than only an absence.

**Raise only what is new.** A finding an earlier review left open is ruled in `verified`
(*FINDINGS AN EARLIER REVIEW LEFT OPEN* below); a point a human made that the code still bears out,
and that no earlier finding covers, is a finding of yours on the usual terms. Treat maintainer
steering as authoritative, and keep your own judgement about the code.

{{DISCUSSION}}

# WHAT THIS REVIEW FOLLOWS

{{HISTORY}}

# FINDINGS AN EARLIER REVIEW LEFT OPEN

{{OPEN_FINDINGS}}

# WHAT THE MAINTAINER HAS SETTLED

{{SETTLED_FINDINGS}}

# NOTES THE FIX RUN LEFT

{{FIX_NOTES}}

# FOLLOW-UPS EARLIER ROUNDS RECORDED

{{CARRIED_FOLLOW_UPS}}

# CI RESULTS

The PR's other checks, waited for and collected before this review started. Some are
path-filtered and do not run on every PR, so a check that is absent has not passed.

A check that validates the code against known-good real-world data, rather than against tests
this team wrote, is the **oracle**. Your reasoning consults the diff; the oracle consults the
world. Where they disagree, the oracle wins.

A failing check is the most valuable evidence in this review: diagnose *why*. A failure you can
explain is a finding to fix before merge; one you cannot is *a check fails and you cannot say
why*, in `needsYou` (*WHEN ANOTHER PASS WILL NOT SETTLE IT* below). The check results are read
again after you, so a review that says nothing about a failing check leaves the reader with a
verdict and no diagnosis.

{{CI_STATUS}}

# RED CHECK

The **red check**, where the repository configures it, runs the tests this pull request adds or
changes against the code as it was **before** the change. Its report, as the workflow read it:

{{RED_CHECK}}

# PR DIFF

{{DIFF_SCOPE}}

```diff
{{PR_DIFF}}
```

# WHAT TO CHECK

Read `CONTEXT.md` first, then explore the changed files in context. `CLAUDE.md` is already in your context; do not read it again.
In `CONTEXT.md`, read the `## Glossary` at the top first, then only the sections below it that
the change touches; where it has no glossary, read it whole.

1. **Correctness against the issue**: does the change do what the linked issue asked? Its
   acceptance criteria are ruled on one by one, under *ACCEPTANCE CRITERIA* above. Then the other
   direction: does the diff add behaviour that neither the issue nor one of its criteria asks for?
   Real scope creep is a finding. A deliberate difference the pull request explains is not: it
   goes in the summary's **Differs from the issue** line. On a PRD slice round the criteria are the
   slice's, so behaviour that belongs to another slice is behaviour nobody asked of this one.
2. **Conventions**: the contract `CLAUDE.md` states for a change of this kind. Flag any
   deviation.
3. **Domain correctness**: does it hold the distinctions `CONTEXT.md` draws, or has it
   collapsed two concepts the model keeps apart? A change whose behaviour is narrower or wider
   than the thing it claims to implement is the most valuable catch here, and the **oracle** is
   what settles it.
4. **Tests**: at least one passing and one failing case, with realistic fixtures. Where the code
   **reads the output of another program** (a command line tool, a service's response, a file
   format), a fixture is realistic only if that program produced it. Run it on the cases that
   matter and compare what it emits against what the code expects: a sample written by hand agrees
   with whatever its author believed the format to be, which is the belief the code already
   encodes, so the two agree and only the program disagrees. Where the cases that matter are
   inputs the checkout does not contain, build them in a scratch directory of your own outside it;
   that is what **BOUNDARIES** permits, and the checkout is left as you found it (`howChecked`
   records what you ran).

   **Say what your own run left unrun, in `notChecked`.** Running tests is your choice; saying
   whether you did is not. Record whether you ran any, and each test or suite exercising code the
   diff changes that your run skipped for want of something in the environment (a tool, a kernel
   feature, a service, a platform, a credential), with the reason the run gave or, where it gave
   none, one line of your own. A test the diff itself marks skipped with no condition is not one
   of these: it is a finding under item 5 (a failure made quiet). Skips in CI you cannot see are not
   yours to list.
5. **A failure this change made quiet**: a path it adds where something that **used to block,
   fail or be reported loudly** now passes quietly: skipped, demoted to a lesser channel,
   defaulted, caught and logged, or returned from as though nothing were wrong. The change's own
   input is the least likely to reach the quiet path:
   - **List every input that can reach the quiet path**, every kind the surrounding code can be
     handed, not only the intended one, and check each of them against the code.
   - **Report every gap you find in one round, grouped as one class.** One finding naming the class
     and listing the members it covers, rather than one finding for the member you happened to try
     first. A member left for a later round costs a round to find and another to fix, and the round
     after that finds the next one.
   - **Say whether the change could fail loudly instead**, and prefer that where it can. A path
     that refuses what it cannot handle (**fail closed**) is wrong once, loudly; one that passes
     it quietly is wrong every time it is used and reports nothing.
6. **Text this change made false**: a doc section, a comment in another file, a domain doc, a
   prompt or a test's description that said something the diff has stopped being true. Reading the
   diff does not find it, so look for it:
   - **For each behaviour the diff changes, write down the phrases that described the old
     behaviour**, then search the whole checkout for each, not only the changed files.
   - **Rule on every hit**: still true, or made false by this change. The step is done only when
     every hit has been ruled on.
   - **A hit this change made false is a fix-before-merge finding**, anchored at the changed line
     that made it false, with the stale `path:line` in its text, as *Where a finding is posted*
     says. It is not a follow-up: the change caused it, so it is this pull request's to fix.
   - **A hit that was already false before this change** was not caused by it, and is a `followUps`
     entry, on the bar *THE TWO KINDS OF FINDING* states.
   - **A change that alters no behaviour** (a comment, a rename the tests pin, documentation
     alone) owes no sweep (`howChecked` records the sweep, or that none was owed).

   Every review runs it, a PRD PR's slice round and its final review included. A verification pass
   sweeps the behaviours its new commits change; a hit for a behaviour an earlier round's diff
   changed, found now, is *previously missed*.
7. **What text sent somewhere new can carry**: a place the change sends text or a value that it
   did not reach before. That is a new destination for text that already existed (a log line now
   quoted in a comment, an error now posted where people read it), and a value added to a
   destination that already exists (a variable newly interpolated into a message, a summary or a
   body). For each one:
   - **What can it carry?** A secret, a credential inside a URL, a private path, untrusted input.
   - **Is the new place read more widely than where the text came from?**
   - **Is it cleaned of what it can carry before it gets there?** Cleaned means that specific
     thing is removed or masked (the credential stripped from the URL, the token replaced).
   - **Text that can carry a secret to a more widely read place, uncleaned, is a fix-before-merge
     finding**, anchored at the change that sends it there, as *Where a finding is posted* says.
   - **A private path or untrusted input reaching a more widely read place, uncleaned, is ruled
     the same way**: a finding where this change causes it. An exposure this change did not cause
     is a `followUps` entry, on the bar *THE TWO KINDS OF FINDING* states.
   - **A change that sends no text anywhere new** (a comment, a rename, documentation alone) owes
     nothing more (`howChecked` records the new destinations, or that there were none).
8. **Edge cases** the change handles wrongly: name the input.

# THE TWO KINDS OF FINDING

There are two, and every finding is one of them.

**Fix before merge**: this pull request is wrong, unsafe, or does not do what the linked issue
asked, and must not merge as it stands. Say so in the finding. Every finding is counted and every
one is listed in the review's findings record under **Open**, so a finding only the prose carries is
one nobody can act on without reading for it. The label is for whoever reads the thread: one you
forget to write still counts and is still recorded, so it is not a dial for how serious you meant
it.

**A follow-up**: real, but not this pull request's to fix. It goes to the `followUps` list your
structured output carries, and only with all three of: one `path` or `path:line` to open first, the
code or check result it rests on, and what this pull request would have to change that is not its
subject. One missing any of them is left out, so gather them while the code is open.

**Previously missed** is the first kind with one more thing said about it: a real problem in code
an earlier review of this pull request already read. Open its body with `**Previously missed.**`
instead of `**Fix before merge.**`. It counts the same way: what the label adds is that the record
was wrong, not that the finding is softer. The commonest one is a member of a class an earlier
round found and did not finish, which is why *What to check* asks for the whole class in the round
that meets its first member.

**The outcome is derived, not written.** A verdict, and the next step a human should take, is
computed from your findings, from `needsYou` below and from the check results, then posted
where GitHub shows it. So do not state a verdict of your own: what decides it is what you
record, not what your prose calls it.

Quote the code or check result each finding rests on, and name in the finding's own text what it
rests on: a criterion id, a rule in `CLAUDE.md` or `CONTEXT.md`, a check result, a concrete input
that fails, or, for a risk that no criterion or rule covers, a described way the change fails or can
be abused. A reader should be able to check you without re-deriving your reasoning. A finding that
can name none of these is a preference (a style choice, a "consider…", a rename you would accept
being overruled on): whatever its severity, it is not posted. If it is not worth fixing, it is not
worth the time of the person who has to read it.

# HOW BAD EACH ONE IS

Every finding and every follow-up carries a `severity`: `high`, `medium` or `low`.

- **high**: it breaks something, loses data, or ships the wrong behaviour to a user.
- **medium**: a real defect with a bounded blast radius: one path, one case, one caller.
- **low**: **a real but small defect.** Something you can name as wrong, with a consequence you
  can state, that happens to be cheap: an off-by-one in a log line, a message naming the wrong
  field, a test that passes for the wrong reason.

`low` is a real defect, never a preference: if you cannot name the defect and its consequence,
it is not a finding.

Severity orders the record, so the worst thing you found is the first thing the reader meets, and
it decides **one thing**, through the repository's fix threshold, never anything finer. Where any
finding left open on the pull request (yours, and the earlier ones you rule still open) is at or
above the threshold, every finding is posted as a thread, lows included, exactly as it would be
without one. Where none is, none is posted as a thread: each is recorded as a **minor finding**,
filed as a follow-up when the pull request merges, and the outcome comes from the check results.
No finding is dropped either way, and `high` is never below the threshold. So rate honestly, and
know what a rating costs: an inflated one holds up an approval and buys a fix round, and an
understated one sends a real problem to a follow-up instead of a fix.

# WHAT YOU WRITE BESIDE THE FINDINGS

Two prose fields for the review, two for the pull request itself, and **none of them restates a
finding.** Every finding is already in the posted body above them, with its severity and a link
to where it was raised, so a second telling is the same problem read twice.

- **`assessment`**: one sentence, under about 200 characters, naming **what is unresolved**:
  *"Sequence validation, empty-column rules and undo-safe state handling are each wrong in a way
  that has to be fixed first."*
  Name the subjects, not the number; the count is on its own line below it, and the assessment is
  what the count cannot say. Where nothing is unresolved (a clean change, with no findings), one
  sentence on why the change holds up.
- **`howChecked`**: what you actually verified, which is how a reader weighs this review. Every
  review carries one. It is held to 100 words and cut from the end past that, so write its parts
  in this order, each a clause:
  - what you ran or read past the diff: the checks, the behaviour you traced, the files you opened
    (*WHAT TO CHECK* item 4);
  - the phrases you searched for and how many hits you read, or that the change alters no
    behaviour and owed no sweep (item 6);
  - the new destinations you found, or that there were none (item 7);
  - then, only where it applies: that this is a verification pass, and what you checked the
    earlier findings against; that *PR DIFF* holds the whole diff of a verification pass, and why;
    that feedback could not be read, where that changes a conclusion; that the red evidence was
    unavailable; and which changes you treated as owing no red test.
- **`title`** and **`summary`**: the pull request's title, and the summary in its body. The
  section below says what goes in each.

Do not use em dashes in anything you write, in these fields or in a finding: use a comma, colon,
semicolon, parentheses, or a new sentence instead.

Refer to issues and pull requests by `#N` alone, without restating their titles: GitHub shows the
title beside the reference already. A pull request's title is the one exception, since a title
does not expand a reference.

# THE TITLE AND THE SUMMARY

{{SUMMARY_SECTION}}

# WHEN ANOTHER PASS WILL NOT SETTLE IT

Most findings are fixed by another pass over this branch. Some are not, and saying which is your
judgement to make: it is what tells the reader they have to read this review rather than act on
it. Report it in `needsYou`, in one line naming which case it is, when one of these holds:

- **the wrong thing was built**: the change does something other than what the linked issue
  asked for, so fixing it is a different change rather than a correction to this one;
- **the issue itself was wrong or unclear**: doing what it asked is the defect, so the pull
  request should be closed rather than fixed; or the code does not settle which of its readings
  was meant, so a human says which before another pass is aimed at one;
- **a check fails and you cannot say why**: the diff does not explain it, so no fix can be aimed
  at it.

Leave it out otherwise, which is nearly every review. It is not a severity dial: using it for a
finding another pass would settle spends the one signal that says a human is needed, on a review
where they were not.

# WHERE A FINDING IS POSTED

Each finding carries a short `title`, the `path` and the `line` it is **anchored** at, and a body.
Where it ends up on the pull request is decided from the diff after you, and is not yours to state
or to work around:

- a line the diff covers gets a thread on that line;
- a line outside the diff in a file this pull request changes gets a thread on the file.

**Every finding is anchored at something this pull request changed.** That is not a formatting
rule, it is what makes it a finding: a maintainer has to be able to reply to it, push back on it
and resolve it, and GitHub gives them nowhere to do any of that on a file the pull request does not
touch, not even a file-level thread.

**A problem in a file this pull request does not touch is anchored at the change that causes it.**
If the change did not cause it, it is not this pull request's to fix. So there is always a changed
line to point at (the one that makes the other file wrong), and the untouched `path:line` goes in
the finding's text, where a reader can follow it. On `src/api.ts:42`:

> **Fix before merge.** This changes the signature of `parse()`, but `docs/api.md:18` still
> describes the old one.

**If nothing in the diff causes it, it is a follow-up.** Put it in `followUps`, on the bar *THE
TWO KINDS OF FINDING* states, rather than in `findings`. The workflow checks this and does not take
your word for it: a finding whose `path` is in no file this pull request changes is **moved to `followUps`**,
filed when the pull request merges, and the review body says it was moved and why. Nothing is lost,
but a finding anchored away from the change stops counting against the merge, so anchoring it at
the cause is the whole of keeping it.

Give the anchor that is true, and never the nearest line inside the diff to something else. A
finding aimed at a line it is not about is one a reader has to re-find, and one a fix round will
change the wrong code for.

Each finding is also given an identifier, by the workflow, so a later round can tell it is the same
finding. **Do not write one**, in any field: an identifier you invented would be matched against a
thread you never opened.

# SUGGESTED CHANGES

When a fix is **mechanical and you know the exact replacement text**, put it in a
` ```suggestion ` block in the finding's body. GitHub renders it as a one-click patch, saving an
`agent:fix` run. It only renders on a thread anchored to a line, so a suggestion is worth writing
only where the lines it replaces are in the diff.

    ```suggestion
    the exact replacement text for the anchored line(s)
    ```

- **Replaces exactly the anchored lines**: `line` alone, or `startLine`..`line`.
- **Literal content**: write the replacement lines exactly as they should appear, with the
  surrounding indentation.

Good candidates, and each is a finding you would report anyway: a comment whose claim the diff
made false, a misspelled identifier that breaks the thing it names, a bound that is off by one.
A suggestion is a way to make a *fix before merge* cheap to apply. Where the fix needs judgement,
spans several places, or changes behaviour, describe it in prose and leave it to `agent:fix`; a
wrong suggestion is one click from being committed.

# BOUNDARIES

Do not modify the checkout: no file in it edited, none added, none removed. The fix is
`agent:fix`'s to make, and a file you leave behind is one nobody asked for.

Running a program to see what it emits is part of reviewing, and *What to check* item 4 asks for
it. Where a check needs an input that does not exist, build it in a **scratch directory outside the
checkout** (`mktemp -d`) and run the program there. That is the whole of the exception: somewhere
to put an input, not permission to touch the branch.

Your findings are returned as structured output and posted by the workflow.

When the review meets the completion bar under *HOW THIS REVIEW RUNS*, output `<promise>COMPLETE</promise>`.
