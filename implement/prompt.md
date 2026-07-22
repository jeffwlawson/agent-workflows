# TASK

Implement issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

You are on branch `{{BRANCH}}`, already created from `main`.

# ISSUE

{{ISSUE_CONTEXT}}

# CONTEXT

Read these before changing code:

- `CONTEXT.md` — the domain model. Pay attention to the difference between a file's
  **role** (from its name) and its `ManifestType` field (a claim inside it), and to the
  three rule classes.
- `CLAUDE.md` — commands and conventions.

Explore the existing rules and their tests before editing. Match what is there.

# IF THIS ISSUE ADDS A RULE

1. Create `src/rules/<rule-id>.ts` with a default export of `defineRule({ ... })`.
2. Register it in `src/rules/index.ts`, keeping the array ordered by rule id.
3. Add `tests/rules/<rule-id>.test.ts` with at least one passing and one failing manifest.
4. New fixtures go under `tests/fixtures/`, following the existing layout.

Rules must be pure — no I/O, no network, no clock. They return `Diagnostic[]`; they never
print, throw, or exit. Use `positionOf(file, path)` for positions rather than computing
line numbers by hand.

# EXECUTION

Do red-green-refactor where a test seam already exists:

1. RED: write a failing test
2. GREEN: implement the smallest correct change
3. REPEAT until the issue is done
4. REFACTOR

Do not improvise new test seams — for example, extracting a function purely so it can be
tested in isolation. That creates spaghetti tests.

Run `npm run verify` before committing. It must pass.

# COMMIT

Make one or more commits on `{{BRANCH}}` with conventional commit messages.

Do not push. Do not edit labels. Do not create GitHub comments.
Do not close the issue. Do not create or edit PRs.

When complete, output `<promise>COMPLETE</promise>`.
