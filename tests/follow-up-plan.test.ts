import { describe, expect, it } from "vitest";
import {
  FOLLOW_UP_STUB_LABEL,
  MAX_STUB_TITLE,
  planFollowUps,
  TRIAGE_LABEL,
  type FilingReview,
  type FilingStub,
} from "../shared/follow-up-plan.js";
import { renderFollowUpsBlock, type FollowUp } from "../shared/review-output.js";

/**
 * The one seam in the filing half (#48). Everything worth arguing about — who
 * the block has to have come from, whether it has been tampered with, what
 * counts as the same finding, and what the merged pull request is told — is
 * decided here, from plain objects. The halves either side of it are a GraphQL
 * read and four `gh` calls, and neither holds a decision.
 *
 * So these are not unit tests standing in for an integration test that would be
 * better. The gather half can only be wrong about *what* it fetched, which a
 * fixture cannot prove either way; the execute half can only be wrong about the
 * order it performs a list in. This is where a wrong answer is possible.
 */

const REVIEW_URL = "https://github.com/o/r/pull/32#pullrequestreview-9";

const followUp = (over: Partial<FollowUp> = {}): FollowUp => ({
  title: "parse() drops the guard",
  location: "src/a.ts:12",
  body: "Evidence it is real. Then why this pull request cannot fix it.",
  ...over,
});

/** A review from the workflow bot, carrying whatever findings it is given. */
const review = (findings: readonly FollowUp[], over: Partial<FilingReview> = {}): FilingReview => ({
  author: "github-actions",
  body: `A summary.\n\n${renderFollowUpsBlock(findings, 0)}`,
  lastEditedAt: null,
  url: REVIEW_URL,
  ...over,
});

/** A stub as the label-filtered listing returns it, carrying its dedup payload. */
const stub = (over: Partial<FilingStub> & { location?: string; pr?: number } = {}): FilingStub => {
  const { location = "src/a.ts", pr = 7, ...rest } = over;
  return {
    number: 71,
    state: "OPEN",
    stateReason: null,
    body: `Prose that may be reworded freely.\n\n<!--{"version":1,"location":"${location}","pr":${pr}}-->`,
    ...rest,
  };
};

/** The plan over one pull request, spelled out at every call so nothing is implied. */
const plan = (
  findings: readonly FollowUp[],
  stubs: readonly FilingStub[] = [],
  over: { prNumber?: number; reviews?: readonly FilingReview[] } = {},
) =>
  planFollowUps({
    prNumber: over.prNumber ?? 32,
    reviews: over.reviews ?? [review(findings)],
    stubs,
  });

const NOTHING = { issues: [], stubComments: [] };

/** The outcome lines of the planned comment, which is where every skip is visible. */
const reportLines = (report: string | undefined): readonly string[] =>
  (report ?? "").split("\n").filter((line) => line.startsWith("- "));

describe("planFollowUps: the authenticity gate", () => {
  /**
   * The restatement rule and this are one decision seen from two sides: each
   * review restates the whole list, so the newest block is the complete answer
   * and every older one is a superseded draft. Merging them would refile a
   * finding the reviewer deliberately dropped.
   */
  it("reads the latest block-carrying review and ignores the earlier ones", () => {
    const result = plan([], [], {
      reviews: [
        review([followUp({ location: "src/old.ts" })]),
        review([followUp({ location: "src/new.ts" })]),
      ],
    });

    expect(result.issues.map((i) => i.path)).toEqual(["src/new.ts"]);
  });

  it("skips a later review that carries no block at all", () => {
    const result = plan([], [], {
      reviews: [
        review([followUp({ location: "src/a.ts" })]),
        { author: "github-actions", body: "A summary, nothing out of scope.", lastEditedAt: null, url: REVIEW_URL },
      ],
    });

    expect(result.issues.map((i) => i.path)).toEqual(["src/a.ts"]);
  });

  /**
   * Deliberately narrower than `isTrustedAuthor`, which also admits any owner,
   * member or collaborator. That gate answers "is this from someone trusted";
   * this one has to answer "is this the review runner's own output". A
   * maintainer who wants an issue filed can file one.
   */
  it("reads no block out of a human's review, however trusted that human is", () => {
    const result = plan([], [], {
      reviews: [review([followUp()], { author: "a-maintainer" })],
    });

    expect(result).toMatchObject({ ...NOTHING, report: undefined });
  });

  it("accepts both spellings of the bot login, since the two APIs disagree", () => {
    for (const author of ["github-actions", "github-actions[bot]"]) {
      expect(plan([], [], { reviews: [review([followUp()], { author })] }).issues).toHaveLength(1);
    }
  });

  /**
   * The ordinary case, and also the upstream failure where an oversized review
   * body 422s and posts nothing. Silence is right for both: most merges have no
   * findings, and a comment on each of them is noise that teaches people to
   * stop reading these.
   */
  it("plans nothing, and says nothing, when no block is found", () => {
    const result = plan([], [], {
      reviews: [{ author: "github-actions", body: "A summary.", lastEditedAt: null, url: REVIEW_URL }],
    });

    expect(result).toEqual({ ...NOTHING, report: undefined, removeMarker: false });
  });

  it("plans nothing, and says nothing, when the pull request has no reviews", () => {
    expect(plan([], [], { reviews: [] })).toEqual({
      ...NOTHING,
      report: undefined,
      removeMarker: false,
    });
  });

  /**
   * The other failure mode, and the one that is loud. Both populations who
   * reach it need to see it: a tamper attempt should not be absorbed in
   * silence, and a maintainer who edited the review to fix a typo has to learn
   * that the edit cost them the filing rather than wonder why nothing happened.
   */
  it("refuses an edited body, names the review, and leaves the marker in place", () => {
    const result = plan([], [], {
      reviews: [review([followUp()], { lastEditedAt: "2026-09-20T10:00:00Z" })],
    });

    expect(result).toMatchObject({ ...NOTHING, removeMarker: false });
    expect(result.report).toContain(REVIEW_URL);
    expect(result.report).toMatch(/edited/i);
  });

  /**
   * No fallback. An earlier unedited review is a superseded draft, and reading
   * it would turn "edit the newest review" into a way of choosing which set of
   * findings gets filed — which is the control this is.
   */
  it("does not fall back to an earlier unedited review when the latest was edited", () => {
    const result = plan([], [], {
      reviews: [
        review([followUp({ location: "src/old.ts" })]),
        review([followUp({ location: "src/new.ts" })], { lastEditedAt: "2026-09-20T10:00:00Z" }),
      ],
    });

    expect(result.issues).toEqual([]);
  });

  /**
   * The version field earns its place here. The review runner and this reader
   * are the same version at *install* time and not at read time — a review
   * posted before a release is read after it — so a shape this cannot read is
   * an ordinary consequence of a release, not a defect. Refusing beats guessing:
   * a guess files issues from a payload whose fields may have moved.
   */
  it("refuses a payload whose version it does not know", () => {
    const body = `A summary.\n\n<!-- agent-follow-ups {"version":2,"dropped":0,"followUps":[]} -->`;

    const result = plan([], [], {
      reviews: [{ author: "github-actions", body, lastEditedAt: null, url: REVIEW_URL }],
    });

    expect(result).toMatchObject({ ...NOTHING, removeMarker: false });
    expect(result.report).toContain("2");
    expect(result.report).toContain(REVIEW_URL);
  });

  it("refuses a payload it cannot parse at all", () => {
    const body = `A summary.\n\n<!-- agent-follow-ups {"version":1,"followUps": -->`;

    const result = plan([], [], {
      reviews: [{ author: "github-actions", body, lastEditedAt: null, url: REVIEW_URL }],
    });

    expect(result).toMatchObject({ ...NOTHING, removeMarker: false });
    expect(result.report).not.toBe(undefined);
  });
});

describe("planFollowUps: what counts as the same finding", () => {
  /**
   * The line number is stripped and discarded. Two reviews of the same chronic
   * problem will nearly always disagree on the line, so keying on it would make
   * dedup fail precisely on the findings it exists to catch.
   */
  it.each([
    ["src/a.ts", "src/a.ts"],
    ["src/a.ts:12", "src/a.ts"],
    ["src/a.ts:12-40", "src/a.ts"],
    ["./src/a.ts:12", "src/a.ts"],
    ["./src/a.ts", "src/a.ts"],
    // Not case-folded: two paths differing only in case are two files on the
    // platform the loop runs on.
    ["src/A.ts", "src/A.ts"],
    // A multi-file location is the agent freelancing on a single-value field.
    // The first path-shaped token is the closest honest reading of it, and
    // refusing would lose the finding outright.
    ["src/a.ts and src/b.ts", "src/a.ts"],
    ["src/a.ts, src/b.ts:12", "src/a.ts"],
  ])("normalises %s to %s", (location: string, path: string) => {
    expect(plan([followUp({ location })]).issues.map((i) => i.path)).toEqual([path]);
  });

  it("matches a stub on the normalised path, whatever line each one named", () => {
    const result = plan([followUp({ location: "./src/a.ts:400" })], [stub({ location: "src/a.ts:12" })]);

    expect(result.issues).toEqual([]);
    expect(result.stubComments.map((c) => c.issue)).toEqual([71]);
  });

  it("does not match a stub at another path", () => {
    const result = plan([followUp({ location: "src/a.ts" })], [stub({ location: "src/b.ts" })]);

    expect(result.issues).toHaveLength(1);
    expect(result.stubComments).toEqual([]);
  });

  /**
   * Keyed on the payload and never on the prose — including the stub's own
   * location line, which is written for a human and read by nobody. Rewording
   * a stub, or correcting the path in its prose, must not break matching.
   */
  it("matches on the payload even when the stub's prose names another path", () => {
    const misleading: FilingStub = {
      number: 71,
      state: "OPEN",
      stateReason: null,
      body: `**Location:** \`src/decoy.ts:4\`\n\n<!--{"version":1,"location":"src/a.ts","pr":7}-->`,
    };

    expect(plan([followUp({ location: "src/decoy.ts" })], [misleading]).issues).toHaveLength(1);
    expect(plan([followUp({ location: "src/a.ts" })], [misleading]).stubComments).toHaveLength(1);
  });

  /**
   * A hand-written stub, or one from before a format change, simply does not
   * match — so the run files a duplicate rather than skipping a real finding.
   * That is the direction every choice in this file fails in: a duplicate is
   * loud and cheap, a skipped finding is silent and unrecoverable.
   */
  it("does not match a stub carrying no payload", () => {
    const result = plan(
      [followUp({ location: "src/a.ts" })],
      [{ number: 71, state: "OPEN", stateReason: null, body: "A hand-written issue about src/a.ts." }],
    );

    expect(result.issues).toHaveLength(1);
    expect(result.stubComments).toEqual([]);
  });

  it("does not match a stub whose payload is a version it does not know", () => {
    const result = plan(
      [followUp({ location: "src/a.ts" })],
      [{
        number: 71,
        state: "OPEN",
        stateReason: null,
        body: `<!--{"version":2,"location":"src/a.ts","pr":7}-->`,
      }],
    );

    expect(result.issues).toHaveLength(1);
  });
});

describe("planFollowUps: what a match is worth", () => {
  it("comments on an open stub rather than opening a second one", () => {
    const result = plan([followUp()], [stub({ state: "OPEN" })]);

    expect(result.issues).toEqual([]);
    expect(result.stubComments).toHaveLength(1);
    expect(result.stubComments[0]?.issue).toBe(71);
    // Chronicity is what triage most wants to see, so the comment says which
    // pull request met it again.
    expect(result.stubComments[0]?.body).toContain("#32");
    expect(result.report).toMatch(/Re-flagged/);
  });

  /**
   * Notifying the people who decided not to do it, to tell them it is still
   * true, is relitigating a closed decision on a schedule. It stays visible in
   * the pull request comment — read once, by the person who just merged.
   */
  it("suppresses against a wontfix decision and comments nowhere", () => {
    const result = plan([followUp()], [stub({ state: "CLOSED", stateReason: "not_planned" })]);

    expect(result).toMatchObject(NOTHING);
    expect(result.report).toMatch(/Suppressed/);
    expect(result.report).toContain("#71");
  });

  it("reads the close reason in both spellings the two APIs report", () => {
    for (const stateReason of ["not_planned", "NOT_PLANNED"]) {
      expect(plan([followUp()], [stub({ state: "closed", stateReason })])).toMatchObject(NOTHING);
    }
  });

  /**
   * A stub someone *fixed* and closed must refile if the problem returns: the
   * finding is true again, and swallowing it is how a regression goes
   * unreported.
   */
  it("files again against a stub that was fixed and closed", () => {
    const result = plan([followUp()], [stub({ state: "CLOSED", stateReason: "completed" })]);

    expect(result.issues).toHaveLength(1);
    expect(result.stubComments).toEqual([]);
  });

  /**
   * What makes a retry exactly idempotent. The marker is left in place on a
   * partial failure so the run can be re-driven; on that retry the findings
   * that did file are open stubs, and without this they would take the
   * comment-on-existing branch and post "flagged again by #32" on a stub #32
   * created ninety seconds earlier.
   */
  it("plans nothing at all when the matched stub was filed by this same pull request", () => {
    const result = plan([followUp()], [stub({ pr: 32 })], { prNumber: 32 });

    expect(result).toMatchObject(NOTHING);
    expect(result.report).toMatch(/Already filed/i);
    expect(result.report).toContain("#71");
  });

  it("prefers the idempotence case over a wontfix decision at the same path", () => {
    const result = plan(
      [followUp()],
      [
        stub({ number: 60, state: "CLOSED", stateReason: "not_planned", pr: 5 }),
        stub({ number: 71, pr: 32 }),
      ],
      { prNumber: 32 },
    );

    expect(result.report).toMatch(/Already filed/i);
    expect(result.report).toContain("#71");
  });

  /**
   * Applying the rule against the tracker but not within the batch would make
   * the second finding's fate depend on a race with issue creation. This is
   * also where path-only matching is most likely to be genuinely wrong, which
   * is why the sibling is named: that is what makes a wrong skip correctable.
   */
  it("applies the same rule within one batch, first wins, and names the sibling", () => {
    const result = plan([
      followUp({ title: "parse() drops the guard", location: "src/a.ts:12" }),
      followUp({ title: "apply() reads the config twice", location: "src/a.ts:88" }),
    ]);

    expect(result.issues.map((i) => i.title)).toEqual(["parse() drops the guard"]);
    const suppressed = reportLines(result.report).find((l) => /Suppressed/.test(l)) ?? "";
    expect(suppressed).toContain("src/a.ts");
    expect(suppressed).toContain("parse() drops the guard");
  });

  it("does not suppress a second finding at a different path", () => {
    const result = plan([
      followUp({ location: "src/a.ts" }),
      followUp({ location: "src/b.ts" }),
    ]);

    expect(result.issues.map((i) => i.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("planFollowUps: the stub it plans", () => {
  const filed = (over: Partial<FollowUp> = {}) => {
    const issue = plan([followUp(over)]).issues[0];
    if (!issue) throw new Error("nothing was planned");
    return issue;
  };

  /**
   * A pull-request-number prefix is provenance visible without opening the
   * issue, but it eats the left edge of every title in a triage list — where a
   * scanner's eye lands — and `pr-follow-up` already carries the same fact in
   * colour.
   */
  it("takes the agent's title verbatim and unprefixed", () => {
    expect(filed({ title: "parse() drops the guard" }).title).toBe("parse() drops the guard");
  });

  it("truncates a long title rather than refusing it", () => {
    const title = filed({ title: "x".repeat(200) }).title;

    expect(title).toHaveLength(MAX_STUB_TITLE);
    expect(title.startsWith("x")).toBe(true);
  });

  it("carries both labels", () => {
    expect(filed().labels).toEqual([TRIAGE_LABEL, FOLLOW_UP_STUB_LABEL]);
  });

  it("carries the agent's two prose beats, and a location line", () => {
    const issue = filed({ body: "The evidence. Then why not here.", location: "src/a.ts:12" });

    expect(issue.body).toContain("The evidence. Then why not here.");
    // The human-facing location keeps the line the agent gave. It is never read
    // back — matching is on the payload — so it costs nothing to be precise.
    expect(issue.body).toContain("src/a.ts:12");
  });

  /**
   * Walking back through nine reviews to find the first occurrence would have
   * to match on prose, so a finding the agent reworded between rounds would
   * look new. Linking the latest and saying what that link means is the honest
   * version.
   */
  it("links the review it was read from, and says that is what the link means", () => {
    const body = filed().body;

    expect(body).toContain(REVIEW_URL);
    expect(body).toMatch(/read/i);
    expect(body).toMatch(/not necessarily/i);
  });

  it("carries the dedup payload the next run matches on", () => {
    expect(filed({ location: "./src/a.ts:12" }).body).toContain(
      `<!--{"version":1,"location":"src/a.ts","pr":32}-->`,
    );
  });

  /**
   * The payload is machine-read, and the prose beside it is model output. A
   * `-->` in that prose would end the comment early, truncating the JSON — a
   * stub nothing can ever match again, which reads exactly like a stub that was
   * never filed.
   */
  it("round-trips a finding whose prose contains an HTML comment terminator", () => {
    const location = "src/a.ts";
    const findings = [followUp({ location, body: "the guard is <!-- gone --> entirely" })];

    const first = planFollowUps({ prNumber: 32, reviews: [review(findings)], stubs: [] });
    const asStub: FilingStub = {
      number: 71,
      state: "OPEN",
      stateReason: null,
      body: first.issues[0]?.body ?? "",
    };

    expect(planFollowUps({ prNumber: 33, reviews: [review(findings)], stubs: [asStub] })).toMatchObject({
      issues: [],
      stubComments: [{ issue: 71 }],
    });
  });
});

describe("planFollowUps: what the merged pull request is told", () => {
  /**
   * A count makes a wrong skip invisible. The path is the only thing that lets
   * a reader see *why* the matcher thought two findings were the same, which is
   * the difference between a wrong skip that is correctable and one that is
   * merely regrettable.
   */
  it.each([
    ["filed", [] as readonly FilingStub[], /Filed/],
    ["re-flagged", [stub({ pr: 5 })], /Re-flagged/],
    ["suppressed", [stub({ state: "CLOSED", stateReason: "not_planned" })], /Suppressed/],
    ["already filed", [stub({ pr: 32 })], /Already filed/i],
  ])("reports %s as one line naming its path and no count", (
    _outcome: string,
    stubs: readonly FilingStub[],
    shape: RegExp,
  ) => {
    const lines = reportLines(plan([followUp({ location: "src/a.ts:12" })], stubs).report);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(shape);
    expect(lines[0]).toContain("src/a.ts");
    // The line the matcher decided on, not how many it decided. A count makes
    // the skip unarguable-with; the path makes it correctable.
    expect(lines[0]).not.toMatch(/\b\d+ finding/);
  });

  /**
   * Three lines is the most a run can produce — the cap is three findings, and
   * a within-batch suppression spends one of them — so the fourth outcome is
   * exercised by the idempotence case above rather than crammed in here.
   */
  it("keeps the outcomes in the order the reviewer listed them", () => {
    const result = planFollowUps({
      prNumber: 32,
      reviews: [
        review([
          followUp({ title: "new", location: "src/new.ts" }),
          followUp({ title: "chronic", location: "src/open.ts" }),
          followUp({ title: "declined", location: "src/wontfix.ts" }),
        ]),
      ],
      stubs: [
        stub({ number: 71, location: "src/open.ts", pr: 5 }),
        stub({ number: 72, location: "src/wontfix.ts", state: "CLOSED", stateReason: "not_planned" }),
      ],
    });

    const lines = reportLines(result.report);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/Filed/);
    expect(lines[0]).toContain("src/new.ts");
    expect(lines[1]).toMatch(/Re-flagged/);
    expect(lines[1]).toContain("src/open.ts");
    expect(lines[2]).toMatch(/Suppressed/);
    expect(lines[2]).toContain("src/wontfix.ts");
  });

  /**
   * The issue does not exist when the plan is made, so the line that links it
   * carries a token the runner substitutes once it does. A plan is a pure
   * function of what was gathered, and an issue number is not something that
   * can be gathered before the issue is created.
   */
  it("leaves a substitutable placeholder where each filed issue's link goes", () => {
    const result = plan([
      followUp({ location: "src/a.ts" }),
      followUp({ location: "src/b.ts" }),
    ]);

    const placeholders = result.issues.map((i) => i.placeholder);
    expect(new Set(placeholders).size).toBe(2);
    for (const placeholder of placeholders) expect(result.report).toContain(placeholder);
  });

  /**
   * The silent exit is for *no findings block at all*. It is not licence to
   * suppress the report of a suppression — a run that files nothing is exactly
   * the run whose reasoning someone will want to see.
   */
  it("still reports when it filed nothing but matched something", () => {
    const result = plan([followUp()], [stub({ state: "CLOSED", stateReason: "not_planned" })]);

    expect(result.issues).toEqual([]);
    expect(result.report).not.toBe(undefined);
  });

  /**
   * The post-merge half of announcing truncation. The review body said it
   * before the merge, where it was actionable; this is the half that survives
   * into the record.
   */
  it("repeats the truncation note when the cap bit, and omits it when it did not", () => {
    const truncated = plan([], [], {
      reviews: [
        { author: "github-actions", body: renderFollowUpsBlock([followUp()], 2), lastEditedAt: null, url: REVIEW_URL },
      ],
    });

    expect(truncated.report).toMatch(/2 further findings were dropped by the cap/);
    expect(plan([followUp()]).report).not.toMatch(/dropped/i);
  });

  /** Removed only on success, so a failed run leaves the retry affordance. */
  it("removes the marker once it has acted on a block, and not otherwise", () => {
    expect(plan([followUp()]).removeMarker).toBe(true);
    expect(
      plan([], [], { reviews: [review([followUp()], { lastEditedAt: "2026-09-20T10:00:00Z" })] })
        .removeMarker,
    ).toBe(false);
  });
});
