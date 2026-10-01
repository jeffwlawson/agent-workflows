import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readSummaryBlock, SUMMARY_END, SUMMARY_START, summaryUpdate } from "../shared/pr-summary.js";
import { SLICES_END, SLICES_START, spliceSliceRows } from "../shared/slices-table.js";
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
  "pr list"*) echo "" ;;
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

  it("opens a PRD PR with Closes first, the note, an empty slices table and an unwritten summary", () => {
    const outcome = runStep(stepRun("implement-prd", "implement-prd", "Open or reuse the PRD PR"), {
      ISSUE_NUMBER: "14",
      ISSUE_TITLE: "A PRD",
      RUN_URL,
      BASE_REF: "main",
      PRD_BRANCH: "agent/prd-14-a-prd",
      SLICE_PR: "20",
      HAS_PAT: "true",
    });

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.sent).toBe(
      [
        "Closes #14",
        "",
        "> [!NOTE]",
        "> The agent loop builds PRD #14 here, one sub-issue at a time, and reviews each before starting the next. It stays a draft until every slice is done. Don't merge it before then. Add your own notes outside the summary below; the loop never edits them.",
        "",
        "## Progress",
        SLICES_START,
        SLICES_END,
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
   * The PRD PR's slices table is outside the block, and is written by another
   * run between reviews. Both writers keep to their own markers.
   */
  it("leaves the slices table as it is, and the table's writer leaves the summary", () => {
    const prd = [
      "Closes #14\n",
      "## Progress",
      SLICES_START,
      SLICES_END,
      "",
      SUMMARY_START,
      "_The final review will summarize the whole PRD here._",
      SUMMARY_END,
      "",
    ].join("\n");
    const withRow = spliceSliceRows(prd, ["| Slice (#15) | [#20](u) | 🟢 | none |"]);
    const written = writeSummary(withRow).request?.body ?? "";

    expect(outside(written)).toEqual(outside(withRow));
    const again = spliceSliceRows(written, ["| Next (#16) | [#21](u) | 🟢 | none |"]);
    expect(readSummaryBlock(again)?.text).toContain("It writes the title.");
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
