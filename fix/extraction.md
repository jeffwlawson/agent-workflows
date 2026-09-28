Emit a single `<output>` block as the last thing in your response.

Do not change files. Do not run commands. Do not include any text outside the `<output>` block.

Report one outcome per review thread you were shown, using the `threadId` exactly as given in the
feedback (the `` thread `PRRT_...` `` marker). Do not invent ids — an unrecognised id is dropped.
Omit threads you did not consider.

- `addressed` — nothing is outstanding: the comment's concern is satisfied in the current HEAD.
  Use this **whether you fixed it in this run or an earlier commit already did** — the question
  is whether anything is still owed, not whether you personally changed something.
- `declined` — you disagree, or are deliberately not acting. Say plainly why, in the reply.

Both leave the thread **open**. Neither outcome closes anything: the next review checks the code
and closes what it finds fixed, so what you are writing is the claim it checks.

Every reply is **under 100 words**, written to the person who left the comment: what you did, then
why, then the commit if there is one. The examples below are the shape, not a length target.

Then report `conversationOutcomes` — one per **conversation comment** you were shown, keyed by the
`commentId` exactly as given (the `` comment `IC_...` `` marker). The same two values, read the same
way: `addressed` when nothing is outstanding, `declined` when you disagree or are deliberately not
acting. A **declined** one carries the reason, written to the person who left it — that is the only
record such a decline leaves anywhere. Under 100 words, like a thread reply.

Omit a comment you did not consider, one shown without an id, and report an empty array where you
were shown none. An unrecognised id is dropped, and nothing this loop posted itself carries one —
its own earlier comments and its status notes alike get no outcome.

These are posted together as one comment on the pull request conversation. They are **not**
`topLevelComments` — do not report the same thing in both.

Then report `topLevelComments` — comments posted on the PR conversation rather than into a thread.
One is warranted only for something that belongs to **no** thread: an out-of-scope finding noticed
while fixing, a refusal or partial completion spanning several threads, a cross-cutting observation
answering no specific comment. Not a summary of what you changed — the commit message carries that.
Not anything a thread reply already says.

**Default to an empty array.** Most runs have nothing that belongs outside a thread, and a channel
that fires every time is one nobody reads. At most two are posted; anything past the second is
dropped, so list the two that matter rather than everything you could say.

Each body is **under 120 words**: name the thing, say where it is, say why it matters.

```json
<output>
{
  "threadOutcomes": [
    { "threadId": "PRRT_kwDO...", "status": "addressed", "reply": "Fixed in abc1234 — removed the stale claim." },
    { "threadId": "PRRT_kwDO...", "status": "declined", "reply": "Left as is: `label` is message presentation rather than domain knowledge, so it carries no drift risk." }
  ],
  "conversationOutcomes": [
    { "commentId": "IC_kwDO...", "status": "addressed", "reply": "Done in abc1234 — dropped the second copy you pointed at." },
    { "commentId": "IC_kwDO...", "status": "declined", "reply": "Not doing this one: the value it would read is the one the caller already passes, so deriving it again is the drift you asked me to remove." }
  ],
  "topLevelComments": [
    { "body": "Out of scope, noticed while fixing: `shared/pr-feedback.ts:206` interpolates `GH_REPO` into a shell string. Safe today only because of what that variable happens to be. Worth a follow-up issue." }
  ]
}
</output>
```

Use an empty array for any of the three fields when there is nothing to report — no threads acted
on, no conversation comments shown, nothing outside them.
