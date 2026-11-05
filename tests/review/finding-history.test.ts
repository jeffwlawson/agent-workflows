import { describe, expect, it } from "vitest";
import { EMPTY_FINDING_HISTORY, LIVE_FINDING_HISTORY, REVIEW_PROMPT, withFindingHistory } from "./finding-history.js";

/**
 * The finding-history sections are printed only where they apply (#749,
 * audit #704 H4, stage 1a): the open findings, the settled findings and the
 * fix run's notes carry their rules with the placeholder, so a review with
 * none of them is handed a heading and one line each.
 */

/** The three sections from the heading of the first to the heading after the last. */
const historySections = (prompt: string): string =>
  prompt.match(/# FINDINGS AN EARLIER REVIEW LEFT OPEN\n.*?(?=# FOLLOW-UPS EARLIER ROUNDS RECORDED)/s)?.[0] ?? "";

/**
 * The three sections as `review/prompt.md` held them before #749, each rule
 * in the static file around the placeholder. Kept here as it was, so the live
 * render can be shown to be the same text.
 */
const BEFORE = `# FINDINGS AN EARLIER REVIEW LEFT OPEN

These were raised by an earlier review of this pull request and nothing has verified them fixed.
Each carries the identifier the workflow gave it when it was posted; the evidence is on the thread
it was raised in, under **EXISTING FEEDBACK** above.

{{OPEN_FINDINGS}}

**Rule on every one of them, by identifier, in \`verified\`.** For each: \`landed\` if the current code
resolves it, \`open\` if it does not, \`declined\` if a maintainer has refused it, and one line saying
why. Check the code in front of you rather than a claim that it was fixed; a reply saying a finding
was addressed is an assertion, and verifying it is the whole of this job. **\`open\` is the ruling
for a finding the current code does not clearly resolve.**

This is asked of **every** review, this round included. A finding does not need a fix round to have
been settled: a human may have pushed the fix, or the finding may have been wrong.

A finding you rule \`landed\` has its thread closed by the workflow, with your line as the reason.
One you rule \`open\` counts against this pull request exactly as a finding of your own would, and
**ruling it \`open\` is the whole of reporting it**. If there is more to say about it than the line
beside its identifier, say it in that line.

**\`declined\` is a maintainer's decision, and you only report it.** Rule a finding \`declined\` only
on the maintainer's latest reply on its thread, and only where that reply refuses it in words
("won't fix", "this is intended", "leave it"). The workflow closes the thread as *won't fix*,
quoting that reply. Every other reply (an explanation, a question, "I'll get to it", or a refusal
the maintainer has since revisited) leaves the finding \`open\`.

# WHAT THE MAINTAINER HAS SETTLED

Findings an earlier review raised that a **human** then closed by hand: settled, and out of every
field.

{{SETTLED_FINDINGS}}

A maintainer closing a thread is the decision on that point; re-posting it as though it were new
is this loop overruling the person it works for, and the record has no way to recognise that it has
happened. If you believe one of them is now a different problem (the code has changed since and
broken something else), say so about *that* problem, naming what changed.

# NOTES THE FIX RUN LEFT

Things \`agent:fix\` noticed while fixing this pull request that are **outside its scope**, posted
on the conversation since the last review. Each carries the id the workflow read it under. They are
not findings against this pull request, and they do not count toward its verdict.

{{FIX_NOTES}}

**Rule on every one of them, by id, in \`noteRulings\`.** Read the code each one points at, then
either:

- **promote** it: it is real, it is not this pull request's to fix, and it is worth an issue. Give
  it a \`severity\`, and a \`location\` where you can name a better one than the note did. The workflow
  records it as a follow-up, filed when this pull request merges like any other. A promoted note
  takes one of the three follow-up places, ahead of your own, so promoting it is the whole of
  recording it.
- **drop** it, with a \`reason\` the body shows: it is not real, it is already tracked, it is this
  pull request's to fix after all (then it is a finding of your own, on the usual terms), or it is
  not worth an issue.

`;

/** What each renderer printed, for the fixtures, before its rules moved into it. */
const BEFORE_INPUTS: Readonly<Record<string, string>> = {
  OPEN_FINDINGS: "- `f-1`: src/queue.ts:206 · the guard runs after the return",
  SETTLED_FINDINGS: [
    "- src/cache.ts:12 · the cache key omits the tenant · closed by @maintainer",
    "",
    "Each of these is **settled by the maintainer**. Do not raise it again, in these words or in any others.",
  ].join("\n"),
  FIX_NOTES: ["- note `IC_one`: **Two tool parameters send fields the API ignores** · `src/tools/recipes.ts:88`", "  `update_recipe` sends them."].join("\n"),
};

describe("the finding-history sections of the review prompt", () => {
  it("print, where each is live, the same text the static prompt printed before", () => {
    const before = BEFORE.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => BEFORE_INPUTS[key] ?? "");

    expect(historySections(withFindingHistory(LIVE_FINDING_HISTORY))).toBe(before);
  });

  it("print, where none is live, a heading and the renderer's one line each, and no rule", () => {
    expect(historySections(withFindingHistory(EMPTY_FINDING_HISTORY))).toBe(
      [
        "# FINDINGS AN EARLIER REVIEW LEFT OPEN",
        "",
        EMPTY_FINDING_HISTORY.OPEN_FINDINGS,
        "",
        "# WHAT THE MAINTAINER HAS SETTLED",
        "",
        EMPTY_FINDING_HISTORY.SETTLED_FINDINGS,
        "",
        "# NOTES THE FIX RUN LEFT",
        "",
        EMPTY_FINDING_HISTORY.FIX_NOTES,
        "",
        "",
      ].join("\n"),
    );
    for (const line of Object.values(EMPTY_FINDING_HISTORY)) expect(line).not.toContain("\n");
  });

  it("leave no rule of theirs in the static prompt", () => {
    const sections = historySections(REVIEW_PROMPT);

    expect(sections).not.toMatch(/Rule on every one|declined|promote|maintainer closing/);
  });
});
