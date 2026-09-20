import { safeGh, writeText } from "../shared/common.js";
import { PACKAGE_NAME } from "../shared/manifest.js";
import {
  passesSecret,
  readInstalledCallers,
  repoSlug,
  selfCheckFor,
  selfCheckMatches,
  type InstalledCaller,
} from "./callers.js";
import { labelCommand, labelSpecsFor } from "./init.js";
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
 *   `GITHUB_TOKEN` grants a job that asks for nothing, which labels exist, and
 *   what this package's latest release is. Every one of them can come back
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
  readonly visibility: "public" | "private" | undefined;
  /** This package's tags, newest first — what a pin is measured against. */
  readonly releases: readonly string[] | undefined;
}

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
      // A job with no `permissions:` block anywhere holds whatever the
      // repository's default token holds, which is a different question with a
      // different answer and a different fix — ruled on once below rather than
      // per scope. Reading it as "grants nothing" is how a working loop gets
      // told to add a line it does not need: **both** defaults grant
      // `packages: read`, and a job-level block naming only that would replace
      // the inherited token and drop everything else it holds.
      if (caller.permissionsFrom === "none") continue;
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

  // The callers that write no `permissions:` block at all — neither on the job
  // nor above `jobs:` — and so run with the repository's default `GITHUB_TOKEN`.
  //
  // Which of the two defaults is set decides everything here, and it is why the
  // scope rows above skip these callers rather than reporting each grant
  // missing. The permissive default is every scope at write, so there is
  // genuinely nothing to say. The restricted one is `contents` and `packages`
  // read, so the install works and every *write* the job makes does not — one
  // finding about the block, not a list of scopes, because the fix is the whole
  // block either way: a job-level one replaces the inherited token rather than
  // adding to it, so naming a single scope is how an adopter loses the rest.
  for (const caller of callers) {
    if (caller.permissionsFrom !== "none") continue;
    if (facts.defaultWorkflowPermissions === "write") continue;

    // Unreadable is a warning rather than an error, unlike the visibility guess
    // above: there the worst case was a needless grant, and here erring the
    // other way would fail a repository whose default is permissive and whose
    // loop works, on a fact nobody could read.
    const unknown = facts.defaultWorkflowPermissions === undefined;
    add({
      severity: unknown ? "warning" : "error",
      check: "permissions block",
      problem:
        `${caller.file} declares no \`permissions:\` block — neither on the \`${caller.jobId}\` ` +
        `job nor above \`jobs:\` — so the job runs with this repository's default ` +
        `\`GITHUB_TOKEN\`. The restricted default is \`contents\` and \`packages\` read and ` +
        `nothing else, so the runner installs and then every write the job makes 403s: its push, ` +
        `its comments, its label transitions, and on a private repository the check runs the CI ` +
        `wait polls.` +
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
  // built-in token with the repository secret correctly set — a push that
  // starts no CI, a label that fires no event, a pull request nothing can mark
  // ready. Three of §1's five, from a line an adopter deleted rather than from
  // anything they failed to set, which is why the secrets row above cannot see
  // it.
  //
  // Only the optional secret is ruled on. `CLAUDE_CODE_OAUTH_TOKEN` is
  // `required: true` on every reusable half, so a caller that omits it is
  // refused by GitHub before the job starts — loud, and out of this command's
  // remit for the reason an absent `self-check` is.
  for (const caller of callers) {
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
        `arrives as the empty string and the job falls back to \`GITHUB_TOKEN\`: a push that ` +
        `starts no CI, a label that fires no event, and a pull request nothing can mark ready. ` +
        `The secret being set is what makes that invisible.` +
        (unset
          ? ` \`AGENT_PAT\` is not set here either, so this is the wire to add once it is.`
          : ``),
      fix:
        `Add \`AGENT_PAT: \${{ secrets.AGENT_PAT }}\` to that job's \`secrets:\` block — or ` +
        `\`secrets: inherit\`, which hands the called workflow every secret this repository holds.`,
    });
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
 * same empty string, and the organization endpoint 404s on a user-owned
 * repository: trusting that as "could not read" would make every org-less
 * repository undiagnosable, which is most of them. Knowing there is no
 * organization is what turns that 404 into the fact it is — *there are none* —
 * while leaving a 403 on a repository that has one as unknown, where absence
 * cannot be concluded from a list that was never served.
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
 * `gh`'s answer for a repository's visibility, as the two cases the diagnosis
 * distinguishes. An **internal** repository is private as far as every check
 * here is concerned: the check-runs API 403s without the scope exactly as it
 * does on a private one.
 *
 * Folded to one case rather than matched in two, because which case `gh` emits
 * is version-dependent — `repo view --json visibility` has answered both
 * `PUBLIC` and `public` across releases. Accepting one spelling of `INTERNAL`
 * and both of the others is an asymmetry with a consequence: the fall-through is
 * `undefined`, so an internal repository whose `gh` lowercased the field would
 * get a correct severity with an untrue sentence attached, saying the visibility
 * could not be read when it was read fine.
 */
export const asVisibility = (raw: string | undefined): "public" | "private" | undefined => {
  const held = raw?.trim().toUpperCase();
  if (held === "PUBLIC") return "public";
  if (held === "PRIVATE" || held === "INTERNAL") return "private";
  return undefined;
};

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
  // old enough not to know this field costs only the question it answers: asked
  // together, an unknown field fails the whole query and the visibility — which
  // decides a severity — would go unread with it. Through `list` for
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
  // repository the endpoint 404s, which `safeGh` renders as the same empty
  // string a 403 gives.
  const organizationSecrets =
    repositorySecrets === undefined || inOrg === false
      ? undefined
      : list(
          ["api", "repos/{owner}/{repo}/actions/organization-secrets?per_page=100"],
          ".secrets[].name",
          dir,
        );

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
  const findings = diagnose(callers, facts);

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
