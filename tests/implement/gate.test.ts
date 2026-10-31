import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubError } from "../../engine/github.js";
import type { GitHubReader } from "../../engine/read.js";
import type { Limits } from "../../engine/writer.js";
import { gate } from "../../implement/gate.js";
import type { CommandIo, Token } from "../../shared/command-io.js";
import { COMMANDS } from "../../shared/contract.js";
import { BLOCKED_LABEL, IMPLEMENT_LABEL } from "../../shared/record.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `implement:gate` (#490), called the way the CLI calls it: its declared
 * inputs, a fake GitHub reader, and the engine's writers over a fake GitHub,
 * sharing one log. What is asserted is what it did to the record, the writes
 * it attempted in order, and the decision and facts it handed on in
 * `gate.json`.
 *
 * The scenarios are the retired shell pre-flight's, `Transition labels`',
 * `Compute branch name`'s and `Record the base`'s, carried over by
 * behaviour, each refusal with today's sentence word for word.
 */

const ISSUE = 12;
const TITLE = "Do the thing";
const BRANCH = "agent/issue-12-do-the-thing";
const BASE = "b".repeat(40);
const TIP = "c".repeat(40);
const RUN_URL = "https://github.com/o/r/actions/runs/99";

let github: FakeGitHub;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;
let reader: GitHubReader;
let reads: ReturnType<typeof fakeReader>["reads"];
let decided: unknown;
let logged: string[];

beforeEach(() => {
  github = fakeGitHub([]);
  github.issues.set(ISSUE, { subIssues: 0, blockedBy: [] });
  github.issueLabels.set(ISSUE, [IMPLEMENT_LABEL]);
  github.branches.set("main", BASE);
  made = undefined;
  asked = undefined;
  ({ reader, reads } = fakeReader(github));
  decided = undefined;
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Inputs = Parameters<typeof gate>[0];

const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: "/out",
  GH_REPO: "o/r",
  GH_TOKEN: "workflow-token",
  ISSUE_NUMBER: String(ISSUE),
  ISSUE_TITLE: TITLE,
  ISSUE_STATE: "open",
  BASE_REF: "main",
  RUN_URL,
  ...over,
});

/** The CLI's half: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS(), github_: GitHubReader = reader): Promise<void> => {
  const io: CommandIo<(typeof COMMANDS)["implement:gate"]["outputs"]> = {
    writers: (limits) => {
      asked = limits;
      made = fakeWriters(github, ["loop", "workflow"] as const, limits);
      return made.writers;
    },
    github: github_,
    outputs: {
      writeJson: (name, value) => {
        expect(name).toBe("gate.json");
        decided = structuredClone(value);
      },
      writeText: () => {},
      writeBytes: () => {},
      appendLine: () => {},
    },
  };
  try {
    await gate(inputs, io);
    made?.log.end();
  } catch (error) {
    made?.log.end(error);
    throw error;
  }
};

/** Each write, as `<token> <type> <what>`. */
const writes = (): string[] =>
  (made?.writes ?? []).map((w) => {
    const [, second] = w.args;
    return `${w.token} ${w.type} ${typeof second === "string" ? second.split("\n")[0] : ""}`.trim();
  });

const labels = (): readonly string[] => github.issueLabels.get(ISSUE) ?? [];
const comments = (): readonly string[] => github.comments.map((c) => c.body);
const refusal = (sentence: string): string => `**\`agent:implement\` didn't run:** ${sentence}`;

/** A reader whose `method` throws `error`, otherwise the fake's. */
const throwing = (method: keyof GitHubReader, error: unknown): GitHubReader => ({
  ...reader,
  [method]: async () => {
    throw error;
  },
});

/** An open pull request whose body closes `issue`, by `number`. */
const openPr = (number: number, body: string): void => {
  github.pullRequests.set(number, { number, nodeId: `PR_${number}`, state: "open", draft: false, headSha: "d".repeat(40), title: "", body, labels: [] });
};

describe("implement:gate leaves an issue with sub-issues to implement-prd", () => {
  /**
   * The partition comes first, ahead of state: a closed PRD would otherwise
   * collect the same "not open" comment twice, from two runs that cannot see
   * each other. Nested (sub-issues and a parent) is the PRD workflow's too.
   */
  it.each([
    ["an open one", INPUTS(), {}],
    ["a closed one", INPUTS({ ISSUE_STATE: "closed" }), {}],
    ["a nested one, with a parent", INPUTS(), { parent: 3 }],
    ["one that is a planning issue and blocked", INPUTS(), { blockedBy: [{ number: 4, state: "open" as const }] }],
  ])("defers on %s, writing nothing to the record", async (_, inputs, over) => {
    github.issues.set(ISSUE, { subIssues: 2, blockedBy: [], ...over });
    github.issueLabels.set(ISSUE, [IMPLEMENT_LABEL, "wayfinder:map"]);

    await run(inputs);

    expect(made?.writes).toEqual([]);
    expect(comments()).toEqual([]);
    expect(labels()).toEqual([IMPLEMENT_LABEL, "wayfinder:map"]);
    expect(reads.map((r) => r.method)).toEqual(["issueShape"]);
    expect(logged).toContain(`#${ISSUE} has 2 sub-issue(s), so agent-implement-prd owns this label event.`);
    expect(decided).toEqual({ proceed: "false" });
  });
});

describe("implement:gate refuses an issue it should not build", () => {
  /** The order the refusals are tried in, each with today's sentence and whether it blocks. */
  it("refuses a closed issue, and does not block it", async () => {
    await run(INPUTS({ ISSUE_STATE: "closed" }));

    expect(comments()).toEqual([refusal("This issue is closed. Reopen it, then add `agent:implement` again.")]);
    expect(writes()).toEqual([
      "workflow comment **`agent:implement` didn't run:** This issue is closed. Reopen it, then add `agent:implement` again.",
      `workflow removeLabel ${IMPLEMENT_LABEL}`,
    ]);
    expect(labels()).toEqual([]);
    expect(decided).toEqual({ proceed: "false" });
  });

  it("refuses a closed issue before its shape, whatever else it is", async () => {
    github.issues.set(ISSUE, { subIssues: 0, parent: 3, blockedBy: [] });
    github.issueLabels.set(ISSUE, [IMPLEMENT_LABEL, "wayfinder:map"]);

    await run(INPUTS({ ISSUE_STATE: "closed" }));

    expect(comments()).toEqual([refusal("This issue is closed. Reopen it, then add `agent:implement` again.")]);
    expect(labels()).toEqual(["wayfinder:map"]);
  });

  /** Ahead of the hierarchy: a planning ticket is refused whatever shape it has. */
  it("refuses a planning issue, ahead of its parent, and blocks it", async () => {
    github.issues.set(ISSUE, { subIssues: 0, parent: 3, blockedBy: [] });
    github.issueLabels.set(ISSUE, [IMPLEMENT_LABEL, "wayfinder:map"]);

    await run();

    expect(comments()).toEqual([
      refusal("This is a planning issue (`wayfinder:*`), not buildable work. Add `agent:implement` to the issues it produces instead."),
    ]);
    expect(writes().map((w) => w.split(" ").slice(0, 2).join(" "))).toEqual(["workflow comment", "workflow removeLabel", "workflow addLabel"]);
    expect(labels()).toEqual(["wayfinder:map", BLOCKED_LABEL]);
    expect(decided).toEqual({ proceed: "false" });
  });

  it("refuses a sub-issue, naming its parent, and blocks it", async () => {
    github.issues.set(ISSUE, { subIssues: 0, parent: 3, blockedBy: [{ number: 4, state: "open" }] });

    await run();

    expect(comments()).toEqual([refusal("This is a sub-issue of #3. Add `agent:implement` to #3 instead; it builds its sub-issues in order.")]);
    expect(labels()).toEqual([BLOCKED_LABEL]);
    expect(reads.map((r) => r.method)).toEqual(["issueShape"]);
  });

  it("refuses an issue with one open blocker, naming it, and blocks it", async () => {
    github.issues.set(ISSUE, { subIssues: 0, blockedBy: [{ number: 4, state: "open" }, { number: 5, state: "closed" }] });
    openPr(30, `Closes #${ISSUE}`);

    await run();

    expect(comments()).toEqual([
      refusal(
        'It\'s blocked by #4, which is still open. Add `agent:implement` again once #4 is closed, or remove the "blocked by" link if it no longer applies.',
      ),
    ]);
    expect(labels()).toEqual([BLOCKED_LABEL]);
    expect(writes().map((w) => w.split(" ").slice(0, 2).join(" "))).toEqual(["workflow comment", "workflow removeLabel", "workflow addLabel"]);
    expect(reads.map((r) => r.method)).toEqual(["issueShape", "openBlockers"]);
  });

  it("refuses an issue with several open blockers, naming each", async () => {
    github.issues.set(ISSUE, { subIssues: 0, blockedBy: [{ number: 4, state: "open" }, { number: 6, state: "open" }] });

    await run();

    expect(comments()).toEqual([
      refusal(
        'It\'s blocked by #4, #6, which are still open. Add `agent:implement` again once they are closed, or remove the "blocked by" links that no longer apply.',
      ),
    ]);
    expect(labels()).toEqual([BLOCKED_LABEL]);
  });

  /** "No blockers" on a blip, as the shell's `|| echo ""` read it. */
  it("goes ahead where the blockers cannot be read", async () => {
    await run(INPUTS(), throwing("openBlockers", new GitHubError("GET blocked_by: 502", 502)));

    expect(comments()).toEqual([`**\`agent:implement\` started:** [Workflow run](${RUN_URL})`]);
    expect(logged.some((l) => l.startsWith(`::warning::Could not read what blocks #${ISSUE}`))).toBe(true);
    expect(decided).toMatchObject({ proceed: "true" });
  });

  it("refuses an issue an open PR already closes, naming the PR, and does not block it", async () => {
    openPr(30, "Something else entirely. Closes #120");
    openPr(31, `Some words.\n\nFixes  #${ISSUE}`);
    openPr(33, `RESOLVES #${ISSUE}.`);
    github.pullRequests.set(34, { ...github.pullRequests.get(33)!, number: 34, state: "closed" });

    await run();

    expect(comments()).toEqual([
      refusal("PR #33 already exists for this issue. Keep working on that PR, or close it and add `agent:implement` again."),
    ]);
    expect(labels()).toEqual([]);
    expect(decided).toEqual({ proceed: "false" });
  });

  it("does not read #120 as closing #12", async () => {
    openPr(30, "Closes #120");

    await run();

    expect(decided).toMatchObject({ proceed: "true" });
  });

  /** "No answer" read as "standalone" is the isolated sub-issue run the partition exists to prevent. */
  it("fails, deciding nothing and writing nothing, where the shape cannot be read", async () => {
    await expect(run(INPUTS(), throwing("issueShape", new GitHubError("graphql: something")))).rejects.toThrow("graphql: something");

    expect(made?.writes).toEqual([]);
    expect(labels()).toEqual([IMPLEMENT_LABEL]);
    expect(decided).toEqual({});
  });

  it("takes the label off and blocks even where the comment fails", async () => {
    github.issues.set(ISSUE, { subIssues: 0, parent: 3, blockedBy: [] });
    github.fails = (write) => write.type === "comment";

    await run();

    expect(comments()).toEqual([]);
    expect(labels()).toEqual([BLOCKED_LABEL]);
    expect(logged).toContain(`::warning::Could not post the refusal comment on #${ISSUE}.`);
    expect(decided).toEqual({ proceed: "false" });
  });
});

describe("implement:gate claims an issue it goes ahead on", () => {
  it("probes, clears a block, links the run, and hands on the branch, the base and an absent tip", async () => {
    github.issueLabels.set(ISSUE, [IMPLEMENT_LABEL, BLOCKED_LABEL]);

    await run();

    expect(writes()).toEqual([
      `workflow addLabel ${IMPLEMENT_LABEL}`,
      `workflow removeLabel ${BLOCKED_LABEL}`,
      `workflow comment **\`agent:implement\` started:** [Workflow run](${RUN_URL})`,
    ]);
    expect(labels()).toEqual([IMPLEMENT_LABEL]);
    expect(decided).toEqual({ proceed: "true", branch: BRANCH, base: BASE, tip: "" });
    expect(reads.map((r) => [r.method, ...r.args])).toEqual([
      ["issueShape", ISSUE],
      ["openBlockers", ISSUE],
      ["openPullRequestsClosing", expect.any(RegExp)],
      ["branchTip", "main"],
      ["branchTip", BRANCH],
    ]);
  });

  it("hands on the tip an earlier run left on the branch", async () => {
    github.branches.set(BRANCH, TIP);

    await run();

    expect(decided).toEqual({ proceed: "true", branch: BRANCH, base: BASE, tip: TIP });
  });

  it("asks for no more writes than it may make", async () => {
    await run();

    expect(asked).toEqual({ comment: 2, removeLabel: 2, addLabel: 2 });
  });

  /** A short token fails the run here, before the agent's job, with the decision already written. */
  it("fails at the probe after writing its decision, with a sentence naming the grant", async () => {
    github.fails = (write) => write.type === "addLabel";

    await expect(run()).rejects.toThrow(
      `Couldn't add \`${IMPLEMENT_LABEL}\` to #${ISSUE}, which it already carries, so this job's token cannot write labels here and nothing was started. Check that the caller grants \`issues: write\`.`,
    );

    expect(decided).toEqual({ proceed: "true" });
    expect(comments()).toEqual([]);
  });

  it("goes on where the start comment cannot be posted, saying so", async () => {
    github.fails = (write) => write.type === "comment";

    await run();

    expect(logged).toContain(`::warning::Could not post the start comment on #${ISSUE}. The run goes on; it is ${RUN_URL}.`);
    expect(decided).toEqual({ proceed: "true", branch: BRANCH, base: BASE, tip: "" });
  });

  it("fails, naming the base, where the base cannot be read", async () => {
    github.branches.delete("main");

    await expect(run()).rejects.toThrow("Couldn't read the commit `main` is at, so nothing was started.");

    expect(decided).toEqual({ proceed: "true", branch: BRANCH });
  });

  /** Absent is a fact the lease is taken on; unreadable is no fact at all. */
  it.each([
    ["a server error", new GitHubError("GET git/ref: 502 Bad Gateway", 502)],
    ["a refusal that is not a 404", new GitHubError("GET git/ref: 403 Forbidden", 403)],
    ["a network failure", new TypeError("fetch failed")],
  ])("fails where the branch's tip is unreadable, on %s", async (_, error) => {
    const unreadable: GitHubReader = {
      ...reader,
      branchTip: async (branch) => {
        if (branch === BRANCH) throw error;
        return reader.branchTip(branch);
      },
    };

    await expect(run(INPUTS(), unreadable)).rejects.toThrow(`Couldn't read whether \`${BRANCH}\` already exists, so nothing was started.`);

    expect(decided).toEqual({ proceed: "true", branch: BRANCH, base: BASE });
  });
});

/**
 * The branch name, byte for byte what *Compute branch name* wrote on the
 * runner (`C.UTF-8`), so a retry lands on the branch an older release named.
 * Each expected slug is that shell's output for the title, recorded:
 *
 *     echo "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' \
 *       | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-50
 */
describe("implement:gate names the branch as the shell step did", () => {
  it.each([
    ["Add a widget", "add-a-widget"],
    ["Fix: the  thing!!! (again)", "fix-the-thing-again"],
    ["--Leading and trailing junk!!--", "leading-and-trailing-junk"],
    ["UPPER_case & Numbers 123", "upper-case-numbers-123"],
    // Exactly 50, uncut.
    ["abcdefghij abcdefghij abcdefghij abcdefghij abcdef", "abcdefghij-abcdefghij-abcdefghij-abcdefghij-abcdef"],
    // Over 50, cut on a separator, which stays.
    ["abcdefghij abcdefghij abcdefghij abcdefghij abcde fgh", "abcdefghij-abcdefghij-abcdefghij-abcdefghij-abcde-"],
    ["The quick brown fox jumps over the lazy dog, then the cat", "the-quick-brown-fox-jumps-over-the-lazy-dog-then-t"],
    // Non-ASCII is a separator, `İ` and the Kelvin sign included, which `toLowerCase` would make ASCII.
    ["Café Über İstanbul Kelvin", "caf-ber-stanbul-elvin"],
    ["Ünïcödé — dash", "n-c-d-dash"],
    ["日本語のタイトル", ""],
    ["!!!", ""],
  ])("%j is %j", async (title, slug) => {
    await run(INPUTS({ ISSUE_TITLE: title }));

    expect(decided).toMatchObject({ branch: `agent/issue-${ISSUE}-${slug}` });
  });
});
