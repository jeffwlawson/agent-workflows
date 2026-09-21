import { afterEach, describe, expect, it, vi } from "vitest";
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

/**
 * A stub as the label-filtered listing returns it, carrying its dedup payload.
 *
 * `location` is written into the key **verbatim**, which is what identity
 * compares; relatedness normalises it on the way back in. So a stub standing in
 * for one this pull request filed has to name the line the finding named.
 */
const stub = (
  over: Partial<FilingStub> & { location?: string; pr?: number; seq?: number } = {},
): FilingStub => {
  const { location = "src/a.ts", pr = 7, seq = 0, ...rest } = over;
  return {
    number: 71,
    state: "OPEN",
    stateReason: null,
    body: `Prose that may be reworded freely.\n\n<!--{"version":2,"location":"${location}","pr":${pr},"seq":${seq}}-->`,
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

/**
 * The advisory link a filed stub carries, or `""` when it carries none. It sits
 * in the issue body rather than in the pull request report on purpose: the
 * report's job was making *skips* visible, and relatedness is not a skip.
 */
const relationOf = (body: string | undefined): string =>
  (body ?? "").split("\n").find((line) => line.startsWith("**Possibly related:**")) ?? "";

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

  /**
   * A bot review carrying no block is not an all-clear: it is a body no review
   * run of this version posted — a `fix` run's thread replies, an older
   * release, a human's review from the bot's own identity. Reading one as an
   * empty list would let a thread reply retract a finding nobody addressed.
   */
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
   * And the other side of that, which is the whole reason a review run records
   * an **empty** block rather than no block: round 1 raised it, the author
   * fixed it, round 2 recorded nothing. Without a retraction round 1 stays the
   * newest list on the pull request and the merge files a stub for work already
   * done — filing against the author's fix, in the one channel whose credit
   * with a triage queue is the only thing keeping it read.
   */
  it("retracts on a later round that recorded nothing", () => {
    const result = plan([], [], {
      reviews: [
        review([followUp({ location: "src/fixed-since.ts" })]),
        review([]),
      ],
    });

    expect(result).toEqual({ ...NOTHING, report: undefined, removeMarker: true });
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

  it("links a stub on the normalised path, whatever line each one named", () => {
    const result = plan([followUp({ location: "./src/a.ts:400" })], [stub({ location: "src/a.ts:12" })]);

    expect(result.issues).toHaveLength(1);
    expect(result.stubComments).toEqual([]);
    expect(relationOf(result.issues[0]?.body)).toContain("#71");
  });

  it("links nothing at another path", () => {
    const result = plan([followUp({ location: "src/a.ts" })], [stub({ location: "src/b.ts" })]);

    expect(result.issues).toHaveLength(1);
    expect(relationOf(result.issues[0]?.body)).toBe("");
  });

  /**
   * Keyed on the payload and never on the prose — including the stub's own
   * location line, which is written for a human and read by nobody. Rewording
   * a stub, or correcting the path in its prose, must not break matching.
   */
  it("reads relatedness off the payload even when the stub's prose names another path", () => {
    const misleading: FilingStub = {
      number: 71,
      state: "OPEN",
      stateReason: null,
      body: `**Location:** \`src/decoy.ts:4\`\n\n<!--{"version":2,"location":"src/a.ts","pr":7,"seq":0}-->`,
    };

    expect(
      relationOf(plan([followUp({ location: "src/decoy.ts" })], [misleading]).issues[0]?.body),
    ).toBe("");
    expect(
      relationOf(plan([followUp({ location: "src/a.ts" })], [misleading]).issues[0]?.body),
    ).toContain("#71");
  });

  /**
   * The last payload wins, which is `parseFollowUpsBlock`'s rule for the same
   * hazard: a stub's prose is written *before* its key, and that prose is the
   * agent quoting the code the finding rests on — which on this feature's own
   * files is a payload. Taking the first would let a quoted decoy speak for a
   * real stub, pointing a triager at somewhere else entirely.
   */
  it("reads the stub's own key, not a payload its evidence quotes", () => {
    const quoting: FilingStub = {
      number: 71,
      state: "OPEN",
      stateReason: null,
      body: [
        'The evidence: the next run reads `<!--{"version":2,"location":"src/decoy.ts","pr":1,"seq":0}-->`.',
        "",
        `<!--{"version":2,"location":"src/real.ts","pr":7,"seq":0}-->`,
      ].join("\n"),
    };

    expect(relationOf(plan([followUp({ location: "src/decoy.ts" })], [quoting]).issues[0]?.body)).toBe(
      "",
    );
    expect(
      relationOf(plan([followUp({ location: "src/real.ts" })], [quoting]).issues[0]?.body),
    ).toContain("#71");
  });

  /**
   * A hand-written stub, or one from before a format change, simply does not
   * match — so the run files without a link rather than linking the wrong
   * thing. `STUB_KEY_VERSION` moved to `2` with this change, so every stub the
   * previous release filed is in exactly that population: accepted, because one
   * unlinked duplicate is a click to close and a skipped finding is not.
   */
  it("links nothing to a stub carrying no payload", () => {
    const result = plan(
      [followUp({ location: "src/a.ts" })],
      [{ number: 71, state: "OPEN", stateReason: null, body: "A hand-written issue about src/a.ts." }],
    );

    expect(result.issues).toHaveLength(1);
    expect(relationOf(result.issues[0]?.body)).toBe("");
  });

  it("links nothing to a stub whose payload is a version it does not know", () => {
    const result = plan(
      [followUp({ location: "src/a.ts" })],
      [{
        number: 71,
        state: "OPEN",
        stateReason: null,
        body: `<!--{"version":3,"location":"src/a.ts","pr":7,"seq":0}-->`,
      }],
    );

    expect(result.issues).toHaveLength(1);
    expect(relationOf(result.issues[0]?.body)).toBe("");
  });
});

/**
 * Identity: the only binding key, and the only thing that stops a file (#82).
 * All three fields have to agree — the pull request, the `location` exactly as
 * the review recorded it, and the finding's place in that review's list.
 */
describe("planFollowUps: identity, and the retry it makes exact", () => {
  /**
   * What makes a retry exactly idempotent. The marker is left in place on a
   * partial failure so the run can be re-driven; on that retry the findings
   * that did file are found by their own key and reported rather than refiled.
   */
  it("plans nothing for a finding this pull request already filed", () => {
    const result = plan(
      [followUp({ location: "src/a.ts:12" })],
      [stub({ location: "src/a.ts:12", pr: 32, seq: 0 })],
      { prNumber: 32 },
    );

    expect(result).toMatchObject(NOTHING);
    expect(result.report).toMatch(/Already filed/i);
    expect(result.report).toContain("#71");
    // Finding-scoped, and the line has to say so: "this same path" would be
    // describing the rule this replaced.
    expect(result.report).toMatch(/same finding/);
  });

  /**
   * `location` is in the key as well as `seq` so a *changed* review fails the
   * check rather than passing it. Same slot, different finding, is exactly
   * where reporting "already filed" would skip a real one.
   */
  it("files when the seq agrees and the location does not", () => {
    const result = plan(
      [followUp({ location: "src/a.ts:400" })],
      [stub({ location: "src/a.ts:12", pr: 32, seq: 0 })],
      { prNumber: 32 },
    );

    expect(result.issues).toHaveLength(1);
    expect(result.report).not.toMatch(/Already filed/i);
  });

  it("files when the location agrees and the seq does not", () => {
    const result = plan(
      [followUp({ location: "src/a.ts:12" })],
      [stub({ location: "src/a.ts:12", pr: 32, seq: 1 })],
      { prNumber: 32 },
    );

    expect(result.issues).toHaveLength(1);
    expect(result.report).not.toMatch(/Already filed/i);
  });

  it("does not read another pull request's stub as its own", () => {
    const result = plan(
      [followUp({ location: "src/a.ts:12" })],
      [stub({ location: "src/a.ts:12", pr: 31, seq: 0 })],
      { prNumber: 32 },
    );

    expect(result.issues).toHaveLength(1);
    expect(result.report).not.toMatch(/Already filed/i);
  });

  /**
   * The production failure this change is for (#82): one review, two findings
   * in `.github/workflows/review.yml` at lines 104 and 462, 358 lines apart and
   * unrelated. The second was dropped, and re-running would have dropped it
   * again.
   */
  it("files both findings when one review raises two at the same path", () => {
    const result = plan([
      followUp({ title: "the fork guard is missing", location: ".github/workflows/review.yml:104" }),
      followUp({ title: "the pin is stale", location: ".github/workflows/review.yml:462" }),
    ]);

    expect(result.issues.map((i) => i.title)).toEqual([
      "the fork guard is missing",
      "the pin is stale",
    ]);
    expect(reportLines(result.report)).toHaveLength(2);
    for (const line of reportLines(result.report)) expect(line).toMatch(/Filed/);
  });

  /** And the retry over that same batch, which has to be exact for both of them. */
  it("is exactly idempotent on a retry, including two findings at one path", () => {
    const findings = [
      followUp({ title: "first", location: "src/a.ts:12" }),
      followUp({ title: "second", location: "src/a.ts:88" }),
      followUp({ title: "third", location: "src/b.ts:4" }),
    ];

    const result = planFollowUps({
      prNumber: 32,
      reviews: [review(findings)],
      stubs: [
        stub({ number: 71, location: "src/a.ts:12", pr: 32, seq: 0 }),
        stub({ number: 72, location: "src/a.ts:88", pr: 32, seq: 1 }),
      ],
    });

    expect(result.issues.map((i) => i.title)).toEqual(["third"]);
    const lines = reportLines(result.report);
    expect(lines[0]).toMatch(/Already filed/i);
    expect(lines[1]).toMatch(/Already filed/i);
    expect(lines[2]).toMatch(/Filed/);
  });

  /**
   * The trap this change is one wrong line away from reintroducing. A `seq`
   * taken from the count of what has filed only advances when something files,
   * so on the retry above the third finding would be written as `seq` 0 — and
   * the attempt after that would read it as the first finding's stub and skip
   * it. Index into the reviewer's list, never into the plan.
   */
  it("numbers a finding by its place in the review's list, not by how many filed", () => {
    const findings = [
      followUp({ title: "first", location: "src/a.ts:12" }),
      followUp({ title: "second", location: "src/a.ts:88" }),
      followUp({ title: "third", location: "src/b.ts:4" }),
    ];

    const result = planFollowUps({
      prNumber: 32,
      reviews: [review(findings)],
      stubs: [
        stub({ number: 71, location: "src/a.ts:12", pr: 32, seq: 0 }),
        stub({ number: 72, location: "src/a.ts:88", pr: 32, seq: 1 }),
      ],
    });

    expect(result.issues[0]?.body).toContain(`"seq":2`);
  });
});

describe("planFollowUps: what relatedness is worth", () => {
  /**
   * A link, never a verdict. #41 keyed a skip on this same coarse match and it
   * cost a real finding; the match itself was not the mistake, the authority
   * given to it was.
   */
  it("files beside an open stub and links it, rather than commenting on it", () => {
    const result = plan([followUp()], [stub({ state: "OPEN" })]);

    expect(result.issues).toHaveLength(1);
    expect(result.stubComments).toEqual([]);
    const relation = relationOf(result.issues[0]?.body);
    expect(relation).toContain("#71");
    expect(relation).toContain("(open)");
    expect(relation).toContain("src/a.ts");
    // The sentence that stops a triager reading a path match as a duplicate
    // claim and closing a real finding on it.
    expect(relation).toMatch(/not a claim/i);
    expect(result.report).toMatch(/Filed/);
  });

  /**
   * A `wontfix` decision is not a standing order to stop reporting the file it
   * was made in. Declining one finding in a 658-line workflow used to suppress
   * every future finding anywhere in it, permanently, with nothing written on
   * the pull request.
   */
  it("files against a wontfix decision, and names the reason in the link", () => {
    const result = plan([followUp()], [stub({ state: "CLOSED", stateReason: "not_planned" })]);

    expect(result.issues).toHaveLength(1);
    expect(result.stubComments).toEqual([]);
    const relation = relationOf(result.issues[0]?.body);
    expect(relation).toContain("#71");
    expect(relation).toContain("wontfix");
    expect(result.report).not.toMatch(/Suppressed/);
  });

  it("reads the close reason in both spellings the two APIs report", () => {
    for (const stateReason of ["not_planned", "NOT_PLANNED"]) {
      const result = plan([followUp()], [stub({ state: "closed", stateReason })]);

      expect(relationOf(result.issues[0]?.body)).toContain("wontfix");
    }
  });

  /**
   * A stub someone *fixed* and closed describes a problem that is no longer
   * there, so pointing a triager at it would mislead rather than help.
   */
  it("links nothing to a stub that was fixed and closed", () => {
    const result = plan([followUp()], [stub({ state: "CLOSED", stateReason: "completed" })]);

    expect(result.issues).toHaveLength(1);
    expect(relationOf(result.issues[0]?.body)).toBe("");
  });

  /** One link, never a list — and an open stub is the later decision of the two. */
  it("links one stub only, preferring an open one over a wontfix at the same path", () => {
    const result = plan(
      [followUp()],
      [
        stub({ number: 60, state: "CLOSED", stateReason: "not_planned", pr: 5 }),
        stub({ number: 71, pr: 5 }),
      ],
    );

    const body = result.issues[0]?.body ?? "";
    expect(body.match(/\*\*Possibly related:\*\*/g)).toHaveLength(1);
    expect(relationOf(body)).toContain("#71");
  });

  /**
   * Identity outranks relatedness: a stub this pull request filed for *this*
   * finding stops the file outright, whatever else sits at the path.
   */
  it("prefers the idempotence case over a wontfix decision at the same path", () => {
    const result = plan(
      [followUp({ location: "src/a.ts:12" })],
      [
        stub({ number: 60, state: "CLOSED", stateReason: "not_planned", location: "src/a.ts", pr: 5 }),
        stub({ number: 71, location: "src/a.ts:12", pr: 32, seq: 0 }),
      ],
      { prNumber: 32 },
    );

    expect(result).toMatchObject(NOTHING);
    expect(result.report).toMatch(/Already filed/i);
    expect(result.report).toContain("#71");
  });

  it("does not link a second finding at a different path to the first one's stub", () => {
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

  /**
   * Two keys in one payload. `location` is written **verbatim**, normalisation
   * and all — identity compares it byte for byte, and relatedness normalises it
   * on the way back in, so storing the normalised form would throw away the
   * half that has to be exact.
   */
  it("carries the dedup payload the next run matches on", () => {
    expect(filed({ location: "./src/a.ts:12" }).body).toContain(
      `<!--{"version":2,"location":"./src/a.ts:12","pr":32,"seq":0}-->`,
    );
  });

  it("carries no relation line when nothing on the tracker is related", () => {
    expect(relationOf(filed().body)).toBe("");
  });

  /**
   * After the provenance sentence and before the key: it is the last thing a
   * triager reads before the payload, and it qualifies the finding rather than
   * the evidence above it.
   */
  it("puts the relation after the provenance sentence and before the payload", () => {
    const body = plan([followUp()], [stub({ pr: 5 })]).issues[0]?.body ?? "";
    const lines = body.split("\n");

    const provenance = lines.findIndex((line) => line.includes(REVIEW_URL));
    const relation = lines.findIndex((line) => line.startsWith("**Possibly related:**"));
    const payload = lines.findIndex((line) => line.startsWith("<!--{"));

    expect(provenance).toBeGreaterThan(-1);
    expect(relation).toBeGreaterThan(provenance);
    expect(payload).toBeGreaterThan(relation);
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

    const second = planFollowUps({ prNumber: 33, reviews: [review(findings)], stubs: [asStub] });

    expect(relationOf(second.issues[0]?.body)).toContain("#71");
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
    // Both related states report identically, and that is the point: the
    // report's job was making *skips* visible and there are none. The relation
    // belongs on the issue being triaged, not on a merged pull request.
    ["filed beside a related open stub", [stub({ pr: 5 })], /Filed/],
    [
      "filed beside a wontfix decision",
      [stub({ state: "CLOSED", stateReason: "not_planned" })],
      /Filed/,
    ],
    ["already filed", [stub({ location: "src/a.ts:12", pr: 32, seq: 0 })], /Already filed/i],
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
   * Three lines is the most a run can produce, and both outcomes appear in
   * them. The cap is three findings, and nothing spends one of them on a skip
   * any more.
   */
  it("keeps the outcomes in the order the reviewer listed them", () => {
    const result = planFollowUps({
      prNumber: 32,
      reviews: [
        review([
          followUp({ title: "new", location: "src/new.ts" }),
          followUp({ title: "retried", location: "src/done.ts:4" }),
          followUp({ title: "declined before", location: "src/wontfix.ts" }),
        ]),
      ],
      stubs: [
        stub({ number: 71, location: "src/done.ts:4", pr: 32, seq: 1 }),
        stub({ number: 72, location: "src/wontfix.ts", state: "CLOSED", stateReason: "not_planned" }),
      ],
    });

    const lines = reportLines(result.report);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/Filed/);
    expect(lines[0]).toContain("src/new.ts");
    expect(lines[1]).toMatch(/Already filed/i);
    expect(lines[1]).toContain("src/done.ts");
    expect(lines[2]).toMatch(/Filed/);
    expect(lines[2]).toContain("src/wontfix.ts");
    // Two outcomes, and neither of the two that used to be a silent skip.
    expect(result.report).not.toMatch(/Suppressed|Re-flagged/);
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
  it("still reports when it filed nothing because it had already filed it", () => {
    const result = plan(
      [followUp({ location: "src/a.ts:12" })],
      [stub({ location: "src/a.ts:12", pr: 32, seq: 0 })],
    );

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

/**
 * Two payloads, two versions (#81). They were one constant, and nothing about
 * them moves together: the findings block is written into a review body by one
 * release and read out of it by the next, while the dedup key is written into
 * an issue that outlives both. Bumping the one constant to change the key also
 * changed the block's shape, so every review body already posted took the
 * loud-refusal branch above and filed nothing — a cost with no connection to
 * the change that caused it.
 *
 * Neither half of that can be asserted on the values, which are both `1` and
 * are meant to be. So each test moves *one* version in a re-imported module
 * graph and asserts the other payload did not follow.
 */
describe("the stub key and the review block version independently", () => {
  afterEach(() => {
    vi.doUnmock("../shared/review-output.js");
    vi.doUnmock("../shared/follow-up-plan.js");
    vi.resetModules();
  });

  /** The filing half, re-imported against a review block whose version has moved on. */
  const filingHalfAgainstBlockVersion = async (version: number) => {
    vi.resetModules();
    vi.doMock("../shared/review-output.js", async () => ({
      ...(await vi.importActual<typeof import("../shared/review-output.js")>(
        "../shared/review-output.js",
      )),
      FOLLOW_UPS_VERSION: version,
    }));
    return import("../shared/follow-up-plan.js");
  };

  it("writes the stub key at its own version when the block's has moved", async () => {
    const { planFollowUps: planAgainst } = await filingHalfAgainstBlockVersion(99);

    const result = planAgainst({ prNumber: 32, reviews: [review([followUp()])], stubs: [] });

    expect(result.issues[0]?.body).toContain(
      `<!--{"version":2,"location":"src/a.ts:12","pr":32,"seq":0}-->`,
    );
  });

  it("reads a stub at its own version when the block's has moved", async () => {
    const { planFollowUps: planAgainst } = await filingHalfAgainstBlockVersion(99);

    const result = planAgainst({ prNumber: 32, reviews: [review([followUp()])], stubs: [stub()] });

    expect(relationOf(result.issues[0]?.body)).toContain("#71");
  });

  /**
   * The other direction has nothing to mock *into*: the review half does not
   * import the filing half, so moving the stub key's version reaches nothing.
   * That absence is the assertion — a re-coupling is what would give this mock
   * something to bite on, and the block would render the moved version.
   */
  it("renders the block at its own version when the stub key's has moved", async () => {
    vi.resetModules();
    vi.doMock("../shared/follow-up-plan.js", async () => ({
      ...(await vi.importActual<typeof import("../shared/follow-up-plan.js")>(
        "../shared/follow-up-plan.js",
      )),
      STUB_KEY_VERSION: 99,
    }));

    const { renderFollowUpsBlock: render, FOLLOW_UPS_MARKER: marker } = await import(
      "../shared/review-output.js"
    );

    expect(render([], 0)).toBe(`<!-- ${marker} {"version":1,"dropped":0,"followUps":[]} -->`);
  });
});
