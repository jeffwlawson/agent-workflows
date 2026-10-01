import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { reviewMutation } from "../shared/review-findings.js";
import { renderReviewPost, VERDICTS, type ReviewOutput } from "../shared/review-output.js";
import type { CarriedFinding, ThreadResolution } from "../shared/review-verification.js";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * Runs the review's posting job's first two steps (#257), the real `run:`
 * blocks read out of `.github/workflows/review.yml`, in order and under
 * `bash -e`, against a `gh` that records every call, fails the replies and the
 * resolves it is told to, and keeps the review request it is sent.
 *
 * What it executes is the order the issue settled: the earlier findings are
 * answered and resolved first, and the overview posted after them lists under
 * *Resolved since last review* only the threads that actually resolved. A
 * thread whose resolve failed is listed as still open, in its own group.
 *
 * The body the step assembles is checked against `renderReviewBody`, so the
 * one renderer stays the TypeScript one: the step only chooses between lines
 * the runner rendered and wraps them in the group the runner named.
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

const stepRun = (name: string): string => {
  const workflow = parse(fs.readFileSync(path.join(".github", "workflows", "review.yml"), "utf8")) as Workflow;
  const step = (workflow.jobs["post-review"]?.steps ?? []).find((s) => s.name === name);

  expect(step?.run, `the posting job has no \`${name}\` step`).toBeDefined();
  return step?.run ?? "";
};

/** Records each call, fails the threads it is told to, and keeps what `--input` sent. */
const FAKE_GH = `#!/bin/bash
printf '%s\\n' "$*" >> "$GH_LOG"
tid=""
prev=""
for a in "$@"; do
  case "$a" in threadId=*) tid="\${a#threadId=}" ;; esac
  if [ "$prev" = "--input" ]; then cp "$a" "$GH_POSTED"; fi
  prev="$a"
done
case "$*" in
  *--input*) echo "https://github.com/acme/widgets/pull/152#pullrequestreview-1"; exit 0 ;;
  *resolveReviewThread*) case " $GH_FAIL_RESOLVE " in *" $tid "*) echo "FORBIDDEN" >&2; exit 1 ;; esac ;;
  *addPullRequestReviewThreadReply*) case " $GH_FAIL_REPLY " in *" $tid "*) exit 1 ;; esac ;;
esac
exit 0
`;

const output = (over: Partial<ReviewOutput> = {}): ReviewOutput => ({
  findings: [],
  followUps: [],
  fixBeforeMerge: [],
  verified: [],
  assessment: "Two earlier findings are fixed.",
  ...over,
});

/** Two threaded findings this review closed, and one legacy body entry with no thread. */
const RESOLVED: readonly CarriedFinding[] = [
  { id: "f-1", threadId: "PRRT_one", text: "the guard runs after the return", severity: "high" },
  { id: "f-2", threadId: "PRRT_two", text: "the cache key omits the tenant", severity: "low" },
  { id: "f-3", text: "a legacy body entry", severity: "medium" },
];

const RESOLUTIONS: readonly ThreadResolution[] = [
  { threadId: "PRRT_one", findingId: "f-1", reason: "ADDRESSED", reply: "**Verified fixed.**", alreadyReplied: false },
  { threadId: "PRRT_two", findingId: "f-2", reason: "WONT_FIX", reply: "Closed as won't fix.", alreadyReplied: false },
];

const PARTS = {
  verdict: VERDICTS["approval recommended"],
  output: output(),
  placed: [],
  movedToFollowUps: 0,
  stillOpen: [],
  resolved: RESOLVED,
  followUps: [],
  droppedFollowUps: 0,
};

interface Outcome {
  readonly status: number | null;
  readonly stderr: string;
  /** Every `gh` call, in order. */
  readonly gh: readonly string[];
  /** The body the review was posted with. */
  readonly body: string;
  readonly url: string;
}

const post = (fail: { readonly resolve?: string; readonly reply?: string } = {}): Outcome => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-post-"));
  const bin = path.join(temp, "bin");
  const log = path.join(temp, "gh.log");
  const posted = path.join(temp, "posted.json");
  const github = path.join(temp, "github_output");
  const rendered = renderReviewPost(PARTS);

  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(temp, "thread_resolutions.json"), JSON.stringify(RESOLUTIONS));
  fs.writeFileSync(
    path.join(temp, "review_payload.json"),
    JSON.stringify(reviewMutation({ pullRequestId: "PR_1", commitOID: "abc", body: rendered.body, placed: [] })),
  );
  fs.writeFileSync(
    path.join(temp, "review_body.json"),
    JSON.stringify({ slotted: rendered.slotted, slot: rendered.slot, resolved: rendered.resolved, groups: rendered.groups }),
  );
  fs.writeFileSync(github, "");

  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
    GH_LOG: log,
    GH_POSTED: posted,
    GH_FAIL_RESOLVE: fail.resolve ?? "",
    GH_FAIL_REPLY: fail.reply ?? "",
    GITHUB_OUTPUT: github,
    RUNNER_TEMP: temp,
    PR_NUMBER: "152",
    RESOLUTIONS: path.join(temp, "thread_resolutions.json"),
    RESOLVED: path.join(temp, "resolved_threads.txt"),
    PAYLOAD: path.join(temp, "review_payload.json"),
    BODY: path.join(temp, "review_body.json"),
  };

  let stderr = "";
  let status: number | null = 0;
  for (const name of ["Resolve the threads this review closed", "Post PR review"]) {
    const script = path.join(temp, "step.sh");
    fs.writeFileSync(script, stepRun(name));
    const result = spawnSync("bash", ["-e", script], { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT, env });
    stderr += result.stderr;
    status = result.status;
    if (status !== 0) break;
  }

  const outcome = {
    status,
    stderr,
    gh: fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((l) => l !== "") : [],
    body: fs.existsSync(posted)
      ? (JSON.parse(fs.readFileSync(posted, "utf8")) as { variables: { input: { body: string } } }).variables.input.body
      : "",
    url: fs.readFileSync(github, "utf8"),
  };
  fs.rmSync(temp, { recursive: true, force: true });
  return outcome;
};

/** The lines of one `<details>` group in a body, or `undefined` where it has none. */
const group = (body: string, title: string): string[] | undefined => {
  const at = body.indexOf(`<summary><b>${title}</b>`);
  if (at < 0) return undefined;
  return body
    .slice(at, body.indexOf("</details>", at))
    .split("\n")
    .filter((line) => line.startsWith("- "));
};

/**
 * Each case runs two steps, so two spawns' worth of ceiling (`vitest.config.ts`):
 * each spawn's own bound is still what ends a hang.
 */
const CEILING = 2 * SUBPROCESS_TIMEOUT;

describe.skipIf(!CAN_RUN)("the review's posting job resolves first, then posts what resolved", () => {
  /**
   * Every reply and resolve is made before the review goes out, so on the
   * pull request they are timestamped ahead of the overview.
   */
  it("answers and resolves the earlier threads before it posts the review", () => {
    const outcome = post();
    const review = outcome.gh.findIndex((call) => call.includes("--input"));
    const threads = outcome.gh.filter((call) => /resolveReviewThread|addPullRequestReviewThreadReply/.test(call));

    expect(outcome.status, outcome.stderr).toBe(0);
    expect(threads).toHaveLength(4);
    expect(review).toBe(outcome.gh.length - 1);
    expect(outcome.url).toContain("url=https://github.com/acme/widgets/pull/152#pullrequestreview-1");
  }, CEILING);

  /**
   * Where every closure held, the body is the runner's own, byte for byte:
   * the step rebuilt the group the runner would have rendered.
   */
  it("posts the body the runner rendered where every thread resolved", () => {
    const outcome = post();

    expect(outcome.body).toBe(renderReviewPost(PARTS).body);
    expect(group(outcome.body, "Resolved since last review")).toHaveLength(3);
    expect(group(outcome.body, "Still open")).toBeUndefined();
  }, CEILING);

  /**
   * The acceptance case: a thread whose resolve failed is listed as still
   * open, with the note, and not as resolved.
   */
  it("lists a thread whose resolve failed as still open, not resolved", () => {
    const outcome = post({ resolve: "PRRT_one" });
    const resolved = group(outcome.body, "Resolved since last review") ?? [];
    const open = group(outcome.body, "Still open") ?? [];

    expect(outcome.status, outcome.stderr).toBe(0);
    expect(open).toHaveLength(1);
    expect(open[0]).toContain("the guard runs after the return");
    expect(resolved).toHaveLength(2);
    expect(resolved.join("\n")).not.toContain("the guard runs after the return");
    // The legacy entry has no thread, and closed by not being listed again.
    expect(resolved.join("\n")).toContain("a legacy body entry");
    expect(outcome.body).toContain("<summary><b>Still open</b> (1)</summary>");
    expect(outcome.body).toContain("<summary><b>Resolved since last review</b> (2)</summary>");
    expect(outcome.body).toContain("their threads could not be resolved");
    // In the place the resolved group had, ahead of everything after it.
    expect(outcome.body.indexOf("Still open")).toBeLessThan(outcome.body.indexOf("Resolved since last review"));
    expect(outcome.stderr + outcome.gh.join("\n")).not.toContain("agent-review:resolved-groups");
  }, CEILING);

  /** A reply that would not post leaves its thread open, and the body says so too. */
  it("lists a thread whose reply failed as still open, and never resolves it", () => {
    const outcome = post({ reply: "PRRT_two" });

    expect(outcome.gh.some((call) => call.includes("resolveReviewThread") && call.includes("PRRT_two"))).toBe(false);
    expect(group(outcome.body, "Still open")?.join("\n")).toContain("the cache key omits the tenant");
    expect(group(outcome.body, "Resolved since last review")).toHaveLength(2);
  }, CEILING);

  /** And where none resolved, the resolved group is the legacy entry alone. */
  it("drops a resolved group nothing is left in, and keeps the rest of the body", () => {
    const outcome = post({ resolve: "PRRT_one PRRT_two" });
    const expected = renderReviewPost(PARTS).body;

    expect(group(outcome.body, "Still open")).toHaveLength(2);
    expect(group(outcome.body, "Resolved since last review")).toHaveLength(1);
    expect(outcome.body.startsWith(expected.slice(0, expected.indexOf("<details>")))).toBe(true);
  }, CEILING);
});
