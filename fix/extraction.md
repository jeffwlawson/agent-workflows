Emit a single `<output>` block as the last thing in your response.

Do not change files. Do not run commands. Do not include any text outside the `<output>` block.

Report one outcome per review thread you were shown, using the `threadId` exactly as given in the
feedback (the `` thread `PRRT_...` `` marker). Do not invent ids — an unrecognised id is dropped.
Omit threads you did not consider.

- `addressed` — nothing is outstanding: the comment's concern is satisfied in the current HEAD.
  Use this **whether you fixed it in this run or an earlier commit already did** — the question
  is whether anything is still owed, not whether you personally changed something. The thread
  will be **resolved**.
- `declined` — you disagree, or are deliberately not acting. The thread stays **open** so a human
  can push back. Say plainly why, in the reply.

The reply is posted publicly into the thread, so write it to the person who left the comment.

Then report `topLevelComments` — comments posted on the PR conversation rather than into a thread.
One is warranted only for something that belongs to **no** thread: an out-of-scope finding noticed
while fixing, a refusal or partial completion spanning several threads, a cross-cutting observation
answering no specific comment. Not a summary of what you changed — the commit message carries that.
Not anything a thread reply already says.

**Default to an empty array.** Most runs have nothing that belongs outside a thread, and a channel
that fires every time is one nobody reads. At most two are posted; anything past the second is
dropped, so list the two that matter rather than everything you could say.

```json
<output>
{
  "threadOutcomes": [
    { "threadId": "PRRT_kwDO...", "status": "addressed", "reply": "Fixed in abc1234 — removed the stale claim." },
    { "threadId": "PRRT_kwDO...", "status": "declined", "reply": "Left as is: `label` is message presentation rather than domain knowledge, so it carries no drift risk." }
  ],
  "topLevelComments": [
    { "body": "Out of scope, noticed while fixing: `shared/pr-feedback.ts:206` interpolates `GH_REPO` into a shell string. Safe today only because of what that variable happens to be. Worth a follow-up issue." }
  ]
}
</output>
```

Use an empty array for either field when there is nothing to report — no threads acted on, nothing
outside them.
