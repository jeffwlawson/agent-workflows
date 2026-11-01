import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BundleHead } from "../../engine/git.js";
import type { Limits } from "../../engine/writer.js";
import { publish } from "../../implement/publish.js";
import type { CheckoutIo, Token } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import { renderPullRequestFrame } from "../../shared/pr-frame.js";
import { IMPLEMENT_LABEL, REVIEW_LABEL } from "../../shared/record.js";
import { fakeGit, fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `implement:publish` (#492), called the way the CLI calls it: its declared
 * inputs, `implement:bundle`'s hand-over directory, a fake GitHub reader, a
 * fake git reader standing for the checkout, and the engine's writers over a
 * fake GitHub, sharing one log. What is asserted is what it did to the
 * record: the writes it attempted, in what order and with which token, what
 * each said, what it refused before its first write, and `published.json`.
 *
 * The scenarios are the retired shell steps' (implement's half of
 * `tests/publish-push-step.test.ts`, and the publish job's assertions in
 * `tests/workflows.test.ts` on *Push branch*, *Open draft PR*, *Link the PR
 * on the issue* and *Request review*), carried over by behaviour, with
 * #329's server error added.
 */

const ISSUE = 12;
const TITLE = "Do the thing";
const BRANCH = "agent/issue-12-do-the-thing";
/** The commit the gate read `main` at. */
const BASE = "b".repeat(40);
/** The agent's commit, the bundle's one tip. */
const TIP = "d".repeat(40);
/** What an earlier failed run left on the branch, as the gate read it. */
const LEFT = "e".repeat(40);
const RUN_URL = "https://github.com/o/r/actions/runs/99";
const RESCUE = `agent/rescue/issue-${ISSUE}`;
/** What an earlier stopped run saved on the rescue branch. */
const RESCUED = "c".repeat(40);

let root: string;
let bundleDir: string;
let github: FakeGitHub;
let files: Map<string, unknown>;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;
let git: ReturnType<typeof fakeGit>;
let log: ReturnType<typeof vi.spyOn>;

const bundlePath = (): string => path.join(bundleDir, "branch.bundle");

/** A git reader over a checkout holding `history`, where the bundle, once handed over, carries `heads`. */
const holding = (
  history: Readonly<Record<string, readonly string[]>> = { [TIP]: [BASE, TIP] },
  heads: readonly BundleHead[] = [{ ref: `refs/heads/${BRANCH}`, commit: TIP }],
) => fakeGit({ bundles: { [bundlePath()]: heads }, history });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "implement-publish-"));
  bundleDir = path.join(root, "bundle");
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(bundlePath(), "a bundle");
  github = fakeGitHub([]);
  github.issueLabels.set(ISSUE, [IMPLEMENT_LABEL]);
  files = new Map();
  made = undefined;
  asked = undefined;
  git = holding();
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

type Inputs = Parameters<typeof publish>[0];

const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: path.join(root, "out"),
  GH_REPO: "o/r",
  GH_TOKEN: "workflow-token",
  LOOP_TOKEN: "loop-token",
  LOOP_TOKEN_SOURCE: "app",
  ISSUE_NUMBER: String(ISSUE),
  ISSUE_TITLE: TITLE,
  BASE_REF: "main",
  BRANCH,
  BASE_SHA: BASE,
  BRANCH_TIP: "",
  RESCUE_BRANCH: RESCUE,
  RUN_URL,
  CHECKOUT: "/checkout",
  HEAD_WAIT_SECONDS: "0",
  HEAD_POLL_SECONDS: "0",
  BUNDLE_DIR: bundleDir,
  ...over,
});

/** The CLI's half: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  const io: CheckoutIo<(typeof COMMANDS)["implement:publish"]["outputs"]> = {
    writers: (limits) => {
      asked = limits;
      made = fakeWriters(github, ["loop", "workflow"] as const, limits);
      return made.writers;
    },
    github: fakeReader(github).reader,
    git: git.git,
    outputs: {
      writeJson: (name, value) => files.set(name, structuredClone(value)),
      writeText: (name, value) => files.set(name, value),
      writeBytes: () => {},
      appendLine: () => {},
    },
  };
  try {
    await publish(inputs, io);
    made?.log.end();
  } catch (error) {
    made?.log.end(error);
    throw error;
  }
};

const writes = () => (made?.writes ?? []).map((w) => `${w.token} ${w.type}`);
const logged = () => log.mock.calls.map((call) => String(call[0]));
const warnings = () => logged().filter((line) => line.startsWith("::warning::"));
/** The pull request this run opened, or the one a test put there. */
const opened = (number = 1) => github.pullRequests.get(number);

/** An open pull request already there, from `head` into `base`. */
const existing = (number: number, head: string, base: string, body = `Closes #${ISSUE}`): void => {
  github.pullRequests.set(number, {
    number,
    nodeId: `PR_${number}`,
    state: "open",
    draft: false,
    headSha: TIP,
    title: "theirs",
    body,
    labels: [],
    headRef: head,
    baseRef: base,
  });
};

describe("implement:publish on a bundle that checks out", () => {
  it("pushes, opens the draft PR, links it on the issue, then hands it to the review, in that order", async () => {
    await run();

    expect(writes()).toEqual([
      "loop pushRef",
      "loop openPullRequest",
      "workflow comment",
      "loop removeLabel",
      "loop removeLabel",
      "loop addLabel",
    ]);
    expect(github.branches.get(BRANCH)).toBe(TIP);
    expect(opened()).toMatchObject({
      draft: true,
      title: `Fix #${ISSUE}: ${TITLE}`,
      body: renderPullRequestFrame({ issue: ISSUE, runUrl: RUN_URL }),
      headRef: BRANCH,
      baseRef: "main",
      labels: [REVIEW_LABEL],
    });
    expect(github.comments).toEqual([{ token: "workflow", issue: ISSUE, body: `**\`${IMPLEMENT_LABEL}\` opened PR #1:** [Workflow run](${RUN_URL})` }]);
    expect(files.get("published.json")).toEqual({ pushed: true, head: TIP, pr: 1, requested: true });
    expect(warnings()).toEqual([]);
  });

  /** #236: this run's own label off before the next step's goes on, and that one removed before it is added, so its add fires. */
  it("takes agent:implement off the issue before agent:review goes on, and removes agent:review before adding it", async () => {
    await run();

    expect((made?.writes ?? []).slice(3).map((w) => [w.type, ...w.args])).toEqual([
      ["removeLabel", ISSUE, IMPLEMENT_LABEL],
      ["removeLabel", 1, REVIEW_LABEL],
      ["addLabel", 1, REVIEW_LABEL],
    ]);
    expect(github.issueLabels.get(ISSUE)).toEqual([]);
  });

  it("cuts the title at 256 characters, never inside one", async () => {
    const long = "é".repeat(300);

    await run(INPUTS({ ISSUE_TITLE: long }));

    const title = opened()?.title ?? "";
    expect(Array.from(title)).toHaveLength(256);
    expect(title).toBe(`Fix #${ISSUE}: ${long}`.slice(0, 256));
  });

  it("asks for nothing beyond its limits", async () => {
    await run();

    expect(asked).toEqual({ pushRef: 1, deleteRef: 1, openPullRequest: 1, addLabel: 1, comment: 1, removeLabel: 2 });
  });

  it("warns where the loop's token is the workflow's, since the label it adds then starts nothing", async () => {
    await run(INPUTS({ LOOP_TOKEN_SOURCE: "workflow" }));

    expect(warnings()).toEqual([
      "::warning::Neither the loop's App nor AGENT_PAT is set, so this label was added with GITHUB_TOKEN and will NOT trigger agent-review. Add agent:review by hand on PR #1.",
    ]);
  });

  it("goes on to the review where the link on the issue cannot be posted", async () => {
    github.fails = (write) => write.type === "comment";

    await run();

    expect(writes().at(-1)).toBe("loop addLabel");
    expect(warnings()[0]).toMatch(/^::warning::Could not comment PR #1 on #12\./);
  });

  it("stops, naming the review as what is missing, where agent:review cannot be added", async () => {
    github.fails = (write) => write.type === "addLabel";

    await expect(run()).rejects.toThrow("Couldn't add `agent:review` to PR #1, so no review was requested.");
    expect(files.get("published.json")).toEqual({ pushed: true, head: TIP, pr: 1, requested: false });
  });
});

/**
 * A run that pushed leaves no rescue branch behind (#270): what it resumed
 * from is in what it pushed. Deleted once the pull request is open, under a
 * lease on its tip as read, and never a reason to stop.
 */
describe("implement:publish deletes the rescue branch once it has opened the PR", () => {
  it("deletes the rescue after the PR opens, leased on its tip, and goes on to link it", async () => {
    github.branches.set(RESCUE, RESCUED);

    await run();

    expect(writes().slice(0, 4)).toEqual(["loop pushRef", "loop openPullRequest", "loop deleteRef", "workflow comment"]);
    expect(made?.writes[2]?.args).toEqual([{ ref: `refs/heads/${RESCUE}`, lease: { tip: RESCUED } }]);
    expect(github.branches.has(RESCUE)).toBe(false);
    expect(logged()).toContain(`Deleted ${RESCUE}: this run succeeded.`);
  });

  it("deletes nothing where there is no rescue branch", async () => {
    await run();

    expect(writes()).not.toContain("loop deleteRef");
    expect(logged()).toContain(`No ${RESCUE} to delete.`);
  });

  it("warns, and still opens the PR, where the rescue cannot be deleted", async () => {
    github.branches.set(RESCUE, RESCUED);
    github.fails = (write) => write.type === "deleteRef";

    await run();

    expect(github.branches.get(RESCUE)).toBe(RESCUED);
    expect(warnings()[0]).toMatch(/^::warning::Could not delete agent\/rescue\/issue-12\./);
    expect(files.get("published.json")).toEqual({ pushed: true, head: TIP, pr: 1, requested: true });
  });

  it("deletes nothing where the push was refused", async () => {
    github.branches.set(RESCUE, RESCUED);
    github.fails = (write) => write.type === "pushRef";

    await expect(run()).rejects.toThrow();
    expect(github.branches.get(RESCUE)).toBe(RESCUED);
    expect(writes()).toEqual(["loop pushRef"]);
  });

  /**
   * A failed open leaves `published.json` with no `pr`, so the retry cuts
   * `BRANCH` afresh at the base and its push replaces what this run pushed:
   * the rescue is then the one copy of those commits, and is kept.
   */
  it.each([
    ["GitHub refuses it", (write: { type: string }) => write.type === "openPullRequest"],
    [
      "a server error's read-back fails too",
      (write: { type: string }, call: string) =>
        write.type !== "openPullRequest" ? false : call === "POST pulls" ? { status: 502, landed: true } : { status: 503, landed: false },
    ],
  ] as const)("keeps the rescue where opening the PR fails because %s", async (_name, fails) => {
    github.branches.set(RESCUE, RESCUED);
    github.fails = fails;

    await expect(run()).rejects.toThrow();
    expect(github.branches.get(RESCUE)).toBe(RESCUED);
    expect(writes()).toEqual(["loop pushRef", "loop openPullRequest"]);
    expect(files.get("published.json")).toEqual({ pushed: true, head: TIP, requested: false });
  });
});

describe("implement:publish's push", () => {
  it("pushes to a branch that does not exist yet only while it still does not", async () => {
    await run();

    expect(made?.writes[0]?.args).toEqual([{ ref: `refs/heads/${BRANCH}`, commit: TIP, lease: { absent: true } }]);
  });

  /** A retry lands on the branch an earlier failed run named, and replaces what it left. */
  it("replaces the branch an earlier run left, leased on the tip the gate read", async () => {
    github.branches.set(BRANCH, LEFT);

    await run(INPUTS({ BRANCH_TIP: LEFT }));

    expect(made?.writes[0]?.args).toEqual([{ ref: `refs/heads/${BRANCH}`, commit: TIP, lease: { tip: LEFT } }]);
    expect(github.branches.get(BRANCH)).toBe(TIP);
  });

  it.each([
    ["moved since the gate read it", LEFT, "f".repeat(40)],
    ["was created since the gate found none", "", "f".repeat(40)],
  ])("refuses a branch that %s, and opens nothing", async (_name, gateTip, now) => {
    github.branches.set(BRANCH, now);

    await expect(run(INPUTS({ BRANCH_TIP: gateTip }))).rejects.toThrow(
      `\`${BRANCH}\` changed while this run worked, so the agent's commits were not pushed over what is there now.`,
    );
    expect(github.branches.get(BRANCH)).toBe(now);
    expect(writes()).toEqual(["loop pushRef"]);
    expect(files.get("published.json")).toEqual({ pushed: false, requested: false });
  });

  it("stops, naming git's reason, where the push fails otherwise", async () => {
    github.fails = (write) => write.type === "pushRef";

    await expect(run()).rejects.toThrow(/^Couldn't push the agent's commits to `agent\/issue-12-do-the-thing`, so nothing was pushed: /);
    expect(writes()).toEqual(["loop pushRef"]);
  });
});

describe("implement:publish's bundle check", () => {
  /** Each defect with today's sentence, before any write. */
  const refuses = async (says: string): Promise<void> => {
    await expect(run()).rejects.toThrow(says);
    expect(made).toBeUndefined();
    expect(github.branches.has(BRANCH)).toBe(false);
  };

  it("refuses where the agent's job handed nothing over", async () => {
    fs.rmSync(bundlePath());

    await refuses("The agent's job finished without handing over its commits, so nothing was pushed.");
  });

  it("refuses a bundle that does not verify", async () => {
    git = fakeGit({ bundles: {}, history: { [TIP]: [BASE, TIP] } });

    await refuses("The agent's commits arrived damaged or incomplete, so nothing was pushed.");
  });

  it.each<[string, readonly BundleHead[]]>([
    ["another branch", [{ ref: "refs/heads/other", commit: TIP }]],
    ["a second branch beside the one named", [{ ref: `refs/heads/${BRANCH}`, commit: TIP }, { ref: "refs/heads/other", commit: TIP }]],
    ["no branch at all", []],
  ])("refuses a bundle of %s", async (_name, heads) => {
    git = holding(undefined, heads);

    await refuses(`The agent's commits arrived on a branch other than \`${BRANCH}\`, or beside other branches, so nothing was pushed.`);
  });

  it("refuses a branch that does not build on the base the gate read", async () => {
    git = holding({ [TIP]: [TIP] });

    await refuses("The agent's commits don't build on `main` as this run found it, so nothing was pushed.");
  });

  it("checks the bundle against the gate's base commit, never the base branch's tip now", async () => {
    await run();

    expect(git.calls).toEqual([`verifyBundle ${bundlePath()}`, `isAncestor ${BASE} ${TIP}`]);
  });
});

/**
 * #329: GitHub has answered a `gh pr create` with an error and opened the
 * pull request all the same, so a server error is read back, by this head
 * and this base, before it is called a failure.
 */
describe("implement:publish on a server error opening the pull request", () => {
  const erroring = (landed: boolean, readBack: false | "fails" = false): void => {
    github.fails = (write, call) => {
      if (write.type !== "openPullRequest") return false;
      if (call === "POST pulls") return { status: 502, landed };
      return readBack === "fails" ? { status: 503, landed: false } : false;
    };
  };

  it("carries on with the PR GitHub opened from this head into this base: linked, reviewed, and a warning", async () => {
    erroring(true);

    await run();

    expect(writes()).toEqual([
      "loop pushRef",
      "loop openPullRequest",
      "workflow comment",
      "loop removeLabel",
      "loop removeLabel",
      "loop addLabel",
    ]);
    expect(opened()?.labels).toEqual([REVIEW_LABEL]);
    expect(github.comments.map((c) => c.body)).toEqual([`**\`${IMPLEMENT_LABEL}\` opened PR #1:** [Workflow run](${RUN_URL})`]);
    expect(warnings()).toEqual([
      expect.stringMatching(
        /^::warning::GitHub answered opening the pull request with a server error \(.*502.*\), but PR #1 from `agent\/issue-12-do-the-thing` into `main` is open, so this run goes on with it\.$/,
      ),
    ]);
    expect(files.get("published.json")).toEqual({ pushed: true, head: TIP, pr: 1, requested: true });
  });

  /**
   * The hard-to-see failure: matching on `Closes #N` would adopt an
   * adopter's own pull request and request a review on it.
   */
  it.each([
    ["from another head", () => existing(40, "their-branch", "main")],
    ["into another base", () => existing(40, BRANCH, "develop")],
    ["that only says Closes #N", () => existing(40, "feature/x", "main", `Fixes #${ISSUE}, and Closes #${ISSUE}`)],
  ])("fails, never taking an open PR %s as this run's", async (_name, arrange) => {
    arrange();
    erroring(false);

    await expect(run()).rejects.toThrow(
      /^Couldn't open a pull request from `agent\/issue-12-do-the-thing` into `main`, so the agent's commits are pushed but nothing asks for their review: /,
    );
    expect(writes()).toEqual(["loop pushRef", "loop openPullRequest"]);
    expect(github.pullRequests.get(40)?.labels).toEqual([]);
    expect(github.comments).toEqual([]);
    expect(files.get("published.json")).toEqual({ pushed: true, head: TIP, requested: false });
  });

  it("fails where the read-back fails too, saying to look for the PR before adding agent:implement again", async () => {
    erroring(true, "fails");

    await expect(run()).rejects.toThrow(
      /^GitHub answered opening the pull request from `agent\/issue-12-do-the-thing` with a server error, and whether it opened anyway could not be read back \(.*503.*\)\. Look for an open pull request from `agent\/issue-12-do-the-thing` before adding `agent:implement` again; if there is one, add `agent:review` to it instead\.$/,
    );
    expect(writes()).toEqual(["loop pushRef", "loop openPullRequest"]);
    expect(github.comments).toEqual([]);
  });

  it("fails a refusal without reading back", async () => {
    existing(40, BRANCH, "main");
    github.fails = (write, call) => write.type === "openPullRequest" && call === "POST pulls";

    await expect(run()).rejects.toThrow(/^Couldn't open a pull request/);
    expect(made?.entries[1]?.calls).toEqual(["POST pulls 422 refused by the fake"]);
  });
});
