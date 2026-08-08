# TASK

Implement issue #{{SUB_NUMBER}}: {{SUB_TITLE}}

It is one slice of PRD #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}.

You are on branch `{{BRANCH}}`, which carries **every slice of this PRD implemented so far**.
Earlier slices are already committed there. Later ones are not yet written and are not yours.

Implement **only** #{{SUB_NUMBER}}. Do not start the next sub-issue, even if it looks small, and
even if the code you are writing would be tidier with it done. Another run does that one, on this
same branch, with this same context — and a slice that quietly absorbs its successor leaves that
run with nothing to do and a sub-issue nobody can honestly close.

# THE SLICE

{{SUB_CONTEXT}}

# THE PRD IT BELONGS TO

Read this for the ordering, the vocabulary and the reasoning behind where the seams are. It is not
a second task list.

{{PRD_CONTEXT}}

# CONTEXT

Read these before changing code:

- `CONTEXT.md` — the domain model. Pay attention to the difference between a file's
  **role** (from its name) and its `ManifestType` field (a claim inside it), and to the
  three rule classes.
- `CLAUDE.md` — commands and conventions.

Then read what the earlier slices already did: `git log main..HEAD` and `git diff main...HEAD`.
Build on that rather than beside it — matching a convention an earlier slice established matters
more here than in a standalone issue, because the whole PRD lands as one PR and is reviewed once.

Explore the existing rules and their tests before editing. Match what is there.

# IF THIS SLICE ADDS A RULE

1. Create `src/rules/<rule-id>.ts` with a default export of `defineRule({ ... })`.
2. Register it in `src/rules/index.ts`, keeping the array ordered by rule id.
3. Add `tests/rules/<rule-id>.test.ts` with at least one passing and one failing manifest.
4. New fixtures go under `tests/fixtures/`, following the existing layout.

`CLAUDE.md` holds the rule contract — purity, return type, positions, registration. Follow it
there rather than from memory.

# EXECUTION

Do red-green-refactor where a test seam already exists:

1. RED: write a failing test
2. GREEN: implement the smallest correct change
3. REPEAT until the slice is done
4. REFACTOR

Do not improvise new test seams — for example, extracting a function purely so it can be
tested in isolation. That creates spaghetti tests.

Run `npm run verify` before committing. It must pass. It covers the earlier slices too, so a
failure may be yours or may be an interaction with what is already on the branch; read the failure
before assuming which.

# BEFORE YOU COMMIT

Review your own slice — read the diff you are about to commit as though someone else wrote it.
This is not ceremony: review happens **once per PR**, after the last slice lands, so a design
problem you leave here is not read by anyone until several slices have been built on top of it.
You are the only reader this slice gets while it is still cheap to change.

# COMMIT

Make one or more commits on `{{BRANCH}}` with conventional commit messages. Name the slice, not
the PRD — `feat: ... (#{{SUB_NUMBER}})`.

Do not push. Do not edit labels. Do not create GitHub comments.
Do not close #{{SUB_NUMBER}} or #{{ISSUE_NUMBER}}. Do not create or edit PRs.
The workflow does all of that after you exit.

When complete, output `<promise>COMPLETE</promise>`.
