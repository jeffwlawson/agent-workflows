- `C1`: A release run publishes the same tarball to GitHub Packages and attaches it, with a `.sha256` file, to the Release for the tag; the digest in the file matches the attached tarball.
- `C2`: Re-running on an already-published tag with the Release or asset missing creates what is missing; with both present, changes nothing.
- `C3`: `npm install <asset url>` of the attached tarball, with no registry credentials in the environment, installs the package with its bundled tree intact (the same check `scripts/bundled-tree.ts` makes after a registry install).
- `C4`: The workflow's Release steps reference no repository or owner by name: they use the workflow's own context (`github.repository`, the tag), and the docs show the URL form with placeholders.
- `C5`: `tests/workflows.test.ts` asserts the permission and the shared tarball between the pack, publish and upload steps.
- `C6`: The guide names the tokenless install and says the registry route needs a token.

The pull request's body as it stands, for the criteria about the pull request itself:

> Opened by the agent loop from #561.
>
> ## Summary
>
> <!-- agent:summary -->
> <!-- /agent:summary -->
>
> Closes #561
