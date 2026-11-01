## What to build

Installing or upgrading the package today needs a registry token: GitHub Packages' npm registry requires auth even for a public package. `.github/workflows/publish.yml` already packs and checks the tarball and ships its dependency tree inside it (`bundleDependencies`, held by `scripts/bundled-tree.ts`), so that one file is a complete install. Attach it to the GitHub Release for the tag, with its SHA-256, so `npm install <release-asset-url>` works with no token (release assets on a public repository need none).

GitHub Packages publishing stays exactly as it is; the Release is an addition.

- Create the `v<version>` Release if absent, and upload the **exact tarball that is published** plus a `<tarball>.sha256` file. Today the check step packs with `--ignore-scripts` (no build) and `npm publish` packs again with `prepack`'s build, so they are two different tarballs. Pack once (with the build), run the bundled-tree check on that file, publish **that file**, and upload **that file**.
- The "already published" path must not skip the Release: a tag whose registry publish succeeded but whose Release step failed (or a re-pushed tag) must be able to create the missing Release or asset on a re-run. A re-run where both exist is a no-op, never a duplicate asset or a changed tarball.
- The job needs `contents: write` for the Release, beside `packages: write`. State why in the workflow comment.
- `docs/deploying-the-service.md` documents `npm install <release-asset-url>` as the tokenless install (and upgrade, same command at a new version), with the checksum check. Its line about "read access to the registry" says when it applies. The registry install stays documented as the other route.

## Acceptance criteria

- A release run publishes the same tarball to GitHub Packages and attaches it, with a `.sha256` file, to the Release for the tag; the digest in the file matches the attached tarball.
- Re-running on an already-published tag with the Release or asset missing creates what is missing; with both present, changes nothing.
- `npm install <asset url>` of the attached tarball, with no registry credentials in the environment, installs the package with its bundled tree intact (the same check `scripts/bundled-tree.ts` makes after a registry install).
- The workflow's Release steps reference no repository or owner by name: they use the workflow's own context (`github.repository`, the tag), and the docs show the URL form with placeholders.
- `tests/workflows.test.ts` asserts the permission and the shared tarball between the pack, publish and upload steps.
- The guide names the tokenless install and says the registry route needs a token.

## Where things are

Read at `main` a3a39c2, 2026-10-31.

- `.github/workflows/publish.yml`: permissions (`contents: read`, `packages: write`); step *Skip if already published* (`already-published` output) gates the pack check, publish and post-publish check; the pack check uses `--ignore-scripts`.
- `scripts/bundled-tree.ts`, `tests/bundled-tree.test.ts`.
- `docs/deploying-the-service.md`: the *Node 24.14 or later ... read access to the registry* requirement, and the install-as-root paragraph near the end.
- CLAUDE.md *Releasing* describes the tag flow and the bundle; update it if the flow's description changes.

## After merge, by a human

- Cut the next release and confirm the Release has the tarball and `.sha256`, and the digest matches.
- From a machine with no registry credentials, run the documented `npm install` of the asset URL and start the CLI.

## Overlap

Checked 2026-10-31 against open issues and PRs: no overlap found. Touches `publish.yml` and the deployment guide only.

## Constraints (design guardrails)

The owner wants nothing here that blocks opening the package to the public later.

- Nothing owner-specific (IPs, host or account names, Unraid, Tailscale, `jeffwlawson`) is baked into package code or its tests' expectations. Values come from `package.json`, the App's own record, a setting, or what the operator types.
- The feature stays host-neutral and orchestrator-neutral: it works the same on any machine that runs the service, and does not change what the Actions orchestrator does.
- Anything that supports only one setup says so in the docs it touches.
