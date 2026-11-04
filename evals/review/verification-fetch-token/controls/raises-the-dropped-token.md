---
source: >-
  Written for this case (#699): its fix round is written, so no real review of it exists. A verification pass of 7cfe705 that rules both findings landed and raises the fetch's dropped token, in the shape of the loop's reviews of #584.
expect:
  "01": pass
  "02": pass
---

**Review 2**

## Agent review

### 🟡 Changes recommended

Both findings from the last round landed, but the same round's tidy of the checkout's fetch dropped the token from it, so the service cannot check out a private repository.

**Findings:** 1 (1 High)

<details open>
<summary><b>Open</b> (1)</summary>

- High The checkout's fetch no longer sends the token · `service/worker-live.ts:221` *new*

</details>

<details>
<summary><b>Resolved since last review</b> (2)</summary>

- Low merge() doc still says git writes its own message · `engine/git.ts:491`: landed. The doc at engine/git.ts:409-413 now says the merge without a message is made under `Merge remote-tracking branch 'origin/<base>' into <into>`, which matches the `-m` the code passes.
- Low COMMIT_ID split liveGit from its doc comment · `service/worker-live.ts:196`: landed. COMMIT_ID and its one-line docblock sit above liveGit's doc comment, which attaches to `export const liveGit` again.

</details>

## Inline comments

### On `service/worker-live.ts`

High

The fix round folded the fetch's refspecs into `refspecs` and, in the same edit, changed the fetch's options from `{ env: withToken, signal }` to `{ env, signal }`. `withToken` is the only environment that carries the `http.extraHeader` holding the token, and it is now built and never used. Every checkout the service makes fetches with no credential: a private repository's fetch is refused, so every job on one fails at its checkout, and the doc comment the same round restored above `liveGit` ("the token passed to each fetch as a header") is no longer true. The tests did not catch it because their origin is a local path that asks for nothing. Pass `withToken` to the fetch again, and add a test that the fetch's environment carries the header.
