import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import {
  fail,
  fetchTrustedComments,
  fetchTrustedIssue,
  git,
  readInputs,
  readLoopAccounts,
  scrubGitHubTokens,
  writers,
} from "../shared/common.js";
import { agentSandbox, claudeAgent } from "../shared/agent.js";
import { RUNNERS } from "../shared/contract.js";
import { rescueRef, resumeFromRescue, resumeSection } from "../shared/rescue.js";
import { staleFailure, staleReason } from "../shared/stale.js";

const INPUTS = readInputs(RUNNERS["implement"].inputs);
/** Chosen at start, so a sandbox that cannot run the agent stops the run before any of its work. */
const SANDBOX = agentSandbox(INPUTS);
const LOOP_ACCOUNTS = readLoopAccounts(INPUTS.AGENT_LOOP_LOGINS);
const { writeJson } = writers(RUNNERS["implement"].outputs);

const ISSUE_NUMBER = INPUTS.ISSUE_NUMBER;
const ISSUE_TITLE = INPUTS.ISSUE_TITLE;
const BRANCH = INPUTS.BRANCH;
/**
 * The branch `BRANCH` was cut from, this run, in the step before this one. Two
 * uses: the prompt says what the agent's branch is based on, and the commit
 * count below measures against it.
 *
 * Required, and an input rather than the literal `main` it once was —
 * this was the only unconditional `main` in a runner rather than in YAML, and
 * the only one that *hard-errored*: a repo whose default branch is `master` got
 * all the way through the agent run and then aborted on a ref that does not
 * exist (docs/ADOPTING.md §5).
 */
const BASE_REF = INPUTS.BASE_REF;

/**
 * Where a run of this issue that stopped before it finished left its commits
 * (#270), and where this one looks for them to resume from. Keyed to the
 * issue's number, so a retitled issue, whose `BRANCH` is named afresh, still
 * finds it.
 */
const RESCUE_BRANCH = INPUTS.RESCUE_BRANCH;

try {
  // Read the issue here and pass it in, rather than letting the agent shell out
  // to `gh`. SECURITY: title/body and comments are author-gated to repo
  // collaborators — never world-writable `--comments`. A maintainer can steer
  // the agent with a comment; a non-collaborator's text is dropped. Collaborator
  // comments are included even when the issue body is withheld, so a maintainer
  // can annotate a community-reported issue.
  const issue = fetchTrustedIssue(INPUTS.GH_REPO, ISSUE_NUMBER, LOOP_ACCOUNTS);
  const comments = fetchTrustedComments(INPUTS.GH_REPO, ISSUE_NUMBER, LOOP_ACCOUNTS);
  const parts = [
    issue.trusted
      ? `# ${issue.title || ISSUE_TITLE}\n\n${issue.body || "(no description)"}`
      : `Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}\n\n(Issue body withheld: the issue author is not a repo collaborator.)`,
  ];
  if (comments) parts.push(`## Collaborator comments\n\n${comments}`);
  const issueContext = parts.join("\n\n");

  // Context fetched; the agent has no legitimate use for the GitHub token.
  scrubGitHubTokens();

  // An earlier run's unpushed commits (#270), where they still build on the
  // base this run's branch was created at. Set aside, and said so on the
  // issue by `implement:conclude`, where the base moved since they were
  // saved: handed over as the branch and its tip, the commit this run moved
  // past.
  const resume = resumeFromRescue(RESCUE_BRANCH);
  if (resume.kind === "resumed") {
    console.log(`Resuming from ${resume.commits} commit(s) an earlier run saved on ${RESCUE_BRANCH}.`);
  } else if (resume.kind === "ignored") {
    console.log(`::warning::${RESCUE_BRANCH} was saved on an older ${BASE_REF}, so this run starts fresh.`);
    writeJson("rescue_ignored.json", { branch: RESCUE_BRANCH, movedPast: git(["rev-parse", rescueRef(RESCUE_BRANCH)]).trim() });
  }

  const result = await sandcastle.run({
    name: `implement-#${ISSUE_NUMBER}`,
    agent: claudeAgent("implement", INPUTS),
    ...SANDBOX,
    logging: { type: "stdout" },
    promptFile: path.join(import.meta.dirname, "prompt.md"),
    promptArgs: {
      ISSUE_NUMBER,
      ISSUE_TITLE,
      BRANCH,
      BASE_REF,
      ISSUE_CONTEXT: issueContext,
      RESUME: resumeSection(resume, RESCUE_BRANCH),
    },
    maxIterations: 1,
  });

  // Before the commit count, and whatever it finds: an agent that says the
  // issue no longer matches the code has said no pull request should open.
  const stale = staleReason(result.stdout);
  if (stale !== undefined) fail(staleFailure(`issue #${ISSUE_NUMBER}`, stale));

  // argv, not a command string: a ref may legally contain `` ` ``, `$()`, `;`,
  // `|` and `&`, and `git()` runs `execFileSync` so this one arrives unparsed.
  // It used to be an `sh()` call with the base branch written into it as a
  // literal, where the question could not arise.
  const commitsAhead = Number(git(["rev-list", "--count", `${BASE_REF}..HEAD`]).trim());
  if (!Number.isFinite(commitsAhead) || commitsAhead === 0) {
    fail("The agent finished without making any changes.");
  }

  console.log(`Implementation produced ${commitsAhead} commit(s) on ${BRANCH}.`);
  console.log(`Commits this run: ${result.commits.length}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
