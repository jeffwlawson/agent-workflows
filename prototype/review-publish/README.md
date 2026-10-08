# PROTOTYPE: `review:publish` and `review:conclude` (#399)

Throwaway. This branch is never merged. It checks ADRs 0004, 0005 and 0006 against what
`review.yml`'s `post-review` job does today.

| What | Where |
|---|---|
| Engine: transport, reader, writer, splicing | `engine/github.ts`, `engine/read.ts`, `engine/writer.ts`, `engine/splice.ts` |
| Contract entries and directory inputs | the end of `shared/contract.ts` |
| Typed readers for the hand-over | `review/hand-over.ts` |
| The two commands | `review/publish.ts`, `review/conclude.ts` |
| What `cli.ts` would do | `review/commands.ts` |
| Scenarios against a fake GitHub | `tests/prototype-review-publish.test.ts` |
| One write log per scenario | `logs/` |
| The posting job's YAML afterwards | `post-review.yml` |

Run it with `npx vitest run tests/prototype-review-publish.test.ts`. That rewrites `logs/`.

## Findings

### Where the decided shape was awkward or wrong

1. **`conclude` is how every run ends, not just the failure path.** Taking `agent:review` off,
   re-requesting it when the head moved, and the fix round's hand-off all run after every result,
   on success as well as failure. So they belong in `conclude`, not `publish`. `conclude` tells
   the endings apart from step outcomes (`MINT_OUTCOME`, `PUBLISH_OUTCOME`) passed as inputs, and
   from `publish`'s own files (`published.json`, `failure_reason.txt`) read through a directory
   input. Today the YAML keeps "a failed hand-off is not a failed review" by putting the steps in
   that order. That now has to be passed as data.
2. **Failure reasons now come from three places**: the review job's output, `publish`'s
   `failure_reason.txt`, and the token mint's own file. The prototype replaces the mint's reason
   with a fixed sentence.
3. **`conclude` can't require `LOOP_TOKEN`**, because a failed mint is one of the endings it has
   to report. ADR 0004 has every command that writes declare it.
4. **"Replace the block between two markers" is too narrow a write type.** The summary write is
   a title, plus a splice, plus a drop that runs only if the splice worked, all against the live
   body. What fits is `editPullRequest({ title?, body?: (live) => string | undefined })`, with
   splicing as an engine helper the loop's function calls.
5. **The hand-over's GraphQL `query` has to be ignored.** Today `gh api graphql --input
   review_payload.json` sends whatever query the file holds, with `contents: write`. The engine
   now owns the mutation, and the reader keeps only the variables. #403 didn't list this gap.
6. **The engine's errors aren't sentences a person can act on.** Every write that stops a command
   needs loop code that catches it and rethrows the sentence the failure comment shows. Without
   that, the comment read "PostReview PR_node failed: addPullRequestReview … 422".
7. **Cleaning at read can't tell the loop's markers from the agent's text.** The runner builds
   loop strings into the agent's text before the hand-over: the resolution marker inside every
   reply, the follow-ups JSON marker in the body, and the head mark in the summary. A cleanup that
   strips HTML comments (what `withoutComments` already does) deletes all three. A cleanup that
   knows the markers would keep a forged one. ADR 0005's "an agent cannot forge one" holds only if
   the hand-over carries the agent's parts unbuilt and `publish` builds them. That means moving
   rendering out of the runner. See the `FINDING` test.

### The write log in practice

- One line per write, with token, type, target, outcome and the GitHub calls. It reads as a
  timeline (see `logs/03-review-refused.md` and `logs/07-hand-off-fails.md`), and a stop at the
  first failure left the record readable in every scenario.
- **The log needs appending per entry**, so a cancelled command leaves what it did. `writers` had
  no append, so `appendLine` was added to `shared/env.ts`.
- **It can't tell a tolerated failure from the one that stopped the command.** The writer doesn't
  know which it was, so the command's end (finished, or stopped and why) should be a final line.
- **The coupled reply-and-resolve logs `failed` even when its reply landed.** Only the calls
  column shows that half succeeded. It needs a `partial` outcome or one entry per call.
- **The writer doesn't latch after a failure.** "Stops at the first failure" belongs to the
  command, as an uncaught throw, because only the loop knows which writes it can live without.
- **Caps are per command, and most are 1 or 2.** Only the thread cap (50) bounds anything real.

### Engine imports and the agent driver

- **Held:** nothing under `engine/` imports loop code (a test).
- **Failed:** `review:publish` reaches the agent driver. The record strings (`VERDICT_CONTEXT`,
  `FIX_ROUND_STATUS`) live in `shared/review-output.ts`, which imports `shared/common.ts`, which
  imports `@ai-hero/sandcastle`. ADR 0004's "a command's imports never reach the agent driver"
  check fails on the first command. The record strings need a module with no imports.

### What the publish job's YAML shrank to

`post-review.yml`: 15 steps become 7, and about 422 lines that aren't comments become about 85.
It gains `setup-node`, moves the mint to the start, adds a glue step that turns `ended.json` into
job outputs for `advance`, and uploads the write logs.
