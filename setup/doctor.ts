import { safeGh, writeText } from "../shared/common.js";
import { PACKAGE_NAME } from "../shared/manifest.js";
import {
  passesSecret,
  PRD_BRANCH_EXAMPLE,
  readInstalledCallers,
  readOtherWorkflows,
  repoSlug,
  selfCheckFor,
  selfCheckMatches,
  type InstalledCaller,
  type OtherWorkflow,
} from "./callers.js";
import { labelCommand, labelSpecsFor } from "./init.js";
import {
  asVisibility,
  policyBody,
  policyCommand,
  POLICY_SETTINGS,
  readPolicies,
  triggeredFiles,
  unallowedFiles,
  unreadable,
  type ActionsPolicy,
} from "./policies.js";
import type { CliIo } from "../cli.js";

/**
 * The preflight: every check here is a failure `docs/ADOPTING.md` §1 describes
 * as announcing itself as something else. None of them errors on its own, which
 * is the whole reason to look for them on purpose — a missing `packages: read`
 * reads as a bad token, a missing `AGENT_PAT` reads as a working loop, and a
 * `self-check` that names a check run the job does not produce reads as a slow CI.
 *
 * Two halves, deliberately separated:
 *
 * - **`gatherFacts`** asks GitHub the questions a checkout cannot answer — which
 *   secrets are set, whether Actions may open pull requests, what the default
 *   `GITHUB_TOKEN` grants a job that asks for nothing, which labels exist, which Actions policies apply,
 *   what the fix-round budget and time limit variables hold, and what this package's latest release is. Every one of them can come back
 *   unreadable (no `gh`, no auth, no admin), and an unreadable answer is
 *   reported as unknown rather than folded into a pass.
 * - **`diagnose`** rules on the callers and those facts and nothing else. It is
 *   pure for the reason `shared/pins.ts` is: the policy is the part worth
 *   holding still, and a diagnosis that can only be exercised against a live
 *   repository is one whose failures nobody has ever seen.
 */

export type Severity = "error" | "warning";

export interface Finding {
  readonly severity: Severity;
  /** Short, stable, and the thing to grep a run's log for. */
  readonly check: string;
  readonly problem: string;
  /** What to do about it. A finding with no fix is a complaint. */
  readonly fix: string;
}

/**
 * What `gh` answered. Every field is optional in the strongest sense — an
 * `undefined` means *not known*, never *not there*, and the two must not
 * collapse: "no secrets are set" and "you are not an admin of this repository"
 * lead to opposite actions.
 */
export interface RepoFacts {
  /**
   * Every Actions secret a workflow here can read: this repository's own, and
   * the organization secrets shared with it. Two endpoints, one answer —
   * `repos/{owner}/{repo}/actions/secrets` is the repository's alone, and an
   * organization that holds one Claude token and one bot PAT centrally answers
   * it with nothing at all.
   */
  readonly secrets: readonly string[] | undefined;
  /** Settings → Actions → General → Allow GitHub Actions to create … pull requests. */
  readonly canCreatePullRequests: boolean | undefined;
  /**
   * Settings → Actions → General → Workflow permissions: what a job that
   * declares no `permissions:` block anywhere actually runs with. `"write"` is
   * the permissive default — every scope, write — and `"read"` the restricted
   * one, worded on that page as "read repository contents and packages
   * permissions", which is the whole of it.
   */
  readonly defaultWorkflowPermissions: "read" | "write" | undefined;
  readonly labels: readonly string[] | undefined;
  /**
   * Ruled on by no grant since #146: the elevation refusal fires wherever the
   * repository sits, so the one severity that turned on this (a public
   * repository being served the check-runs API without `checks: read`) has no
   * basis. The grant scenarios in `tests/agent-cli.test.ts` set both spellings
   * and insist the verdict is identical.
   *
   * It decides one thing again since #219: GitHub's default rule blocks
   * `pull_request_target` on a **public** repository with no event policy
   * allowing it, and leaves a private or internal one alone.
   */
  readonly visibility: "public" | "private" | undefined;
  /**
   * Every Actions policy that applies here, this repository's own and its
   * parents'. `undefined` where the list could not be read, which is never "no
   * policy": the first is a thing to check and the second an error. An entry is
   * `undefined` where that one policy could not be read, on the same terms.
   */
  readonly actionsPolicies: readonly (ActionsPolicy | undefined)[] | undefined;
  /** This package's tags, newest first — what a pin is measured against. */
  readonly releases: readonly string[] | undefined;
  /**
   * The fix-round budget variable, `AGENT_MAX_FIX_ROUNDS` (#204): its value,
   * `null` where it is set nowhere a workflow here can read it, and `undefined`
   * where that could not be known. Three states, because "unset" is the
   * default budget of 3 and "unreadable" is no budget anybody knows.
   */
  readonly maxFixRounds: string | null | undefined;
  /**
   * The time limit variables (#220), keyed by name: each one's value, or `null`
   * where it is set nowhere. `undefined` as a whole where the variables could
   * not be listed; they are read from the same lists, so they are known or
   * unknown together.
   */
  readonly timeoutMinutes: Readonly<Record<string, string | null | undefined>> | undefined;
}

/** The repository variable the review reads its fix-round budget from (#201). */
export const FIX_ROUNDS_VARIABLE = "AGENT_MAX_FIX_ROUNDS";

/**
 * The budget the review applies where the variable is set nowhere. A second
 * copy of the review's own `${MAX_FIX_ROUNDS:-3}`, held equal to it by a test.
 */
export const DEFAULT_FIX_ROUNDS = 3;

/** The test the review's budget step applies to the variable, and no looser. */
const COUNT = /^[0-9]+$/;

/**
 * The repository variables a job's time limit is read from (#220), the
 * workflows whose jobs read each, and the default where it is unset: a second
 * copy of each workflow's own, held equal to it by a test.
 */
export const TIMEOUT_VARIABLES = [
  {
    name: "AGENT_TIMEOUT_MINUTES",
    workflows: ["implement", "implement-prd", "fix", "update-branch"],
    defaultMinutes: 30,
    // Read straight into `timeout-minutes`, where a value GitHub cannot read as
    // a number fails the job before its first step.
    consequence:
      "the four jobs that write code read it straight into their `timeout-minutes`, so every one " +
      "of them fails before its first step: no comment, and the label left on",
    meaning: "the minutes an implement, fix or update-branch run may take",
  },
  {
    name: "AGENT_REVIEW_TIMEOUT_MINUTES",
    workflows: ["review"],
    defaultMinutes: 5,
    consequence: "every review refuses to start, naming it",
    meaning: "the minutes a review may take beyond its 15-minute CI wait",
  },
] as const;

/**
 * The test a time limit is held to: a positive integer, and written as JSON
 * writes one, since the agent jobs read it through `fromJSON`, which refuses a
 * leading zero.
 */
const MINUTES = /^[1-9][0-9]*$/;

/**
 * An input value GitHub works out at run time: any `${{`, anywhere in the
 * string, makes the whole of it an expression. What it comes to is not in the
 * caller, so `doctor` can say neither the budget it sets nor that the review
 * refuses it.
 */
const isExpression = (value: string): boolean => value.includes("${{");

/**
 * The reusable halves that declare **no secrets at all**, and so have no wire
 * for a caller to get wrong.
 *
 * `diagnose` rules on a fixed list and reads nothing out of `examples/callers/`,
 * so a release that changes the *shape* of a caller is a release that teaches
 * this file about it in the same commit (`CONTEXT.md`). `follow-ups` (#50) is
 * the first such shape: it runs no model, so it takes no
 * `CLAUDE_CODE_OAUTH_TOKEN`, and it creates its issues with the workflow token,
 * so it takes no `AGENT_PAT` either — the loop PAT is optional everywhere, and a
 * filing step that depended on it would file nothing at all on a repository
 * without one.
 *
 * Without this entry the wiring check below would tell an adopter to add a
 * secret the called workflow does not declare, which GitHub refuses outright:
 * a fix that breaks a working loop, which is the one thing a preflight must
 * never produce.
 */
const SECRETLESS_WORKFLOWS: ReadonlySet<string> = new Set(["follow-ups"]);

/** An exact release tag, or a full commit SHA. Nothing that can move. */
const TAG = /^v?\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;

const semver = (tag: string): readonly number[] =>
  (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag)?.slice(1) ?? ["0", "0", "0"]).map(Number);

const compareVersions = (a: string, b: string): number => {
  const [left, right] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i += 1) {
    const difference = (right[i] ?? 0) - (left[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/**
 * Which permission each reusable half needs from its caller, and what that
 * scope buys — which is the part no YAML states.
 *
 * Every row is a cell of a table written twice already, and this is the third
 * copy: the reusable half's own `permissions:` is the **ceiling** — the
 * authoritative statement of what that job spends — and the reference caller's
 * block is the **grant**, held equal to the ceiling in `tests/workflows.test.ts`
 * because a called workflow can only downgrade the token it is handed. A third
 * copy has to exist, because only `dist` ships and a preflight cannot read
 * `examples/callers/` out of a tarball it is not in; what keeps it from drifting
 * is `tests/agent-cli.test.ts`, which derives this table from those ceilings and
 * fails by name when any of the three disagree.
 *
 * So the column worth reading here is `why`, and a row is therefore one `why`
 * rather than one scope. `pull-requests: write` is two rows because
 * `follow-ups` spends it on a pull request that is already closed, where none of
 * the transition-step account the other five get is true; a single row covering
 * both would be an explanation that is wrong wherever it is not the one the
 * reader needs.
 *
 * **There is no severity column, and its absence is a finding rather than a
 * simplification.** Until #146 every row carried one: how its absence presented
 * — a 403 on the call the scope is spent on, softened to a warning where a
 * public repository was served that call anyway, or where no call was known to
 * need the scope at all. Every one of those accounts described the unsplit
 * shape, where the grant and the job were one file and a short grant cost the
 * call. Split, the caller's block is the ceiling for every job it calls and
 * GitHub refuses an elevation by refusing the **workflow file**: the run is a
 * `startup_failure` before any job starts, and the step the scope is spent on is
 * never reached. Probed on a real token across four scopes, both a missing line
 * and an explicit `none`, and a caller with no block at all against a restricted
 * default — every one refused at startup, none of them reaching a step.
 *
 * So every missing grant is an **error**, for a reason that belongs to the call
 * chain rather than to the scope: no row can argue itself down to a warning, and
 * the sentence saying why is written once, in `diagnose`, rather than eleven
 * times here.
 *
 * For four releases this list held two of the nine rows, and the seven it
 * skipped failed the same way the two it caught did: a caller that looked
 * complete, and a failure naming neither the scope nor the file — a 403 reading
 * `Resource not accessible by integration` then, on a step whose own name was
 * about labels or about a push (#45); a run with no job log in it now. The
 * refusal does name both, in an annotation on a run page nobody is watching
 * until they wonder why a label did nothing.
 */
export const REQUIRED_PERMISSIONS: readonly {
  readonly permission: string;
  readonly value: string;
  readonly workflows: readonly string[] | "all";
  readonly why: string;
}[] = [
  {
    permission: "packages",
    value: "read",
    workflows: "all",
    why:
      "the runner is installed from GitHub Packages, which has no anonymous install even for a " +
      "public package, so every job in the loop spends this one before it does anything else. It " +
      "is the only row that is not about what its workflow does",
  },
  {
    permission: "pull-requests",
    value: "write",
    workflows: ["review", "fix", "update-branch", "implement", "implement-prd"],
    why:
      "on `review`, `fix` and `update-branch` it is the label transition, `gh pr edit`, that " +
      "hands the pull request to the next workflow in the loop. The two implement halves " +
      "transition an *issue* and spend this scope on the pull request they open and mark ready, " +
      "and on `implement`'s preflight `gh pr list`. Required whether or not `AGENT_PAT` is set: " +
      "the PAT decides which token some of those calls use, not whether the job is allowed to " +
      "make them (`docs/ADOPTING.md` §4)",
  },
  {
    permission: "pull-requests",
    value: "write",
    workflows: ["follow-ups"],
    why:
      "this job transitions no label and checks nothing out, so the account in the row above is " +
      "not what happens here. It reads the marker and the reviews off a pull request that is " +
      "already merged and closed, and spends the write on the two calls that end the run: the " +
      "report saying what was filed, and the removal of the `agent:follow-ups` marker that " +
      "carries the state, which therefore stays and makes a retry a label removed and added by " +
      "hand. The failure comment this workflow would post to say so is a `gh pr comment` too",
  },
  {
    permission: "contents",
    value: "write",
    workflows: ["implement", "implement-prd", "fix", "update-branch"],
    why:
      "the branch this job produces is committed and pushed, and the whole agent pass is spent " +
      "before the push. Required whether or not `AGENT_PAT` is set: the checkout pushes under " +
      "the PAT where there is one, so the PAT decides which token pushes rather than whether " +
      "the job may (`docs/ADOPTING.md` §4)",
  },
  {
    permission: "issues",
    value: "write",
    workflows: ["implement", "implement-prd"],
    why:
      "the issue's labels are transitioned from this job — `agent:in-progress` above the " +
      "checkout, and the `agent:blocked` and reason it leaves when it stops — its outcome is " +
      "commented on the issue, and the PRD chain closes the sub-issue it finished in order to " +
      "advance",
  },
  {
    permission: "issues",
    value: "write",
    workflows: ["follow-ups"],
    why:
      "this is the grant the workflow exists for: it files the review's recorded out-of-scope " +
      "findings as issues, with the workflow token rather than the PAT. Creation is the whole of " +
      "what it spends the grant on since #82 — a related issue is linked from the stub being " +
      "filed rather than commented on, so nothing here writes to an issue it did not open. " +
      "Nothing here is waited on either: the whole run happens after a merge, and what would " +
      "report a problem with it is a comment on a pull request that is already closed",
  },
  {
    permission: "checks",
    value: "read",
    workflows: ["review"],
    why:
      "the CI wait polls the check-runs API, which a **public** repository serves without the " +
      "scope. That is why the grant was missing from v0.1.0 through v0.1.4 and why it still reads " +
      "as optional there; the review job declares it, so the caller's half is not optional on a " +
      "public repository either and your repository's visibility decides nothing about this " +
      "finding (#146)",
  },
  {
    permission: "actions",
    value: "read",
    workflows: ["review"],
    why:
      "the CI wait reads the commit's workflow runs, which is the only place a CI run that is " +
      "queued or waiting for approval shows: it has created no check run yet. Newer than every " +
      "other grant on this caller (#221), so a caller installed before that release looks " +
      "complete, and a push made with `GITHUB_TOKEN` starts exactly such a run",
  },
  {
    permission: "statuses",
    value: "write",
    workflows: ["review"],
    why:
      "the review's verdict — what to do about it next — is posted as an `agent-review` commit " +
      "status on the reviewed commit, and a status is its own scope rather than part of " +
      "`pull-requests: write`. The step that posts it warns rather than failing, on the grounds " +
      "that a posted review is worth more than the line summarising it — so where the token is " +
      "short for some other reason the loop looks like one whose verdicts are switched off, and " +
      "nothing on the pull request says otherwise",
  },
  {
    permission: "statuses",
    value: "write",
    workflows: ["update-branch"],
    why:
      "a clean refresh copies the review's verdict from the old head on to the merge commit it " +
      "creates, because a commit status belongs to a commit and the new one carries none until " +
      "something posts it. That copy is what stops every refresh of a reviewed pull request " +
      "quietly costing a review round, and the step makes it a warning rather than a failure " +
      "because the merge is pushed by the time it runs",
  },
  {
    permission: "statuses",
    value: "read",
    workflows: ["implement-prd"],
    why:
      "the slices table records each slice's `agent-review` verdict, read from the merged " +
      "commit's status, and a status is its own scope rather than part of `contents` or " +
      "`pull-requests`. The read happens on the run after a slice's review round ends, once the " +
      "slice is already merged into the PRD branch, so a job short of it merges the slice and " +
      "then stops the chain before its row is written (#199)",
  },
  {
    permission: "contents",
    value: "write",
    workflows: ["review"],
    why:
      "the review's `resolve` job closes the threads the review verified, and GitHub refuses " +
      "`resolveReviewThread` to a token without it (#133). Only that job spends the write: it " +
      "checks nothing out and runs no agent, and the review job narrows the grant back to " +
      "`read`, so a review still cannot touch the branch. Newer than every other grant on this " +
      "caller, so a caller installed before that release holds `contents: read` and looks " +
      "complete",
  },
  {
    permission: "contents",
    value: "read",
    workflows: ["follow-ups"],
    why:
      "nothing in this job reads the repository and nothing is checked out, so this grant buys " +
      "no call — it is the level the job declares, and that is the whole of why it is needed. A " +
      "`permissions:` block replaces the token rather than adding to it, so leaving the line out " +
      "sets `contents: none`, which is less than `read` and is refused like any other shortfall " +
      "(#146, probed)",
  },
];

/**
 * `permissions: write-all` and `read-all` are a *string* where the block is
 * usually a map, and `callersIn` reports them under `*`. Granted is granted —
 * telling someone to add `packages: read` to a job that already holds every
 * read scope is a wrong diagnosis, which is the one thing a preflight cannot
 * afford to produce.
 */
const missingPermission = (
  caller: InstalledCaller,
  permission: string,
  value: string,
): boolean => {
  const all = caller.permissions["*"];
  if (all === "write-all" || (all === "read-all" && value === "read")) return false;

  const held = caller.permissions[permission];
  return held !== value && held !== "write";
};

/**
 * What a shortfall costs, in the words of the thing that does it — and the
 * reason every grant above is an error rather than a judgement per scope.
 *
 * Where an adopter finds it matters as much as what it says. `gh run view`
 * prints only *This run likely failed because of a workflow file issue*, naming
 * neither the scope nor the file; the annotation on the run page names both.
 * Recorded from a real refusal (#146), which is also why this does not quote the
 * message: the annotation names the **called** job, which this table does not
 * know, and a quote with the wrong job id in it is worse than a paraphrase.
 *
 * It is appended to two findings with different subjects, so it names the short
 * scope by description rather than as "this scope". A grant finding has just
 * named one; the no-`permissions:`-block finding has just named the two the
 * restricted default *does* grant, and "this scope" there points an adopter at
 * `contents` or `packages` when the annotation will name whichever one the job
 * declares and they do not hold.
 */
const REFUSED =
  `A called job cannot hold more than its caller granted, and GitHub refuses the elevation rather ` +
  `than trimming it: this fails the whole run before any job starts, as an *Invalid workflow file* ` +
  `annotation on the run page naming the scope that is short — which \`gh run view\` reports only ` +
  `as a workflow file issue, and which no job log records at all.`;

/**
 * Rule on the installed callers, the workflows beside them and the facts. Pure:
 * everything it needs has already been read, and everything it cannot know
 * arrives as `undefined`.
 */
export const diagnose = (
  callers: readonly InstalledCaller[],
  facts: RepoFacts,
  others: readonly OtherWorkflow[],
  packageName: string = PACKAGE_NAME,
): readonly Finding[] => {
  const findings: Finding[] = [];
  const add = (finding: Finding): void => {
    findings.push(finding);
  };

  if (callers.length === 0) {
    return [
      {
        severity: "error",
        check: "callers",
        problem: `No workflow under .github/workflows calls ${repoSlug(packageName)}.`,
        fix: `Run \`init\` to copy the reference callers in, then re-run this.`,
      },
    ];
  }

  const hasPat = facts.secrets?.includes("AGENT_PAT");

  for (const { permission, value, workflows, why } of REQUIRED_PERMISSIONS) {
    for (const caller of callers) {
      if (workflows !== "all" && !workflows.includes(caller.workflow)) continue;
      // A job with no `permissions:` block anywhere holds whatever the
      // repository's default token holds, which is a different question with a
      // different answer and a different fix — ruled on once below rather than
      // per scope. Reading it as "grants nothing" is how a working loop gets
      // told to add a line it does not need: **both** defaults grant
      // `packages: read`, and a job-level block naming only that would replace
      // the inherited token and drop everything else it holds.
      if (caller.permissionsFrom === "none") continue;
      if (!missingPermission(caller, permission, value)) continue;

      // A grant can be short in two ways, and they do not take the same
      // sentence. An **absent** line is added. A line that is present at a
      // weaker value is *changed*: told to add one it already has, an adopter
      // ends up with two `contents:` keys in one block, which GitHub's workflow
      // parser refuses outright — a `startup_failure` with no job log, which is
      // the state this row exists to prevent rather than to cause.
      //
      // Not hypothetical, and the reason the distinction arrived with #133:
      // `contents: write` on a review caller is the first row here whose
      // failure is a wrong value rather than a missing line, and every caller
      // installed before it has `contents: read` written out.
      //
      // A blanket `write-all` / `read-all` is a string rather than a map, so it
      // names no scope and lands on the *absent* arm. That wording is no better
      // there than it was before, and no worse; what such a caller needs is the
      // block rewritten as a map, which is not this row's to say.
      const held = caller.permissions[permission];
      const block =
        caller.permissionsFrom === "workflow"
          ? "the workflow's top-level `permissions:` block"
          : "that job's `permissions:` block";
      // Said on both arms where it applies: a job that inherits and is told to
      // edit "its own" block would be told to create one, replacing the
      // top-level block and losing every grant in it.
      const inherited =
        caller.permissionsFrom === "workflow"
          ? ` The \`${caller.jobId}\` job declares none of its own, and a job-level block replaces the top-level one rather than adding to it.`
          : ``;
      add({
        // Every one of them, wherever the repository sits and whatever else is
        // configured. A called workflow can only *downgrade* the token it is
        // handed, and GitHub does not trim the job to fit what it was handed:
        // it refuses the elevation by refusing the workflow file, so the run is
        // a `startup_failure` and the step the scope is spent on never happens
        // (#146). There is no scope for which that is a warning.
        severity: "error",
        check: `${permission}: ${value}`,
        problem:
          (held === undefined
            ? `${caller.file} grants the \`${caller.jobId}\` job no \`${permission}: ${value}\` — ${why}.`
            : `${caller.file} grants the \`${caller.jobId}\` job \`${permission}: ${held}\` where it needs \`${permission}: ${value}\` — ${why}.`) +
          // Said on every one of them rather than carried per row: it is one
          // statement about the call chain, and eleven copies of it in the
          // table above would be eleven places for it to go stale.
          ` ${REFUSED}`,
        fix:
          held === undefined
            ? `Add \`${permission}: ${value}\` to ${block}.${inherited}`
            : `Change \`${permission}: ${held}\` to \`${permission}: ${value}\` in ${block} — the line is already there, and a second \`${permission}:\` key in one block is a workflow GitHub refuses to parse.${inherited}`,
      });
    }
  }

  // The callers that write no `permissions:` block at all — neither on the job
  // nor above `jobs:` — and so run with the repository's default `GITHUB_TOKEN`.
  //
  // Which of the two defaults is set decides everything here, and it is why the
  // scope rows above skip these callers rather than reporting each grant
  // missing. The permissive default is every scope at write, so it under-grants
  // nothing and there is genuinely nothing to say. The restricted one is
  // `contents` and `packages` read, which is less than every job in this loop
  // declares — and #146's third case settled what that costs: the default token
  // is the ceiling like any other, so the run is refused at startup rather than
  // running on what the default holds.
  //
  // One finding about the block, not a list of scopes, because the fix is the
  // whole block either way: a job-level one replaces the inherited token rather
  // than adding to it, so naming a single scope is how an adopter loses the rest.
  for (const caller of callers) {
    if (caller.permissionsFrom !== "none") continue;
    if (facts.defaultWorkflowPermissions === "write") continue;

    // Unreadable is a warning rather than an error, and it is the one fact
    // here that still changes a severity: erring the other way would exit 1 on
    // a repository whose default is the permissive one and whose loop works,
    // on a fact nobody could read.
    const unknown = facts.defaultWorkflowPermissions === undefined;
    add({
      severity: unknown ? "warning" : "error",
      check: "permissions block",
      problem:
        `${caller.file} declares no \`permissions:\` block — neither on the \`${caller.jobId}\` ` +
        `job nor above \`jobs:\` — so the job runs with this repository's default ` +
        `\`GITHUB_TOKEN\`. The restricted default is \`contents\` and \`packages\` read and ` +
        `nothing else, which is less than the job this caller calls declares. ${REFUSED}` +
        (unknown
          ? ` This repository's default workflow permissions could not be read, so this is ` +
            `reported as something to check rather than as a fault — if the setting is the ` +
            `permissive one, every scope is granted and there is nothing to do.`
          : ``),
      fix:
        `Give the \`${caller.jobId}\` job a \`permissions:\` block naming every scope it needs. ` +
        `A block replaces the inherited token wholesale rather than adding to it, so copy the ` +
        `whole one from examples/callers/${caller.workflow}.yml rather than adding a single line.`,
    });
  }

  for (const caller of callers) {
    if (TAG.test(caller.ref) || SHA.test(caller.ref)) continue;
    add({
      severity: "error",
      check: "pin shape",
      problem:
        `${caller.file} is pinned to \`@${caller.ref}\`, which is not an exact tag or a SHA. ` +
        `\`pull_request_target\` hands the called workflow write access and your secrets, so a ` +
        `ref that moves is a job that changes under a pull request nobody touched.`,
      fix: `Pin an exact tag — \`@v<version>\` — or a full commit SHA.`,
    });
  }

  // Compared literally, and in full: the wait filters with
  // `select(.name != env.SELF_CHECK)`, so every byte of it counts. A
  // `self-check` naming only the caller's job is the shape somebody writes from
  // memory, `review/review` is the same thing with the spaces left out, and one
  // naming the wrong called job is what a renamed reusable leaves behind. All
  // three exclude nothing and none of them errors. `selfCheckFor` is the name
  // the job really produces — the calling job's display name, not its id — so
  // it is also the whole of the fix.
  for (const caller of callers) {
    if (selfCheckMatches(caller)) continue;
    add({
      severity: "error",
      check: "self-check",
      problem:
        `${caller.file} sets \`self-check: ${caller.selfCheck}\` on the \`${caller.jobId}\` job, ` +
        `which calls \`${caller.workflow}.yml\`. The check run that job produces is named ` +
        `\`${selfCheckFor(caller)}\` — \`<calling job's name> / <called job's name>\`, matched ` +
        `byte for byte — so the wait does not ` +
        `recognise its own and waits for itself before reviewing on degraded evidence.`,
      fix: `Set \`self-check: ${selfCheckFor(caller)}\`.`,
    });
  }

  // The wire, as distinct from the secret. A `workflow_call` job receives only
  // what its caller hands it — there is no inheritance without
  // `secrets: inherit` — and `AGENT_PAT` is declared optional by every reusable
  // half, so a caller that does not name it does not fail: the secret arrives
  // as the empty string and the `secrets.AGENT_PAT || secrets.GITHUB_TOKEN`
  // fallback on the other side absorbs it. The loop then runs under the
  // built-in token with the repository secret correctly set: a push whose
  // CI waits for approval, a label that fires no event, a pull request nothing
  // can mark ready. Three of §1's failures, from a line an adopter deleted rather than from
  // anything they failed to set, which is why the secrets row above cannot see
  // it.
  //
  // Only the optional secret is ruled on. `CLAUDE_CODE_OAUTH_TOKEN` is
  // `required: true` on every reusable half, so a caller that omits it is
  // refused by GitHub before the job starts — loud, and out of this command's
  // remit for the reason an absent `self-check` is.
  for (const caller of callers) {
    if (SECRETLESS_WORKFLOWS.has(caller.workflow)) continue;
    if (passesSecret(caller, "AGENT_PAT")) continue;

    const named =
      caller.secrets === undefined || caller.secrets === "inherit" ? [] : caller.secrets;
    // Where the secret is known not to be set, the row above is already the
    // error and this is the next thing to do rather than a second fault. Where
    // it could not be read, a set one is the case that costs something.
    const unset = facts.secrets !== undefined && !facts.secrets.includes("AGENT_PAT");
    add({
      severity: unset ? "warning" : "error",
      check: "secrets wiring",
      problem:
        `${caller.file} does not hand \`AGENT_PAT\` to \`${caller.workflow}.yml\` — the ` +
        `\`${caller.jobId}\` job ` +
        (named.length === 0
          ? `declares no \`secrets:\` block at all`
          : `passes only ${named.map((name) => `\`${name}\``).join(", ")}`) +
        `. A called workflow gets only what it is passed, and this one is optional there, so it ` +
        `arrives as the empty string and the job falls back to \`GITHUB_TOKEN\`: a push whose ` +
        `CI waits for approval, a label that fires no event, and a pull request nothing can mark ` +
        `ready. ` +
        `The secret being set is what makes that invisible.` +
        (unset
          ? ` \`AGENT_PAT\` is not set here either, so this is the wire to add once it is.`
          : ``),
      fix:
        `Add \`AGENT_PAT: \${{ secrets.AGENT_PAT }}\` to that job's \`secrets:\` block — or ` +
        `\`secrets: inherit\`, which hands the called workflow every secret this repository holds.`,
    });
  }

  // The fix-round budget (#201, #204). A review with budget left starts a fix
  // round itself by adding `agent:fix`, and without `AGENT_PAT` that label
  // fires no event: the review knows, and asks for the label on every verdict
  // instead, so no automatic round ever starts. The default counts, which makes
  // this true of every repository that set nothing and has no PAT.
  //
  // The budget is settled the way the review settles it: the deprecated
  // `auto-fix` input wins where a caller still passes it (`true` is 1, `false`
  // is 0), and otherwise the variable, 3 where it is unset. A value neither
  // would accept is no budget, and has its own finding below.
  //
  // A warning, because the loop itself is unharmed and the `AGENT_PAT` row is
  // already the error for the same secret. It reads `facts.secrets` directly
  // rather than `hasPat`: that is `undefined` in exactly the case this must not
  // rule on, and `!hasPat` would collapse it into the failing one. So is an
  // unreadable variable, which is not an unset one.
  const budgetOf = (caller: InstalledCaller): { rounds: number; from: string } | undefined => {
    if (caller.autoFix !== undefined) {
      if (isExpression(caller.autoFix)) return undefined;
      if (caller.autoFix === "true") return { rounds: 1, from: "`auto-fix: true`" };
      if (caller.autoFix === "false") return { rounds: 0, from: "`auto-fix: false`" };
      return undefined;
    }
    if (facts.maxFixRounds === undefined) return undefined;
    if (facts.maxFixRounds === null) return { rounds: DEFAULT_FIX_ROUNDS, from: "the default" };
    if (!COUNT.test(facts.maxFixRounds)) return undefined;
    return { rounds: Number(facts.maxFixRounds), from: `\`${FIX_ROUNDS_VARIABLE}\`` };
  };
  const reviews = callers.filter((caller) => caller.workflow === "review");
  if (facts.secrets !== undefined && !facts.secrets.includes("AGENT_PAT")) {
    for (const caller of reviews) {
      const budget = budgetOf(caller);
      if (budget === undefined || budget.rounds === 0) continue;
      add({
        severity: "warning",
        check: "fix rounds without a PAT",
        problem:
          `${caller.file}'s \`${caller.jobId}\` job reviews with a fix-round budget of ` +
          `${budget.rounds} (${budget.from}), so a review that recommends changes starts a fix ` +
          `round itself by adding \`agent:fix\`. \`AGENT_PAT\` is not set, and a label added with ` +
          `\`GITHUB_TOKEN\` fires no event, so no automatic fix round ever starts: every verdict ` +
          `asks for \`agent:fix\` by hand instead.`,
        fix:
          `Set \`AGENT_PAT\` (above), or set the repository variable \`${FIX_ROUNDS_VARIABLE}\` to ` +
          `\`0\` to say that fix rounds here are started by hand.`,
      });
    }
  }

  // A variable the review refuses (#201): not a non-negative integer, so every
  // review ends red before it starts, naming it. An error wherever a review
  // caller reads it, and a warning where every one still passes `auto-fix`,
  // which wins over it for one release and leaves it unread until the next.
  if (
    reviews.length > 0 &&
    typeof facts.maxFixRounds === "string" &&
    !COUNT.test(facts.maxFixRounds)
  ) {
    const read = reviews.some((caller) => caller.autoFix === undefined);
    add({
      severity: read ? "error" : "warning",
      check: "fix-round budget",
      problem:
        `The repository variable \`${FIX_ROUNDS_VARIABLE}\` is \`${facts.maxFixRounds}\`, which is ` +
        `not a non-negative integer. The review refuses it rather than guess a number of fix ` +
        `rounds, so ` +
        (read
          ? `every review fails before it starts.`
          : `every review will fail once \`auto-fix\`, which overrides it today, is gone.`),
      fix:
        `Set it to the number of automatic fix rounds a pull request may have (\`0\` for none), ` +
        `or delete it for the default of ${DEFAULT_FIX_ROUNDS}.`,
    });
  }

  // A time limit that is not a positive integer (#220). An error wherever a
  // caller whose job reads it is installed, and a warning where none is, since
  // nothing reads it yet. Unset is the default and unreadable is no finding.
  for (const variable of TIMEOUT_VARIABLES) {
    const value = facts.timeoutMinutes?.[variable.name];
    if (typeof value !== "string" || MINUTES.test(value)) continue;
    const read = callers.some((caller) => (variable.workflows as readonly string[]).includes(caller.workflow));
    add({
      severity: read ? "error" : "warning",
      check: "time limit",
      problem:
        `The repository variable \`${variable.name}\` is \`${value}\`, which is not a positive ` +
        `integer, so ` +
        (read ? `${variable.consequence}.` : `once a caller that reads it is installed, ${variable.consequence}.`),
      fix:
        `Set it to ${variable.meaning}, as a whole number with no leading zero, or delete it for the ` +
        `default of ${variable.defaultMinutes}.`,
    });
  }

  // `auto-fix`, deprecated (#201, PRD #200 decision 4). The review honours it
  // for one release, and the release after stops declaring it, which GitHub
  // answers by failing the whole caller at startup. A warning while it still
  // works, and an error where its value is one the review refuses already. A
  // `${{` expression is neither: what it comes to is settled at run time, so
  // it is only the deprecation this can speak to.
  for (const caller of reviews) {
    if (caller.autoFix === undefined) continue;
    const expression = isExpression(caller.autoFix);
    const rounds = caller.autoFix === "true" ? "1" : caller.autoFix === "false" ? "0" : undefined;
    const refused = rounds === undefined && !expression;
    add({
      severity: refused ? "error" : "warning",
      check: "auto-fix deprecated",
      problem:
        `${caller.file} passes \`auto-fix: ${caller.autoFix}\` on the \`${caller.jobId}\` job. ` +
        `The input is deprecated and goes in the next release, and a caller that passes an input ` +
        `the called workflow no longer declares fails before any job starts. ` +
        (refused
          ? `This value is neither \`true\` nor \`false\`, so the review refuses it today.`
          : expression
            ? `Until then, whatever it comes to at run time other than empty wins over ` +
              `\`${FIX_ROUNDS_VARIABLE}\`, and the review refuses anything but \`true\` or \`false\`.`
            : `Until then it wins over \`${FIX_ROUNDS_VARIABLE}\`.`),
      fix:
        `Remove \`auto-fix\` from that job's \`with:\` block and set the repository variable ` +
        (rounds === undefined
          ? `\`${FIX_ROUNDS_VARIABLE}\` to the number of automatic fix rounds a pull request may ` +
            `have (\`0\` for none, unset for ${DEFAULT_FIX_ROUNDS}).`
          : `\`${FIX_ROUNDS_VARIABLE}\` to \`${rounds}\`, which is what \`auto-fix: ` +
            `${caller.autoFix}\` does today; unset, it is ${DEFAULT_FIX_ROUNDS}.`),
    });
  }

  // CI on slice PRs (#209). The PRD chain opens each slice PR into its PRD
  // branch, and a CI whose `pull_request` trigger is filtered to the default
  // branch never runs on one. Nothing errors: review reads CI as unknown, a
  // clean slice lands on *Needs a closer look* and the chain parks at its first
  // slice, which is jeffwlawson/mealie-mcp-server#80.
  //
  // One workflow that runs is enough. An unreadable one could be it, so where
  // none is known to run and one could not be read this is a warning rather
  // than a pass or a fault.
  if (callers.some((caller) => caller.workflow === "implement-prd")) {
    const runs = others.some((workflow) => workflow.onSlicePrs === "runs");
    const unreadable = others.filter((workflow) => workflow.onSlicePrs === undefined);
    const filtered = others.filter((workflow) => workflow.onSlicePrs === "filtered out");
    const line = `branches: [main, 'agent/prd-**']`;
    if (!runs && unreadable.length > 0) {
      add({
        severity: "warning",
        check: "CI on slice PRs",
        problem:
          `${unreadable.map((workflow) => workflow.file).join(", ")} could not be read, and no other ` +
          `workflow here runs on a pull request into a PRD branch (\`${PRD_BRANCH_EXAMPLE}\`). ` +
          `If none does, every slice PR reads its CI as unknown and the PRD chain parks at its first slice.`,
        fix:
          `Check that your CI's \`pull_request\` trigger covers the PRD branches, one line: ` +
          `\`${line}\` (docs/ADOPTING.md, *Slice PRs and your CI*).`,
      });
    } else if (!runs) {
      add({
        severity: "error",
        check: "CI on slice PRs",
        problem:
          (filtered.length === 0
            ? `No workflow here other than the loop's own triggers on \`pull_request\`, so `
            : `${filtered.map((workflow) => workflow.file).join(", ")} ${filtered.length === 1 ? "filters" : "filter"} ` +
              `\`pull_request\` to branches that leave out the PRD branches (\`${PRD_BRANCH_EXAMPLE}\`), so `) +
          `nothing runs on a slice PR. Review reads its CI as unknown rather than green, a clean ` +
          `slice lands on *Needs a closer look*, and the PRD chain parks at its first slice.`,
        fix:
          filtered.length === 0
            ? `Give your CI a \`pull_request\` trigger that covers the PRD branches: ` +
              `\`pull_request: { ${line} }\` (docs/ADOPTING.md, *Slice PRs and your CI*).`
            : `Add the PRD branches to that filter, one line: \`${line}\` ` +
              `(docs/ADOPTING.md, *Slice PRs and your CI*).`,
      });
    }
  }

  // The review caller's `closed` trigger (#209), which a caller installed
  // before it does not carry and `init` does not add back: it moves pins and
  // nothing else. Without it the loop works exactly as it did, and a slice PR
  // merged by hand is the dead end it was, so a warning, and only where there
  // is a chain to move.
  if (callers.some((caller) => caller.workflow === "implement-prd")) {
    for (const caller of callers) {
      if (caller.workflow !== "review" || caller.pullRequestTypes.includes("closed")) continue;
      add({
        severity: "warning",
        check: "hand-merged slice PRs",
        problem:
          `${caller.file} triggers on \`pull_request_target\` types ` +
          `${caller.pullRequestTypes.length === 0 ? "it does not list" : caller.pullRequestTypes.map((type) => `\`${type}\``).join(", ")}, ` +
          `without \`closed\`. A slice PR merged by hand then does not move the PRD chain on: ` +
          `nothing re-adds \`agent:implement\` to its parent, and nothing says so.`,
        fix: `Set \`types: [closed, labeled]\` on that trigger, as examples/callers/review.yml does.`,
      });
    }
  }

  // GitHub's default rule blocks `pull_request_target` on a public repository
  // with no event policy allowing it, enforced from 2026-11-02 (#219). The
  // blocked run is GitHub's, not ours, so no step of the loop gets to say why:
  // a label lands and nothing happens. Private and internal repositories are
  // outside the rule and hear nothing about it.
  //
  // Read only where it was read. An unreadable policy list is a thing to check,
  // never "no policy"; an unreadable visibility is one too, since the rule only
  // bites if the answer is public.
  const triggered = triggeredFiles(callers);
  if (triggered.length > 0 && facts.visibility !== "private") {
    const unallowed =
      facts.actionsPolicies === undefined ? triggered : unallowedFiles(callers, facts.actionsPolicies);
    const fix =
      `Run \`init\` again, which creates it; or, as a repository admin, ` +
      `\`${policyCommand(policyBody(callers, unallowed))}\`; or add it under ${POLICY_SETTINGS}.`;
    const consequence =
      `GitHub blocks \`pull_request_target\` on a public repository from 2026-11-02 unless an ` +
      `Actions event policy allows it, and these callers run on nothing else: a label is added ` +
      `and no run starts, with nothing in the loop saying why.`;
    // One policy unread is as unknown as the list unread, but only where the
    // ones that were read leave a caller uncovered.
    if (facts.actionsPolicies === undefined || (unallowed.length > 0 && unreadable(facts.actionsPolicies))) {
      add({
        severity: "warning",
        check: "pull_request_target policy",
        problem:
          `Could not read the Actions policies that apply here, so nothing here knows whether ` +
          `${unallowed.join(", ")} may still run. ${consequence}` +
          (facts.visibility === undefined ? ` This repository's visibility could not be read either; a private one is not affected.` : ``),
        fix: `Check ${POLICY_SETTINGS} for a policy allowing \`pull_request_target\` for those files. ${fix}`,
      });
    } else if (unallowed.length > 0) {
      const unknown = facts.visibility === undefined;
      add({
        severity: unknown ? "warning" : "error",
        check: "pull_request_target policy",
        problem:
          `No active Actions policy allows \`pull_request_target\` for ${unallowed.join(", ")}. ` +
          consequence +
          (unknown
            ? ` This repository's visibility could not be read, so this is something to check ` +
              `rather than a fault: a private or internal repository is not affected.`
            : ``),
        fix,
      });
    }
  }

  if (facts.secrets === undefined) {
    add({
      severity: "warning",
      check: "secrets",
      problem:
        `Could not read the Actions secrets available here — neither this repository's own nor ` +
        `the organization secrets shared with it.`,
      fix: `Check \`CLAUDE_CODE_OAUTH_TOKEN\` and \`AGENT_PAT\` by hand; reading them needs admin.`,
    });
  } else {
    if (!facts.secrets.includes("CLAUDE_CODE_OAUTH_TOKEN")) {
      add({
        severity: "error",
        check: "secrets",
        problem: `The \`CLAUDE_CODE_OAUTH_TOKEN\` secret is not set; every agent workflow fails immediately.`,
        fix: `Set it under Settings → Secrets and variables → Actions.`,
      });
    }
    if (!facts.secrets.includes("AGENT_PAT")) {
      add({
        severity: "error",
        check: "secrets",
        problem:
          `The \`AGENT_PAT\` secret is not set. The workflows fall back to \`GITHUB_TOKEN\` and go ` +
          `on running, but a push made with it starts CI that waits for approval, a label added ` +
          `with it fires no event, ` +
          `and it cannot mark a pull request ready — so the loop looks alive and transitions nothing. ` +
          `Without it, the PRD chain stops after its first slice.`,
        fix: `Set a fine-grained PAT with Contents, Pull requests, Issues and Workflows write.`,
      });
    }
  }

  if (facts.canCreatePullRequests === undefined) {
    add({
      severity: "warning",
      check: "actions can open PRs",
      problem: `Could not read whether GitHub Actions may create pull requests here.`,
      fix: `Check Settings → Actions → General → Allow GitHub Actions to create and approve pull requests.`,
    });
  } else if (!facts.canCreatePullRequests) {
    // A user PAT is not the Actions bot, so it bypasses the setting outright.
    // Which is why this is only an error when there is no PAT behind it.
    add({
      severity: hasPat ? "warning" : "error",
      check: "actions can open PRs",
      problem:
        `GitHub Actions is not permitted to create pull requests in this repository. The agent ` +
        `does its work correctly and the run dies at \`gh pr create\`.` +
        (hasPat ? ` \`AGENT_PAT\` is set, which bypasses it.` : ``),
      fix: `Enable Settings → Actions → General → Allow GitHub Actions to create and approve pull requests, or set \`AGENT_PAT\`.`,
    });
  }

  // Specs rather than names, so the command offered here is the one `init`'s
  // `SETUP.md` would have run — `labelCommand` is a single definition of it.
  // Only the name decides anything at run time, but a fix that creates six
  // labels with random colours and no descriptions leaves a repository that
  // followed the advice looking different from one that ran `init`, over a
  // difference nobody chose.
  const needed = labelSpecsFor(callers.map((caller) => caller.workflow));
  if (facts.labels === undefined) {
    add({
      severity: "warning",
      check: "labels",
      problem: `Could not list this repository's labels.`,
      fix: `Create them by hand:\n       ${needed.map(labelCommand).join("\n       ")}`,
    });
  } else {
    const absent = needed.filter((label) => !facts.labels?.includes(label.name));
    if (absent.length > 0) {
      add({
        severity: "error",
        check: "labels",
        problem:
          `${absent.map((label) => label.name).join(", ")} ${absent.length === 1 ? "does" : "do"} ` +
          `not exist. A missing label makes its transition a no-op, so the state machine drifts ` +
          `without erroring.`,
        fix: absent.map(labelCommand).join("\n       "),
      });
    }
  }

  // Pin *freshness*, which is the one that has actually rotted: the repository
  // this loop was piloted on sat four releases behind and nothing said so. A
  // report rather than a failure — an old pin is a working loop on an old
  // version, and taking a release is still the adopter's call.
  // Only release-shaped tags: this repository's tags are `v<major.minor.patch>`
  // and anything else — a moving alias, somebody's scratch tag — is not a
  // release a pin can be measured against, and would sort as 0.0.0 if left in.
  const releases = [...(facts.releases ?? [])].filter((tag) => TAG.test(tag)).sort(compareVersions);
  const latest = releases[0];
  if (latest === undefined) {
    add({
      severity: "warning",
      check: "pin freshness",
      problem: `Could not read ${repoSlug(packageName)}'s releases, so nothing here knows whether the pins are current.`,
      fix: `Compare each caller's \`@ref\` against the latest tag by hand.`,
    });
  } else {
    const move = `Move every caller together: a repository whose callers name two tags is calling two runner versions at once.`;
    for (const caller of callers) {
      const behind = releases.indexOf(caller.ref);
      if (behind > 0) {
        add({
          severity: "warning",
          check: "pin freshness",
          problem: `${caller.file} is pinned to \`@${caller.ref}\` — ${behind} ${behind === 1 ? "release" : "releases"} behind \`${latest}\`.`,
          fix: move,
        });
        continue;
      }
      // A tag older than the newest one but absent from the list read back: the
      // tags endpoint answers a page at a time, so a pin left long enough falls
      // off the end of it. Saying "behind, distance unknown" is the honest
      // answer; saying nothing would make the stalest pins the quiet ones.
      if (behind < 0 && TAG.test(caller.ref) && compareVersions(caller.ref, latest) > 0) {
        add({
          severity: "warning",
          check: "pin freshness",
          problem: `${caller.file} is pinned to \`@${caller.ref}\`, which is older than \`${latest}\` and no longer among the tags read back.`,
          fix: move,
        });
      }
    }
  }

  return findings;
};

/**
 * A **list** `gh` answered with — which is the one place empty output must not
 * mean "could not read".
 *
 * `--jq '.secrets[].name'` over `{"total_count":0,"secrets":[]}` prints nothing
 * and exits 0, and `safeGh` prints nothing when `gh` is absent, unauthenticated
 * or not an admin here. Read as lines, those two collapse into one answer and
 * lead to opposite actions: a repository `init` has just scaffolded — the exact
 * moment `SETUP.md` §5 says to run this — has no secrets at all, and reporting
 * that as "unknown" passes the run it exists to fail.
 *
 * So the query asks for a shape whose *empty* answer is still output. `@json`
 * renders the array as a string, which `gh` prints raw, so `[]` comes back as
 * two characters and only a failure comes back as none.
 *
 * Exported as the reading half on its own, because the distinction it draws is
 * the whole point and a test of it must not need a `gh` on the path.
 */
export const parseList = (out: string): readonly string[] | undefined => {
  if (out.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(out);
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    // Output that is not the JSON that was asked for is not an answer either —
    // a `gh` old enough not to know `@json`, or one that printed a warning.
    return undefined;
  }
};

const list = (
  args: readonly string[],
  jq: string,
  cwd: string,
): readonly string[] | undefined => parseList(safeGh([...args, "--jq", `[${jq}] | @json`], { cwd }));

/**
 * The secrets a workflow here can actually read, out of the two lists GitHub
 * keeps apart — the repository's own, and the organization secrets shared with
 * it — and `undefined` where either of them could not be read.
 *
 * The judgement is in the third argument. `safeGh` renders every failure as the
 * same empty string, and the organization endpoint refuses a user-owned
 * repository outright — 422 Validation Failed, observed against this repository
 * with `gh` 2.101.0, and named as the instance rather than the rule because the
 * argument holds for whatever code a later API answers with. Trusting that
 * refusal as "could not read" would make every org-less repository
 * undiagnosable, which is most of them. Knowing there is no organization is
 * what turns that refusal into the fact it is — *there are none* — while
 * leaving a 403 on a repository that has one as unknown, where absence cannot
 * be concluded from a list that was never served.
 */
export const availableSecrets = (
  repository: readonly string[] | undefined,
  organization: readonly string[] | undefined,
  inOrganization: boolean | undefined,
): readonly string[] | undefined => {
  if (repository === undefined) return undefined;
  if (inOrganization === false) return repository;
  if (organization === undefined) return undefined;
  return [...repository, ...organization];
};

/**
 * The budget variable out of the two lists `vars` resolves it from, the
 * repository's own and the organization's shared with it (#204). Each list is
 * the values of variables by that name, so empty or one long; the repository's
 * wins, as it does in a workflow. `null` is "set nowhere", and is concluded
 * only from lists that were read, on `availableSecrets`' terms.
 */
export const availableVariable = (
  repository: readonly string[] | undefined,
  organization: readonly string[] | undefined,
  inOrganization: boolean | undefined,
): string | null | undefined => {
  if (repository === undefined) return undefined;
  const [own] = repository;
  if (own !== undefined) return own;
  if (inOrganization === false) return null;
  if (organization === undefined) return undefined;
  return organization[0] ?? null;
};

/**
 * Moved beside the policy it now also decides (#219), and still exported here
 * for the callers that know it by this module.
 */
export { asVisibility };

/**
 * Ask GitHub the questions a checkout cannot answer. Every call goes
 * through `safeGh`, which returns `""` rather than throwing — an unauthenticated
 * `gh`, a missing one, or a token without admin are all ordinary outcomes here,
 * and the point is to report what could not be read rather than to abort.
 */
export const gatherFacts = (dir: string, packageName: string = PACKAGE_NAME): RepoFacts => {
  // Every call runs *in the repository being diagnosed*. `gh` reads
  // `{owner}/{repo}` and every repo-scoped subcommand off the working
  // directory's git remote, so a `doctor --dir ../other` that did not say so
  // would check one repository's files against another repository's secrets.
  const [visibility] = list(["repo", "view", "--json", "visibility"], ".visibility", dir) ?? [];

  // Whether there is an organization behind this repository at all, which is
  // what makes an empty organization-secrets answer readable below.
  //
  // A second call rather than a second field of the one above, so that a `gh`
  // old enough not to know either field costs only the question it answers:
  // asked together, one unknown field fails the whole query and takes the other
  // answer with it, and this one decides whether the secrets are readable at
  // all. Through `list` for
  // `parseList`'s reason, since the answer is legally `false` and a `false` read
  // as a `gh` that said nothing is the distinction the secrets turn on.
  const [inOrganization] =
    list(["repo", "view", "--json", "isInOrganization"], ".isInOrganization", dir) ?? [];

  // One call, two facts: the default token's permissions and the create-pull-
  // requests setting are two fields of the same response, they need the same
  // admin to read, and so they are readable or unreadable together. Asked for as
  // a two-element array for `parseList`'s reason — a field that is legally
  // `false` must not come back looking like a `gh` that said nothing.
  const [defaultPermissions, canCreate] =
    list(
      ["api", "repos/{owner}/{repo}/actions/permissions/workflow"],
      ".default_workflow_permissions, .can_approve_pull_request_reviews",
      dir,
    ) ?? [];

  // Two endpoints, because GitHub keeps them apart: the first is this
  // repository's own secrets, the second is "all organization secrets shared
  // with a repository". A repository whose tokens are held centrally has none
  // of its own, so reading only the first would fail a working loop with a fix
  // telling them to duplicate an organization secret.
  //
  // The page size is a page size, not the default: both endpoints serve 30 at a
  // time, name-ascending, and a repository with more than that would truncate
  // `CLAUDE_CODE_OAUTH_TOKEN` off the end — where `parseList` cannot tell a
  // short page from a short list. `--paginate` is not the fix: it applies the
  // query per page and prints one array per page, which is not the single JSON
  // document `parseList` reads, so every answer would come back unreadable
  // instead.
  const repositorySecrets = list(
    ["api", "repos/{owner}/{repo}/actions/secrets?per_page=100"],
    ".secrets[].name",
    dir,
  );
  const inOrg = inOrganization === "true" ? true : inOrganization === "false" ? false : undefined;
  // Not asked where there is nothing to ask — an unreadable first list makes
  // the answer unknown whatever the second says, and on a user-owned
  // repository the endpoint refuses the request (422 against this repository's
  // `gh`), which `safeGh` renders as the same empty string a 403 gives.
  const organizationSecrets =
    repositorySecrets === undefined || inOrg === false
      ? undefined
      : list(
          ["api", "repos/{owner}/{repo}/actions/organization-secrets?per_page=100"],
          ".secrets[].name",
          dir,
        );

  // The budget and time limit variables, from the same two places as the
  // secrets and for the same reason: `vars` resolves an organization variable
  // shared with this repository too, and a repository one of the same name over
  // it. Picked by name out of the list rather than asked for by name, because
  // asking for one that is not set is a 404, which `safeGh` renders as the same
  // empty string a 403 gives, and "unset" must not collapse into "unreadable".
  // The list is served a page at a time, so one longer than its page is refused
  // by `error` rather than read as a list that happens not to hold the name.
  //
  // Each variable comes back as its name and then its value, flat, which is the
  // list `parseList` reads.
  const wanted: readonly string[] = [FIX_ROUNDS_VARIABLE, ...TIMEOUT_VARIABLES.map((v) => v.name)];
  const variables = (endpoint: string): readonly string[] | undefined =>
    list(
      ["api", `repos/{owner}/{repo}/actions/${endpoint}?per_page=30`],
      `if .total_count > (.variables | length) then error("more variables than one page") ` +
        `else .variables[] | select(${wanted.map((name) => `.name == "${name}"`).join(" or ")}) ` +
        `| .name, .value end`,
      dir,
    );
  const valuesOf = (flat: readonly string[] | undefined, name: string): readonly string[] | undefined =>
    flat?.filter((_, i) => i % 2 === 1 && flat[i - 1] === name);
  const repositoryVariables = variables("variables");
  const organizationVariables =
    repositoryVariables === undefined ||
    inOrg === false ||
    wanted.every((name) => (valuesOf(repositoryVariables, name) ?? []).length > 0)
      ? undefined
      : variables("organization-variables");
  const variable = (name: string): string | null | undefined =>
    availableVariable(valuesOf(repositoryVariables, name), valuesOf(organizationVariables, name), inOrg);

  return {
    secrets: availableSecrets(repositorySecrets, organizationSecrets, inOrg),
    // Both spellings named, so the third case stays `undefined`: a field a
    // future API drops answers `null`, and reading anything-but-`true` as `false`
    // would turn that into "the setting is off" — a finding about a fact nobody
    // read.
    canCreatePullRequests:
      canCreate === "true" ? true : canCreate === "false" ? false : undefined,
    defaultWorkflowPermissions:
      defaultPermissions === "read" || defaultPermissions === "write"
        ? defaultPermissions
        : undefined,
    labels: list(["label", "list", "--limit", "200", "--json", "name"], ".[].name", dir),
    visibility: asVisibility(visibility),
    actionsPolicies: readPolicies(dir),
    releases: list(["api", `repos/${repoSlug(packageName)}/tags`], ".[].name", dir),
    maxFixRounds: variable(FIX_ROUNDS_VARIABLE),
    timeoutMinutes:
      repositoryVariables === undefined
        ? undefined
        : Object.fromEntries(TIMEOUT_VARIABLES.map(({ name }) => [name, variable(name)])),
  };
};

export interface DoctorOptions {
  /** The repository to diagnose. */
  readonly dir: string;
  /**
   * The answers `gh` would have given. Supplied by the tests so the diagnosis
   * can be exercised without an authenticated GitHub; read for real otherwise.
   */
  readonly facts?: RepoFacts | undefined;
}

/**
 * Whether `gh` answered nothing at all — no auth, no `gh`, no admin here. Read
 * off the whole record rather than a chosen field, so a fact added later is
 * covered by construction: the question is "was anything about the repository
 * knowable", and every field of it is `undefined` for exactly that reason.
 */
const nothingRead = (facts: RepoFacts): boolean =>
  Object.values(facts).every((value) => value === undefined);

const render = (finding: Finding): string =>
  `${finding.severity === "error" ? "FAIL" : "warn"}  ${finding.check}: ${finding.problem}\n` +
  `      fix: ${finding.fix}\n`;

/**
 * Run every check and return the process exit code: non-zero if any detectable
 * §1 failure is present, zero if the only findings are things that could not be
 * read or pins that have merely gone stale.
 *
 * The reasons are written to `OUTPUT_DIR/failure_reason.txt` as well as to
 * stderr, for the reason every runner's `fail()` does it: a preflight run as a
 * workflow step has to leave something the `if: failure()` step can put in front
 * of a human.
 */
export const runDoctor = async (options: DoctorOptions, io: CliIo): Promise<number> => {
  const callers = readInstalledCallers(options.dir, PACKAGE_NAME);
  const facts = options.facts ?? gatherFacts(options.dir);
  const findings = diagnose(callers, facts, readOtherWorkflows(options.dir, PACKAGE_NAME));

  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");

  for (const finding of warnings) io.stdout(render(finding));
  for (const finding of errors) io.stderr(render(finding));

  if (errors.length === 0) {
    io.stdout(
      // "Nothing broken" is a claim about what was looked at, and with no `gh`,
      // no auth or no admin the only thing looked at was the callers. Saying it
      // anyway is worst at the moment `setup/SETUP.md` §5 sends somebody here —
      // and permanently, for an adopter who is not an admin of the repository.
      // Exit 0 is still right: nothing was found to be wrong.
      nothingRead(facts)
        ? `${callers.length} caller(s) checked and nothing wrong with them. No repository fact ` +
          `could be read, so the secrets, the repository settings and the labels are unchecked.\n`
        : `${callers.length} caller(s) checked; ${warnings.length} thing(s) to know, nothing broken.\n`,
    );
    return 0;
  }

  const reason = errors.map((finding) => `${finding.check}: ${finding.problem} Fix: ${finding.fix}`).join("\n");
  writeText("failure_reason.txt", reason);
  io.stderr(`\n${errors.length} problem(s) that will not announce themselves. See above.\n`);
  return 1;
};
