# agent-workflows

The runners behind a GitHub Actions agent loop: a labelled issue becomes a reviewed pull request
without a human in the middle. One binary, one version, one subcommand per workflow.

```bash
npx --yes @jeffwlawson/agent-workflows@<version> implement
npx --yes @jeffwlawson/agent-workflows@<version> implement-prd
npx --yes @jeffwlawson/agent-workflows@<version> review
npx --yes @jeffwlawson/agent-workflows@<version> fix
npx --yes @jeffwlawson/agent-workflows@<version> update-branch
```

Each runner takes its whole input from the environment the workflow step sets — issue or PR number,
branch, `CLAUDE_CODE_OAUTH_TOKEN`, model overrides, `OUTPUT_DIR`. None of them takes an argument,
and passing one is refused rather than ignored.

## Pin the version in the workflow, not in `package.json`

`pull_request_target` takes the workflow YAML from the **base** branch and checks out the **PR
head**. A runner addressed by path therefore comes from the pull request, so a branch opened before
a runner change keeps executing the old code — silently, with no error. Invoking a pinned version
from the YAML puts the runner on the base side of that split, where the rest of the loop's controls
already live.

That only holds if the version is in the workflow file. Depending on this package from the calling
repository's `package.json` leaves the version under the PR head's control and changes nothing.

Pin an exact version — no range, no dist-tag — for the reason `.nvmrc` exists: a floating pin is a
runner that changes under a pull request nobody touched.

## What the loop still needs from the repository it runs in

The prompts ship inside this package and are deliberately generic. They send the agent to two files
in the repository being worked on:

- `CONTEXT.md` — the domain model: the concepts, their relationships, and the seams between them.
- `CLAUDE.md` — the commands and conventions, above all the **one command that gates everything**.

An agent is only as good as those two files. There is no second copy of anyone's conventions inside
this package to fall back on.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | the command succeeded |
| 1 | the run failed; the reason is in `$OUTPUT_DIR/failure_reason.txt`, for the workflow's `if: failure()` step to put on the issue or PR |
| 2 | bad usage — an unknown subcommand, or an argument to a runner |

## Building and publishing

```bash
npm run build     # tsc, then copy each runner's prompt into dist/ beside it
npm publish       # prepack runs the build first
```

`prepack` is what stops a publish shipping a stale `dist/`. The prompts are copied rather than
compiled: every runner resolves its prompt relative to its own directory, and `tsc` emits `.js` and
nothing else.

A version has to be **published before the workflow pinning it runs**, since `npx` resolves the pin
from the registry rather than from the repository. Bumping the version here and repinning the
workflows are therefore two halves of one change; a test compares them so neither half can land
alone.
