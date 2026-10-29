import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Limits } from "../../engine/writer.js";
import { file } from "../../follow-ups/file.js";
import type { CommandIo, Token } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { OPENING } from "../../follow-ups/checklist.js";
import { FOLLOW_UP_STUB_LABEL, FOLLOW_UPS_LABEL, POST_MERGE_CHECKLIST_MARK, stubMarker, TRIAGE_LABEL } from "../../shared/record.js";
import { renderFollowUpsBlock, type FollowUp } from "../../shared/review-output.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub, type ReceivedRead } from "../engine/fakes.js";

/**
 * `follow-ups:file` (#510), called the way the CLI calls it: its declared
 * inputs, a fake GitHub reader, and the engine's writers over a fake GitHub.
 * What is asserted is what it did to the record: the writes it made, in what
 * order and with which token, what each said, and what it read. How the plan
 * is made is `planFollowUps`', held in `tests/follow-up-plan.test.ts`.
 *
 * The scenarios are the ones the `gh` half met (`shared/follow-up-filing.ts`
 * before #510), carried over by behaviour, with #510's server error added.
 */

const PR = 32;
const REVIEW_URL = `https://github.com/o/r/pull/${PR}#pullrequestreview-9`;

let github: FakeGitHub;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;
let reads: readonly ReceivedRead[];
let log: ReturnType<typeof vi.spyOn>;

const followUp = (n: number, over: Partial<FollowUp> = {}): FollowUp => ({
  title: `Finding ${n}`,
  location: `src/f${n}.ts:${n + 1}`,
  body: `Evidence for ${n}.`,
  severity: "medium",
  ...over,
});

/** The pull request's review history: one review by the loop, recording `findings`. */
const reviewed = (findings: readonly FollowUp[], over: { lastEditedAt?: string | null; cap?: number } = {}): void => {
  github.reviewHistory.set(PR, [
    {
      author: "github-actions",
      body: `A summary.\n\n${renderFollowUpsBlock(findings, 0, 0, over.cap ?? 3)}`,
      lastEditedAt: over.lastEditedAt ?? null,
      url: REVIEW_URL,
    },
  ]);
};

/** A stub already in the tracker, labelled `pr-follow-up`, with `body`. */
const stub = (number: number, body: string): void => {
  github.filed.set(number, { title: "theirs", body, state: "OPEN", stateReason: null });
  github.issueLabels.set(number, [TRIAGE_LABEL, FOLLOW_UP_STUB_LABEL]);
};

beforeEach(() => {
  github = fakeGitHub([{ number: PR, state: "closed", merged: true, labels: [FOLLOW_UPS_LABEL] }]);
  github.repoLabels.push(TRIAGE_LABEL, FOLLOW_UP_STUB_LABEL);
  made = undefined;
  asked = undefined;
  reads = [];
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Inputs = Parameters<typeof file>[0];

const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: "/out",
  GH_REPO: "o/r",
  GH_TOKEN: "workflow-token",
  AGENT_LOOP_LOGINS: "",
  PR_NUMBER: String(PR),
  ...over,
});

/** The CLI's half: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  const reader = fakeReader(github);
  reads = reader.reads;
  const io: CommandIo<(typeof COMMANDS)["follow-ups:file"]["outputs"]> = {
    writers: (limits) => {
      asked = limits;
      made = fakeWriters(github, ["loop", "workflow"] as const, limits);
      return made.writers;
    },
    github: reader.reader,
    outputs: { writeJson: () => {}, writeText: () => {}, writeBytes: () => {}, appendLine: () => {} },
  };
  try {
    await file(inputs, io);
    made?.log.end();
  } catch (error) {
    made?.log.end(error);
    throw error;
  }
};

const writes = () => (made?.writes ?? []).map((w) => `${w.token} ${w.type}`);
const logged = () => log.mock.calls.map((call) => String(call[0]));
const warnings = () => logged().filter((line) => line.startsWith("::warning::"));
const comments = () => github.comments.map((c) => c.body);
const markerOn = () => github.pullRequests.get(PR)?.labels.includes(FOLLOW_UPS_LABEL);
/** The issues this run filed, by number, title and labels: every one but those a test put there. */
const filed = () =>
  [...github.filed].filter(([, issue]) => issue.title !== "theirs").map(([number, issue]) => [number, issue.title, github.issueLabels.get(number)] as const);

describe("follow-ups:file without the marker", () => {
  it("writes nothing and says so in the log", async () => {
    github.pullRequests.get(PR)?.labels.splice(0);
    reviewed([followUp(0)]);

    await run();

    expect(writes()).toEqual([]);
    expect(reads.map((r) => r.method)).toEqual(["pullRequest"]);
    expect(logged()).toEqual([`#${PR} links no issue, so there is no post-merge checklist.`, `#${PR} does not carry \`${FOLLOW_UPS_LABEL}\`. Nothing to file.`]);
  });

  it("throws where the pull request cannot be read, rather than reading it as unmarked", async () => {
    github.pullRequests.delete(PR);

    await expect(run()).rejects.toThrow(/404/);
    expect(writes()).toEqual([]);
  });

  it("refuses a PR_NUMBER that is not a pull request number before it reads anything", async () => {
    await expect(run(INPUTS({ PR_NUMBER: "abc" }))).rejects.toThrow('PR_NUMBER is "abc", which is not a pull request number.');
    expect(reads).toEqual([]);
  });
});

describe("follow-ups:file with the marker", () => {
  it("files each stub in the reviewer's order, names them in the report, and removes the marker last", async () => {
    reviewed([followUp(0), followUp(1)]);

    await run();

    expect(writes()).toEqual(["workflow createIssue", "workflow createIssue", "workflow comment", "workflow removeLabel"]);
    expect(filed()).toEqual([
      [33, "Finding 0", [TRIAGE_LABEL, FOLLOW_UP_STUB_LABEL]],
      [34, "Finding 1", [TRIAGE_LABEL, FOLLOW_UP_STUB_LABEL]],
    ]);
    expect(github.filed.get(33)?.body.split("\n").at(-1)).toBe(stubMarker("src/f0.ts:1", PR, 0));
    expect(comments()).toHaveLength(1);
    expect(comments()[0]).toContain("- **Filed** · `src/f0.ts` · #33");
    expect(comments()[0]).toContain("- **Filed** · `src/f1.ts` · #34");
    expect(markerOn()).toBe(false);
    expect(reads.map((r) => r.method)).toEqual(["pullRequest", "reviewHistory", "labelledIssues", "repoLabels"]);
    expect(reads.find((r) => r.method === "labelledIssues")?.args).toEqual([FOLLOW_UP_STUB_LABEL]);
    expect(logged()).toEqual([`#${PR} links no issue, so there is no post-merge checklist.`, `Filed 2 issue(s): #33, #34.`, `Reported on #${PR}: true.`, "Marker removed: true."]);
  });

  it("files nothing and says nothing for a block that recorded nothing, and removes the marker", async () => {
    reviewed([]);

    await run();

    expect(writes()).toEqual(["workflow removeLabel"]);
    expect(markerOn()).toBe(false);
    // The repository's labels are read only where something is filed.
    expect(reads.map((r) => r.method)).not.toContain("repoLabels");
    expect(logged()).toEqual([`#${PR} links no issue, so there is no post-merge checklist.`, "Filed 0 issue(s).", `Reported on #${PR}: false.`, "Marker removed: true."]);
  });

  it("does not file a stub this pull request already filed", async () => {
    reviewed([followUp(0), followUp(1)]);
    stub(40, `Prose.\n\n${stubMarker("src/f0.ts:1", PR, 0)}`);

    await run();

    expect(filed().map(([, title]) => title)).toEqual(["Finding 1"]);
    expect(comments()[0]).toContain("- **Already filed by this pull request** · `src/f0.ts` · #40");
    expect(comments()[0]).toContain("- **Filed** · `src/f1.ts` · #41");
    expect(markerOn()).toBe(false);
  });

  it("files a stub without a label the repository lacks, and says so", async () => {
    github.repoLabels.splice(0);
    github.repoLabels.push(TRIAGE_LABEL);
    reviewed([followUp(0)]);

    await run();

    expect(filed()).toEqual([[33, "Finding 0", [TRIAGE_LABEL]]]);
    expect(warnings()).toEqual([
      `::warning::Filed #33 without \`${FOLLOW_UP_STUB_LABEL}\`, which this repository does not have. Create the label and add it to the issue.`,
    ]);
    expect(markerOn()).toBe(false);
  });

  it("refuses an edited review on the pull request, filing nothing and leaving the marker on", async () => {
    reviewed([followUp(0)], { lastEditedAt: "2026-01-02T00:00:00Z" });

    await run();

    expect(writes()).toEqual(["workflow comment"]);
    expect(comments()[0]).toMatch(/^\*\*No follow-ups were filed\.\*\* \[The review\]\(.*\) they were recorded in has been edited/);
    expect(markerOn()).toBe(true);
  });

  it("writes with the workflow's token alone, within its limits, and logs each write", async () => {
    reviewed([followUp(0)]);

    await run();

    expect(asked).toEqual({ createIssue: 200, comment: 2, removeLabel: 1 });
    expect(new Set(made?.writes.map((w) => w.token))).toEqual(new Set(["workflow"]));
    expect(made?.entries.map((e) => `${e.token} ${e.type} ${e.outcome}`)).toEqual([
      "workflow createIssue applied",
      "workflow comment applied",
      "workflow removeLabel applied",
    ]);
    expect(made?.entries[0]?.target).toBe(`"Finding 0" ${TRIAGE_LABEL} ${FOLLOW_UP_STUB_LABEL}`);
  });

  it("refuses a stub past its limit, posting nothing and leaving the marker on", async () => {
    reviewed(
      Array.from({ length: 201 }, (_, n) => followUp(n)),
      { cap: 300 },
    );

    await expect(run()).rejects.toThrow(/past the limit of 200/);
    expect(filed()).toHaveLength(200);
    expect(comments()).toEqual([]);
    expect(markerOn()).toBe(true);
  });

  it("stops with the marker on where a stub cannot be filed", async () => {
    reviewed([followUp(0)]);
    github.fails = (write) => write.type === "createIssue";

    await expect(run()).rejects.toThrow(/^Couldn't file "Finding 0", so `agent:follow-ups` is left on/);
    expect(comments()).toEqual([]);
    expect(markerOn()).toBe(true);
  });
});

/**
 * GitHub can open an issue and still answer the create with a server error,
 * so one is read back (#510): the `pr-follow-up` issues are listed, and the
 * one whose key is this finding's identity is the one this run filed.
 */
describe("follow-ups:file on a server error filing a stub", () => {
  const erroring = (landed: boolean, readBack: false | "fails" = false): void => {
    github.fails = (write, call) => {
      if (write.type !== "createIssue") return false;
      if (call === "POST issues") return { status: 502, landed };
      return readBack === "fails" ? { status: 503, landed: false } : false;
    };
  };

  it("carries on with a stub GitHub filed all the same, saying so", async () => {
    reviewed([followUp(0)]);
    erroring(true);

    await run();

    expect(filed().map(([number, title]) => [number, title])).toEqual([[33, "Finding 0"]]);
    expect(comments()[0]).toContain("- **Filed** · `src/f0.ts` · #33");
    expect(markerOn()).toBe(false);
    expect(warnings()).toEqual([
      expect.stringMatching(
        /^::warning::GitHub answered filing "Finding 0" with a server error \(.*502.*\), but #33 is that stub, so this run goes on with it\. GitHub's reply is in the write log\.$/,
      ),
    ]);
  });

  it("stops with the marker on where the read-back finds no such stub", async () => {
    reviewed([followUp(0)]);
    erroring(false);

    await expect(run()).rejects.toThrow(/^Couldn't file "Finding 0", so `agent:follow-ups` is left on: .*502/);
    expect(comments()).toEqual([]);
    expect(markerOn()).toBe(true);
  });

  it("takes no stub whose key is another finding's, whatever its prose quotes", async () => {
    reviewed([followUp(0)]);
    // Another pull request's stub, quoting this finding's key ahead of its own.
    stub(40, `It quotes ${stubMarker("src/f0.ts:1", PR, 0)} as evidence.\n\n${stubMarker("src/f0.ts:1", 31, 0)}`);
    erroring(false);

    await expect(run()).rejects.toThrow(/^Couldn't file "Finding 0", so `agent:follow-ups` is left on/);
    expect(markerOn()).toBe(true);
  });

  it("stops with the marker on, saying to look first, where the read-back fails too", async () => {
    reviewed([followUp(0)]);
    erroring(true, "fails");

    await expect(run()).rejects.toThrow(
      /^GitHub answered filing "Finding 0" with a server error, and whether it was filed anyway could not be read back \(.*503.*\)\. `agent:follow-ups` is left on, so removing it and adding it back files whatever is missing, and nothing twice\.$/,
    );
    expect(comments()).toEqual([]);
    expect(markerOn()).toBe(true);
  });
});

/**
 * The post-merge checklist (#544): posted on every merge, labelled or not,
 * from the linked issue, or a PRD's parent and each sub-issue. What is read
 * from each brief is `planChecklist`'s, in `checklist.test.ts`; this holds
 * what is gathered, in what order, and what is written.
 */
describe("follow-ups:file's post-merge checklist", () => {
  const brief = (...items: string[]): string =>
    ["## Agent Brief", "### Acceptance criteria", "- It works.", "### After merge, by a human", ...items.map((item) => `- ${item}`)].join("\n");
  /** Issue `number`, opened by a maintainer with `body`, with `comments` by one, oldest first. */
  const linked = (number: number, body: string, comments: readonly string[] = []): void => {
    github.issues.set(number, { subIssues: 0, blockedBy: [] });
    github.bodies.set(number, { body, author: "maintainer", association: "OWNER" });
    github.discussion.set(number, comments.map((comment) => ({ body: comment, author: "maintainer", association: "MEMBER" })));
  };
  const closes = (body: string): void => {
    const pr = github.pullRequests.get(PR);
    if (pr !== undefined) pr.body = body;
  };
  const checklists = () => comments().filter((body) => body.includes(POST_MERGE_CHECKLIST_MARK));

  it("is posted on a merge without the marker, attributed to the linked issue, and nothing is filed", async () => {
    github.pullRequests.get(PR)?.labels.splice(0);
    closes("Does a thing.\n\nCloses #5");
    linked(5, "A report.", [brief("Run setup on a real worker.")]);

    await run();

    expect(writes()).toEqual(["workflow comment"]);
    expect(comments()).toEqual([`${OPENING}\n\nFrom #5:\n- [ ] Run setup on a real worker.\n\n${POST_MERGE_CHECKLIST_MARK}`]);
    expect(reads.map((r) => r.method)).toEqual(["pullRequest", "issueBody", "issueShape", "authoredComments", "authoredComments"]);
    expect(reads.filter((r) => r.method === "authoredComments").map((r) => r.args)).toEqual([[5], [PR]]);
    expect(markerOn()).toBe(false);
    expect(logged()).toEqual([`Posted the post-merge checklist on #${PR}.`, `#${PR} does not carry \`${FOLLOW_UPS_LABEL}\`. Nothing to file.`]);
  });

  it("covers a PRD's parent, then every sub-issue in the list's order, closed ones included", async () => {
    closes("Closes #20, closes #22");
    linked(20, brief("Check the whole."));
    linked(21, brief("Check the first."));
    linked(22, brief("Check the second."));
    linked(23, "No section.");
    github.issues.set(20, {
      subIssues: 3,
      blockedBy: [],
      children: [
        { number: 21, title: "first", state: "CLOSED" },
        { number: 23, title: "none", state: "CLOSED" },
        { number: 22, title: "second", state: "OPEN" },
      ],
    });
    reviewed([]);

    await run();

    expect(checklists()).toEqual([
      [OPENING, "From #20:\n- [ ] Check the whole.", "From #21:\n- [ ] Check the first.", "From #22:\n- [ ] Check the second.", POST_MERGE_CHECKLIST_MARK].join("\n\n"),
    ]);
  });

  it("posts nothing where no linked brief names a check, or the pull request links no issue", async () => {
    github.pullRequests.get(PR)?.labels.splice(0);
    closes("Closes #5");
    linked(5, "A report.", ["### Acceptance criteria\n- It works."]);

    await run();
    expect(writes()).toEqual([]);

    closes("No link.");
    await run();
    expect(writes()).toEqual([]);
    expect(reads.map((r) => r.method)).toEqual(["pullRequest"]);
  });

  it("posts no second checklist on a re-run, and logs why", async () => {
    closes("Closes #5");
    linked(5, brief("Check."));
    reviewed([]);

    // The second run is the retry `follow-ups:conclude` names: the label added back.
    await run();
    github.pullRequests.get(PR)?.labels.push(FOLLOW_UPS_LABEL);
    await run();

    expect(checklists()).toHaveLength(1);
    expect(logged()).toContain(`#${PR} already carries the post-merge checklist, so it is not posted again.`);
  });

  it("is not suppressed by the marker in a comment posted by an account that is not the loop's", async () => {
    closes("Closes #5");
    linked(5, brief("Check."));
    github.discussion.set(PR, [{ body: POST_MERGE_CHECKLIST_MARK, author: "someone", association: "MEMBER" }]);
    reviewed([]);

    await run();

    expect(checklists()).toHaveLength(1);
  });

  it("is posted before an edited review's refusal to file, and that refusal does not stop it", async () => {
    closes("Closes #5");
    linked(5, brief("Check."));
    reviewed([followUp(0)], { lastEditedAt: "2026-01-02T00:00:00Z" });

    await run();

    expect(writes()).toEqual(["workflow comment", "workflow comment"]);
    expect(comments()[0]).toContain(POST_MERGE_CHECKLIST_MARK);
    expect(comments()[1]).toMatch(/^\*\*No follow-ups were filed\.\*\*/);
    expect(markerOn()).toBe(true);
  });

  it("files first and then fails the run, naming the issue, where a sub-issue cannot be read", async () => {
    closes("Closes #20");
    linked(20, brief("Check."));
    github.issues.set(20, { subIssues: 1, blockedBy: [], children: [{ number: 21, title: "gone", state: "OPEN" }] });
    reviewed([followUp(0)]);

    await expect(run()).rejects.toThrow(/^Couldn't read #21 for the post-merge checklist: .*404/);
    expect(checklists()).toEqual([]);
    expect(filed().map(([, title]) => title)).toEqual(["Finding 0"]);
    expect(markerOn()).toBe(false);
  });

  it("fails the run without the marker too, where a sub-issue cannot be read, having written nothing", async () => {
    github.pullRequests.get(PR)?.labels.splice(0);
    closes("Closes #20");
    linked(20, brief("Check."));
    github.issues.set(20, { subIssues: 1, blockedBy: [], children: [{ number: 21, title: "gone", state: "OPEN" }] });

    await expect(run()).rejects.toThrow(/^Couldn't read #21 for the post-merge checklist/);
    expect(writes()).toEqual([]);
    expect(logged()).toContain(`#${PR} does not carry \`${FOLLOW_UPS_LABEL}\`. Nothing to file.`);
  });

  it("is not posted on a pull request closed without merging, which the manual entry point still files from", async () => {
    const pull = github.pullRequests.get(PR);
    if (pull !== undefined) pull.merged = false;
    closes("Closes #5");
    linked(5, brief("Check."));
    reviewed([followUp(0)]);

    await run();

    expect(checklists()).toEqual([]);
    expect(reads.map((r) => r.method)).not.toContain("issueBody");
    expect(filed().map(([, title]) => title)).toEqual(["Finding 0"]);
    expect(logged()[0]).toBe(`#${PR} has not merged, so there is no post-merge checklist.`);
  });

  it.each([
    ["an issue not found", () => undefined],
    ["a pull request's number", () => github.pullRequests.set(8, { ...github.pullRequests.get(PR)!, number: 8, body: "### After merge, by a human\n- Not a brief." })],
    ["an issue transferred out", () => linked(5, brief("Check."))],
  ])("posts nothing and fails nothing where the link names %s, and still files", async (_case, seed) => {
    closes("Closes #5");
    seed();
    if (github.pullRequests.has(8)) closes("Closes #8");
    if (github.bodies.has(5)) github.bodies.set(5, { ...github.bodies.get(5)!, isIssue: false });
    reviewed([followUp(0)]);

    await run();

    expect(checklists()).toEqual([]);
    expect(filed().map(([, title]) => title)).toEqual(["Finding 0"]);
    expect(logged()[0]).toMatch(/^#\d+ links #\d+, which is not an issue of this repository, so there is no post-merge checklist\.$/);
  });
});
