import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * The loop's token resolver (#319, PRD #314), executed: the choice
 * `.github/actions/loop-token` makes between the App, `AGENT_PAT` and the
 * workflow token, read out of the action and run under `bash`, against a
 * `gh` that records each call and the token it was made with.
 *
 * Minting is GitHub's own action and is not run here: what the action does
 * with a mint is asserted in `tests/workflows.test.ts`.
 *
 * Skipped where `bash` is not on PATH.
 */

const CAN_RUN =
  process.platform !== "win32" &&
  spawnSync("sh", ["-c", "command -v bash"], { timeout: SUBPROCESS_TIMEOUT }).status === 0;

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly run?: string;
}
interface Action {
  readonly runs: { readonly steps: readonly Step[] };
}

const chooseRun = (): string => {
  const action = parse(fs.readFileSync(path.join(".github", "actions", "loop-token", "action.yml"), "utf8")) as Action;
  const step = action.runs.steps.find((s) => s.id === "choose");

  expect(step?.run, "the resolver has no `choose` step").toBeDefined();
  return step?.run ?? "";
};

interface Outcome {
  readonly status: number | null;
  readonly stdout: string;
  /** Each `gh` call, as `<token> <argv>`. */
  readonly gh: readonly string[];
  readonly output: string;
}

/** Runs a script under `bash -e`, with a recording `gh` first on PATH. */
const execute = (script: string, env: Readonly<Record<string, string>>): Outcome => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-token-"));
  const bin = path.join(temp, "bin");
  const log = path.join(temp, "gh.log");
  const file = path.join(temp, "step.sh");
  // Its own, never the runner's: a test run inside a workflow job inherits
  // that job's `GITHUB_OUTPUT`.
  const output = path.join(temp, "output");
  fs.writeFileSync(output, "");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "gh"),
    '#!/bin/sh\nprintf \'%s %s\\n\' "$GH_TOKEN" "$*" >> "$GH_LOG"\n[ "$1 $2" = "pr view" ] && printf \'%s\\n\' "$PUSHED_SHA"\nexit 0\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(file, script);

  const result = spawnSync("bash", ["-e", file], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      GH_LOG: log,
      GITHUB_OUTPUT: output,
      ...env,
    },
  });
  const gh = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  const written = fs.readFileSync(output, "utf8");
  fs.rmSync(temp, { recursive: true, force: true });
  return { status: result.status, stdout: result.stdout, gh, output: written };
};

describe.skipIf(!CAN_RUN)("the loop's token resolver chooses, executed", () => {
  /** What the action's `env:` makes of each input: whether it is set, never its value. */
  const choose = (app: boolean, key: boolean, pat: boolean): Outcome =>
    execute(chooseRun(), { HAS_APP_ID: String(app), HAS_APP_KEY: String(key), HAS_PAT: String(pat) });

  it.each([
    [true, true, true, "app"],
    [true, true, false, "app"],
    [false, false, true, "pat"],
    [false, false, false, "workflow"],
    // Half an App cannot mint, so it is passed over for what is left.
    [true, false, true, "pat"],
    [false, true, true, "pat"],
    [true, false, false, "workflow"],
    [false, true, false, "workflow"],
  ] as const)("App ID %s, key %s, PAT %s: reports %s", (app, key, pat, source) => {
    const outcome = choose(app, key, pat);

    expect(outcome.status, outcome.stdout).toBe(0);
    expect(outcome.output).toBe(`source=${source}\n`);
    expect(outcome.gh).toEqual([]);
  });

  /** A half-finished App is named rather than silently passed over. */
  it.each([
    [true, false, "AGENT_APP_ID is set but AGENT_APP_PRIVATE_KEY is not"],
    [false, true, "AGENT_APP_PRIVATE_KEY is set but AGENT_APP_ID is not"],
  ] as const)("warns on half an App (ID %s, key %s)", (app, key, warning) => {
    expect(choose(app, key, true).stdout).toContain(`::warning::${warning}`);
  });

  it("warns of nothing on a whole App, or none", () => {
    expect(choose(true, true, false).stdout).not.toContain("::warning::");
    expect(choose(false, false, true).stdout).not.toContain("::warning::");
  });
});

// The writes made with the source the resolver reported are each a
// command's now. The issue side's review request is `implement:publish`'s
// (#492) and `implement-prd:publish`'s (#503); on the PR side (#320), fix's
// re-review and ready-mark are `fix:publish`'s (#468), update-branch's review
// of a resolution `update-branch:publish`'s (#484), review's advance and park
// `review:advance`'s (#423), and the ready-mark `review:conclude`'s (#419).
// Each is held in that command's tests, under `tests/implement/`,
// `tests/implement-prd/`, `tests/fix/`, `tests/update-branch/` and
// `tests/review/`.
