- `C1`: The script, given a log containing `Adopter-Action:` lines, returns a section listing each with its short SHA and pull request number; given none, a section saying there is no adopter action; given no earlier tag, the "no earlier release" line.
- `C2`: A line that merely mentions the key mid-sentence is not taken; the key matches at the start of a line, ignoring case.
- `C3`: The Release `publish.yml` creates has the install sentence and the *Adopter action* section as its body, built from the history between the previous `v*` tag and this one, and a re-run that finds the Release present does not change its body.
- `C4`: The script is excluded from the tarball and nothing built imports it, the way `scripts/sync-version.ts` is, and a test says so.
- `C5`: A test in `tests/workflows.test.ts` holds `publish.yml` to calling the script on the Release's creation and to passing the body by file.
- `C6`: `CLAUDE.md` says when a change owes an adopter action and the trailer's exact form, and `docs/ADOPTING.md`'s *Keeping the pins fresh* tells an adopter to read the section when moving the pin.
- `C7`: The PR states what a real squash-merged commit on `main` showed for a trailer.
- `C8`: The verify command `CLAUDE.md` names passes.

The pull request's body as it stands, for the criteria about the pull request itself:

> Opened by the agent loop from #621.
>
> ## Summary
>
> <!-- agent:summary -->
> <!-- /agent:summary -->
>
> Closes #621
