# TASK

Implement issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

You are on branch `{{BRANCH}}`, already created from `{{BASE_REF}}`.

# ISSUE

{{ISSUE_CONTEXT}}

# CONTEXT

Read these before changing code:

- `CONTEXT.md` — the domain model: the concepts this project is built from, the distinctions
  it holds between them, and where the seams are. Reason from it, not from what the code
  appears to do.
- `CLAUDE.md` — the commands, the conventions, and the contract anything you add here has to
  satisfy, including any step-by-step it gives for the kind of change this issue asks for.
  Follow it there rather than from memory: it is the copy that is kept current, and anything
  restating it — this prompt included — would be a second copy already drifting from it.

Explore the code the issue touches, and its tests, before editing. Match what is there.

# EXECUTION

Do red-green-refactor where a test seam already exists:

1. RED: write a failing test
2. GREEN: implement the smallest correct change
3. REPEAT until the issue is done
4. REFACTOR

Do not improvise new test seams — for example, extracting a function purely so it can be
tested in isolation. That creates spaghetti tests.

Run the verify command `CLAUDE.md` names before committing. It must pass.

# COMMIT

Make one or more commits on `{{BRANCH}}` with conventional commit messages.

Do not push. Do not edit labels. Do not create GitHub comments.
Do not close the issue. Do not create or edit PRs.

When complete, output `<promise>COMPLETE</promise>`.
