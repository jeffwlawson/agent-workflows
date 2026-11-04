> *Filed by AI from the pre-merge check of #568 (#567). Not urgent: both need someone who can push tags to the repository.*

## What happens

Since #568 the service's checkouts fetch tags, as Actions' `fetch-depth: 0` always has. Two places then read a short ref name that a tag can shadow:

1. **Implement's checkout.** A tag named `main` (the base branch's name) makes `git checkout -B main main` fail with "ambiguous object name" for an implement job, which passes the base ref as the sha (`service/worker.ts:1509` → `service/worker-live.ts:217`). New with #568.
2. **update-branch's merge.** `engine/git.ts:486` merges the short name `origin/${base}`. A tag named `origin/main` wins, so the merge brings in the tag's commit while the comment reports the real base. Seen in a probe: the tag's file landed in the merge. Actions has had this since `fetch-depth: 0`. #568 brings it to the service.

## Proposal

Fully qualify both: check out `refs/remotes/origin/<branch>`, and merge `refs/remotes/origin/<base>`. Add a test for each with a shadowing tag present.
