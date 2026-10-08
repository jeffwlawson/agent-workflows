import { execFileSync } from "node:child_process";
import type { OutputWriters } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { FINAL_REVIEW_MARK, PRD_BRANCH_PREFIX, SLICE_TRAILER } from "../shared/record.js";

type Inputs = InputValues<(typeof COMMANDS)["review:red-check-place"]["inputs"]>;
type Outputs = OutputWriters<(typeof COMMANDS)["review:red-check-place"]["outputs"]>;

/**
 * Where the red check stands once its tree is placed, or why there is nothing
 * to run: `ready` where the test files are over the "before" tree, and each
 * other value the reason the job runs nothing. `review:red-check-classify`
 * reads it as the report's `status`.
 */
export const PLACEMENTS = ["ready", "no-test-files", "misconfigured", "final-review", "no-merge-base"] as const;

export type Placement = (typeof PLACEMENTS)[number];

/** `place.json`: what was placed, and on what. */
export interface Placed {
  readonly status: Placement;
  readonly reason?: string;
  readonly head: string;
  /** The "before" tree, where one was found. */
  readonly base?: string;
  /** On a slice round (#235), the slice whose "before" `base` is. */
  readonly slice?: number;
  /** The test files put over `base`, which the adopter's command is handed. */
  readonly files: readonly string[];
  /**
   * The non-test files the pull request changes. Absent where `base` was never
   * found to list them against, which is not the same as none.
   */
  readonly source?: readonly string[];
}

/**
 * `review:red-check-place` (#422): the tree the red check's tests run on, in
 * the pull request's checkout, before any of its code runs.
 *
 * **What it runs on.** The merge-base of the pull request's head and its base
 * branch, with the test files the PR adds or changes put over it, and nothing
 * else of the PR's: every non-test file is the merge-base's. What a test file
 * is, is the adopter's `red-check-test-globs`, as `:(glob)` pathspecs, so
 * `**` matches any depth as in a `.gitignore`. Renames are split, so a test
 * file the PR moved counts as added. A name with a line break in it cannot be
 * handed to the command one a line, so it is dropped with a warning rather
 * than split in two. The files are put back from the head as literal paths: a
 * file name is the PR's, and a `*` in one is not a pattern.
 *
 * **On a slice round of a PRD PR** (#235), "before" is the PRD branch as it
 * stood before that slice, not the merge-base: every slice is built on the
 * earlier ones, so against the merge-base each slice's tests would run on code
 * with none of them, and a test of an earlier slice's code would be broken
 * there rather than red. The slice is the one started last on the branch's
 * first-parent log, by the `Agent-Slice` trailer `implement-prd` gives every
 * commit it builds, and its base is the first parent of its earliest commit:
 * what `shared/slice-ranges.ts` calls the slice range's base, and what that
 * slice was built on. Read from the history alone, since the job holds no
 * token that reads the sub-issues, which is the same answer wherever the chain
 * builds the slices in order, as it does. A PRD branch with no trailered
 * commit keeps the merge-base, the direction the review's own brief fails in
 * where it cannot tell the slice.
 *
 * **The final review runs nothing** (`final-review`): against the merge-base a
 * later slice's test of an earlier slice's code fails to import, and reads as
 * broken, so a merge-base run would tell the review that slice's change is
 * uncovered when its own round found it red. The review reads each slice
 * round's record instead. It is told apart by the mark the finishing run
 * writes into the body, as the label event carried it.
 *
 * Every outcome but a failure of git itself is a placement, written to
 * `place.json`, and none fails the command: a red check that cannot run says
 * why in its report, and never stops the review.
 */
export const place = (inputs: Inputs, outputs: Outputs): void => {
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: inputs.CHECKOUT, encoding: "utf8" });
  /** NUL-separated names, as `-z` lists them. */
  const names = (...args: string[]): string[] => git(...args).split("\0").filter((name) => name !== "");
  const write = (placed: Placed): void => outputs.writeJson("place.json", placed);

  const head = git("rev-parse", "HEAD").trim();

  const missing = [
    ...(inputs.REPORT_PATH === "" ? ["`red-check-report`"] : []),
    ...(inputs.TEST_GLOBS.trim() === "" ? ["`red-check-test-globs`"] : []),
  ];
  if (missing.length > 0) {
    const reason = `The red check is configured with \`red-check-command\` but not ${missing.join(" ")}. Set them in the review caller's \`with:\` block.`;
    console.log(`::error::${reason}`);
    write({ status: "misconfigured", reason, head, files: [] });
    return;
  }

  const prd = inputs.BRANCH.startsWith(PRD_BRANCH_PREFIX);
  if (prd && inputs.PR_BODY.includes(FINAL_REVIEW_MARK)) {
    console.log(
      "The final review of a PRD PR: each slice's tests were run against the PRD branch as it stood before that slice, in that slice's round, so nothing is run here.",
    );
    write({ status: "final-review", head, files: [] });
    return;
  }

  const upstream = `refs/remotes/origin/${inputs.BASE_REF}`;
  let base: string;
  try {
    base = git("merge-base", "HEAD", upstream).trim();
  } catch {
    const reason = `${head} has no merge-base with ${inputs.BASE_REF}.`;
    console.log(`::error::${reason}`);
    write({ status: "no-merge-base", reason, head, files: [] });
    return;
  }

  let slice: number | undefined;
  if (prd) {
    const started = sliceStarted(git, upstream);
    if (started === undefined) {
      console.log(
        `::warning::No commit on this PRD branch carries an \`${SLICE_TRAILER}\` trailer, so the red check runs against the merge-base rather than the PRD branch as it stood before this slice.`,
      );
    } else {
      console.log(
        `Slice round of #${started.slice}: the tests run against the PRD branch as it stood before it, ${started.base}, not the merge-base ${base}.`,
      );
      base = started.base;
      slice = started.slice;
    }
  }
  const at = { head, base, ...(slice === undefined ? {} : { slice }) };

  const globs = inputs.TEST_GLOBS.split("\n")
    .map((glob) => glob.trim())
    .filter((glob) => glob !== "");

  // The other half, for the review (#232): every non-test file the PR
  // changes, deleted ones included, since a behaviour change in one is what a
  // red test has to cover. Listed before the test files are looked for, so a
  // PR that changes source and no test still says so.
  const source = names("diff", "-z", "--name-only", "--no-renames", base, head, "--", ".", ...globs.map((glob) => `:(exclude,glob)${glob}`)).filter(
    (file) => !file.includes("\n"),
  );

  const placed: string[] = [];
  for (const file of names("diff", "-z", "--name-only", "--no-renames", "--diff-filter=AM", base, head, "--", ...globs.map((glob) => `:(glob)${glob}`))) {
    if (file.includes("\n")) {
      console.log("::warning::Skipped a test file whose name has a line break in it.");
      continue;
    }
    placed.push(file);
  }

  if (placed.length === 0) {
    console.log("This PR adds or changes no test file, so there is nothing to run against the merge-base.");
    write({ status: "no-test-files", ...at, files: [], source });
    return;
  }

  git("checkout", "--quiet", "--detach", base);
  git("--literal-pathspecs", "checkout", head, "--", ...placed);
  console.log(`Put ${placed.length} test file(s) from ${head} over the merge-base ${base}:`);
  for (const file of placed) console.log(`  ${file}`);
  write({ status: "ready", ...at, files: placed, source });
};

/**
 * The slice started last on the PRD branch's first-parent log since
 * `upstream`, and the first parent of its earliest commit, or nothing where
 * no commit carries the trailer. A log that cannot be read reads as none.
 */
const sliceStarted = (
  git: (...args: string[]) => string,
  upstream: string,
): { readonly slice: number; readonly base: string } | undefined => {
  let log: string;
  try {
    log = git(
      "log",
      "--first-parent",
      "--reverse",
      `--format=%H%x1f%P%x1f%(trailers:key=${SLICE_TRAILER},valueonly,separator=%x2C)%x1e`,
      `${upstream}..HEAD`,
    );
  } catch {
    return undefined;
  }
  const started = new Set<string>();
  let last: { readonly slice: number; readonly base: string } | undefined;
  for (const record of log.split("\x1e")) {
    const [, parents = "", trailer = ""] = record.replace(/^\n/, "").split("\x1f");
    const number = /#(\d+)/.exec(trailer.split(",")[0] ?? "")?.[1];
    if (number === undefined || started.has(number)) continue;
    started.add(number);
    last = { slice: Number(number), base: parents.split(" ")[0] ?? "" };
  }
  return last === undefined || last.base === "" ? undefined : last;
};
