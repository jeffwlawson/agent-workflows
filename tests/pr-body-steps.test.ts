import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  OPENING_STATUS,
  renderPrdStatus,
  renderProgressList,
  spliceProgressList,
  spliceStatus,
  statusBlock,
  type ProgressInputs,
} from "../shared/progress-list.js";
import { spliceBlock } from "../engine/splice.js";
import { summaryBlock } from "../review/pr-summary.js";
import { REVIEW_URL_SLOT } from "../shared/prd-round.js";
import { sliceRanges } from "../shared/slice-ranges.js";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";
import {
  DRAFT_NOTE_END,
  DRAFT_NOTE_START,
  PROGRESS_END,
  PROGRESS_START,
  STATUS_END,
  STATUS_START,
  SUMMARY_END,
  SUMMARY_START,
} from "../shared/record.js";

/**
 * The pull request body's writers that are still shell (#218), run as the
 * real `run:` blocks read out of the workflows under `bash -e`, against a `gh`
 * that records what it was sent: the **frame** each opening run writes once,
 * and the splices of the progress list and the status line. The review's
 * summary, and a regular pull request's status line, are `review:publish`'s,
 * and its tests hold them (`tests/review/publish.test.ts`).
 *
 * Skipped where `bash` or `jq` are not on PATH.
 */

const onPath = (command: string): boolean =>
  process.platform !== "win32" &&
  spawnSync("sh", ["-c", `command -v ${command}`], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

const CAN_RUN = ["bash", "jq"].every(onPath);

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
}
interface Workflow {
  readonly jobs: Record<string, { readonly steps?: readonly Step[] }>;
}

const stepRun = (workflow: string, job: string, name: string): string => {
  const parsed = parse(fs.readFileSync(path.join(".github", "workflows", `${workflow}.yml`), "utf8")) as Workflow;
  const step = (parsed.jobs[job]?.steps ?? []).find((s) => s.name === name);

  expect(step?.run, `${workflow}.yml's ${job} job has no \`${name}\` step`).toBeDefined();
  return step?.run ?? "";
};

/**
 * Records each call; answers a PR read with `GH_PR`, keeps what a `--input` or
 * a `--body-file` sent, and fails the calls `GH_FAIL` names.
 */
const FAKE_GH = `#!/bin/bash
printf '%s\\n' "$*" >> "$GH_LOG"
prev=""
for a in "$@"; do
  if [ "$prev" = "--input" ] || [ "$prev" = "--body-file" ]; then cp "$a" "$GH_SENT"; fi
  prev="$a"
done
case "$*" in
  *PATCH*) case " $GH_FAIL " in *" patch "*) exit 1 ;; esac; echo '{}' ;;
  "api repos/{owner}/{repo}/pulls/"*) case " $GH_FAIL " in *" read "*) exit 1 ;; esac; cat "$GH_PR" ;;
  "pr create"*) echo "https://github.com/acme/widgets/pull/31" ;;
  "pr list"*) echo "\${GH_PR_LIST:-}" ;;
esac
exit 0
`;

interface Outcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly gh: readonly string[];
  /** What a `--input` or `--body-file` sent, or `undefined` where nothing was. */
  readonly sent: string | undefined;
  /** The files named in `kept`, as the step left them, `undefined` where it wrote none. */
  readonly kept: Readonly<Record<string, string | undefined>>;
}

const runStep = (
  script: string,
  env: Record<string, string>,
  files: Record<string, string> = {},
  kept: readonly string[] = [],
): Outcome => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pr-body-"));
  const bin = path.join(temp, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(temp, name), content);
  const log = path.join(temp, "gh.log");
  const sent = path.join(temp, "sent");
  const stepFile = path.join(temp, "step.sh");
  fs.writeFileSync(stepFile, script);
  fs.writeFileSync(path.join(temp, "github_output"), "");

  const result = spawnSync("bash", ["-e", stepFile], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      GH_LOG: log,
      GH_SENT: sent,
      GH_PR: path.join(temp, "pr.json"),
      GH_FAIL: "",
      GITHUB_OUTPUT: path.join(temp, "github_output"),
      RUNNER_TEMP: temp,
      ...env,
    },
  });
  const outcome = {
    status: result.status,
    stdout: result.stdout + result.stderr,
    gh: fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((l) => l !== "") : [],
    sent: fs.existsSync(sent) ? fs.readFileSync(sent, "utf8") : undefined,
    kept: Object.fromEntries(
      kept.map((name) => {
        const file = path.join(temp, name);
        return [name, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined];
      }),
    ),
  };
  fs.rmSync(temp, { recursive: true, force: true });
  return outcome;
};

const RUN_URL = "https://github.com/acme/widgets/actions/runs/4242";

/** A PRD of two slices, the first approved and the second in review. */
const PROGRESS_SUBS = [
  { number: 15, title: "One", state: "OPEN" as const },
  { number: 16, title: "Two", state: "OPEN" as const },
];
const PROGRESS: ProgressInputs = {
  subIssues: PROGRESS_SUBS,
  ranges: sliceRanges(
    [
      { sha: "c", parents: ["b"], slice: 16 },
      { sha: "b", parents: ["a"], slice: 15 },
    ],
    PROGRESS_SUBS,
  ),
  verdict: "none",
  running: { kind: "review" },
  finalReview: "not requested",
};

/**
 * The preflight's snapshot of the PRD, #14: #15 closed before the upgrade
 * with no slice range, and #16 open.
 */
const SNAPSHOT = { subIssues: { nodes: [{ number: 15, state: "CLOSED" }, { number: 16, state: "OPEN" }] } };

/** The PRD PR's `Closes` block, which `implement-prd` owns and the review splices around. */
const CLOSES_START = "<!-- agent:closes -->";
const CLOSES_END = "<!-- /agent:closes -->";

/**
 * The frames, exactly as the issue settled them. Written once by the run that
 * opens the pull request, and never again by anything.
 */
describe.skipIf(!CAN_RUN)("the frame a pull request opens with", () => {
  it("opens a single-issue PR with the note and its status line, the summary, then Closes", () => {
    const outcome = runStep(stepRun("implement", "publish", "Open draft PR"), {
      ISSUE_NUMBER: "123",
      ISSUE_TITLE: "Do the thing",
      RUN_URL,
      BASE_REF: "main",
      BRANCH: "agent/issue-123-do-the-thing",
      OPENING_STATUS,
    });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.sent).toBe(
      [
        "> [!NOTE]",
        `> ${statusBlock(OPENING_STATUS)}`,
        ">",
        `> Opened by the agent loop from #123 ([Workflow run](${RUN_URL})). Comment here to steer it; your notes outside the loop's blocks are never edited.`,
        "",
        "---",
        "",
        "## Summary",
        "",
        SUMMARY_START,
        "_The review will summarize this change here after its first pass._",
        SUMMARY_END,
        "",
        "Closes #123",
        "",
      ].join("\n"),
    );
  });

  it("opens a PRD PR with the note and its status line, the summary, the progress table, then the Closes line", () => {
    const outcome = runStep(
      stepRun("implement-prd", "publish", "Open or reuse the PRD PR"),
      {
        ISSUE_NUMBER: "14",
        ISSUE_TITLE: "A PRD",
        RUN_URL,
        BASE_REF: "main",
        PRD_BRANCH: "agent/prd-14-a-prd",
        TOKEN_SOURCE: "pat",
        SUB: "15",
        SUB_K: "1",
        SUBS: "2",
        PROGRESS_START,
        PROGRESS_END,
        STATUS_START,
        STATUS_END,
      },
      {
        "prd-issue.json": JSON.stringify({
          subIssues: { nodes: [{ number: 15, state: "OPEN" }, { number: 16, state: "OPEN" }] },
        }),
        "progress.md": renderProgressList(PROGRESS),
        "status.md": statusBlock("**🔍 Reviewing slice 1 of 2** · #15"),
      },
    );

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.gh.at(-1)).toBe("pr comment 31 --body **Slice 1 of 2 · #15 started**");
    expect(outcome.sent).toBe(
      [
        "> [!NOTE]",
        `> ${statusBlock("**🔍 Reviewing slice 1 of 2** · #15")}`,
        ">",
        `> ${DRAFT_NOTE_START}The agent loop builds PRD #14 here, one sub-issue at a time, and reviews each on this PR before starting the next. It stays a draft until every slice is done. Don't merge it before then.${DRAFT_NOTE_END} Built by the agent loop from PRD #14, one sub-issue per slice. Comment here to steer it; your notes outside the loop's blocks are never edited.`,
        "",
        "---",
        "",
        "## Summary",
        "",
        SUMMARY_START,
        "_The final review will summarize the whole PRD here._",
        SUMMARY_END,
        "",
        "---",
        "",
        renderProgressList(PROGRESS),
        "",
        CLOSES_START,
        "Closes #14, closes #15, closes #16",
        CLOSES_END,
        "",
      ].join("\n"),
    );
  });
});

/**
 * The progress list's three writers in a workflow (#246), each splicing a list a
 * runner rendered into the PRD PR's body: the advance job at every ending of a
 * round, the build run that reuses a PRD PR once its slice is pushed, and the
 * build run that stops after its runner showed the slice building. All
 * keep the rule `spliceProgressList` keeps, and are held to it here: every
 * byte outside the markers kept, a list appended to a body with none, and
 * half a list, or two, not written.
 */
describe.skipIf(!CAN_RUN)("the progress list is spliced into the PRD PR's body", () => {
  const list = renderProgressList(PROGRESS);
  const stale = renderProgressList({ ...PROGRESS, running: null, verdict: "approval" });
  const bodies: readonly [string, string | null][] = [
    ["a body with a list", `${CLOSES_START}\nCloses #14\n${CLOSES_END}\n\n${stale}\n\nMine.\r\n`],
    ["a body with none", `${CLOSES_START}\nCloses #14\n${CLOSES_END}\n\nMine.`],
    ["a body ending in a newline", "Mine.\n"],
    ["no body", null],
    ["half a list", `Mine.\n${PROGRESS_START}\nrest`],
    ["two lists", `${stale}\n${stale}`],
  ];

  const ADVANCE_ENV = {
    PR_NUMBER: "201",
    GH_REPO: "acme/widgets",
    SERVER_URL: "https://github.com",
    REVIEW_URL: "",
    REVIEW_URL_SLOT,
    PROGRESS_START,
    PROGRESS_END,
    STATUS_START,
    STATUS_END,
  };
  const advance = (body: string | null, env: Record<string, string>, fail = "", files: Record<string, string> = {}): Outcome =>
    runStep(
      stepRun("review", "advance", "Re-render the progress list"),
      { ...ADVANCE_ENV, GH_FAIL: fail, ...env },
      {
        "pr.json": JSON.stringify({ number: 201, body }),
        "progress_approved.md": "approved list",
        "progress_parked.md": "parked list",
        "progress_running.md": list,
        ...files,
      },
    );
  const RUNNING = { ENDED: "true", VERDICT: "changes recommended", FIX_ROUND: "true" };

  it.each(bodies)("the advance job over %s keeps spliceProgressList's rule", (_case, body) => {
    const outcome = advance(body, RUNNING);
    const expected = spliceProgressList(body ?? "", list);

    expect(outcome.status, outcome.stdout).toBe(0);
    if (expected === undefined) {
      expect(outcome.sent).toBeUndefined();
      expect(outcome.stdout).toContain("half a progress list, or two");
    } else {
      expect(JSON.parse(outcome.sent ?? "{}")).toEqual({ body: expected });
    }
  });

  it.each([
    ["an approval", { ENDED: "true", VERDICT: "approval recommended" }, "approved list"],
    ["a fix round started", RUNNING, list],
    ["changes recommended", { ENDED: "true", VERDICT: "changes recommended", FIX_ROUND: "false" }, "parked list"],
    ["changes recommended, with no fix-round output", { ENDED: "true", VERDICT: "changes recommended" }, "parked list"],
    ["needs a closer look", { ENDED: "true", VERDICT: "needs a closer look" }, "parked list"],
    ["a run that did not finish", { ENDED: "false", VERDICT: "approval recommended" }, "parked list"],
  ])("the advance job writes the list for %s", (_case, env, written) => {
    const outcome = advance("Mine.", env);

    expect(JSON.parse(outcome.sent ?? "{}")).toEqual({ body: `Mine.\n\n${written}` });
  });

  it("the advance job goes on with a warning where the list cannot be read, written or was not rendered", () => {
    const unread = advance("Mine.", RUNNING, "read");
    expect(unread.status, unread.stdout).toBe(0);
    expect(unread.stdout).toContain("::warning::Could not read PRD PR #201");

    const unwritten = advance("Mine.", RUNNING, "patch");
    expect(unwritten.status, unwritten.stdout).toBe(0);
    expect(unwritten.stdout).toContain("::warning::Could not write PRD PR #201's progress list");

    const none = runStep(
      stepRun("review", "advance", "Re-render the progress list"),
      { ...ADVANCE_ENV, ...RUNNING },
      { "pr.json": JSON.stringify({ number: 201, body: "Mine." }) },
    );
    expect(none.status, none.stdout).toBe(0);
    expect(none.stdout).toContain("::warning::The review rendered no progress list");
    expect(none.gh).toEqual([]);
  }, 3 * SUBPROCESS_TIMEOUT);

  const reuse = (body: string | null, fail = "", files: Record<string, string> = {}): Outcome =>
    runStep(
      stepRun("implement-prd", "publish", "Open or reuse the PRD PR"),
      {
        ISSUE_NUMBER: "14",
        ISSUE_TITLE: "A PRD",
        BASE_REF: "main",
        PRD_BRANCH: "agent/prd-14-a-prd",
        TOKEN_SOURCE: "pat",
        SUB: "16",
        SUB_K: "2",
        SUBS: "2",
        PROGRESS_START,
        PROGRESS_END,
        STATUS_START,
        STATUS_END,
        GH_PR_LIST: "201",
        GH_FAIL: fail,
      },
      {
        "pr.json": JSON.stringify({ number: 201, body }),
        "progress.md": list,
        "prd-issue.json": JSON.stringify(SNAPSHOT),
        ...files,
      },
    );

  /**
   * A body with no `Closes` marker at all is one an older release opened
   * (#248), and gets the block at its end, from the snapshot, with no
   * line for a sub-issue closed before the upgrade.
   */
  const reused = (body: string | null): string | undefined => {
    const spliced = spliceProgressList(body ?? "", list);
    if (spliced === undefined || (body ?? "").includes(CLOSES_START)) return spliced;
    return `${spliced}\n\n${CLOSES_START}\nCloses #14, closes #16\n${CLOSES_END}`;
  };

  it.each(bodies)("a build run reusing the PRD PR over %s keeps spliceProgressList's rule", (_case, body) => {
    const outcome = reuse(body);
    const expected = reused(body);

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.gh.some((call) => call.startsWith("pr create"))).toBe(false);
    if (expected === undefined) {
      expect(outcome.sent).toBeUndefined();
      expect(outcome.stdout).toContain("half a progress list, or two");
    } else {
      expect(JSON.parse(outcome.sent ?? "{}")).toEqual({ body: expected });
    }
  });

  it("a build run reusing the PRD PR goes on with a warning where the list cannot be written", () => {
    const outcome = reuse("Mine.", "patch");

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.stdout).toContain("::warning::Could not write PRD PR #201's progress list");
  });
});

/**
 * A build run that stops after its runner showed the slice building writes
 * the list back (#246): the one the runner rendered for nothing pushed, or for
 * the slice pushed, whichever happened. A failed build starts no round, so no
 * advance job would.
 */
describe.skipIf(!CAN_RUN)("a stopped build run writes the progress list back", () => {
  const building = renderProgressList({ ...PROGRESS, running: { kind: "build", subIssue: 16 }, verdict: "approval" });
  const bodies: readonly [string, string | null][] = [
    ["a body with a list", `${CLOSES_START}\nCloses #14\n${CLOSES_END}\n\n${building}\n\nMine.\r\n`],
    ["a body with none", `${CLOSES_START}\nCloses #14\n${CLOSES_END}\n\nMine.`],
    ["a body ending in a newline", "Mine.\n"],
    ["no body", null],
    ["half a list", `Mine.\n${PROGRESS_START}\nrest`],
    ["two lists", `${building}\n${building}`],
  ];

  const stopped = (
    body: string | null,
    env: Record<string, string> = {},
    files: Record<string, string> = { "progress_stopped.md": "stopped list", "progress_stopped_pushed.md": "pushed list" },
  ): Outcome =>
    runStep(
      stepRun("implement-prd", "publish", "Show the stopped slice in the progress list"),
      { PRD_PR: "201", PUSHED: "", PROGRESS_START, PROGRESS_END, STATUS_START, STATUS_END, ...env },
      { "pr.json": JSON.stringify({ number: 201, body }), ...files },
    );

  it.each(bodies)("over %s keeps spliceProgressList's rule", (_case, body) => {
    const outcome = stopped(body);
    const expected = spliceProgressList(body ?? "", "stopped list");

    expect(outcome.status, outcome.stdout).toBe(0);
    if (expected === undefined) {
      expect(outcome.sent).toBeUndefined();
      expect(outcome.stdout).toContain("half a progress list, or two");
    } else {
      expect(JSON.parse(outcome.sent ?? "{}")).toEqual({ body: expected });
    }
  });

  it.each([
    ["nothing was pushed", "", "stopped list"],
    ["the slice was pushed", "0123456789abcdef", "pushed list"],
  ])("writes the list for a run that stopped where %s", (_case, pushed, written) => {
    const outcome = stopped("Mine.", { PUSHED: pushed });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(JSON.parse(outcome.sent ?? "{}")).toEqual({ body: `Mine.\n\n${written}` });
  });

  it("writes nothing where no PRD PR is open, or the runner never showed the slice building", () => {
    const unopened = stopped("Mine.", { PRD_PR: "" });
    expect(unopened.status, unopened.stdout).toBe(0);
    expect(unopened.gh).toEqual([]);

    const unrendered = stopped("Mine.", {}, {});
    expect(unrendered.status, unrendered.stdout).toBe(0);
    expect(unrendered.gh).toEqual([]);
  }, 2 * SUBPROCESS_TIMEOUT);

  it("goes on with a warning where the list cannot be read or written", () => {
    const unread = stopped("Mine.", { GH_FAIL: "read" });
    expect(unread.status, unread.stdout).toBe(0);
    expect(unread.stdout).toContain("::warning::Could not read PRD PR #201");

    const unwritten = stopped("Mine.", { GH_FAIL: "patch" });
    expect(unwritten.status, unwritten.stdout).toBe(0);
    expect(unwritten.stdout).toContain("::warning::Could not write PRD PR #201's progress list");
  }, 2 * SUBPROCESS_TIMEOUT);
});

/**
 * A build run shows its slice **building** from its gate (#312), which runs no
 * toolchain: it rewrites the slice's row and the status line in the table the
 * last round's ending left, and the result is the render, held equal here. It
 * keeps the table and the status line it found, for a run that stops before
 * the runner renders its own to write back.
 */
describe.skipIf(!CAN_RUN)("a build run's gate shows the slice building", () => {
  const SUBS = [
    { number: 15, title: "One", state: "OPEN" as const },
    { number: 16, title: "Two", state: "OPEN" as const },
    { number: 17, title: "Three", state: "OPEN" as const },
  ];
  const prUrl = "https://github.com/acme/widgets/pull/201";
  const approved: ProgressInputs = {
    subIssues: SUBS,
    ranges: sliceRanges([{ sha: "0123456789abcdef", parents: ["fedcba9876543210"], slice: 15 }], SUBS),
    verdict: "approval",
    running: null,
    finalReview: "not requested",
    prUrl,
    rounds: {
      slices: { 15: { reviews: 2, fixes: 1, latestReview: `${prUrl}#pullrequestreview-9` } },
      final: { reviews: 0, fixes: 0 },
      all: { reviews: 2, fixes: 1 },
    },
  };
  const building: ProgressInputs = { ...approved, running: { kind: "build", subIssue: 16 } };
  const frame = (inputs: ProgressInputs): string =>
    [
      `> [!NOTE]\n> ${statusBlock(renderPrdStatus(inputs))}\n> Mine.`,
      `## Summary\n\n${SUMMARY_START}\nx\n${SUMMARY_END}`,
      renderProgressList(inputs),
      `${CLOSES_START}\nCloses #14\n${CLOSES_END}\n`,
    ].join("\n\n");
  const UNBUILT = ["progress_unbuilt.md", "status_unbuilt.md"];

  const gate = (body: string | null, fail = ""): Outcome =>
    runStep(
      stepRun("implement-prd", "gate", "Show the slice building in the progress list"),
      { PRD_PR: "201", SUB: "16", SUB_K: "2", SUBS: "3", PROGRESS_START, PROGRESS_END, STATUS_START, STATUS_END, GH_FAIL: fail },
      { "pr.json": JSON.stringify({ number: 201, body }) },
      UNBUILT,
    );

  it("writes the table and the status line the renderer renders with the slice building", () => {
    const outcome = gate(frame(approved));

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(JSON.parse(outcome.sent ?? "{}")).toEqual({ body: frame(building) });
    expect(outcome.kept).toEqual({
      "progress_unbuilt.md": renderProgressList(approved),
      "status_unbuilt.md": statusBlock(renderPrdStatus(approved)),
    });
  });

  it("writes the table alone where the note has no status line, as the splice leaves one", () => {
    const body = `Mine.\n\n${renderProgressList(approved)}`;
    const outcome = gate(body);

    expect(JSON.parse(outcome.sent ?? "{}")).toEqual({ body: spliceProgressList(body, renderProgressList(building)) });
    expect(outcome.kept["status_unbuilt.md"]).toBeUndefined();
  });

  it.each([
    ["half a list", `Mine.\n${PROGRESS_START}\nrest`, "half a progress list, or two"],
    ["two lists", `${renderProgressList(approved)}\n${renderProgressList(approved)}`, "half a progress list, or two"],
    ["a list without the slice's row", renderProgressList({ ...approved, subIssues: SUBS.slice(0, 1) }), "has no row for sub-issue #16"],
  ])("leaves %s alone, with a warning, and keeps nothing to write back", (_case, body, warning) => {
    const outcome = gate(body);

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.stdout).toContain(`::warning::`);
    expect(outcome.stdout).toContain(warning);
    expect(outcome.gh.some((call) => call.includes("PATCH"))).toBe(false);
    expect(outcome.kept).toEqual({ "progress_unbuilt.md": undefined, "status_unbuilt.md": undefined });
  });

  it("writes nothing to a body with no list, or no body", () => {
    for (const body of ["Mine.", null]) {
      const outcome = gate(body);
      expect(outcome.status, outcome.stdout).toBe(0);
      expect(outcome.gh.some((call) => call.includes("PATCH"))).toBe(false);
      expect(outcome.kept["progress_unbuilt.md"]).toBeUndefined();
    }
  }, 2 * SUBPROCESS_TIMEOUT);

  it("goes on with a warning where the PRD PR cannot be read or written", () => {
    const unread = gate(frame(approved), "read");
    expect(unread.status, unread.stdout).toBe(0);
    expect(unread.stdout).toContain("::warning::Could not read PRD PR #201");
    expect(unread.kept["progress_unbuilt.md"]).toBeUndefined();

    const unwritten = gate(frame(approved), "patch");
    expect(unwritten.status, unwritten.stdout).toBe(0);
    expect(unwritten.stdout).toContain("::warning::Could not write PRD PR #201's progress list");
  }, 2 * SUBPROCESS_TIMEOUT);

  /**
   * A run that stops after the gate's write, in the catch-up or before the
   * runner rendered anything, has only what the gate kept, and writes that
   * back: the row is not left building.
   */
  it("is undone by a run that stops before the runner renders its own", () => {
    const written = gate(frame(approved));
    const after = (JSON.parse(written.sent ?? "{}") as { body: string }).body;
    const kept = Object.fromEntries(Object.entries(written.kept).filter((e): e is [string, string] => e[1] !== undefined));

    const stopped = runStep(
      stepRun("implement-prd", "publish", "Show the stopped slice in the progress list"),
      { PRD_PR: "201", PUSHED: "", PROGRESS_START, PROGRESS_END, STATUS_START, STATUS_END },
      { "pr.json": JSON.stringify({ number: 201, body: after }), ...kept },
    );

    expect(stopped.status, stopped.stdout).toBe(0);
    expect(JSON.parse(stopped.sent ?? "{}")).toEqual({ body: frame(approved) });
  }, 2 * SUBPROCESS_TIMEOUT);

  it("is undone by the runner's render where the runner got that far", () => {
    const stopped = runStep(
      stepRun("implement-prd", "publish", "Show the stopped slice in the progress list"),
      { PRD_PR: "201", PUSHED: "", PROGRESS_START, PROGRESS_END, STATUS_START, STATUS_END },
      {
        "pr.json": JSON.stringify({ number: 201, body: "Mine." }),
        "progress_stopped.md": "stopped list",
        "progress_unbuilt.md": "unbuilt list",
      },
    );

    expect(JSON.parse(stopped.sent ?? "{}")).toEqual({ body: "Mine.\n\nstopped list" });
  });
});

/**
 * **A slices table an older release wrote is history, and nothing rewrites it**
 * (#248): pre-upgrade compatibility, removable under #224. A PRD PR an older
 * release opened carries `Closes #<parent>`, a note, the slices table between
 * its markers and the summary block, and no `Closes` block or progress list.
 * Every writer of a PRD PR's body runs over it in turn, as a chain resumed at
 * the upgrade would: the build run that reuses it, the advance job at the end
 * of its round, the slice round's summary, the stopped run's list and the
 * final review's summary. The table comes through every one byte for byte.
 */
describe.skipIf(!CAN_RUN)("an old slices table in the PRD PR's body", () => {
  const HEAD = "0123456789abcdef0123456789abcdef01234567";
  const SUMMARY = { start: SUMMARY_START, end: SUMMARY_END };
  const TABLE = [
    "<!-- agent:slices -->",
    "| Slice | PR | Verdict | Open findings |",
    "|---|---|---|---|",
    "| One (#15) | #20 | ✅ approval recommended | none |",
    "<!-- /agent:slices -->",
  ].join("\n");
  const OLD = [
    "Closes #14",
    "",
    "> [!NOTE]",
    "> The agent loop builds PRD #14 here, one sub-issue at a time, and reviews each before starting the next.",
    "",
    "## Progress",
    TABLE,
    "",
    SUMMARY_START,
    "_The final review will summarize the whole PRD here._",
    SUMMARY_END,
    "",
  ].join("\n");
  const list = renderProgressList(PROGRESS);

  const keepsTable = (body: string | undefined): string => {
    expect(body?.split(TABLE)).toHaveLength(2);
    expect(body).toContain(`## Progress\n${TABLE}\n`);
    return body ?? "";
  };

  it("survives every rewrite of the body, unchanged", () => {
    const reused = runStep(
      stepRun("implement-prd", "publish", "Open or reuse the PRD PR"),
      {
        ISSUE_NUMBER: "14",
        ISSUE_TITLE: "A PRD",
        BASE_REF: "main",
        PRD_BRANCH: "agent/prd-14-a-prd",
        TOKEN_SOURCE: "pat",
        SUB: "16",
        SUB_K: "2",
        SUBS: "2",
        PROGRESS_START,
        PROGRESS_END,
        STATUS_START,
        STATUS_END,
        GH_PR_LIST: "201",
      },
      {
        "pr.json": JSON.stringify({ number: 201, body: OLD }),
        "progress.md": list,
        "prd-issue.json": JSON.stringify(SNAPSHOT),
      },
    );
    expect(reused.status, reused.stdout).toBe(0);
    const afterReuse = keepsTable((JSON.parse(reused.sent ?? "{}") as { body?: string }).body);
    expect(afterReuse).toBe(`${OLD}\n${list}\n\n${CLOSES_START}\nCloses #14, closes #16\n${CLOSES_END}`);

    const advanced = runStep(
      stepRun("review", "advance", "Re-render the progress list"),
      {
        PR_NUMBER: "201",
        GH_REPO: "acme/widgets",
        SERVER_URL: "https://github.com",
        REVIEW_URL: "",
        REVIEW_URL_SLOT,
        PROGRESS_START,
        PROGRESS_END,
        STATUS_START,
        STATUS_END,
        ENDED: "true",
        VERDICT: "approval recommended",
      },
      {
        "pr.json": JSON.stringify({ number: 201, body: afterReuse }),
        "progress_approved.md": "approved list",
        "progress_parked.md": "parked list",
        "progress_running.md": list,
      },
    );
    expect(advanced.status, advanced.stdout).toBe(0);
    const afterAdvance = keepsTable((JSON.parse(advanced.sent ?? "{}") as { body?: string }).body);

    // The slice round's summary, which `review:publish` writes by the
    // engine's splice (`tests/review/publish.test.ts` holds it to that).
    const afterSliceRound = keepsTable(spliceBlock(afterAdvance, SUMMARY, summaryBlock("What slice 1 did.", HEAD, false), "append"));

    const stopped = runStep(
      stepRun("implement-prd", "publish", "Show the stopped slice in the progress list"),
      { PRD_PR: "201", PUSHED: "", PROGRESS_START, PROGRESS_END, STATUS_START, STATUS_END },
      { "pr.json": JSON.stringify({ number: 201, body: afterSliceRound }), "progress_stopped.md": "stopped list" },
    );
    expect(stopped.status, stopped.stdout).toBe(0);
    const afterStopped = keepsTable((JSON.parse(stopped.sent ?? "{}") as { body?: string }).body);

    keepsTable(spliceBlock(afterStopped, SUMMARY, summaryBlock("The PRD.", HEAD, true), "append"));
  }, 3 * SUBPROCESS_TIMEOUT);

  /** The block goes in only where no `Closes` marker is: a body with one is left to the splice alone. */
  it("gets the Closes block once, on the first build run that reuses the PRD PR", () => {
    const withBlock = `${CLOSES_START}\nCloses #14\nCloses #16\n${CLOSES_END}\n\n${OLD}`;
    const outcome = runStep(
      stepRun("implement-prd", "publish", "Open or reuse the PRD PR"),
      {
        ISSUE_NUMBER: "14",
        ISSUE_TITLE: "A PRD",
        BASE_REF: "main",
        PRD_BRANCH: "agent/prd-14-a-prd",
        TOKEN_SOURCE: "pat",
        SUB: "16",
        SUB_K: "2",
        SUBS: "2",
        PROGRESS_START,
        PROGRESS_END,
        STATUS_START,
        STATUS_END,
        GH_PR_LIST: "201",
      },
      {
        "pr.json": JSON.stringify({ number: 201, body: withBlock }),
        "progress.md": list,
        "prd-issue.json": JSON.stringify(SNAPSHOT),
      },
    );

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(JSON.parse(outcome.sent ?? "{}")).toEqual({ body: spliceProgressList(withBlock, list) });
  });
});

/**
 * The status line at the top of the note (#298), written by every writer of
 * the progress table beside it (on a regular pull request, by `review:publish`,
 * whose tests hold it). Each keeps `spliceStatus`'s rule: replaced between its markers, a body
 * with none left as it is, and half a line, or two, left alone, while the
 * table beside it is still written.
 */
describe.skipIf(!CAN_RUN)("the status line is spliced into the note", () => {
  const list = renderProgressList(PROGRESS);
  const status = statusBlock("**⏸️ Slice 2 of 2 parked** · #16 · 1 finding open. [See it]({{AGENT_REVIEW_URL}})");
  const note = (line: string): string => `> [!NOTE]\n> ${line}\n>\n> Mine.\r\n`;
  const bodies: readonly [string, string][] = [
    ["a body with a status line", `${note(statusBlock("old"))}\n${list}`],
    ["a body with none", `${note("no line")}\n${list}`],
    ["half a line", `${note(`${STATUS_START}old`)}\n${list}`],
    ["two lines", `${note(statusBlock("a") + statusBlock("b"))}\n${list}`],
  ];
  const linked = status.replace("{{AGENT_REVIEW_URL}}", "https://github.com/acme/widgets/pull/201#pullrequestreview-9");
  const expected = (body: string, line: string): string => {
    const spliced = spliceProgressList(body, list) ?? "";
    return spliceStatus(spliced, line) ?? spliced;
  };

  it.each(bodies)("the advance job over %s keeps spliceStatus's rule, linking the posted review", (_case, body) => {
    const outcome = runStep(
      stepRun("review", "advance", "Re-render the progress list"),
      {
        PR_NUMBER: "201",
        GH_REPO: "acme/widgets",
        SERVER_URL: "https://github.com",
        REVIEW_URL: "https://github.com/acme/widgets/pull/201#pullrequestreview-9",
        REVIEW_URL_SLOT,
        PROGRESS_START,
        PROGRESS_END,
        STATUS_START,
        STATUS_END,
        ENDED: "true",
        VERDICT: "changes recommended",
        FIX_ROUND: "false",
      },
      { "pr.json": JSON.stringify({ number: 201, body }), "progress_parked.md": list, "status_parked.md": status },
    );

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(JSON.parse(outcome.sent ?? "{}")).toEqual({ body: expected(body, linked) });
  });

  it("the advance job links the pull request where no review was posted", () => {
    const outcome = runStep(
      stepRun("review", "advance", "Re-render the progress list"),
      {
        PR_NUMBER: "201",
        GH_REPO: "acme/widgets",
        SERVER_URL: "https://github.com",
        REVIEW_URL: "",
        REVIEW_URL_SLOT,
        PROGRESS_START,
        PROGRESS_END,
        STATUS_START,
        STATUS_END,
        ENDED: "false",
      },
      { "pr.json": JSON.stringify({ number: 201, body: bodies[0]?.[1] }), "progress_parked.md": list, "status_parked.md": status },
    );

    expect((JSON.parse(outcome.sent ?? "{}") as { body?: string }).body).toContain("[See it](https://github.com/acme/widgets/pull/201)");
  });

  it.each(bodies)("a build run reusing the PRD PR over %s keeps spliceStatus's rule", (_case, body) => {
    const withCloses = `${body}\n\n${CLOSES_START}\nCloses #14, closes #16\n${CLOSES_END}`;
    const outcome = runStep(
      stepRun("implement-prd", "publish", "Open or reuse the PRD PR"),
      {
        ISSUE_NUMBER: "14",
        ISSUE_TITLE: "A PRD",
        BASE_REF: "main",
        PRD_BRANCH: "agent/prd-14-a-prd",
        TOKEN_SOURCE: "pat",
        SUB: "16",
        SUB_K: "2",
        SUBS: "2",
        PROGRESS_START,
        PROGRESS_END,
        STATUS_START,
        STATUS_END,
        GH_PR_LIST: "201",
      },
      {
        "pr.json": JSON.stringify({ number: 201, body: withCloses }),
        "progress.md": list,
        "status.md": status,
        "prd-issue.json": JSON.stringify(SNAPSHOT),
      },
    );

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(JSON.parse(outcome.sent ?? "{}")).toEqual({ body: expected(withCloses, status) });
  });

  it.each(bodies)("a stopped build run over %s keeps spliceStatus's rule", (_case, body) => {
    const outcome = runStep(
      stepRun("implement-prd", "publish", "Show the stopped slice in the progress list"),
      { PRD_PR: "201", PUSHED: "", PROGRESS_START, PROGRESS_END, STATUS_START, STATUS_END },
      { "pr.json": JSON.stringify({ number: 201, body }), "progress_stopped.md": list, "status_stopped.md": status },
    );

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(JSON.parse(outcome.sent ?? "{}")).toEqual({ body: expected(body, status) });
  });
});
