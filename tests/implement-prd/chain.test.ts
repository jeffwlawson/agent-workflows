import { describe, expect, it } from "vitest";
import type { SubIssue } from "../../engine/read.js";
import { afterVerdict, blockerRefusal, chainOf, decide, linkRefusal, type PrdPullRequest, type Verdict } from "../../implement-prd/chain.js";
import { VERDICTS } from "../../shared/review-output.js";
import { FINAL_REVIEW_MARK } from "../../shared/record.js";

/**
 * The slice choice and the decision table `implement-prd:gate` rules with
 * (#498), as a table: where the chain stands from the sub-issues and the
 * trailers, then what the run does from that, the PRD PR and its head's
 * verdict. The rows are the retired shell pre-flight's, carried over by
 * behaviour, each refusal with today's sentence.
 */

/** Sub-issues #172 on, in `states`. */
const subs = (...states: readonly ("OPEN" | "CLOSED")[]): SubIssue[] =>
  states.map((state, i) => ({ number: 172 + i, title: `Slice ${i + 1}`, state }));

/** A commit message carrying the trailer for `sub`, as a build run writes it. */
const built = (sub: number): string => `feat: slice ${sub} (#${sub})\n\nWhy.\n\nAgent-Slice: #${sub}`;

const PR: PrdPullRequest = { number: 201, draft: true, labels: [], body: "Closes #171", headSha: "h".repeat(40) };

const verdict = (state: string, description = ""): Verdict => ({ state, description, targetUrl: "https://github.com/o/r/pull/201#pullrequestreview-9" });
const APPROVED = verdict("success", VERDICTS["approval recommended"].description);

/** The whole decision: the table, then the verdict where the table asks for it. */
const run = (states: readonly ("OPEN" | "CLOSED")[], messages: readonly string[], pr: PrdPullRequest | undefined, v?: Verdict) => {
  const chain = chainOf(subs(...states), messages);
  const ruled = decide(chain, pr);
  return ruled.kind === "verdict" ? afterVerdict(chain, ruled.pr, v) : ruled;
};

const WAYS =
  "To move on, add `agent:fix` to PRD PR #201 for another fix round; or decline a finding by replying to it, then add `agent:review` there; or push a commit, then add `agent:review` there. The chain moves on once a review of the PRD PR's latest commit recommends approval.";

describe("the slice choice", () => {
  it.each([
    ["no trailers", ["OPEN", "OPEN", "OPEN"], [], { next: 172, position: 1, built: 0, beforeUpgrade: 0, landed: 0, current: undefined }],
    ["some", ["OPEN", "OPEN", "OPEN"], [built(172), "fix: address review findings"], { next: 173, position: 2, built: 1, beforeUpgrade: 0, landed: 1, current: 172 }],
    ["all", ["OPEN", "OPEN", "OPEN"], [built(172), built(173), built(174)], { next: undefined, position: undefined, built: 3, beforeUpgrade: 0, landed: 3, current: 174 }],
    [
      "closed with no trailer, landed before the upgrade",
      ["CLOSED", "OPEN", "OPEN"],
      [built(173)],
      { next: 174, position: 3, built: 1, beforeUpgrade: 1, landed: 2, current: 173 },
    ],
    ["trailers in mixed case", ["OPEN", "OPEN"], ["feat: one\n\nagent-slice: #172", "feat: two\n\nAGENT-SLICE:\t#173 "], { next: undefined, position: undefined, built: 2, beforeUpgrade: 0, landed: 2, current: 173 }],
    [
      "a trailer naming no sub-issue, or not on a line of its own",
      ["OPEN", "OPEN"],
      ["feat: elsewhere\n\nAgent-Slice: #9", "docs: say Agent-Slice: #172 inline"],
      { next: 172, position: 1, built: 0, beforeUpgrade: 0, landed: 0, current: undefined },
    ],
    /**
     * A short list: a trailer naming a sub-issue the list does not hold
     * counts nothing, so the chain is ruled on what the list says, never on
     * a count of trailers.
     */
    ["a short sub-issue list", ["OPEN"], [built(172), built(173), built(174)], { next: undefined, position: undefined, built: 1, beforeUpgrade: 0, landed: 1, current: 172 }],
  ] as const)("%s", (_case, states, messages, expected) => {
    const chain = chainOf(subs(...states), messages);

    expect({
      next: chain.next?.subIssue.number,
      position: chain.next?.position,
      built: chain.built,
      beforeUpgrade: chain.beforeUpgrade,
      landed: chain.landed,
      current: chain.current,
    }).toEqual(expected);
  });

  /** A closed sub-issue with a trailer is built, not landed before the upgrade; an open one is never built again. */
  it("never builds again a sub-issue that has a trailer, whatever its state", () => {
    const chain = chainOf(subs("CLOSED", "OPEN"), [built(172)]);

    expect(chain.next?.subIssue.number).toBe(173);
    expect(chain.beforeUpgrade).toBe(0);
  });
});

describe("the decision", () => {
  it.each([
    ["nothing built, no PRD PR: the first slice", ["OPEN", "OPEN"], [], undefined, undefined, { kind: "build" }],
    ["only closed sub-issues landed before the upgrade, with a PRD PR: the first after it, with no verdict", ["CLOSED", "OPEN"], [], PR, undefined, { kind: "build" }],
    [
      "every sub-issue closed before the upgrade",
      ["CLOSED", "CLOSED"],
      [],
      PR,
      undefined,
      {
        kind: "refuse",
        sentence:
          "Every sub-issue of this PRD was closed before this release built any of them, so there's nothing left to build. To build more, add a sub-issue, or reopen one, first.",
      },
    ],
    ["slices built and no PRD PR: only open it", ["OPEN", "OPEN"], [built(172)], undefined, undefined, { kind: "open-only" }],
    [
      "an approval, some left: the next slice",
      ["OPEN", "OPEN"],
      [built(172)],
      PR,
      APPROVED,
      { kind: "build", approved: { subIssue: 172, sha: PR.headSha, review: APPROVED.targetUrl } },
    ],
    [
      "an approval, none left: finishing",
      ["OPEN", "OPEN"],
      [built(172), built(173)],
      PR,
      APPROVED,
      { kind: "finishing", approved: { subIssue: 173, sha: PR.headSha, review: APPROVED.targetUrl } },
    ],
    [
      "several landed, the final-review mark present, draft",
      ["OPEN", "OPEN"],
      [built(172), built(173)],
      { ...PR, body: `Closes #171\n\n${FINAL_REVIEW_MARK}` },
      APPROVED,
      {
        kind: "refuse",
        sentence: "Every sub-issue of this PRD is built and the final review of PRD PR #201 was requested, so it's yours from here. To build more, add a sub-issue first.",
      },
    ],
    [
      "several landed, the final-review mark present, ready",
      ["OPEN", "OPEN"],
      [built(172), built(173)],
      { ...PR, draft: false, body: FINAL_REVIEW_MARK },
      APPROVED,
      {
        kind: "refuse",
        sentence: "Every sub-issue of this PRD is built and the final review of PRD PR #201 was requested, so it's yours from here. To build more, add a sub-issue first.",
      },
    ],
    [
      "several landed, the mark absent, ready by review: still finishing",
      ["OPEN", "OPEN"],
      [built(172), built(173)],
      { ...PR, draft: false },
      APPROVED,
      { kind: "finishing", approved: { subIssue: 173, sha: PR.headSha, review: APPROVED.targetUrl } },
    ],
    [
      "landed before the upgrade counts towards the mark's test",
      ["CLOSED", "OPEN"],
      [built(173)],
      { ...PR, body: FINAL_REVIEW_MARK },
      APPROVED,
      {
        kind: "refuse",
        sentence: "Every sub-issue of this PRD is built and the final review of PRD PR #201 was requested, so it's yours from here. To build more, add a sub-issue first.",
      },
    ],
    [
      "one slice landed, a ready PRD PR: finished",
      ["OPEN"],
      [built(172)],
      { ...PR, draft: false },
      APPROVED,
      { kind: "refuse", sentence: "Every sub-issue of this PRD is built and its PRD PR is ready for you. To build more, add a sub-issue first." },
    ],
    [
      "one slice landed, a draft PRD PR: finishing",
      ["OPEN"],
      [built(172)],
      PR,
      APPROVED,
      { kind: "finishing", approved: { subIssue: 172, sha: PR.headSha, review: APPROVED.targetUrl } },
    ],
  ] as const)("%s", (_case, states, messages, pr, v, expected) => {
    expect(run(states, messages, pr, v)).toEqual(expected);
  });

  /** A round in flight is never cut short, whatever its head carries now. */
  it.each(["agent:review", "agent:fix", "agent:update-branch"])("refuses while the PRD PR carries %s", (label) => {
    expect(run(["OPEN", "OPEN"], [built(172)], { ...PR, labels: ["bug", label] }, APPROVED)).toEqual({
      kind: "refuse",
      sentence: `PRD PR #201 still has \`${label}\`, so its review round hasn't ended and nothing was built. Add \`agent:implement\` again once that label is gone.`,
    });
  });

  it("names every busy label, in the order the PRD PR carries them", () => {
    const outcome = run(["OPEN", "OPEN"], [built(172)], { ...PR, labels: ["agent:fix", "agent:review"] }, APPROVED);

    expect(outcome).toMatchObject({ sentence: expect.stringContaining("still has `agent:fix`, `agent:review`, so") });
  });

  /** The gate, shut: every ending of a round but an approval refuses and names the ways on. */
  it.each([
    ["no verdict", undefined, `PRD PR #201's latest commit hasn't been reviewed, so the next slice wasn't started. ${WAYS}`],
    [
      "an error",
      verdict("error", "The review run did not finish, so there's no verdict."),
      `The review of PRD PR #201's latest commit didn't finish, so there's no verdict and the next slice wasn't started. ${WAYS}`,
    ],
    [
      "changes recommended",
      verdict("failure", VERDICTS["changes recommended"].description),
      `The review of PRD PR #201's latest commit didn't recommend approval (Changes recommended), so the next slice wasn't started. ${WAYS}`,
    ],
    [
      "changes recommended after a fix round",
      verdict("failure", "Changes recommended after a fix round. Read the review, then add agent:fix again or fix it by hand."),
      `The review of PRD PR #201's latest commit didn't recommend approval (Changes recommended after a fix round), so the next slice wasn't started. ${WAYS}`,
    ],
    [
      "needs a closer look",
      verdict("failure", VERDICTS["needs a closer look"].description),
      `The review of PRD PR #201's latest commit didn't recommend approval (Needs a closer look), so the next slice wasn't started. ${WAYS}`,
    ],
    [
      "a review still pending",
      verdict("pending", "Reviewing."),
      `The review of PRD PR #201's latest commit didn't recommend approval (Reviewing.), so the next slice wasn't started. ${WAYS}`,
    ],
  ] as const)("refuses the next slice on %s", (_case, v, sentence) => {
    expect(run(["OPEN", "OPEN"], [built(172)], PR, v)).toEqual({ kind: "refuse", sentence });
  });

  /** …and the last slice is not finished on before its round approves. */
  it("does not finish on a last slice whose round did not approve", () => {
    expect(run(["OPEN"], [built(172)], PR, verdict("failure", "Changes recommended. x"))).toMatchObject({ kind: "refuse" });
  });

  /** An approval with no link is still an approval: the note then says it has none. */
  it("hands on an empty review link where the verdict links none", () => {
    expect(run(["OPEN", "OPEN"], [built(172)], PR, { ...APPROVED, targetUrl: null })).toEqual({
      kind: "build",
      approved: { subIssue: 172, sha: PR.headSha, review: "" },
    });
  });
});

describe("the blocker checks", () => {
  const ORDER = [172, 173, 174];

  it.each([
    ["links that agree with the order", 173, [{ number: 172, open: true }], undefined],
    [
      "a sub-issue blocked by a later sibling, whatever its state",
      173,
      [{ number: 174, open: false }],
      "Sub-issue #173 comes before #174 in this PRD's sub-issue list, but it's blocked by #174, so it would be built first. Reorder the sub-issues so #174 comes before #173, then add `agent:implement` again.",
    ],
    [
      "a sub-issue blocked by an open issue outside the PRD",
      173,
      [{ number: 99, open: true }],
      'Sub-issue #173 is blocked by #99, which isn\'t part of this PRD, and the chain can\'t build #173 until #99 is done. Move that "blocked by" link from #173 to this issue, then add `agent:implement` again.',
    ],
    ["a sub-issue blocked by a closed issue outside the PRD", 173, [{ number: 99, open: false }], undefined],
  ] as const)("%s", (_case, sub, blockers, expected) => {
    expect(linkRefusal(ORDER, sub, blockers)).toBe(expected);
  });

  it("names the PRD's own open blockers, one sentence for one and another for several", () => {
    expect(blockerRefusal([])).toBeUndefined();
    expect(blockerRefusal([50])).toBe(
      'It\'s blocked by #50, which is still open. Add `agent:implement` again once #50 is closed, or remove the "blocked by" link if it no longer applies.',
    );
    expect(blockerRefusal([50, 51])).toBe(
      'It\'s blocked by #50, #51, which are still open. Add `agent:implement` again once they are closed, or remove the "blocked by" links that no longer apply.',
    );
  });
});
