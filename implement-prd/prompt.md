# TASK

Implement issue #{{SUB_NUMBER}}: {{SUB_TITLE}}

It is one slice of PRD #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}.

You are on the slice branch `{{BRANCH}}`, cut from the tip of the PRD branch `{{PRD_BRANCH}}`.
The PRD branch holds **every earlier slice of this PRD**, so they are already in your checkout:
build on them rather than redo them. Later slices are not yet written and are not yours.

Implement **only** #{{SUB_NUMBER}}. Do not start the next sub-issue, even if it looks small, and
even if the code you are writing would be tidier with it done. Another run does that one, on a
slice branch of its own cut from the PRD branch, with this same context, and a slice that quietly
absorbs its successor leaves that run with nothing to do and a sub-issue nobody can honestly close.

# THE SLICE

{{SUB_CONTEXT}}

# THE PRD IT BELONGS TO

Read this for the ordering, the vocabulary and the reasoning behind where the seams are. It is not
a second task list.

{{PRD_CONTEXT}}

# CONTEXT

Read these before changing code:

- `CONTEXT.md`: the domain model (the concepts this project is built from, the distinctions
  it holds between them, and where the seams are). Reason from it, not from what the code
  appears to do.
- `CLAUDE.md`: the commands, the conventions, and the contract anything you add here has to
  satisfy, including any step-by-step it gives for the kind of change this slice asks for.
  Follow it there rather than from memory: it is the copy that is kept current, and anything
  restating it (this prompt included) would be a second copy already drifting from it.

Then read what the earlier slices already did: `git log {{BASE_REF}}..HEAD` and
`git diff {{BASE_REF}}...HEAD`.
Build on that rather than beside it: matching a convention an earlier slice established matters
more here than in a standalone issue, because every later slice is built on top of this one.

Explore the code the slice touches, and its tests, before editing. Match what is there.

# EXECUTION

Do red-green-refactor where a test seam already exists:

1. RED: write a failing test
2. GREEN: implement the smallest correct change
3. REPEAT until the slice is done
4. REFACTOR

Do not improvise new test seams: for example, extracting a function purely so it can be
tested in isolation. That creates spaghetti tests.

Run the verify command `CLAUDE.md` names before committing. It must pass. It covers the earlier
slices too, so a failure may be yours or may be an interaction with what is already on the
branch; read the failure before assuming which.

# BEFORE YOU COMMIT

Review your own slice: read the diff you are about to commit as though someone else wrote it.
This is not ceremony: this slice is opened as a pull request of its own against the PRD branch and
reviewed there, and the next slice is built on whatever that review leaves. A design problem you
catch now costs one edit; one the review catches costs a round.

# COMMIT

Make one or more commits on `{{BRANCH}}` with conventional commit messages. Name the slice, not
the PRD: `feat: ... (#{{SUB_NUMBER}})`.
Do not use em dashes in anything you write; use a comma, colon, semicolon, parentheses, or a new sentence instead.

Do not push. Do not edit labels. Do not create GitHub comments.
Do not close #{{SUB_NUMBER}} or #{{ISSUE_NUMBER}}. Do not create or edit PRs.
The workflow does all of that after you exit.

When complete, output `<promise>COMPLETE</promise>`.
