These were raised by an earlier review of this pull request and nothing has verified them fixed.
Each carries the identifier the workflow gave it when it was posted; the evidence is on the thread
it was raised in, under **EXISTING FEEDBACK** above.

- `f-e9ff19ad`: engine/git.ts:491 · With no `message`, the merge now passes its own `-m "Merge remote-tracking branch 'origin/${base}' into ${into}"`. The `GitMerger.merge` doc at `engine/git.ts:409-410` still says "without it, git writes its own." Someone reading the contract will expect git's own message, which follows config such as `merge.suppressDest`, and will get the literal subject built here instead. Reword those lines to say the merge is made under the subject a person's `git merge origin/<base>` makes.
- `f-2cf88326`: service/worker-live.ts:196 (outdated: the code here has changed since) · `COMMIT_ID` and its docblock sit between `liveGit`'s TSDoc (`service/worker-live.ts:188-195`, "The checkout, with the token passed to each fetch as a header...") and `export const liveGit`. That comment now attaches to `COMMIT_ID`, which ends up with two docblocks, and `liveGit` has none. Hover and generated docs no longer explain why the token is kept out of the checkout's configuration. Move the `COMMIT_ID` declaration above the `liveGit` docblock.

**Rule on every one of them, by identifier, in `verified`.** For each: `landed` if the current code
resolves it, `open` if it does not, `declined` if a maintainer has refused it, and one line saying
why. Check the code in front of you rather than a claim that it was fixed; a reply saying a finding
was addressed is an assertion, and verifying it is the whole of this job. **`open` is the ruling
for a finding the current code does not clearly resolve.**

This is asked of **every** review, this round included. A finding does not need a fix round to have
been settled: a human may have pushed the fix, or the finding may have been wrong.

A finding you rule `landed` has its thread closed by the workflow, with your line as the reason.
One you rule `open` counts against this pull request exactly as a finding of your own would, and
**ruling it `open` is the whole of reporting it**. If there is more to say about it than the line
beside its identifier, say it in that line.

**`declined` is a maintainer's decision, and you only report it.** Rule a finding `declined` only
on the maintainer's latest reply on its thread, and only where that reply refuses it in words
("won't fix", "this is intended", "leave it"). The workflow closes the thread as *won't fix*,
quoting that reply. Every other reply (an explanation, a question, "I'll get to it", or a refusal
the maintainer has since revisited) leaves the finding `open`.
