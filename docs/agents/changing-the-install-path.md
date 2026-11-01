# Changing the install path

`setup/` is `init` and `doctor` — the half a human runs, in somebody else's checkout. It is
deliberately **not** shaped like a runner: a runner is `<name>/<name>.ts` plus a prompt and takes no
arguments, and the walk in `tests/agent-cli.test.ts` derives "the runners" from exactly that shape,
so a `setup/setup.ts` would quietly enrol these two in every rule written for the runners.

1. `setup/callers.ts` is the half both use — reading a caller out of an adopter's tree. A caller is
   recognised by **what it calls**, never by its filename: adopters rename files and job ids, and a
   re-run that does not find theirs writes a second copy beside it.
2. `init` copies `examples/callers/`; it does not generate. A generator is a second description of a
   caller, and the release after it drifts is one where an adopter installs a file nothing tested.
   It copies **once**: a caller already installed has its pin moved in the adopter's own text and
   nothing else touched, and one they do not have is named rather than written back. A caller is
   what an adopter owns, so a re-run that re-copied would silently revert their `with:` inputs,
   their job id and their extra permissions — the silent-failure class this command exists to
   remove. Drift in the caller *body* is `doctor`'s to report, not `init`'s to overwrite.
3. The rewrite is `shared/pins.ts` — the same one the release performs. See *Releasing*.
4. `doctor` is two halves: `gatherFacts` asks `gh` what a checkout cannot answer, and `diagnose`
   rules on callers and facts and nothing else. Keep the second one pure — every check is exercised
   through it, and an unreadable fact must stay `undefined` rather than collapsing into a pass.
   "No secrets are set" and "you are not an admin here" lead to opposite actions.
5. `diagnose` rules on a **fixed list**, and nothing diffs an adopter's caller against
   `examples/callers/`. So a release that changes a caller *body* — a new `with:` input, a changed
   trigger, another grant — is a change to `diagnose` in the same commit, the way a new pin site is
   a change to `shared/pins.ts` in the same commit. Neither half carries it otherwise, and a re-run
   of `init` reports `unchanged` on a caller that is now wrong.
6. `examples/callers/*.yml` and `setup/SETUP.md` are **assets**: `scripts/copy-assets.ts` puts them
   under `dist/` at the same relative path, exactly as it does a prompt, because `tsc` emits `.js`
   and nothing else. An asset that is not copied resolves in a checkout and is absent from the
   tarball — a failure only a published version shows.
