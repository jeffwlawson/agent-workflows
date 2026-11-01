## Problem

A repository's verify command can fail on the service orchestrator for a reason it never has on Actions: the service's checkout holds no tags. This repository's `tests/workflows.test.ts` reads the release the local callers pin with `git show v<pin>:…` and fails with "Fetch the tags" when the tag is absent. An update-branch agent on #463 (service, v0.9.2) saw 12 such failures, which Actions does not produce. Every agent that runs verify (fix, implement, implement-prd, update-branch on a conflict) can be misled the same way: it may try to "fix" a failure that is not the change's, or commit past it, as that one did. Any repository whose tests or build read a tag (version checks, `git describe`, release notes) is affected.

## Acceptance criteria

- [ ] A checkout the service makes holds every tag the repository's base has, as `fetch-depth: 0` gives on Actions, or the smallest fetch that yields the same set of tags. The brief's author recommends `--tags` on the existing fetch, adding no history beyond what the head and the base already bring; the implementer decides and justifies it in the PR.
- [ ] The agent's sandbox copy holds those tags: a tag the checkout has can be read by `git show <tag>:<path>` from inside the agent's working copy.
- [ ] A test proves a checkout made by the service's git edge holds the base's tags (a tag created on the base is present in the resulting checkout), and fails if tags are skipped.
- [ ] The platform spec and the service deployment doc state that the checkout carries the repository's tags, wherever they describe what the checkout fetches (including the note that Actions' `fetch-depth: 0` fetches every branch while the service's fetches the base alone).
- [ ] The token is still passed per fetch and never stored in the checkout.
- [ ] One PR. Host-neutral: nothing about a particular deployment.

## Where things are (checked 2026-10-31 at c8ff6c2; pointers may move)

- Cause: `service/worker-live.ts:212`, the checkout's fetch passes `--no-tags` and names only the head and the base branch.
- Contrast: `.github/workflows/fix.yml:315,722`, `implement.yml:308,647`, `implement-prd.yml:444,572,961`, `update-branch.yml:268,377,733`, `review.yml:260,652` all use `fetch-depth: 0`. `service/worker.ts:1829-1835` has the comment noting the service fetches the base alone; `service/worker.ts:67-72` is the `Git.checkout` contract.
- Sandbox copy: Sandcastle bundles the checkout with `git bundle create … --all` (`node_modules/@ai-hero/sandcastle/dist/chunk-VOG34SRF.js:26185`), and `--all` includes `refs/tags/*`, so the copy should carry any tag the checkout has and likely needs no change in `engine/bwrap.ts`; confirm with the test above rather than assume.
- Docs: `docs/platform-spec.md` near line 1144 (the checkout note) and wherever it describes the service's checkout; `docs/deploying-the-service.md`.
- No existing test covers `liveGit` (none under `tests/` references it).

## Overlap checked

Searched open and closed issues and PRs for tags, checkout and fetch: no duplicate or same-scope work. #463 is where the symptom was seen, not a related change. No open PR touches `service/worker-live.ts`.
