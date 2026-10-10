# TASK

Implement issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

You are on branch `{{BRANCH}}`, already created from `{{BASE_REF}}`.

# ISSUE

{{ISSUE_CONTEXT}}

# CONTEXT

Read these before changing code:

- `CONTEXT.md`: the domain model (the concepts this project is built from, the distinctions
  it holds between them, and where the seams are). Reason from it, not from what the code
  appears to do.
- `CLAUDE.md`: the commands, the conventions, and the contract anything you add here has to
  satisfy, including any step-by-step it gives for the kind of change this issue asks for.
  Follow it there rather than from memory: it is the copy that is kept current, and anything
  restating it (this prompt included) would be a second copy already drifting from it.

Explore the code the issue touches, and its tests, before editing. Match what is there.

# CHECK THE ISSUE AGAINST THE CODE

An issue can wait days before it is built, and the code it names can move in that time. Before you
change any code, check that the files, functions, steps, inputs and commands the issue and its
brief name still exist as described. One of three things is true:

1. **Everything is where the issue says.** Carry on. There is nothing to report.
2. **Something moved, and where it went is clear**: a step became a command, or a function changed
   modules. Build at the new place. In the message of the commit that does the work, add a short
   "moved" note naming each moved thing: where the issue said it was, and where you found it. A
   criterion that names the old place is met at the new one, and the review reads the note to
   find it there.
3. **The issue's premise no longer holds**: what it removes is already gone, or what it fixes was
   replaced. Stop. Commit nothing. End your output with `<stale>` and `</stale>` around one or two
   sentences naming which part of the issue no longer matches the code and what the code shows
   instead. That is a human's call, not yours, and the run fails with your reason.

# EXECUTION

Do red-green-refactor where a test seam already exists:

1. RED: write a failing test
2. GREEN: implement the smallest correct change
3. REPEAT until the issue is done
4. REFACTOR

Do not improvise new test seams: for example, extracting a function purely so it can be
tested in isolation. That creates spaghetti tests.

Run the verify command `CLAUDE.md` names before committing. It must pass.

# COMMIT

Make one or more commits on `{{BRANCH}}` with conventional commit messages.
Do not use em dashes in anything you write; use a comma, colon, semicolon, parentheses, or a new sentence instead.

Do not push. Do not edit labels. Do not create GitHub comments.
Do not close the issue. Do not create or edit PRs.

When complete, output `<promise>COMPLETE</promise>`.
