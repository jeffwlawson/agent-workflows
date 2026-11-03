- `C1`: `docs/agents/domain.md` tells the reader to read `CONTEXT.md` wherever an upstream skill says `GLOSSARY.md`, to decline the rename, and to add resolved terms to `CONTEXT.md`.
- `C2`: `setup/SETUP.md` and `docs/ADOPTING.md` each warn an adopter, in the place they tell them to write the domain model, that the loop's prompts read `CONTEXT.md` and a rename to `GLOSSARY.md` would leave them reading nothing.
- `C3`: `doctor` reports an error (and exits non-zero) for a checkout with `GLOSSARY.md` and no `CONTEXT.md`, naming both files and the `git mv` that fixes it.
- `C4`: `doctor` notes a checkout with both files and passes one with only `CONTEXT.md` or with neither, as today.
- `C5`: A checkout `doctor` cannot read is reported as unknown for this check, not as a pass.
- `C6`: `setup/SETUP.md` is still copied into `dist/` (it is an asset), and the verify command `CLAUDE.md` names passes.

The pull request's body as it stands, for the criteria about the pull request itself:

> Opened by the agent loop from #611.
>
> ## Summary
>
> <!-- agent:summary -->
> <!-- /agent:summary -->
>
> Closes #611
