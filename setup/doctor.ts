import { safeGh, writeText } from "../shared/common.js";
import { PACKAGE_NAME } from "../shared/manifest.js";
import { readInstalledCallers, repoSlug, type InstalledCaller } from "./callers.js";
import { labelsFor } from "./init.js";
import type { CliIo } from "../cli.js";

/**
 * The preflight: every check here is a failure `docs/ADOPTING.md` §1 describes
 * as announcing itself as something else. None of them errors on its own, which
 * is the whole reason to look for them on purpose — a missing `packages: read`
 * reads as a bad token, a missing `AGENT_PAT` reads as a working loop, and a
 * `self-check` that does not name its own job reads as a slow CI.
 *
 * Two halves, deliberately separated:
 *
 * - **`gatherFacts`** asks GitHub the four questions a checkout cannot answer —
 *   which secrets are set, whether Actions may open pull requests, which labels
 *   exist, and what this package's latest release is. Every one of them can
 *   come back unreadable (no `gh`, no auth, no admin), and an unreadable answer
 *   is reported as unknown rather than folded into a pass.
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
  /** Names of the repository's Actions secrets. */
  readonly secrets: readonly string[] | undefined;
  /** Settings → Actions → General → Allow GitHub Actions to create … pull requests. */
  readonly canCreatePullRequests: boolean | undefined;
  readonly labels: readonly string[] | undefined;
  readonly visibility: "public" | "private" | undefined;
  /** This package's tags, newest first — what a pin is measured against. */
  readonly releases: readonly string[] | undefined;
}

/** An exact release tag, or a full commit SHA. Nothing that can move. */
const TAG = /^v?\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;

/**
 * The fix for a missing label is the command that creates it — the same one
 * `init`'s `SETUP.md` already listed, so the two halves of the install path say
 * the same thing.
 */
const labelCommand = (name: string): string => `gh label create "${name}"`;

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
 * Which permission each reusable half needs from its caller, and why its absence
 * is not an error message. `packages: read` is universal — it is not about what
 * the job does but about installing the runner it runs — and `checks: read` is
 * the row only a private repository needs, which is exactly why it was missing
 * from v0.1.0 through v0.1.4 without anything failing.
 */
const REQUIRED_PERMISSIONS: readonly {
  readonly permission: string;
  readonly value: string;
  readonly workflows: readonly string[] | "all";
  readonly why: string;
  readonly privateOnly: boolean;
}[] = [
  {
    permission: "packages",
    value: "read",
    workflows: "all",
    why:
      "the runner is installed from GitHub Packages, which has no anonymous install even for a " +
      "public package. Without the grant the run dies at `npx` with a 401 that reads like a bad token",
    privateOnly: false,
  },
  {
    permission: "checks",
    value: "read",
    workflows: ["review"],
    why:
      "the CI wait polls the check-runs API, which a public repository serves without the scope " +
      "and a private one 403s. The poll then spends its whole budget and reviews with no CI evidence",
    privateOnly: true,
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
 * Rule on the installed callers and the facts. Pure: everything it needs has
 * already been read, and everything it cannot know arrives as `undefined`.
 */
export const diagnose = (
  callers: readonly InstalledCaller[],
  facts: RepoFacts,
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

  for (const { permission, value, workflows, why, privateOnly } of REQUIRED_PERMISSIONS) {
    for (const caller of callers) {
      if (workflows !== "all" && !workflows.includes(caller.workflow)) continue;
      if (!missingPermission(caller, permission, value)) continue;

      // A called workflow can only *downgrade* the token it is handed, so a
      // grant missing from the caller cannot be made up for on the other side.
      //
      // Visibility is the one unreadable fact that changes a severity instead
      // of adding a finding of its own, and unknown resolves to the private
      // branch: a needless grant costs nothing and a missing one reviews blind.
      // Erring that way is the call; presenting a guess as a determination is
      // not, so the guess says so — otherwise an unauthenticated run against a
      // public repository exits 1 with nothing admitting why.
      const guessed = privateOnly && facts.visibility === undefined;
      add({
        severity: privateOnly && facts.visibility === "public" ? "warning" : "error",
        check: `${permission}: ${value}`,
        problem:
          `${caller.file} grants the \`${caller.jobId}\` job no \`${permission}: ${value}\` — ${why}.` +
          (guessed
            ? ` This repository's visibility could not be read, so this is reported as an error on the assumption that it is private.`
            : ``),
        fix:
          caller.permissionsFrom === "workflow"
            ? `Add \`${permission}: ${value}\` to the workflow's top-level \`permissions:\` block. The \`${caller.jobId}\` job declares none of its own, and a job-level block replaces the top-level one rather than adding to it.`
            : `Add \`${permission}: ${value}\` to that job's \`permissions:\` block.`,
      });
    }
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

  for (const caller of callers) {
    if (caller.selfCheck === undefined) continue;
    const [job] = caller.selfCheck.split("/").map((half) => half.trim());
    if (job === caller.jobId) continue;
    add({
      severity: "error",
      check: "self-check",
      problem:
        `${caller.file} sets \`self-check: ${caller.selfCheck}\` on a job whose id is ` +
        `\`${caller.jobId}\`. The check run is named \`<caller job id> / <called job id>\`, so the ` +
        `wait does not recognise its own and waits for itself before reviewing on degraded evidence.`,
      fix: `Set \`self-check: ${caller.jobId} / ${caller.selfCheck.split("/").pop()?.trim() ?? caller.workflow}\`.`,
    });
  }

  if (facts.secrets === undefined) {
    add({
      severity: "warning",
      check: "secrets",
      problem: `Could not read this repository's Actions secrets.`,
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
          `on running, but a push made with it starts no CI, a label added with it fires no event, ` +
          `and it cannot mark a pull request ready — so the loop looks alive and transitions nothing.`,
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

  const needed = labelsFor(callers.map((caller) => caller.workflow));
  if (facts.labels === undefined) {
    add({
      severity: "warning",
      check: "labels",
      problem: `Could not list this repository's labels.`,
      fix: `Create them by hand: ${needed.map(labelCommand).join("; ")}.`,
    });
  } else {
    const absent = needed.filter((label) => !facts.labels?.includes(label));
    if (absent.length > 0) {
      add({
        severity: "error",
        check: "labels",
        problem:
          `${absent.join(", ")} ${absent.length === 1 ? "does" : "do"} not exist. A missing label ` +
          `makes its transition a no-op, so the state machine drifts without erroring.`,
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
 * One scalar `gh` answer, or `undefined` when `gh` could not give one.
 *
 * Safe for a scalar precisely because the two answers this is used for —
 * `.visibility` and `.can_approve_pull_request_reviews` — have no empty value:
 * a repository is `PUBLIC` or `PRIVATE`, the setting is `true` or `false`, and
 * nothing prints an empty line but a `gh` that failed.
 */
const answer = (args: readonly string[], cwd: string): string | undefined => {
  const out = safeGh(args, { cwd }).trim();
  return out === "" ? undefined : out;
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
 * Ask GitHub the four questions a checkout cannot answer. Every call goes
 * through `safeGh`, which returns `""` rather than throwing — an unauthenticated
 * `gh`, a missing one, or a token without admin are all ordinary outcomes here,
 * and the point is to report what could not be read rather than to abort.
 */
export const gatherFacts = (dir: string, packageName: string = PACKAGE_NAME): RepoFacts => {
  // Every call runs *in the repository being diagnosed*. `gh` reads
  // `{owner}/{repo}` and every repo-scoped subcommand off the working
  // directory's git remote, so a `doctor --dir ../other` that did not say so
  // would check one repository's files against another repository's secrets.
  const visibility = answer(["repo", "view", "--json", "visibility", "--jq", ".visibility"], dir);
  const canCreate = answer(
    ["api", "repos/{owner}/{repo}/actions/permissions/workflow", "--jq", ".can_approve_pull_request_reviews"],
    dir,
  );

  return {
    // A page size, not the default. The secrets endpoint serves 30 at a time,
    // name-ascending, and a repository with more than that would truncate
    // `CLAUDE_CODE_OAUTH_TOKEN` off the end — where `parseList` cannot tell a
    // short page from a short list and the run fails a correctly configured
    // repository. `--paginate` is not the fix: it applies the query per page and
    // prints one array per page, which is not the single JSON document
    // `parseList` reads — so every answer would come back unreadable instead.
    secrets: list(
      ["api", "repos/{owner}/{repo}/actions/secrets?per_page=100"],
      ".secrets[].name",
      dir,
    ),
    canCreatePullRequests: canCreate === undefined ? undefined : canCreate === "true",
    labels: list(["label", "list", "--limit", "200", "--json", "name"], ".[].name", dir),
    visibility:
      visibility === "PUBLIC" || visibility === "public"
        ? "public"
        : visibility === "PRIVATE" || visibility === "private" || visibility === "INTERNAL"
          ? "private"
          : undefined,
    releases: list(["api", `repos/${repoSlug(packageName)}/tags`], ".[].name", dir),
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
  const findings = diagnose(callers, facts);

  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");

  for (const finding of warnings) io.stdout(render(finding));
  for (const finding of errors) io.stderr(render(finding));

  if (errors.length === 0) {
    io.stdout(
      `${callers.length} caller(s) checked; ${warnings.length} thing(s) to know, nothing broken.\n`,
    );
    return 0;
  }

  const reason = errors.map((finding) => `${finding.check}: ${finding.problem} Fix: ${finding.fix}`).join("\n");
  writeText("failure_reason.txt", reason);
  io.stderr(`\n${errors.length} problem(s) that will not announce themselves. See above.\n`);
  return 1;
};
