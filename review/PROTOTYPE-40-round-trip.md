# PROTOTYPE — throwaway. Not wired to anything. Do not merge to `main`.

Drafted for [#40](https://github.com/jeffwlawson/agent-workflows/issues/40) so the round trip can
be *reacted to* rather than argued about. Three drafts: what the reviewer is told, what it emits,
and what a stub reads like.

Grilled and settled on 2026-09-19 — every choice below is confirmed. The seams this draft does not
cross are named where they fall: the trigger and the opt-out label are #39's, dedup at filing time
is #41's.

---

## 0. Where the block physically lives

Settled by [#38](https://github.com/jeffwlawson/agent-workflows/issues/38): the filing step reads
the **review body** of the latest bot review. `review/review.ts:81` sets that body to
`result.output.summary` verbatim. So the third channel cannot stay a sibling of `summary` in the
posted artifact — the runner has to **serialise it into the body** on the way out.

Shape: a collapsed `<details>` a human can open, wrapping a fenced JSON payload the filing step
parses. One block, two readers.

**Settled — collapsed `<details>`, visible.** An opt-out the author cannot see is not an opt-out.
The cost is body length (#37: 65,536 chars, overflow is a 422 that takes the inline comments with
it), which the cap of 3 keeps near zero.

**Settled — the human half renders titles and locations only**, with the JSON in an adjacent HTML
comment. That is enough to answer the only question the block asks of a pre-merge reader — *do I
want these filed* — and it does not duplicate the full stub bodies into a body with a hard
ceiling.

---

## 1. `review/extraction.md` — the change

Appended after the existing `startLine` paragraph, before the JSON example:

> ### Out-of-scope findings
>
> `followUps` carries findings that are **real and not fixable in this pull request**. Each one
> becomes a tracking issue when the PR merges, so the bar is what you would want a stranger to
> receive cold:
>
> - **A location.** A path, or `path:line` — the place a reader starts.
> - **Evidence it is real.** The code or the check result it rests on, quoted. Not a suspicion.
> - **Why this pull request cannot fix it.** Out of scope means the change in front of you does
>   not own the problem, not that the problem is tedious.
>
> Excluded: style preferences, "consider adding tests someday", and speculative refactors.
>
> **This list is complete every run.** The instruction to raise only what is new governs the
> summary and the inline comments; it does **not** govern this list. Re-state every finding that
> still stands, including ones you listed in an earlier review of this pull request. Only the most
> recent list is read, so a finding you leave out is a finding dropped.
>
> **Order them most serious first.** Most serious means the finding whose consequence is worst if
> nobody ever fixes it — not the one that is hardest to fix, and not the one you are most confident
> about.
>
> **At most three.** If you have more than three, list the three most serious. Anything past the
> third is dropped from the end of your list — so the order you choose is the order that survives.
>
> Use an empty array when there are none — which is the ordinary case.

And the JSON example gains:

```json
"followUps": [
  {
    "title": "parse() silently accepts trailing separators",
    "location": "src/example.ts:120",
    "body": "**Evidence.** `parse()` splits on `,` and drops empty segments, so `\"a,b,\"` and `\"a,b\"` return the same array — `example.test.ts` has no case for either.\n\n**Why not here.** This pull request only changes the caller in `apply()`; tightening `parse()` would change what every other caller accepts."
  }
]
```

**Settled — `followUps`, not `outOfScope`.** It agrees with the settled `pr-follow-up` stub label.
The bar lives in the prompt prose, where it is actually enforced, not in a field name read once.

**Settled — `location` is its own field.** It costs a field and buys the only machine-readable
anchor [#41](https://github.com/jeffwlawson/agent-workflows/issues/41) has to key duplicate
detection on, short of comparing prose.

**Settled — evidence and "why not here" are two prose beats inside one `body`, not two fields.**
Two fields would appear to enforce the bar structurally, but a required field is satisfied by a
sentence of filler; the bar is a prompt problem either way. One `body` also keeps the shape close
to `InlineComment`, which the agent already produces well.

**Settled — the ordering instruction names its axis, and names the two it rejects.** *Difficulty*
and *confidence* are the orderings a model reaches for unprompted, and both are wrong: a
trivial-to-fix data-loss bug outranks a gnarly refactor. The word *worst* is gone — it can be read
as worst-*quality*, which inverts the instruction. The summary channel can afford "worst first"
because every finding there carries a **blocking** / **judgement call** label supplying the axis;
`followUps` has no such label and must state it.

**Settled — the truncation mechanism is stated to the model.** "Keep the three worst" describes a
filter applied inside the model, where nothing can check it — the same unobservable-compliance
failure as the "already tracked" clause below. "List the three most serious; anything past the
third is dropped from the end" puts the whole operation in the output.

### The clause that has to go

[#31](https://github.com/jeffwlawson/agent-workflows/issues/31)'s bar also excludes *"anything
already tracked"*. **The agent cannot honour it.** `scrubGitHubTokens()` runs at
`review/review.ts:45`, before the agent starts — it has no view of the issue tracker, by design. An
instruction the agent cannot check is an instruction it will fabricate compliance with.

It is **dropped from the prompt**, and dedup moves to filing time, where a token exists.
That is #41's question, and this draft assumes it lands somewhere.

### `CLAUDE.md`: prompts name no domain

Checked. The added text names no consuming repo's vocabulary and does not name the gate command.
The example uses `src/example.ts`, matching the file's existing placeholders.

---

## 2. `shared/review-output.ts` — the schema addition

```ts
/** Cap lives here so the prompt and the runner cannot drift. */
export const MAX_FOLLOW_UPS = 3;

export interface FollowUp {
  /** One line, as a human scans it in a triage list. */
  readonly title: string;
  /** `path` or `path:line` — where a reader starts. Not validated against the diff. */
  readonly location: string;
  /** Evidence it is real, then why this PR cannot fix it. */
  readonly body: string;
}

export interface ReviewOutput {
  readonly summary: string;
  readonly inlineComments: InlineComment[];
  readonly followUps: FollowUp[];
}

const parseFollowUp = (value: unknown): FollowUp => {
  const record = asRecord(value, "follow-up");
  return {
    title: asString(record["title"], "follow-up title"),
    location: asString(record["location"] ?? record["path"], "follow-up location"),
    body: asString(record["body"], "follow-up body"),
  };
};
```

and inside `reviewOutputSchema`:

```ts
    followUps: asArray(record["followUps"] ?? [], "followUps").map(parseFollowUp),
```

**The cap is not enforced here.** A schema throw fails extraction, which loses the *whole* review —
summary and inline comments with it. A model that emits four follow-ups has not produced a broken
review; it has produced one finding too many. Truncation belongs in the runner, next to
`filterInlineComments`, which already drops bad output rather than rejecting it:

```ts
export const capFollowUps = (
  followUps: readonly FollowUp[],
): { kept: FollowUp[]; dropped: number } => ({
  kept: followUps.slice(0, MAX_FOLLOW_UPS),
  dropped: Math.max(0, followUps.length - MAX_FOLLOW_UPS),
});
```

**Settled — `slice(0, 3)` takes the first three, delegating the ordering to the model.** The
alternative is no ordering contract at all and three arbitrary findings. This is not a new house
assumption: `extraction.md` already orders the summary's findings worst-first on the model's
judgement. What §1 adds is the *axis* (most serious if never fixed) and the *consequence* (the tail
is dropped), because neither was stated.

### Where the truncation is *said* — twice, deliberately

1. **In the review body**, where the author sees it before merge and can still act:
   `> 2 further findings were truncated by the cap of 3.`
2. **In the merge-time comment**, where the filing step reports what it did.

**Settled — both.** They reach different readers at different moments, and (1) is the only one
that is *actionable*: it arrives while the PR is still open, so the author can raise the dropped
finding themselves or widen the PR. (2) reports after the fact, when the finding is already gone.

---

## 3. What the review body carries (assembled by `review/review.ts`)

Appended to `summary` before `writeJson("review_payload.json", …)`:

```markdown
<details>
<summary>3 follow-ups will be filed when this merges — add <code>no-follow-ups</code> to opt out</summary>

1. **parse() silently accepts trailing separators** — `src/example.ts:120`
2. **Retry budget is shared across unrelated callers** — `src/client.ts:88`
3. **Config loader reads the env twice** — `src/config.ts:14`

1 further finding was truncated by the cap of 3.

<!--agent-follow-ups
{"version":1,"followUps":[{"title":"parse() silently accepts trailing separators","location":"src/example.ts:120","body":"..."}]}
-->

</details>
```

**Not this ticket's — the opt-out label name is invented here.** Its real name, and whether it is opt-out at
all, is [#39](https://github.com/jeffwlawson/agent-workflows/issues/39)'s. This draft only shows
that the review body is where a human first learns the label exists.

**Settled — keep `"version": 1`.** The pin makes the review runner and the filing step
same-version at *install* time, not at *read* time: a review posted before a release is read by a
filing step from after it. The version field is the cheapest way for the reader to refuse a shape
it does not know.

---

## 4. The stub, as the filing runner assembles it

**Title** — the agent's `title`, verbatim, truncated at 80 characters. No prefix.

**Settled — no prefix.** A `[PR #32]` prefix is provenance visible without opening the issue, but
it eats the left edge of every title in a triage list — where a scanner's eye lands — and the
`pr-follow-up` label already carries the same fact in colour.

**Labels** — `needs-triage`, `pr-follow-up`. Settled on the map.

**Body:**

```markdown
## Finding

**Evidence.** `parse()` splits on `,` and drops empty segments, so `"a,b,"` and `"a,b"` return the
same array — `example.test.ts` has no case for either.

**Why it was not fixed in the pull request.** That pull request only changed the caller in
`apply()`; tightening `parse()` would change what every other caller accepts.

**Location:** `src/example.ts:120`

---

<sub>Filed automatically on merge of #32, from
[this review](https://github.com/jeffwlawson/agent-workflows/pull/32#pullrequestreview-3456789).
The reviewer restates its full list each run, so that review is where the finding was **read**, not
necessarily where it was first raised.</sub>
```

**Settled — the stub links the review that was *read* (the latest), and says plainly that this is
where the finding was read, not necessarily first raised.** Walking back through nine reviews to
find the first occurrence matches on prose, so a finding the agent re-worded between rounds would
look new. Linking the PR alone discards a link that is exactly right for *show me the reasoning* —
it only needed the caveat.

**Settled — the title is not repeated as an `H1` in the body.** GitHub already renders it.

---

## 5. The round trip, end to end

```
review agent
  └─ emits { summary, inlineComments, followUps }      ← extraction.md §1, schema §2
review/review.ts
  ├─ filterInlineComments(...)                          (existing)
  ├─ capFollowUps(...) → kept, dropped                  ← §2
  └─ body = summary + renderFollowUpsBlock(kept, dropped)  ← §3
agent-review.yml → posts the review
  ⋮  (possibly many times; latest wins)
merge
  └─ sixth subcommand                                   ← #39 decides what fires it
       ├─ GraphQL: latest bot review with a block, lastEditedAt == null   ← #38
       ├─ dedup against already-filed stubs             ← #41, needs a token
       └─ gh issue create --label needs-triage --label pr-follow-up   ← §4
```

The seam this draft does **not** cross: everything below `merge` is #39's and #41's.
