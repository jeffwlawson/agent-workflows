import { execFileSync } from "node:child_process";
import type { Limits } from "../engine/writer.js";
import { issueNumber, tolerated } from "../shared/command-helpers.js";
import type { CommandIo } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import { clean } from "../shared/clean.js";
import type { InputValues } from "../shared/env.js";
import { SETUP_CHECK_LABEL } from "../shared/record.js";

type Declared = (typeof COMMANDS)["setup-check:report"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = CommandIo<Declared["outputs"]>;

/**
 * `setup-check:report` (#821): how every setup check ends, on the issue that
 * asked for it. The service's alone: a setup check is the one job kind with no
 * workflow on Actions, where a caller's `setup:` already runs in every agent's
 * job.
 *
 * The worker hands it how each step ended, as data, and the end of a failed
 * step's output, raw (ADR 0006); every string of the comment is written here
 * (ADR 0007). One comment: a line saying how the check ended, then one line
 * per step, the checkout of the default branch, the repository's setup
 * (`AGENT_SETUP`) and its verify command (`AGENT_VERIFY`), each passed,
 * failed with its exit code and the end of its output, skipped and why, or
 * timed out; and the commit it checked, read at the checkout's head. Then
 * `agent:setup-check` off, so the label is on exactly while the check runs.
 *
 * Both writes are tolerated: a report GitHub refuses is a warning, and the
 * label still comes off, since a check left labelled would be run again by
 * the next scan to fail to post again. It adds no `agent:blocked`: a check
 * that fails has found what it was asked to find.
 */
export const report = async (inputs: Inputs, io: Io): Promise<void> => {
  const issue = issueNumber(inputs.ISSUE_NUMBER);
  const sha = inputs.CHECKOUT_RESULT === "passed" ? headOf(inputs.CHECKOUT) : undefined;
  const body = setupCheckReport(inputs, sha);

  const { workflow } = io.writers(LIMITS);
  await tolerated(`Could not post the setup check's report on #${issue}.`, () => workflow.comment(issue, body));
  await tolerated(`Could not take \`${SETUP_CHECK_LABEL}\` off #${issue}.`, () => workflow.removeLabel(issue, SETUP_CHECK_LABEL));
};

/** What the report may write, and how many (ADR 0005): its comment, and its own label off. */
const LIMITS: Limits = { comment: 1, removeLabel: 1 };

/**
 * The commit `checkout` is at, or `undefined` where it cannot be read: the
 * report then says the checkout passed without naming one, rather than not
 * posting.
 */
const headOf = (checkout: string): string | undefined => {
  if (checkout === "") return undefined;
  try {
    return execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: checkout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    console.log(`::warning::The commit checked out in ${checkout} could not be read, so the report names none.`);
    return undefined;
  }
};

type StepResult = Inputs["SETUP_RESULT"];

/** One of the two sandboxed steps, as the report names it and the variable it runs. */
interface Step {
  readonly name: "Setup" | "Verify";
  readonly variable: "AGENT_SETUP" | "AGENT_VERIFY";
  readonly result: StepResult;
  readonly exit: string;
  readonly output: string;
}

/** The report's comment, from the worker's hand-over and the commit read at the checkout's head. */
const setupCheckReport = (inputs: Inputs, sha: string | undefined): string => {
  const base = `\`${inputs.BASE_REF}\``;
  const at = sha === undefined ? base : `${base} at ${sha}`;
  const setup: Step = { name: "Setup", variable: "AGENT_SETUP", result: inputs.SETUP_RESULT, exit: inputs.SETUP_EXIT, output: inputs.SETUP_OUTPUT };
  const verify: Step = { name: "Verify", variable: "AGENT_VERIFY", result: inputs.VERIFY_RESULT, exit: inputs.VERIFY_EXIT, output: inputs.VERIFY_OUTPUT };
  const limit = inputs.TIMEOUT_MINUTES === "" ? "its time limit" : `its time limit, ${inputs.TIMEOUT_MINUTES} minutes`;

  const checkoutLine =
    inputs.CHECKOUT_RESULT === "passed"
      ? `- **Checkout** of ${base}: passed${sha === undefined ? "" : `, at ${sha}`}.`
      : inputs.CHECKOUT_RESULT === "timed-out"
        ? `- **Checkout** of ${base}: timed out: it did not finish within ${limit}.`
        : `- **Checkout** of ${base}: failed: ${sentence(inputs.CHECKOUT_REASON === "" ? "it gave no reason" : clean(inputs.CHECKOUT_REASON))}`;

  const steps = [checkoutLine, stepLine(setup, inputs, limit), stepLine(verify, inputs, limit)];
  return [`${headline(inputs, setup, verify, at)}`, "", ...steps, "", `[Run](${inputs.RUN_URL}) · To check again, add \`${SETUP_CHECK_LABEL}\` again.`, ""].join("\n");
};

/** The report's first line: the label, how the check ended, and what it checked. */
const headline = (inputs: Inputs, setup: Step, verify: Step, at: string): string => {
  const label = `\`${SETUP_CHECK_LABEL}\``;
  if (inputs.CHECKOUT_RESULT !== "passed") {
    return `**${label} ${inputs.CHECKOUT_RESULT === "timed-out" ? "timed out" : "failed"}:** ${at} could not be checked out, so neither the setup nor the verify command ran. No agent was started.`;
  }
  const stopped = [setup, verify].find((step) => step.result === "failed" || step.result === "timed-out");
  if (stopped !== undefined) {
    const how = stopped.result === "timed-out" ? "did not finish" : "failed";
    return `**${label} ${stopped.result === "timed-out" ? "timed out" : "failed"}:** ${stopped.name === "Setup" ? "the setup" : "the verify command"} (\`${stopped.variable}\`) ${how} on ${at}, in the sandbox. No agent was started.`;
  }
  if (verify.result === "unset") {
    return `**${label} incomplete:** ${setup.result === "unset" ? "nothing was set up and nothing verified" : "the setup passed, but nothing verified it"} on ${at}: \`AGENT_VERIFY\` is unset. No agent was started.`;
  }
  return `**${label} passed:** ${setup.result === "unset" ? "the verify command passed" : "the setup and the verify command passed"} on ${at}, in the sandbox. No agent was started.`;
};

/** One sandboxed step's line. */
const stepLine = (step: Step, inputs: Inputs, limit: string): string => {
  const named = `- **${step.name}** (\`${step.variable}\`)`;
  switch (step.result) {
    case "passed":
      return `${named}: passed.`;
    case "timed-out":
      return `${named}: timed out: it did not finish within ${limit}.`;
    case "unset":
      return step.variable === "AGENT_SETUP"
        ? `${named}: skipped: \`AGENT_SETUP\` is unset, so nothing was installed before the verify command.`
        : `${named}: skipped: \`AGENT_VERIFY\` is unset. Set it to the command that checks this repository, as a repository variable (\`gh variable set AGENT_VERIFY --body "npm test"\`, or the repository's *Settings → Secrets and variables → Actions → Variables*), and add \`${SETUP_CHECK_LABEL}\` again.`;
    case "not-run":
      return `${named}: not run, since ${notRunBecause(step, inputs)}.`;
    case "failed":
      return `${named}: failed${step.exit === "" ? ": it could not be started in the sandbox" : `, with exit code ${step.exit}`}. ${quoted(step.output)}`;
  }
};

/** Why a step was not run: the step before it did not pass. */
const notRunBecause = (step: Step, inputs: Inputs): string => {
  if (inputs.CHECKOUT_RESULT !== "passed") return "the checkout did not finish";
  if (step.variable === "AGENT_VERIFY") return inputs.SETUP_RESULT === "timed-out" ? "the setup timed out" : "the setup failed";
  return "the checkout did not finish";
};

/** The end of a step's output, fenced so nothing in it renders, or that it wrote none. */
const quoted = (output: string): string => {
  const text = clean(output).trimEnd();
  if (text === "") return "It wrote no output.";
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(longest + 1);
  return `The end of its output:\n\n  ${fence}\n${text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")}\n  ${fence}`;
};

/** A reason as the end of a sentence: closed with a full stop where it has no closing punctuation of its own. */
const sentence = (reason: string): string => {
  const trimmed = reason.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};
