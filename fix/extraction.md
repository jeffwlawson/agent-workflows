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

```json
<output>
{
  "threadOutcomes": [
    { "threadId": "PRRT_kwDO...", "status": "addressed", "reply": "Fixed in abc1234 — removed the stale claim." },
    { "threadId": "PRRT_kwDO...", "status": "declined", "reply": "Left as is: `label` is message presentation rather than domain knowledge, so it carries no drift risk." }
  ]
}
</output>
```

Use an empty array when there were no threads to act on.
