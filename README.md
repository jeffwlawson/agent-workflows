# agent-workflows

The runners behind a GitHub Actions agent loop: a labelled issue becomes a reviewed pull request
without a human in the middle. One binary, one version, one subcommand per workflow.

```bash
npx --yes @jeffwlawson/agent-workflows@<version> implement
npx --yes @jeffwlawson/agent-workflows@<version> implement-prd
npx --yes @jeffwlawson/agent-workflows@<version> review
npx --yes @jeffwlawson/agent-workflows@<version> fix
npx --yes @jeffwlawson/agent-workflows@<version> update-branch
npx --yes @jeffwlawson/agent-workflows@<version> follow-ups
```

Each runner takes its whole input from the environment the workflow step sets — issue or PR number,
branch, `CLAUDE_CODE_OAUTH_TOKEN`, model overrides, `OUTPUT_DIR`. None of them takes an argument,
and passing one is refused rather than ignored.

`follow-ups` is the one that runs **no model**: it files the out-of-scope findings a review
recorded, once the pull request has closed, and needs no `CLAUDE_CODE_OAUTH_TOKEN` because nothing
in it is an agent. Its caller is the one file in the loop that is optional — copy it and merged
pull requests file their findings, leave it out and they stay in the review body, unfiled.

Two more subcommands are the **install path**, run by a human rather than by a workflow:

```bash
npx --yes @jeffwlawson/agent-workflows@<version> init      # scaffold the caller workflows
npx --yes @jeffwlawson/agent-workflows@<version> doctor    # check what fails silently
```

Those two are typed at a terminal, so no workflow has written the scoped `.npmrc` for them — see
*Installing it* below for the two `npm config set` lines. Without them the scope resolves to npmjs
and `npx` exits `404 Not Found`, which reads as "no such package" rather than "not authenticated".

`init` copies the reference callers from [`examples/callers/`](./examples/callers/) into
`.github/workflows/`, substituting the one thing that is per-repo — the version pin — and writes a
`SETUP.md` naming the work it cannot do: the two secrets, the repository setting, the labels, and
the two documents below. It **updates** on a re-run rather than refusing, which is how you take a
release: the pin moves in the callers you have, and nothing else about them changes, a caller being
the half an adopter owns.

`doctor` exits non-zero on every failure `docs/ADOPTING.md` §1 describes as announcing itself as
something else — a missing secret, a caller that does not pass `AGENT_PAT` on to the workflow it
calls, a caller whose `permissions:` block leaves out a grant the workflow it calls spends *on the
repository it is run against*, a pin that is a branch rather than a tag, a `self-check` that does
not name the check run its job produces, a label that does not exist — and names the fix for each.
It also reports, without failing: how many releases behind each pin is, and the one grant no call
is known to 403 without — `agent-follow-ups`' `contents: read`, a warning everywhere. Both are a
thing to know rather than a thing that is broken.

They are subcommands of the same binary on purpose: the version that writes a pin has to be the
version that pin names.

## Installing it

Published to **GitHub Packages**, so `npx` needs a scoped registry and a token:

```yaml
- uses: actions/setup-node@v7
  with:
    registry-url: https://npm.pkg.github.com
    scope: "@jeffwlawson"
    # This is the registry half of `setup-node`, not the toolchain half. From
    # v5 it also caches npm on its own when `package.json` names a package
    # manager, which fails a repo with no root lockfile.
    package-manager-cache: false
- run: npx --yes @jeffwlawson/agent-workflows@<version> review
  env:
    NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Run by hand rather than by a workflow — `init`, `doctor`, or a local invocation — nothing has
written that `.npmrc`, so write it once per machine:

```bash
gh auth refresh -h github.com -s read:packages     # if your gh token lacks the scope
npm config set @jeffwlawson:registry=https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken="$(gh auth token)"
```

The scope matters: it keeps the entry to `@jeffwlawson`, so the consuming repo's own install still
resolves everything else from npmjs. The token is **unconditional** — GitHub Packages has no
anonymous install even for a public package — so the workflow granting it needs `packages: read`.
That is a permission rather than a secret, and it has to be granted in the *calling* workflow, since
a called one can only downgrade the token it is handed.

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
| 1 | the run failed, or `doctor` found a problem; the reason is in `$OUTPUT_DIR/failure_reason.txt`, for the workflow's `if: failure()` step to put on the issue or PR |
| 2 | bad usage — an unknown subcommand, an argument to a runner, or an option `init`/`doctor` does not know |

## Building and publishing

```bash
npm run build     # tsc, then copy each runner's prompt into dist/ beside it
npm publish       # prepack runs the build first
```

`publishConfig.registry` points at GitHub Packages, so `npm publish` needs no `--registry` flag and
cannot reach npmjs by accident. In practice it runs from CI on an `agent-workflows-v<version>` tag
push, behind two guards: the tag and this manifest must name the same version, and a version already
on the registry is a no-op rather than a 409.

`prepack` is what stops a publish shipping a stale `dist/`. The prompts are copied rather than
compiled: every runner resolves its prompt relative to its own directory, and `tsc` emits `.js` and
nothing else. The reference callers ride along for the same reason — `init` reads them out of the
tarball at a path relative to its own module.

A version has to be **published before the workflow pinning it runs**, since `npx` resolves the pin
from the registry rather than from the repository. Bumping the version here and repinning the
workflows are therefore two halves of one change; a test compares them so neither half can land
alone.
