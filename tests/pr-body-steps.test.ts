import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readSummaryBlock, SUMMARY_END, SUMMARY_START, summaryUpdate } from "../shared/pr-summary.js";
import {
  PROGRESS_END,
  PROGRESS_START,
  renderProgressList,
  spliceProgressList,
  type ProgressInputs,
} from "../shared/progress-list.js";
import { sliceRanges } from "../shared/slice-ranges.js";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * The pull request body's two writers (#218), run as the real `run:` blocks
 * read out of the workflows under `bash -e`, against a `gh` that records what
 * it was sent: the **frame** each opening run writes once, and the posting
 * job's splice of the review's summary into the body as it stands.
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
}

const runStep = (
  script: string,
  env: Record<string, string>,
  files: Record<string, string> = {},
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

/** The PRD PR's `Closes` block, which `implement-prd` owns and the review splices around. */
const CLOSES_START = "<!-- agent:closes -->";
const CLOSES_END = "<!-- /agent:closes -->";

/**
 * The frames, exactly as the issue settled them. Written once by the run that
 * opens the pull request, and never again by anything.
 */
describe.skipIf(!CAN_RUN)("the frame a pull request opens with", () => {
  it("opens a single-issue PR with Closes first, the note, the run and an unwritten summary", () => {
    const outcome = runStep(stepRun("implement", "implement", "Open draft PR"), {
      ISSUE_NUMBER: "123",
      ISSUE_TITLE: "Do the thing",
      RUN_URL,
      BASE_REF: "main",
      BRANCH: "agent/issue-123-do-the-thing",
    });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.sent).toBe(
      [
        "Closes #123",
        "",
        "> [!NOTE]",
        `> Opened by the agent loop from #123 ([run](${RUN_URL})). It stays a draft while the loop reviews and fixes it, and leaves draft when it's ready for you. Comment here to steer it. Add your own notes outside the summary below; the loop never edits them.`,
        "",
        SUMMARY_START,
        "_The review will summarize this change here after its first pass._",
        SUMMARY_END,
        "",
      ].join("\n"),
    );
  });

  it("opens a PRD PR with the Closes block first, the progress list, the note and an unwritten summary", () => {
    const outcome = runStep(
      stepRun("implement-prd", "implement-prd", "Open or reuse the PRD PR"),
      {
        ISSUE_NUMBER: "14",
        ISSUE_TITLE: "A PRD",
        RUN_URL,
        BASE_REF: "main",
        PRD_BRANCH: "agent/prd-14-a-prd",
        HAS_PAT: "true",
        PROGRESS_START,
        PROGRESS_END,
      },
      {
        "prd-issue.json": JSON.stringify({
          subIssues: { nodes: [{ number: 15, state: "OPEN" }, { number: 16, state: "OPEN" }] },
        }),
      },
    );

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.sent).toBe(
      [
        CLOSES_START,
        "Closes #14",
        "Closes #15",
        "Closes #16",
        CLOSES_END,
        "",
        PROGRESS_START,
        "_The progress list is written when this slice's review round ends._",
        PROGRESS_END,
        "",
        "> [!NOTE]",
        "> The agent loop builds PRD #14 here, one sub-issue at a time, and reviews each on this PR before starting the next. It stays a draft until every slice is done. Don't merge it before then. Add your own notes outside the blocks the loop writes; it never edits them.",
        "",
        SUMMARY_START,
        "_The final review will summarize the whole PRD here._",
        SUMMARY_END,
        "",
      ].join("\n"),
    );
  });
});

const HEAD = "0123456789abcdef0123456789abcdef01234567";

/** For a case that runs the step twice: two spawns' worth (`vitest.config.ts`). */
const CEILING = 2 * SUBPROCESS_TIMEOUT;

const FRAME = [
  "Closes #123\r\n",
  "> [!NOTE]\r\n> Opened by the agent loop from #123.\r\n",
  SUMMARY_START,
  "_The review will summarize this change here after its first pass._",
  SUMMARY_END,
  "\r\nMy own note, with a trailing newline and a CRLF.\n",
].join("\n");

const writeSummary = (
  body: string | null,
  update: { readonly title?: string; readonly summary?: string } | null = {
    title: "feat: write the title",
    summary: "It writes the title.\n\n- **Breaking:** the old field is gone.",
  },
  fail = "",
): Outcome & { readonly request: { title?: string; body?: string } | undefined } => {
  const file = update === null ? undefined : summaryUpdate(update, HEAD);
  const outcome = runStep(
    stepRun("review", "post-review", "Write the PR title and summary"),
    { PR_NUMBER: "152", GH_FAIL: fail },
    {
      "pr.json": JSON.stringify({ number: 152, title: "Fix #123: Do the thing", body }),
      ...(file === undefined ? {} : { "pr_summary.json": JSON.stringify(file) }),
    },
  );
  return {
    ...outcome,
    request: outcome.sent === undefined ? undefined : (JSON.parse(outcome.sent) as { title?: string; body?: string }),
  };
};

/** What surrounds the block, which is every byte the review does not own. */
const outside = (body: string): [string, string] => {
  const start = body.indexOf(SUMMARY_START);
  const end = body.indexOf(SUMMARY_END) + SUMMARY_END.length;
  return [body.slice(0, start), body.slice(end)];
};

describe.skipIf(!CAN_RUN)("the posting job writes the title and the summary block", () => {
  it("splices the summary between the markers and keeps every other byte", () => {
    const outcome = writeSummary(FRAME);
    const written = outcome.request?.body ?? "";

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outside(written)).toEqual(outside(FRAME));
    expect(readSummaryBlock(written)).toEqual({
      text: "It writes the title.\n\n- **Breaking:** the old field is gone.",
      head: HEAD,
    });
    expect(outcome.request?.title).toBe("feat: write the title");
    expect(outcome.gh.some((call) => call.startsWith("api --method PATCH repos/{owner}/{repo}/pulls/152"))).toBe(true);
  });

  /**
   * The PRD PR's `Closes` block is outside the summary block and is the
   * chain's, so the review's rewrite carries it over byte for byte: merging
   * the PRD PR closes what it always said it would.
   */
  it("leaves the PRD PR's Closes block as it is", () => {
    const prd = [
      CLOSES_START,
      "Closes #14",
      "Closes #15",
      CLOSES_END,
      "",
      SUMMARY_START,
      "_The final review will summarize the whole PRD here._",
      SUMMARY_END,
      "",
    ].join("\n");
    const written = writeSummary(prd).request?.body ?? "";

    expect(outside(written)).toEqual(outside(prd));
    expect(written.startsWith(`${CLOSES_START}\nCloses #14\nCloses #15\n${CLOSES_END}\n`)).toBe(true);
  });

  /**
   * And the progress list beside it (#246), which the chain re-renders and
   * the review never touches: both blocks come through the rewrite byte for
   * byte, whatever the summary becomes.
   */
  it("leaves the PRD PR's Closes block and progress list as they are", () => {
    const list = renderProgressList(PROGRESS);
    const prd = [
      CLOSES_START,
      "Closes #14",
      "Closes #15",
      CLOSES_END,
      "",
      list,
      "",
      "> [!NOTE]\r\n> A note.",
      "",
      SUMMARY_START,
      "_The final review will summarize the whole PRD here._",
      SUMMARY_END,
      "",
    ].join("\n");
    const written = writeSummary(prd).request?.body ?? "";

    expect(outside(written)).toEqual(outside(prd));
    expect(written.startsWith(`${CLOSES_START}\nCloses #14\nCloses #15\n${CLOSES_END}\n\n${list}\n\n`)).toBe(true);
  });

  /** Rewriting a block a review already wrote replaces it, and only it. */
  it("replaces an earlier summary rather than adding a second", () => {
    const once = writeSummary(FRAME).request?.body ?? "";
    const twice = writeSummary(once, { summary: "Now it does more." }).request?.body ?? "";

    expect(twice.split(SUMMARY_START)).toHaveLength(2);
    expect(readSummaryBlock(twice)?.text).toBe("Now it does more.");
    expect(outside(twice)).toEqual(outside(FRAME));
  }, CEILING);

  it("appends a block to a body that has none, keeping what is there", () => {
    const written = writeSummary("Closes #9\n\nA body from before the frame.").request?.body ?? "";

    expect(written.startsWith("Closes #9\n\nA body from before the frame.\n\n")).toBe(true);
    expect(readSummaryBlock(written)?.head).toBe(HEAD);
    expect(readSummaryBlock(writeSummary(null).request?.body ?? "")?.head).toBe(HEAD);
  }, CEILING);

  /**
   * Half a block, or two, is not written into: which marker is the real one is
   * where a maintainer's text ends, and that is not a guess to make. The title
   * still is.
   */
  it.each([
    ["a start with no end", `Closes #1\n${SUMMARY_START}\nmine`],
    ["two blocks", `${FRAME}\n${SUMMARY_START}\nx\n${SUMMARY_END}`],
    ["the end before the start", `${SUMMARY_END}\nmine\n${SUMMARY_START}`],
  ])("writes the title alone over %s, and says why", (_case, body) => {
    const outcome = writeSummary(body);

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.request).toEqual({ title: "feat: write the title" });
    expect(outcome.stdout).toContain("half a summary block, or two");
  });

  /** Nothing pushed since the summary was written: the runner wrote no file. */
  it("writes nothing where the review left the title and summary as they are", () => {
    const outcome = writeSummary(FRAME, null);

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.gh).toEqual([]);
    expect(outcome.stdout).toContain("left as they are");
  });

  it("writes only the half the review produced", () => {
    expect(writeSummary(FRAME, { title: "fix: x" }).request).toEqual({ title: "fix: x" });
    expect(writeSummary(FRAME, { summary: "Only this." }).request?.title).toBeUndefined();
  }, CEILING);

  it("warns and goes on where the pull request cannot be read or written", () => {
    const unread = writeSummary(FRAME, { title: "fix: x" }, "read");
    expect(unread.status, unread.stdout).toBe(0);
    expect(unread.stdout).toContain("::warning::Could not read PR #152");
    expect(unread.gh.some((call) => call.includes("PATCH"))).toBe(false);

    const unwritten = writeSummary(FRAME, { title: "fix: x" }, "patch");
    expect(unwritten.status, unwritten.stdout).toBe(0);
    expect(unwritten.stdout).toContain("::warning::Could not write the title and summary of PR #152");
  }, CEILING);
});

/**
 * The progress list's two writers in a workflow (#246), each splicing a list a
 * runner rendered into the PRD PR's body: the advance job at every ending of a
 * round, and the build run that reuses a PRD PR once its slice is pushed. Both
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

  const advance = (body: string | null, env: Record<string, string>, fail = ""): Outcome =>
    runStep(
      stepRun("review", "advance", "Re-render the progress list"),
      { PR_NUMBER: "201", PROGRESS_START, PROGRESS_END, GH_FAIL: fail, ...env },
      {
        "pr.json": JSON.stringify({ number: 201, body }),
        "progress_approved.md": "approved list",
        "progress_parked.md": "parked list",
        "progress_running.md": list,
      },
    );
  const RUNNING = { ENDED: "true", VERDICT: "changes recommended, fix round started" };

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
    ["changes recommended", { ENDED: "true", VERDICT: "changes recommended" }, "parked list"],
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
      { PR_NUMBER: "201", PROGRESS_START, PROGRESS_END, ...RUNNING },
      { "pr.json": JSON.stringify({ number: 201, body: "Mine." }) },
    );
    expect(none.status, none.stdout).toBe(0);
    expect(none.stdout).toContain("::warning::The review rendered no progress list");
    expect(none.gh).toEqual([]);
  }, 3 * SUBPROCESS_TIMEOUT);

  const reuse = (body: string | null, fail = ""): Outcome =>
    runStep(
      stepRun("implement-prd", "implement-prd", "Open or reuse the PRD PR"),
      {
        ISSUE_NUMBER: "14",
        ISSUE_TITLE: "A PRD",
        BASE_REF: "main",
        PRD_BRANCH: "agent/prd-14-a-prd",
        HAS_PAT: "true",
        PROGRESS_START,
        PROGRESS_END,
        GH_PR_LIST: "201",
        GH_FAIL: fail,
      },
      { "pr.json": JSON.stringify({ number: 201, body }), "progress.md": list },
    );

  it.each(bodies)("a build run reusing the PRD PR over %s keeps spliceProgressList's rule", (_case, body) => {
    const outcome = reuse(body);
    const expected = spliceProgressList(body ?? "", list);

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
