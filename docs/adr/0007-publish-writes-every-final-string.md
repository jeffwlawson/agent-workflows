---
status: accepted
date: 2026-10-08
---

# The hand-over carries decisions and raw text, and publish writes every final string

[ADR 0005](./0005-writes-are-calls-with-a-log.md) has the readers give out the agent's text only
in cleaned form, and the loop add its markers after that, so "an agent cannot forge one". The
prototype of `review:publish` (#399) showed that this does not hold on today's hand-over (#405).
The runner builds the finished text before handing it over, mixing the agent's words with the
loop's own strings:

- the resolution marker at the end of each reply in `thread_resolutions.json`;
- the follow-ups payload, and the slot for the *Resolved* group, in `review_body.json`'s `slotted`;
- the head mark in `pr_summary.json`'s `summary.inner`.

All of these are HTML comments. A cleanup that strips comments deletes them along with anything the
agent hid. A cleanup that knows the markers keeps any marker the agent forged, because the agent's
runner can write these files ([ADR 0006](./0006-hand-over-between-agent-and-publish.md)).

**The runner decides, and publish writes the text.** The runner keeps every step that chooses
something: the verdict, which findings get a thread and where, which threads close and why, the
open and resolved grouping, the follow-up cap, the open count, and whether the summary is due. It
hands these over as data. Every step that turns those choices into text moves to publish: the
review body (`renderReviewPost` and its parts), each thread's body, the two closing replies, the
summary block with its Evidence and merge-danger sections, the status line and the follow-ups
block. Every marker moves with them, and so does every other string the loop writes into the
record as given, such as a commit status's context and description. No hand-over file holds a
record string.

**The same holds for the files `review:advance` reads.** Today the runner writes the park comments
and each ending's progress table and status line as finished text, and the last two carry the
`agent:progress` and `agent:status` markers. The runner hands over the round, the park reason, the
open findings and the data behind each ending's table instead, and `review:advance` writes the
text and its markers.

**All free text in the hand-over is cleaned on read, whoever wrote it.** Besides the agent's words,
the formatters take in a maintainer's reply, which a declined thread's reply quotes, and text from
the red check. Once formatting moves, those sit in files the agent can write too, so the readers
clean them the same way. Every other field is a target, a choice or a count, checked as #403
decided.

**The body's size limit moves with the formatting.** Only the finished text can be measured, so
publish holds the body to `REVIEW_BODY_BUDGET` and sheds in the same order as today. That includes
the last step, cutting out-of-scope follow-ups from the filed list, so publish makes that one
decision. A home for the list that never competes with the review's text is #406, which changes
the record and is outside this stage.

**The hand-over goes from seven files to five:**

| File | Holds |
|---|---|
| `findings.json` (was `review_payload.json`) | One entry per finding to post: id, severity, title, the agent's text, path, line, and whether it was previously missed |
| `review_body.json` | The verdict, the agent's assessment, the open, resolved and missed entries, criteria results, follow-ups and their cap, and red-test results |
| `thread_resolutions.json` | Per thread: id, reason, whether it was already replied to, and the agent's note or the maintainer's reply to quote |
| `pr_summary.json` | The title, the agent's summary, whether the round is final, and the data behind Evidence and merge danger |
| `verdict.json` | The verdict's key, and whether it starts a fix round. Publish takes the status contexts, states and descriptions from its own constants (`VERDICT_CONTEXT`, `FIX_ROUND_STATUS` and the verdict table) |

`pr_status.md` goes, because publish builds the status line from the verdict and the open count.
`follow_ups.md` goes, because publish adds the `agent:follow-ups` label when the list is not empty
after shedding.

## Considered options

- **The runner keeps building the text, and publish checks the markers.** Rejected: no check can
  tell the loop's marker from one the agent wrote in the same file.
- **The runner formats the prose, and publish adds only the markers.** Rejected: in the review body
  the markers sit inside the prose, one per entry, so the two cannot be handed over apart.
- **Publish fetches the non-agent text itself**, such as the maintainer's reply. Rejected: it adds
  GitHub calls, and it would quote a reply the maintainer may have edited after the review read it.
  One rule, "all free text in the hand-over is cleaned", is simpler.
- **One hand-over file instead of five.** Not taken: each file matches one kind of write, so ADR
  0006's declared sets and the prototype's readers keep their shape and only their contents change.

This is also how gh-aw works: the agent emits plain items, and the writer cleans their text (it
removes every HTML comment, among other steps) before adding its own footer and markers. It is what
OWASP's *Improper Output Handling* (LLM05) recommends: treat model output as untrusted, and encode
it where it is used, in code the model cannot reach.

## Consequences

- ADR 0005's "an agent cannot forge one" rests on this ADR.
- The agent's runner can no longer name a status context, or start a fix round by adding
  `fixRound`. It can still claim a verdict or a fix round, which is a choice like any other and is
  checked as #403 decided; what it posts is one of publish's own statuses.
- ADR 0006's check of the payload's `commitOID` against the reviewed commit goes away. Publish
  builds the review request from the reviewed commit it is given as an input, so no hand-over file
  names a commit.
- The `agent:follow-ups` label is added only when follow-ups survive shedding. Today it is added
  whenever the runner wrote any.
- The runner's tests of the formatters become tests of `review:publish`. The runner's tests check
  the decisions it hands over.
- The prototype's `FINDING` test spells two of the markers wrongly (`agent-review:resolution`,
  `agent-review:follow-ups`). The real ones are `agent-resolution` and `agent-follow-ups`. The
  finding holds anyway, since every real marker is an HTML comment.

## Revisit when

A formatter has to read something only the agent's runner can see, so publish cannot build the
text from the hand-over and its own inputs.
