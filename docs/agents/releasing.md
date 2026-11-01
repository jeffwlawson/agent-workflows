# Releasing

Publishing is a **tag push**, and the version in the tag and in `package.json` must agree:

```bash
npm version patch          # or minor / major
git push --follow-tags
```

`v*` on a commit reachable from `main` triggers `publish.yml`. It refuses a tag on an unmerged
commit, and on a version already on the registry skips the publish but still attaches the
release's tarball to its GitHub Release where that is missing.

**That first command is the whole release.** The version appears in thirteen files and `npm
version` bumps two of them; `scripts/sync-version.ts` writes the other eleven — the `npm exec`
pin of each step that runs the package (thirty-four: the runner's or the filing command's in each of
seven reusable workflows but `fix.yml`, `update-branch.yml`, `implement.yml`, `implement-prd.yml`
and `merge.yml`,
`implement-prd:gate`, `implement-prd:catch-up`, `implement-prd:publish` and `implement-prd:conclude`
in `implement-prd.yml`, `implement:gate`,
`implement:prepare`, `implement:bundle`, `implement:publish` and `implement:conclude` in
`implement.yml`, and
`review:gate`, `review:budget`, `review:collect-checks`, `review:red-check-place`, `review:red-check-classify`,
`review:publish`, `review:conclude` and `review:advance` beside the runner in `review.yml`,
`fix:gate`, `fix:prepare`, `fix:bundle`, `fix:publish` and `fix:conclude` in `fix.yml`, and
`update-branch:gate`, `update-branch:merge`, `update-branch:prepare`, `update-branch:bundle`,
`update-branch:publish` and `update-branch:conclude` in `update-branch.yml`, and
`follow-ups:conclude` beside the filing command in `follow-ups.yml`, and `merge:gate`,
`merge:publish` and `merge:conclude` in `merge.yml`), the
`npm install` pin of each step that installs it early, ahead of the steps that run from that
install (six: one ahead of the red check's two in `review.yml`, one ahead of `fix:prepare`, the
runner and `fix:bundle` in `fix.yml`, in `update-branch.yml` one ahead of `update-branch:gate`
and `update-branch:merge` in the gate job and one ahead of `update-branch:prepare`, the runner and
`update-branch:bundle` in the agent's job, one ahead of `implement:prepare`, the runner and
`implement:bundle` in `implement.yml`, and one ahead of `implement-prd:prepare`, the runner and
`implement-prd:bundle` in `implement-prd.yml`, which all three run by its path), the `uses:` ref of
each caller in the two caller files
of each of the two caller sets, and the `uses:` ref a reusable's step names a composite action in
`.github/actions/` with (nine of those: `loop-token` once in each of `implement.yml`, `fix.yml`,
`update-branch.yml` and `merge.yml`, twice in `implement-prd.yml` and three times in `review.yml`,
so sixty-three pins in the eleven files). Fix's runner, update-branch's, implement's and implement-prd's carry no pin of their own: each
runs its job's early install's binary by its path, from the checkout, because `npm exec` finds an install under its `--prefix`
only from that directory (#486's fix round). It
runs from the `version` lifecycle script, which npm fires *after* the manifest is bumped and
*before* the commit is made, so everything it stages lands in the same `v<version>` commit. It
stages **by path** — the eleven it wrote, never `-A`: npm's dirty-tree check passes untracked
files, so `-A` would carry a stray one into the tag `publish.yml` fires on, and nothing here would
see it. It propagates and never decides: the version is read from `package.json`, never passed in,
and nothing there commits or tags — `npm version` does both, and a second tagging path is a second
way to publish.

It refuses to run anywhere but the tip of origin's default branch — on that branch, at the commit
origin has, asked of origin rather than of a possibly stale `origin/main`. `publish.yml` refuses an
unmerged tag too, but only after the push; v0.7.9 was first cut in a worktree one merge behind.

It refuses rather than doing part of the job. Both caller sets must hold the same caller files,
each set must call every reusable exactly once (the local set may leave out only a reusable the
release its callers pin does not have yet, asked of git at that tag, so the release that first
ships a reusable is cut with the local caller one job short, as v0.9.5 was for `merge.yml`, and
the next is refused until it is in), and each file must carry exactly the pins expected of it, one recognisable pin per site, so
an eighth workflow whose caller is missing from either
set, or a caller file missing from either, stops the release instead of quietly propagating to
what it found. A step naming a composite action, and a caller naming a reusable workflow, is
counted by its path, not by its pin, so one named under a ref that is not a pin is refused rather
than skipped.

A refusal leaves no commit and no tag, but it does leave the **manifest and lockfile bumped** in
the working tree — npm writes those before the hook runs and does not roll them back. Undo them
before you retry, or the retry dies on npm's dirty-tree check instead of on the fault you were
fixing:

```bash
git checkout -- package.json package-lock.json
```

The commit's message is `.npmrc`'s `message=v%s`, the `v` matching the tag `publish.yml` fires on.
That is the whole file: the registry and the token live in the `.npmrc` `actions/setup-node` writes
under `RUNNER_TEMP`, and a second copy of the scope here is a second place for it to be wrong.

The release also ships the dependency tree it was tested with, inside the package (#430): every
runtime dependency is listed in `bundleDependencies`, so `npm pack` puts the tree `npm ci` built
from `package-lock.json` under the tarball's own `node_modules`, and npm installs it from there as
it is. Not a shrinkwrap, which #414 tried: npm reads a dependency's `npm-shrinkwrap.json` only when
the registry's metadata sets `_hasShrinkwrap`, and GitHub Packages never sets it, so the file shipped
and was never read. The lockfile stays the one copy. `scripts/bundled-tree.ts`, run from source and
excluded from the build like `sync-version.ts`, holds a package's bundled tree to the lockfile's
runtime entries, version for version, with no dev package: `tests/bundled-tree.test.ts` runs it on a
pack and an install of that pack, and `publish.yml` runs it on the pack before publishing, on the
release installed through `npm exec` after, and on the Release asset installed by its URL.
`tests/bundled-tree.test.ts` also fails, naming the package, on a runtime dependency with an install
script or an `os` or `cpu` field: bundling builds the tree once, on the publishing runner, so adding
one is a decision to make on purpose.

`publish.yml` packs **once** (#561), with `prepack`'s build, and that one file is what the check
reads, what `npm publish` uploads, and what is attached, with its `.sha256`, to the tag's GitHub
Release: the tokenless install, since GitHub Packages' npm registry wants a token even for a public
package and a public repository's Release assets do not. The *already published* preflight gates
the registry publish only. A re-run on a published tag fetches the published tarball rather than
building another, and creates the Release or uploads an asset only where it is missing.

The checks that made this a chore rather than a hazard are still the backstop, and are what a
rewrite gone wrong lands on: `PIN` in `tests/workflows.test.ts` is derived from `package.json` and
checked against **both caller sets** — `examples/callers/*.yml` and `.github/workflows/agent-*.yml`
— so a release that leaves either behind fails the build by name. A stale example is an adopter
running last release's runners; a stale local caller is *this* repo running them.

`.github/dependabot.yml` is **not** the mechanism for that bump, and is not installed here for the
loop pins at all — `PIN` already holds both caller sets to `package.json`, so they cannot go stale.
It is here for the ordinary action pins (`actions/checkout` and friends), which nothing else tracks;
it exists as a documented adoption step because an adopter has no test that can see their pin
(`docs/ADOPTING.md` §4, which holds the one copy of the config).

Its `agent-loop` group should therefore never open a pull request here, and one that does is a
second signal that a release step was missed — it reads `.github/workflows` only, so it moves the
local callers and never `examples/callers/` or the `npm exec` lines, and its PR stays red until you
move those by hand.

Changing what a pin looks like — a new workflow, a renamed one, a different invocation — is a
change to `shared/pins.ts` and `tests/pins.test.ts` in the same commit, and to
`scripts/sync-version.ts` and its tests if the *set* of sites changed too. `shared/pins.ts` knows
four forms, `@<version>` for the npm spec `npm exec` takes, `@<version>` for the one `npm install`
takes (#422), `@v<version>` for a caller's `uses:` ref to a reusable workflow, and `@v<version>`
for a reusable's `uses:` ref to a composite action in `.github/actions/` (#257), and a fifth would
be a site it skips.

The split is not cosmetic. `shared/pins.ts` is the rewrite itself and **ships**, because `init`
(#6) performs the same rewrite into an adopter's tree; `scripts/sync-version.ts` is the release
policy around it and is excluded from the tarball. That exclusion holds only while nothing built
imports the script — `tsc` emits an excluded file the moment something pulls it in — so put shared
code in `shared/`, never in `scripts/`. A test in `tests/sync-version.test.ts` asserts it.

> **`bin` must never start with `./`.** `npm publish` silently drops such an entry and exits 0,
> producing a package whose commands cannot be run. `ci.yml` runs `npm publish --dry-run` and fails
> on the one log line that reveals it — `npm pack` does not reproduce it and neither does npm 10, so
> a local check will pass. See CONTEXT.md.
