import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { gitFetcher, gitReader, gitWrites, type GitEnvironment } from "../../engine/git.js";
import type { Limits } from "../../engine/writer.js";
import { conclude, MINT_FAILED } from "../../implement-prd/conclude.js";
import type { Token } from "../../shared/command-io.js";
import type { COMMANDS } from "../../shared/contract.js";
import type { InputValues } from "../../shared/env.js";
import { renderPrdStatus, renderProgressList, statusBlock } from "../../shared/progress-list.js";
import { BLOCKED_LABEL, CATCH_UP_TRAILER, catchUpMessage, IMPLEMENT_LABEL, SLICE_TRAILER } from "../../shared/record.js";
import { ignoredNote } from "../../shared/rescue.js";
import { sliceRanges } from "../../shared/slice-ranges.js";
import { SUBPROCESS_TIMEOUT } from "../../vitest.config.js";
import { fakeGitHub, fakeReader, fakeWriters, type FakeGitHub } from "../engine/fakes.js";

/**
 * `implement-prd:conclude` (#505), called the way the CLI calls it: its
 * declared inputs, the six directories it reads (the gate's, the
 * catch-up's, `implement-prd:prepare`'s, the runner's, `implement-prd:bundle`'s
 * and `implement-prd:publish`'s), the engine's real git reader and fetcher
 * working in a clone of a temporary bare repository standing in for the one
 * on GitHub, as the publish job's checkout leaves it, and the engine's
 * writers, whose loop push is the real `gitWrites` against that repository
 * and whose other writes land on a fake GitHub. What is asserted is what it
 * did to the record: the writes it attempted, in what order and with which
 * token, the failure comment byte for byte, the rescue branch, and the PRD
 * PR's progress list.
 *
 * The scenarios are the retired steps' (implement-prd's halves of
 * `tests/failure-step.test.ts`, `tests/rescue-step.test.ts`,
 * `tests/trigger-label-step.test.ts` and `tests/pr-body-steps.test.ts`'s
 * stopped-slice cases), carried over by behaviour, and the ones the move
 * adds: the stopped row read off the branch after a pushed catch-up merge
 * (#325), the label off where publish's removal failed (#494), and a bad
 * file in one directory costing nothing in another.
 */

type Inputs = InputValues<(typeof COMMANDS)["implement-prd:conclude"]["inputs"]>;

const PARENT = 222;
const PRD_BRANCH = "agent/prd-222-slices";
const RESCUE = `agent/rescue/prd-${PARENT}`;
const SUB = 242;
const PRD_PR = 300;
const SUB_ISSUES = [
  { number: 240, title: "landed before the upgrade", state: "CLOSED" },
  { number: 241, title: "an earlier slice", state: "OPEN" },
  { number: SUB, title: "this run's", state: "OPEN" },
  { number: 243, title: "next", state: "OPEN" },
] as const;
const RUN_URL = "https://github.com/acme/widgets/actions/runs/7";
const SERVER = "https://github.com";
const REPO = "acme/widgets";
const TOKEN = "ghs_workflow-token-0123456789";
const LOOP_TOKEN = "ghs_loop-token-0123456789";
/** Building the repositories spawns git a dozen times, and a case a dozen more. */
const CEILING = 40 * SUBPROCESS_TIMEOUT;

const DIRS = ["gate", "catch-up", "prepare", "runner", "bundle", "publish"] as const;
type Dir = (typeof DIRS)[number];

let scratch: string;
let origin: string;
let seed: string;
let agent: string;
let work: string;
let env: GitEnvironment;
/** `main` as the chain started. */
let base: string;
/** The PRD branch's tip as the gate read it: an earlier slice, #241. */
let tip: string;
let github: FakeGitHub;
let made: ReturnType<typeof fakeWriters<Token>> | undefined;
let asked: Limits | undefined;
let logged: string[];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SUBPROCESS_TIMEOUT,
    env: { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  }).trim();

/** One commit in `dir` with `message`, touching a file of its own, returning its sha. */
const commit = (dir: string, message: string): string => {
  const name = `${git(dir, "rev-list", "--count", "--all")}-${path.basename(dir)}.txt`;
  fs.writeFileSync(path.join(dir, name), `${message}\n`);
  git(dir, "add", name);
  git(dir, "commit", "--quiet", "-m", message);
  return git(dir, "rev-parse", "HEAD");
};

const dirOf = (name: Dir): string => path.join(scratch, name);

const put = (dir: Dir, name: string, value: unknown): void =>
  fs.writeFileSync(path.join(dirOf(dir), name), typeof value === "string" ? value : JSON.stringify(value));

/** The agent's commits, bundled ahead of `prerequisite` into the bundle's directory, as `implement-prd:bundle` writes them. */
const bundle = (prerequisite = tip): void => {
  git(agent, "bundle", "create", "--quiet", path.join(dirOf("bundle"), "branch.bundle"), `refs/heads/${PRD_BRANCH}`, `^${prerequisite}`);
};

const remoteTip = (branch: string): string | undefined => {
  try {
    return git(origin, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  } catch {
    return undefined;
  }
};

/** The PRD PR's body as the gate left it: the note, and the list showing #242 building. */
const BUILDING = [
  `> [!NOTE]\n> ${statusBlock(`**🔨 Building slice 3 of 4** · #${SUB}`)}`,
  "## Summary\n\nx",
  [
    "<!-- agent:progress -->",
    "## Progress",
    "",
    "| Slice | Status | Reviews | Fixes | Diff |",
    "|---|---|---|---|---|",
    "| 1 · #240 | ☑️ Landed before upgrade | – | – | – |",
    "| 2 · #241 | ✅ Approved | 0 | 0 | – |",
    `| 3 · #${SUB} | 🔨 Building | – | – | – |`,
    "| 4 · #243 | ⏳ Not started | – | – | – |",
    "<!-- /agent:progress -->",
  ].join("\n"),
].join("\n\n");

/** A remote whose PRD branch holds slice #241, an agent's clone on it, the gate's snapshot, and the PRD PR showing #242 building. */
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "implement-prd-conclude-"));
  env = { PATH: process.env["PATH"] ?? "", HOME: scratch };
  for (const dir of DIRS) fs.mkdirSync(dirOf(dir));
  origin = path.join(scratch, "origin.git");
  seed = path.join(scratch, "seed");
  agent = path.join(scratch, "agent");
  work = path.join(scratch, "work");
  put("gate", "prd-issue.json", { parent: null, labels: { nodes: [{ name: IMPLEMENT_LABEL }] }, subIssues: { totalCount: SUB_ISSUES.length, nodes: SUB_ISSUES } });
  git(scratch, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(scratch, "init", "--quiet", "--initial-branch=main", seed);
  base = commit(seed, "chore: the default branch");
  git(seed, "push", "--quiet", origin, "main");
  git(seed, "checkout", "--quiet", "-b", PRD_BRANCH);
  tip = commit(seed, `feat: an earlier slice\n\n${SLICE_TRAILER}: #241`);
  git(seed, "push", "--quiet", origin, PRD_BRANCH);
  git(scratch, "clone", "--quiet", origin, agent);
  git(agent, "checkout", "--quiet", "-B", PRD_BRANCH, tip);
  github = fakeGitHub([
    { number: PRD_PR, draft: true, headSha: tip, body: BUILDING, labels: [], headRef: PRD_BRANCH, baseRef: "main" },
  ]);
  github.branches.set(PRD_BRANCH, tip);
  github.issueLabels.set(PARENT, [IMPLEMENT_LABEL]);
  made = undefined;
  asked = undefined;
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
}, CEILING);

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A build run that finished, publish included. */
const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
  OUTPUT_DIR: "/out",
  GH_REPO: REPO,
  GH_TOKEN: TOKEN,
  LOOP_TOKEN,
  LOOP_TOKEN_SOURCE: "app",
  AGENT_LOOP_LOGINS: "",
  GITHUB_SERVER_URL: SERVER,
  GITHUB_REPOSITORY: REPO,
  ISSUE_NUMBER: String(PARENT),
  BASE_REF: "main",
  RUN_URL,
  RESCUE_BRANCH: RESCUE,
  CHECKOUT: work,
  REFUSED: "false",
  BUILD: "true",
  FINISHING: "false",
  PRD_BRANCH,
  PRD_PR: String(PRD_PR),
  SUB: String(SUB),
  BASE_SHA: tip,
  MERGED: "",
  GATE_RESULT: "success",
  GATE_REASON: "",
  CATCH_UP_RESULT: "success",
  AGENT_RESULT: "success",
  TIMED_OUT: "false",
  TIMEOUT_MINUTES: "30",
  MINT_OUTCOME: "success",
  DOWNLOAD_OUTCOME: "success",
  PUBLISH_OUTCOME: "success",
  GATE_DIR: dirOf("gate"),
  CATCH_UP_DIR: dirOf("catch-up"),
  PREPARE_DIR: dirOf("prepare"),
  IMPLEMENT_PRD_DIR: dirOf("runner"),
  BUNDLE_DIR: dirOf("bundle"),
  PUBLISH_DIR: dirOf("publish"),
  ...over,
});

/** An agent's job that stopped on its own terms: publish never ran. */
const AGENT_FAILED = (over: Partial<Inputs> = {}): Inputs => INPUTS({ AGENT_RESULT: "failure", PUBLISH_OUTCOME: "skipped", ...over });

/** The finishing run, which built nothing, stopped in publish. */
const FINISHING_FAILED = (over: Partial<Inputs> = {}): Inputs =>
  INPUTS({ BUILD: "false", FINISHING: "true", SUB: "", BASE_SHA: "", CATCH_UP_RESULT: "skipped", AGENT_RESULT: "skipped", DOWNLOAD_OUTCOME: "skipped", PUBLISH_OUTCOME: "failure", ...over });

/** A gate that died before it decided: no `proceed`, so `REFUSED` empty, and nothing after it ran. */
const UNDECIDED = (over: Partial<Inputs> = {}): Inputs =>
  INPUTS({
    REFUSED: "",
    BUILD: "",
    FINISHING: "",
    PRD_BRANCH: "",
    PRD_PR: "",
    SUB: "",
    BASE_SHA: "",
    GATE_RESULT: "failure",
    CATCH_UP_RESULT: "skipped",
    AGENT_RESULT: "skipped",
    DOWNLOAD_OUTCOME: "skipped",
    PUBLISH_OUTCOME: "skipped",
    ...over,
  });

/** The CLI's half, in the publish job's fresh clone of the base: the io, the call, and the log's last line however it ended. */
const run = async (inputs: Inputs = INPUTS()): Promise<void> => {
  git(scratch, "clone", "--quiet", origin, work);
  const real = gitWrites({ dir: work, env, remote: origin }, LOOP_TOKEN);
  try {
    await conclude(inputs, {
      writers: (limits) => {
        asked = limits;
        made = fakeWriters(github, ["loop", "workflow"] as const, limits, {
          loop: {
            pushRef: async (call, push) => {
              const done = await real.pushRef(call, push);
              github.branches.set(push.ref.replace(/^refs\/heads\//, ""), push.commit);
              return done;
            },
          },
        });
        return made.writers;
      },
      github: fakeReader(github).reader,
      git: gitReader({ dir: work, env }),
      fetcher: gitFetcher({ dir: work, env, remote: origin }, TOKEN),
      outputs: { writeJson: () => {}, writeText: () => {}, writeBytes: () => {}, appendLine: () => {} },
    });
    made?.log.end();
  } catch (error) {
    made?.log.end(error);
    throw error;
  }
};

/** Each write, as `<token> <type>`, with the label it moves. */
const writes = (): string[] =>
  (made?.writes ?? []).map((w) => `${w.token} ${w.type}${w.type === "removeLabel" || w.type === "addLabel" ? ` ${String(w.args[1])}` : ""}`);
const comments = (): string[] => github.comments.map((c) => c.body);
const comment = (): string => comments().at(-1) ?? "";
const labels = (): string[] => github.issueLabels.get(PARENT) ?? [];
const body = (): string => github.pullRequests.get(PRD_PR)?.body ?? "";
const warnings = (): string[] => logged.filter((line) => line.startsWith("::warning::"));

/** The comment, as every stopped run writes it (#253). */
const stopped = (reason: string, retry: string): string => `**\`agent:implement\` stopped:** ${reason}\n\n[Workflow run](${RUN_URL}) · ${retry}\n`;

/** What every decided run that stopped writes, in the loop's one order. */
const STOPPED_WRITES = ["workflow comment", `workflow removeLabel ${IMPLEMENT_LABEL}`, `workflow addLabel ${BLOCKED_LABEL}`];

describe("implement-prd:conclude ends a run that finished", () => {
  it("takes agent:implement off, and says nothing else: the rest is publish's", async () => {
    put("publish", "published.json", { pushed: true, head: "a".repeat(40), pr: PRD_PR, requested: true, handedOver: false });

    await run();

    expect(writes()).toEqual([`workflow removeLabel ${IMPLEMENT_LABEL}`]);
    expect(labels()).toEqual([]);
    expect(comments()).toEqual([]);
    expect(body()).toBe(BUILDING);
  }, CEILING);

  /** #494's review finding: publish's removal is tolerated, so where it failed the label is still on, and comes off here. */
  it("takes agent:implement off where publish's removal failed, and where it did not", async () => {
    await run();
    expect(labels()).toEqual([]);

    github.issueLabels.set(PARENT, []);
    fs.rmSync(work, { recursive: true, force: true });
    await run();
    expect(writes()).toEqual([`workflow removeLabel ${IMPLEMENT_LABEL}`]);
  }, CEILING);

  it("takes it off a finishing run that handed over, and an open-only run, alike", async () => {
    await run(INPUTS({ BUILD: "false", FINISHING: "true", SUB: "", CATCH_UP_RESULT: "skipped", AGENT_RESULT: "skipped", DOWNLOAD_OUTCOME: "skipped" }));
    expect(writes()).toEqual([`workflow removeLabel ${IMPLEMENT_LABEL}`]);

    fs.rmSync(work, { recursive: true, force: true });
    await run(INPUTS({ BUILD: "false", SUB: "", CATCH_UP_RESULT: "skipped", AGENT_RESULT: "skipped", DOWNLOAD_OUTCOME: "skipped" }));
    expect(writes()).toEqual([`workflow removeLabel ${IMPLEMENT_LABEL}`]);
  }, CEILING);

  it("writes nothing on a run the gate refused or deferred", async () => {
    await run(INPUTS({ REFUSED: "true", CATCH_UP_RESULT: "skipped", AGENT_RESULT: "skipped" }));

    expect(asked).toBeUndefined();
    expect(labels()).toEqual([IMPLEMENT_LABEL]);
  }, CEILING);

  it("asks for exactly the writes it may make", async () => {
    await run();

    expect(asked).toEqual({ comment: 2, removeLabel: 1, addLabel: 1, pushRef: 1, editPullRequest: 1 });
  }, CEILING);
});

describe("implement-prd:conclude ends a chain the catch-up parked", () => {
  it("says nothing the catch-up said, takes the label off, and writes the slice back as not started", async () => {
    await run(INPUTS({ AGENT_RESULT: "skipped", DOWNLOAD_OUTCOME: "skipped", PUBLISH_OUTCOME: "skipped" }));

    expect(writes()).toEqual([`workflow removeLabel ${IMPLEMENT_LABEL}`, "loop editPullRequest"]);
    expect(comments()).toEqual([]);
    expect(labels()).toEqual([]);
    expect(body()).toContain(`| 3 · #${SUB} | ⏳ Not started |`);
    expect(body()).not.toContain("🔨");
  }, CEILING);
});

/**
 * Every retry form and suffix, byte for byte as the shell step wrote them,
 * with the writes in its order: the comment, the label off where the gate
 * decided, `agent:blocked`.
 */
describe("implement-prd:conclude says how a stopped run goes on", () => {
  const building = ` It was building sub-issue #${SUB}.`;

  it("add agent:implement, after a run that stopped with nothing to show for it", async () => {
    put("runner", "failure_reason.txt", "The runner wrote this.\n");

    await run(AGENT_FAILED());

    expect(comment()).toBe(stopped(`The runner wrote this.${building}`, "To try again, add `agent:implement`."));
    expect(writes().slice(0, 3)).toEqual(STOPPED_WRITES);
    expect(labels()).toEqual([BLOCKED_LABEL]);
  }, CEILING);

  it("resume the hand-over, after a finishing run", async () => {
    put("publish", "failure_reason.txt", "Couldn't mark PRD PR #300 ready for review.");

    await run(FINISHING_FAILED());

    expect(comment()).toBe(
      stopped(
        "Couldn't mark PRD PR #300 ready for review. It was handing the PRD PR over, with every sub-issue built.",
        "To try again, add `agent:implement`; it resumes the handover and builds nothing.",
      ),
    );
    expect(writes()).toEqual(STOPPED_WRITES);
  }, CEILING);

  it("remove then add, after a gate that died before deciding, and leaves the label on", async () => {
    await run(UNDECIDED({ GATE_REASON: "Couldn't read the PRD's sub-issues." }));

    expect(comment()).toBe(
      stopped("Couldn't read the PRD's sub-issues.", "To try again, remove `agent:implement` if it is still on this issue, then add it."),
    );
    expect(writes()).toEqual(["workflow comment", `workflow addLabel ${BLOCKED_LABEL}`]);
    expect(labels()).toEqual([IMPLEMENT_LABEL, BLOCKED_LABEL]);
  }, CEILING);

  it("remove then add, after a gate that died before deciding with no reason, in either shape it leaves", async () => {
    await run(UNDECIDED());

    expect(comment()).toBe(
      stopped(
        "It stopped without giving a reason. The workflow run's log has the details.",
        "To try again, remove `agent:implement` if it is still on this issue, then add it.",
      ),
    );
  }, CEILING);

  it("add agent:review to the PRD PR, after a pushed catch-up merge", async () => {
    await run(AGENT_FAILED({ MERGED: "0123456789abcdef0123456789abcdef01234567" }));

    expect(comment()).toBe(
      stopped(
        `It stopped without giving a reason. The workflow run's log has the details.${building}`,
        "The default branch `main` was merged into the PRD branch before it stopped, and that merge has no review yet, so adding `agent:implement` would be refused. Add `agent:review` to PRD PR #300; the chain moves on once it recommends approval.",
      ),
    );
  }, CEILING);

  it("built and pushed, whatever was merged before it, naming the PRD PR publish found", async () => {
    put("publish", "published.json", { pushed: true, head: "a".repeat(40), pr: 301, requested: false, handedOver: false });
    put("publish", "failure_reason.txt", "Couldn't add `agent:review` to PRD PR #301, so no review was requested.");

    await run(INPUTS({ PUBLISH_OUTCOME: "failure", MERGED: "0123456789abcdef0123456789abcdef01234567" }));

    expect(comment()).toBe(
      stopped(
        `Couldn't add \`agent:review\` to PRD PR #301, so no review was requested.${building}`,
        `Sub-issue #${SUB} was built and pushed to the PRD branch before it stopped, so it won't be built again. Add \`agent:review\` to PRD PR #301 if it doesn't have it.`,
      ),
    );
  }, CEILING);

  it("built and pushed, with no PRD PR yet", async () => {
    put("publish", "published.json", { pushed: true, head: "a".repeat(40), requested: false, handedOver: false });

    await run(INPUTS({ PRD_PR: "", PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toBe(
      stopped(
        `It stopped without giving a reason. The workflow run's log has the details.${building}`,
        `Sub-issue #${SUB} was built and pushed to the PRD branch before it stopped, so it won't be built again. To open the PRD PR and ask for its review, add \`agent:implement\`.`,
      ),
    );
  }, CEILING);

  it("saved on the rescue branch, where nothing else was the way on", async () => {
    commit(agent, "feat: half of it");
    bundle();

    await run(AGENT_FAILED({ AGENT_RESULT: "cancelled", TIMED_OUT: "true" }));

    expect(comment()).toBe(
      stopped(
        `It timed out after 30 minutes. The repository variable \`AGENT_TIMEOUT_MINUTES\` raises the limit.${building}`,
        "Its commits so far are saved on `agent/rescue/prd-222`. To resume from them, add `agent:implement`.",
      ),
    );
    expect(writes().slice(0, 4)).toEqual(["loop pushRef", ...STOPPED_WRITES]);
  }, CEILING);

  it("saved on the rescue branch, beside a retry that names something else", async () => {
    commit(agent, "feat: half of it");
    bundle();

    await run(AGENT_FAILED({ MERGED: "0123456789abcdef0123456789abcdef01234567" }));

    expect(comment()).toContain(
      "Add `agent:review` to PRD PR #300; the chain moves on once it recommends approval. Its commits so far are saved on `agent/rescue/prd-222`, and the next `agent:implement` run resumes from them.\n",
    );
  }, CEILING);

  it("names no sub-issue on a run that only opened a missing PRD PR", async () => {
    put("publish", "failure_reason.txt", "Couldn't open the PRD PR.");

    await run(INPUTS({ BUILD: "false", SUB: "", PRD_PR: "", CATCH_UP_RESULT: "skipped", AGENT_RESULT: "skipped", PUBLISH_OUTCOME: "failure" }));

    expect(comment()).toBe(stopped("Couldn't open the PRD PR.", "To try again, add `agent:implement`."));
  }, CEILING);
});

describe("implement-prd:conclude says why a run stopped", () => {
  const reason = (): string => /stopped:\*\* (.*?)( It was building|\n)/.exec(comment())?.[1] ?? "";

  it("says a run cancelled at its limit timed out, and one cancelled early was cancelled", async () => {
    put("runner", "failure_reason.txt", "The runner wrote this.");
    await run(AGENT_FAILED({ AGENT_RESULT: "cancelled", TIMED_OUT: "true" }));
    expect(reason()).toBe("It timed out after 30 minutes. The repository variable `AGENT_TIMEOUT_MINUTES` raises the limit.");

    fs.rmSync(work, { recursive: true, force: true });
    await run(AGENT_FAILED({ AGENT_RESULT: "cancelled" }));
    expect(reason()).toBe("It was cancelled before it finished, by hand or by GitHub.");
  }, CEILING);

  it("says a run that failed at its limit with no reason timed out, and still reads a reason it gave", async () => {
    await run(AGENT_FAILED({ TIMED_OUT: "true" }));
    expect(reason()).toBe("It timed out after 30 minutes. The repository variable `AGENT_TIMEOUT_MINUTES` raises the limit.");

    put("runner", "failure_reason.txt", "The runner wrote this.");
    fs.rmSync(work, { recursive: true, force: true });
    await run(AGENT_FAILED({ TIMED_OUT: "true" }));
    expect(reason()).toBe("The runner wrote this.");
  }, CEILING);

  it("says a run cancelled in its gate, its catch-up or its publish was cancelled", async () => {
    for (const over of [
      { GATE_RESULT: "cancelled", CATCH_UP_RESULT: "skipped", AGENT_RESULT: "skipped" },
      { CATCH_UP_RESULT: "cancelled", AGENT_RESULT: "skipped" },
      { PUBLISH_OUTCOME: "cancelled" },
    ] as const) {
      fs.rmSync(work, { recursive: true, force: true });
      await run(INPUTS(over));
      expect(reason(), JSON.stringify(over)).toBe("It was cancelled before it finished, by hand or by GitHub.");
    }
  }, CEILING);

  it("reads each producer's reason from its own directory", async () => {
    const cases = [
      ["catch-up", "Couldn't push the merge.", { CATCH_UP_RESULT: "failure", AGENT_RESULT: "skipped" }],
      ["prepare", "Couldn't check the rescue.", { AGENT_RESULT: "failure" }],
      ["bundle", "Couldn't bundle.", { AGENT_RESULT: "failure" }],
      ["publish", "Couldn't push.", { PUBLISH_OUTCOME: "failure" }],
    ] as const;
    for (const [dir, text, over] of cases) {
      for (const d of DIRS) if (d !== "gate") fs.rmSync(path.join(dirOf(d), "failure_reason.txt"), { force: true });
      put(dir, "failure_reason.txt", `${text}\n`);
      fs.rmSync(work, { recursive: true, force: true });
      await run(INPUTS(over));
      expect(reason(), dir).toBe(text);
    }
  }, CEILING);

  it("gives the gate's reason, handed on as an output, for a gate that failed after it decided", async () => {
    await run(INPUTS({ GATE_RESULT: "failure", GATE_REASON: "Couldn't remove `agent:blocked`.", CATCH_UP_RESULT: "skipped", AGENT_RESULT: "skipped" }));

    expect(reason()).toBe("Couldn't remove `agent:blocked`.");
    expect(writes().slice(0, 3)).toEqual(STOPPED_WRITES);
  }, CEILING);

  it("gives the runner's reason before implement-prd:bundle's", async () => {
    put("runner", "failure_reason.txt", "The runner wrote this.");
    put("bundle", "failure_reason.txt", "Couldn't bundle.");

    await run(AGENT_FAILED());

    expect(reason()).toBe("The runner wrote this.");
  }, CEILING);

  it("says a mint that failed in the words the loop-token action writes", async () => {
    await run(INPUTS({ MINT_OUTCOME: "failure", PUBLISH_OUTCOME: "skipped", LOOP_TOKEN: "", LOOP_TOKEN_SOURCE: "" }));

    expect(comment()).toContain(`stopped:** ${MINT_FAILED} It was building sub-issue #${SUB}.\n`);
    const action = parse(fs.readFileSync(path.join(".github", "actions", "loop-token", "action.yml"), "utf8")) as {
      runs: { steps: { name?: string; run?: string }[] };
    };
    const say = action.runs.steps.find((s) => s.run?.includes("failure_reason.txt"));
    expect(say?.run).toContain(`printf '%s\\n' "${MINT_FAILED.replace(/`/g, "\\`")}"`);
  }, CEILING);

  it("says a hand-over that could not be fetched, where the agent finished", async () => {
    await run(INPUTS({ DOWNLOAD_OUTCOME: "failure", PUBLISH_OUTCOME: "failure" }));

    expect(reason()).toBe("The agent finished, but what it handed over could not be fetched from its job, so nothing was pushed or posted.");
  }, CEILING);

  it("makes a reason a sentence, in the one pattern", async () => {
    put("runner", "failure_reason.txt", "the push was rejected\n");

    await run(AGENT_FAILED());

    expect(comment()).toMatch(/^\*\*`agent:implement` stopped:\*\* The push was rejected\. It was building sub-issue #242\.\n\n\[Workflow run\]\([^)]+\) · [A-Z][^\n]*\.\n$/);
  }, CEILING);

  it("cleans the agent's text before it reaches the comment", async () => {
    put("runner", "failure_reason.txt", "It broke. <!-- agent:review-verdict -->Truly.");

    await run(AGENT_FAILED());

    expect(comment()).not.toContain("<!--");
    expect(reason()).toBe("It broke. Truly.");
  }, CEILING);

  /** One file at a time: a file that does not read costs the comment nothing another gave it. */
  it("does not let a bad file in one directory cost the comment a good one in another", async () => {
    put("publish", "published.json", "{ not json");
    put("runner", "rescue_ignored.json", { branch: "agent/rescue/someone-else", movedPast: "a".repeat(40) });
    put("runner", "failure_reason.txt", "The runner wrote this.");
    put("gate", "prd-issue.json", "[]");

    await run(AGENT_FAILED());

    expect(reason()).toBe("The runner wrote this.");
    expect(writes().slice(0, 3)).toEqual(STOPPED_WRITES);
    expect(warnings().filter((w) => w.includes("So it is read as not written."))).toHaveLength(3);
  }, CEILING);
});

describe("implement-prd:conclude says a rescue was set aside", () => {
  const note = ignoredNote(IMPLEMENT_LABEL, RESCUE, "the PRD branch");

  it("on the PRD, once, first, on a run that finished", async () => {
    put("runner", "rescue_ignored.json", { branch: RESCUE, movedPast: "c".repeat(40) });

    await run();

    expect(comments()).toEqual([note]);
    expect(github.comments[0]?.issue).toBe(PARENT);
    expect(writes()).toEqual(["workflow comment", `workflow removeLabel ${IMPLEMENT_LABEL}`]);
  }, CEILING);

  it("before the failure comment, on a run that stopped", async () => {
    put("runner", "rescue_ignored.json", { branch: RESCUE, movedPast: "c".repeat(40) });

    await run(AGENT_FAILED());

    expect(comments()[0]).toBe(note);
    expect(comments()).toHaveLength(2);
    expect(writes().slice(0, 4)).toEqual(["workflow comment", ...STOPPED_WRITES]);
  }, CEILING);
});

describe("implement-prd:conclude rescues a stopped run's commits to a side branch", () => {
  it("pushes the agent's commits to the rescue branch, and leaves the PRD branch alone", async () => {
    commit(agent, "feat: one");
    const made_ = commit(agent, "feat: two");
    bundle();

    await run(AGENT_FAILED());

    expect(remoteTip(RESCUE)).toBe(made_);
    expect(remoteTip(PRD_BRANCH)).toBe(tip);
    expect(logged).toContain(`Rescued the agent's commits, up to ${made_}, to ${RESCUE}.`);
  }, CEILING);

  /** A run that resumed from a rescue and stopped again holds everything the rescue held, so its own replaces it. */
  it("overwrites an earlier rescue, leased on its tip as read", async () => {
    const earlier = commit(agent, "feat: one");
    git(agent, "push", "--quiet", origin, `HEAD:refs/heads/${RESCUE}`);
    github.branches.set(RESCUE, earlier);
    const later = commit(agent, "feat: two");
    bundle();

    await run(AGENT_FAILED());

    expect(remoteTip(RESCUE)).toBe(later);
    expect(made?.writes.find((w) => w.type === "pushRef")?.args[0]).toMatchObject({ lease: { tip: earlier } });
  }, CEILING);

  it("pushes nothing where the run made no commits, or pushed its slice", async () => {
    await run(AGENT_FAILED());
    expect(remoteTip(RESCUE)).toBeUndefined();
    expect(logged).toContain("No commits ahead of the tip this run started from, so there is nothing to rescue.");

    commit(agent, "feat: one");
    bundle();
    put("publish", "published.json", { pushed: true, head: "a".repeat(40), pr: PRD_PR, requested: false, handedOver: false });
    fs.rmSync(work, { recursive: true, force: true });
    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));
    expect(remoteTip(RESCUE)).toBeUndefined();
  }, CEILING);

  it("rescues nothing that does not build on the tip the run started from, and says so", async () => {
    git(agent, "checkout", "--quiet", "--orphan", "unrelated");
    commit(agent, "unrelated");
    git(agent, "branch", "--quiet", "-D", PRD_BRANCH);
    git(agent, "branch", "--quiet", "-m", PRD_BRANCH);
    git(agent, "bundle", "create", "--quiet", path.join(dirOf("bundle"), "branch.bundle"), `refs/heads/${PRD_BRANCH}`);

    await run(AGENT_FAILED());

    expect(remoteTip(RESCUE)).toBeUndefined();
    expect(warnings().some((w) => w.includes("so nothing was rescued."))).toBe(true);
    expect(comment()).not.toContain("agent/rescue/");
  }, CEILING);

  it("rescues nothing where the loop's token was not minted", async () => {
    commit(agent, "feat: one");
    bundle();

    await run(AGENT_FAILED({ MINT_OUTCOME: "failure", LOOP_TOKEN: "", LOOP_TOKEN_SOURCE: "" }));

    expect(remoteTip(RESCUE)).toBeUndefined();
    expect(writes().filter((w) => w.startsWith("loop"))).toEqual([]);
  }, CEILING);
});

/**
 * The stopped slice's row (#246, #325), read off the PRD branch's trailers as
 * the run left it, rather than a copy of the list the gate replaced.
 */
describe("implement-prd:conclude writes the stopped slice back into the progress list", () => {
  const prUrl = `${SERVER}/${REPO}/pull/${PRD_PR}`;

  it("shows the slice not started, and the one before it approved, where nothing was pushed", async () => {
    await run(AGENT_FAILED());

    expect(writes()).toEqual([...STOPPED_WRITES, "loop editPullRequest"]);
    expect(body()).toContain(`| 2 · #241 | ✅ Approved |`);
    expect(body()).toContain(`| 3 · #${SUB} | ⏳ Not started |`);
    expect(body()).toContain(statusBlock("**✅ Slice 2 of 4 approved** · #241"));
    expect(body()).toContain("## Summary\n\nx");
    expect(logged).toContain(`Wrote PRD PR #${PRD_PR}'s progress list: the slice stopped.`);
  }, CEILING);

  /** #325: the head is the merge, which no review has seen, so the slice under review is parked, as the comment says. */
  it("shows the slice parked after a pushed catch-up merge and an agent's job that died before the runner", async () => {
    git(seed, "checkout", "--quiet", "main");
    commit(seed, "ci: main moved");
    git(seed, "push", "--quiet", origin, "main");
    git(seed, "checkout", "--quiet", PRD_BRANCH);
    git(seed, "merge", "--quiet", "--no-ff", "-m", catchUpMessage("main", PRD_BRANCH, SUB), "main");
    const merge = git(seed, "rev-parse", "HEAD");
    git(seed, "push", "--quiet", origin, PRD_BRANCH);
    put("prepare", "failure_reason.txt", "Couldn't check whether an earlier run left commits.");

    await run(AGENT_FAILED({ MERGED: merge, BASE_SHA: merge }));

    expect(git(origin, "log", "-1", `--format=%(trailers:key=${CATCH_UP_TRAILER},valueonly)`, merge)).toBe(`#${SUB}`);
    expect(body()).toContain(`| 2 · #241 | ⏸️ Parked |`);
    expect(body()).toContain(`| 3 · #${SUB} | ⏳ Not started |`);
    expect(body()).toContain(statusBlock("**⏸️ Slice 2 of 4 parked** · #241."));
    expect(comment()).toContain("Add `agent:review` to PRD PR #300; the chain moves on once it recommends approval.");
  }, CEILING);

  it("shows the slice parked after its push, as rendered from the branch it pushed", async () => {
    git(agent, "checkout", "--quiet", PRD_BRANCH);
    const pushed = commit(agent, `feat: this slice\n\n${SLICE_TRAILER}: #${SUB}`);
    git(agent, "push", "--quiet", origin, `HEAD:refs/heads/${PRD_BRANCH}`);
    put("publish", "published.json", { pushed: true, head: pushed, pr: PRD_PR, requested: false, handedOver: false });

    await run(INPUTS({ PUBLISH_OUTCOME: "failure" }));

    const ranges = sliceRanges(
      [
        { sha: pushed, parents: [tip], slice: SUB },
        { sha: tip, parents: [base], slice: 241 },
      ],
      SUB_ISSUES,
    );
    const expected = { subIssues: SUB_ISSUES, ranges, verdict: "none", running: null, finalReview: "not requested", prUrl, rounds: { slices: {}, final: { reviews: 0, fixes: 0 }, all: { reviews: 0, fixes: 0 } } } as const;
    expect(body()).toContain(renderProgressList(expected));
    expect(body()).toContain(statusBlock(renderPrdStatus(expected)));
    expect(body()).toContain(`| 3 · #${SUB} | ⏸️ Parked |`);
    expect(logged).toContain(`Wrote PRD PR #${PRD_PR}'s progress list: the slice stopped after its push.`);
  }, CEILING);

  it("writes into the PRD PR publish opened, where the gate found none", async () => {
    git(agent, "checkout", "--quiet", PRD_BRANCH);
    const pushed = commit(agent, `feat: this slice\n\n${SLICE_TRAILER}: #${SUB}`);
    git(agent, "push", "--quiet", origin, `HEAD:refs/heads/${PRD_BRANCH}`);
    put("publish", "published.json", { pushed: true, head: pushed, pr: PRD_PR, requested: false, handedOver: false });

    await run(INPUTS({ PRD_PR: "", PUBLISH_OUTCOME: "failure" }));

    expect(body()).toContain(`| 3 · #${SUB} | ⏸️ Parked |`);
  }, CEILING);

  it("writes no list where there is no PRD PR, or the body never had one", async () => {
    await run(AGENT_FAILED({ PRD_PR: "" }));
    expect(writes()).toEqual(STOPPED_WRITES);

    github.pullRequests.get(PRD_PR)!.body = "Mine.";
    fs.rmSync(work, { recursive: true, force: true });
    await run(AGENT_FAILED());
    expect(body()).toBe("Mine.");
  }, CEILING);

  it("leaves half a list alone, with a warning", async () => {
    github.pullRequests.get(PRD_PR)!.body = "Mine.\n<!-- agent:progress -->\nrest";

    await run(AGENT_FAILED());

    expect(body()).toBe("Mine.\n<!-- agent:progress -->\nrest");
    expect(warnings().some((w) => w.startsWith(`::warning::PRD PR #${PRD_PR}'s body carries half a progress list, or two`))).toBe(true);
  }, CEILING);

  /** The status line beside it keeps `spliceStatus`'s rule: replaced where the note has one, and otherwise left as it is. */
  it.each([
    ["a status line", true],
    ["none", false],
    ["half a line", false],
  ] as const)("writes the list into a note with %s, and the status line only where it has one", async (_case, replaced) => {
    const half = `> [!NOTE]\n> <!-- agent:status -->old\n\nMine.`;
    const listOnly = BUILDING.split("\n\n").slice(1).join("\n\n");
    const before = _case === "a status line" ? BUILDING : _case === "none" ? `Mine.\n\n${listOnly}` : `${half}\n\n${listOnly}`;
    github.pullRequests.get(PRD_PR)!.body = before;

    await run(AGENT_FAILED());

    expect(body()).toContain(`| 3 · #${SUB} | ⏳ Not started |`);
    expect(body().includes(statusBlock("**✅ Slice 2 of 4 approved** · #241"))).toBe(replaced);
    if (_case === "half a line") expect(body()).toContain(half);
  }, CEILING);

  /**
   * A PRD PR an older release opened carries the slices table the loop no
   * longer writes, outside every marker; a stopped run's write leaves it as
   * it is, byte for byte, as every other writer of the body does.
   */
  it("leaves an old slices table in the body as it is", async () => {
    const table = [
      "<!-- agent:slices -->",
      "| Slice | PR | Verdict | Open findings |",
      "|---|---|---|---|",
      "| One (#15) | #20 | ✅ approval recommended | none |",
      "<!-- /agent:slices -->",
    ].join("\n");
    github.pullRequests.get(PRD_PR)!.body = `Closes #14\n\n## Progress\n${table}\n\n${BUILDING}`;

    await run(AGENT_FAILED());

    expect(body().split(table)).toHaveLength(2);
    expect(body()).toContain(`## Progress\n${table}\n`);
    expect(body()).toContain(`| 3 · #${SUB} | ⏳ Not started |`);
  }, CEILING);

  it("goes on with a warning where the list cannot be written", async () => {
    github.fails = (write) => write.type === "editPullRequest";

    await run(AGENT_FAILED());

    expect(body()).toBe(BUILDING);
    expect(warnings().some((w) => w.startsWith(`::warning::Could not write PRD PR #${PRD_PR}'s progress list`))).toBe(true);
    expect(labels()).toEqual([BLOCKED_LABEL]);
  }, CEILING);

  it("writes none on a run that finished, or a gate that never decided", async () => {
    await run();
    expect(body()).toBe(BUILDING);

    fs.rmSync(work, { recursive: true, force: true });
    await run(UNDECIDED({ PRD_PR: String(PRD_PR) }));
    expect(body()).toBe(BUILDING);
  }, CEILING);

  it("writes none, with a warning, where the loop's token was not minted", async () => {
    await run(AGENT_FAILED({ MINT_OUTCOME: "failure", LOOP_TOKEN: "", LOOP_TOKEN_SOURCE: "" }));

    expect(body()).toBe(BUILDING);
    expect(warnings()).toContain(`::warning::The loop's token was not minted, so PRD PR #${PRD_PR}'s progress list still shows the slice building.`);
  }, CEILING);
});
