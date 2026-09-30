import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";
import { escapeRe, WORKFLOW_DIR } from "../shared/pins.js";

/**
 * Reading a caller out of an adopter's tree — the one thing `init` and `doctor`
 * both do, for opposite reasons.
 *
 * `init` reads what is already installed so a re-run updates it in place rather
 * than writing a second copy beside a file somebody renamed. `doctor` reads the
 * same files to diagnose them. Neither knows how many there are: an adopter
 * takes whatever subset of them they want, under whatever filenames, with
 * whatever job ids.
 *
 * So a caller is recognised by **what it calls**, never by its filename. The
 * reference set ships as `agent-<name>.yml`, but `docs/ADOPTING.md` §4 says to
 * rename if you like, and the only thing that actually identifies one is a
 * `uses:` naming this package's repository.
 */

/** `@owner/repo` on npm is `owner/repo` on GitHub — one literal, not two. */
export const repoSlug = (packageName: string): string => packageName.replace(/^@/, "");

export interface InstalledCaller {
  /** Repo-relative and forward-slashed — the path as a human would write it. */
  readonly file: string;
  /** The reusable half it calls: `review`, `fix`, … */
  readonly workflow: string;
  /** First half of `self-check`, and the thing an adopter is free to rename. */
  readonly jobId: string;
  /**
   * That job's **display name** — `jobs.<id>.name` when it declares one, and
   * the id otherwise. This is the half GitHub writes into the check-run name,
   * so it is what `self-check` has to state; the id stays the thing findings
   * name, because it is what an adopter greps their YAML for.
   */
  readonly jobName: string;
  /** Whatever follows the `@`: a tag, a SHA, or — the defect — a branch. */
  readonly ref: string;
  /**
   * The grants this job actually runs with: its own block, or the workflow's
   * top-level one when it declares none. A called workflow can only downgrade
   * these.
   */
  readonly permissions: Readonly<Record<string, string>>;
  /**
   * Where those grants were written: its own block, the workflow's top-level
   * one, or nowhere. The *fix* for a missing grant differs by which — a
   * job-level block replaces the top-level one wholesale, so telling somebody
   * to add one to a job that currently inherits would drop every grant it
   * holds today.
   */
  readonly permissionsFrom: "job" | "workflow" | "none";
  /** `self-check`, on the one caller that takes it. */
  readonly selfCheck: string | undefined;
  /**
   * What this caller passes as `auto-fix` (#102), the input the fix-round
   * budget deprecated (#201): the value as written, and `undefined` where it
   * passes nothing, the empty string or YAML's null, which is the input's own
   * default and leaves the budget to the repository variable. A `${{`
   * expression is kept as written: it is settled at run time, and nothing here
   * can say what it comes to. A value rather than a
   * boolean, because `false` is a budget of 0 that wins over the variable, and
   * reading it as "not passed" would hand the budget back to a variable the
   * review never consults.
   *
   * A field rather than the whole `with:` map, because `diagnose` rules on a
   * fixed list: an input it was not taught about is one nothing here can say
   * anything useful about, and a map invites a reader to go looking.
   */
  readonly autoFix: string | undefined;
  /**
   * What this job hands the workflow it calls: the names in its `secrets:`
   * block, the literal `"inherit"`, or `undefined` where it declares no block.
   *
   * Read for the same reason `with:` and `permissions:` are — it is a wire the
   * caller owns and the called half cannot make up for. A `workflow_call` job
   * receives *only* what it is passed; there is no inheritance without
   * `secrets: inherit`.
   */
  readonly secrets: readonly string[] | "inherit" | undefined;
  /**
   * The activity types its `pull_request_target` trigger lists, or none where
   * it lists none. Read for one rule (#209): the review caller's `closed` is
   * what moves the PRD chain on from a slice PR merged by hand, and a caller
   * installed before that has `labeled` alone.
   */
  readonly pullRequestTypes: readonly string[];
  /**
   * The events its workflow file triggers on: the keys of `on:`, or the one or
   * several it names as a string or a list. Read for the Actions policy (#219),
   * which targets a workflow **file** and has to know which of them run on
   * `pull_request_target`, and which events such a file also starts on.
   */
  readonly events: readonly string[];
}

/**
 * The check-run name this caller's job actually produces, which is what
 * `self-check` has to be set to.
 *
 * **Both** halves are knowable from here, and neither is quite a job id.
 *
 * The first is the calling job's *display name*: GitHub writes `jobs.<id>.name`
 * into the check run when the job declares one and falls back to the id only
 * when it does not. The reference callers declare none, which is why the id
 * reads as the answer — but `docs/ADOPTING.md` §4 invites an adopter to rename,
 * and a caller carrying `name: Agent review` produces `Agent review / review`.
 * Composing the id there would fail a correct caller and hand it a `fix:` that
 * breaks a working loop, which is the one thing a preflight cannot do.
 *
 * The second is the `uses:` filename — every reusable half in this package
 * declares one job whose id is its own filename and no `name:` of its own, both
 * asserted in `tests/workflows.test.ts` beside the pair the reference caller
 * states — so `workflow` is the called job's display name rather than a
 * stand-in for it.
 *
 * Checking only the first half is how `self-check: agent_review` passes, and
 * `agent_review / reviewer` with it: neither names a check run that exists, so
 * the wait excludes nothing, spends 15 of its 20 minutes waiting for itself and
 * then reviews on degraded evidence. Nothing errors at any point.
 */
export const selfCheckFor = (caller: InstalledCaller): string =>
  `${caller.jobName} / ${caller.workflow}`;

/**
 * Whether a caller's `self-check` is that name, compared **literally**.
 *
 * `review.yml` filters with `select(.name != env.SELF_CHECK)`, which is a byte
 * comparison against the check run's own name, so ` / ` is part of the value
 * rather than spacing around it. `review/review` is the shape somebody writes
 * from memory and it excludes nothing — the same silence a wrong job id gives,
 * through the other half of the same string.
 *
 * True for a caller that sets no `self-check` at all: `review` is the only one
 * that takes such an input, and it declares it `required: true`, so an absent
 * one is refused by GitHub rather than being quietly wrong.
 */
export const selfCheckMatches = (caller: InstalledCaller): boolean =>
  caller.selfCheck === undefined || caller.selfCheck === selfCheckFor(caller);

/**
 * Whether this caller hands `name` to the workflow it calls.
 *
 * `secrets: inherit` passes everything, a map passes what it names, and no
 * block at all passes nothing. An *optional* secret that was not passed is not
 * an error on either side: it arrives as the empty string, which is why the one
 * wire an adopter can quietly drop is the one nothing complains about.
 */
export const passesSecret = (caller: InstalledCaller, name: string): boolean =>
  caller.secrets === "inherit" || (caller.secrets?.includes(name) ?? false);

/**
 * The block is a map of names, or the single word `inherit`. Anything else —
 * an empty block, a list, a string that is not `inherit` — names nothing, and
 * is read as such rather than as an absent block: a `secrets:` key that GitHub
 * would reject is not a wire either way.
 */
const secretsOf = (value: unknown): readonly string[] | "inherit" | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.trim() === "inherit" ? "inherit" : [];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>)
    : [];
};

const asStringMap = (value: unknown): Record<string, string> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, held]) => [key, String(held)]),
      )
    : {};

/**
 * `auto-fix` as the review receives it, read from the parsed `with:` value
 * rather than out of `asStringMap`, whose `String` turns YAML's null (`auto-fix:`
 * with nothing after it, `~`, `null`) into the word `"null"`. GitHub hands the
 * review the empty string for all of those, and the review tests for empty and
 * nothing else, so each is "not passed". YAML's own boolean still goes through
 * `String`, which is what makes `auto-fix: true` and `auto-fix: "true"` the
 * same answer, as they are to the string input the review declares.
 */
const autoFixOf = (inputs: unknown): string | undefined => {
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) return undefined;
  const held = (inputs as Record<string, unknown>)["auto-fix"];
  if (held === undefined || held === null) return undefined;
  const value = String(held);
  return value === "" ? undefined : value;
};

/**
 * `permissions:` is usually a map and may legally be the string `write-all` or
 * `read-all`. Reported under `*` rather than expanded, so a reader has to decide
 * what a blanket grant means for the scope they are asking about instead of
 * finding a key that was never written.
 */
const permissionsOf = (value: unknown): Record<string, string> =>
  typeof value === "string" ? { "*": value } : asStringMap(value);

/**
 * The block may also sit at the **workflow top level**, where GitHub applies it
 * to every job — a `uses:` job included — and a job that declares its own
 * replaces it *wholesale* rather than merging into it.
 *
 * So a caller granting `packages: read` above `jobs:` is correctly permissioned,
 * and reading only the job's block reports it as granting nothing: two errors
 * and a `fix:` that is a no-op, on a repository where nothing is wrong. That is
 * the same wrong-diagnosis class the `write-all` handling exists to prevent, and
 * a preflight cannot afford either.
 *
 * Presence of the key is what decides, not its contents: `permissions: {}` on
 * the job is a deliberate "grant nothing" override and has to stay one.
 */
const grantsFor = (
  job: object,
  top: unknown,
  topDeclared: boolean,
): Pick<InstalledCaller, "permissions" | "permissionsFrom"> => {
  if ("permissions" in job) {
    return {
      permissions: permissionsOf((job as { readonly permissions?: unknown }).permissions),
      permissionsFrom: "job",
    };
  }
  if (topDeclared) return { permissions: permissionsOf(top), permissionsFrom: "workflow" };
  return { permissions: {}, permissionsFrom: "none" };
};

/**
 * Every job in one workflow file that calls this package's reusable half.
 *
 * Text in, callers out — it opens nothing, the same seam `shared/pins.ts` draws
 * for the same reason: the file discovery differs between the two callers and
 * the parsing does not.
 */
export const callersIn = (
  text: string,
  packageName: string,
  file: string,
): readonly InstalledCaller[] => {
  const uses = new RegExp(
    `^${escapeRe(repoSlug(packageName))}/${escapeRe(WORKFLOW_DIR)}/(.+)\\.yml@(.+)$`,
  );

  let jobs: Record<string, unknown> = {};
  let top: unknown;
  let topDeclared = false;
  let pullRequestTypes: readonly string[] = [];
  let events: readonly string[] = [];
  try {
    const document = parse(text) as
      | { readonly jobs?: unknown; readonly permissions?: unknown; readonly on?: unknown }
      | null;
    const trigger = (document?.on as { readonly pull_request_target?: unknown } | null | undefined)
      ?.pull_request_target as { readonly types?: unknown } | null | undefined;
    pullRequestTypes = patternsOf(trigger?.types) ?? [];
    events = eventsOf(document?.on);
    const held = document?.jobs;
    if (typeof held === "object" && held !== null && !Array.isArray(held)) {
      jobs = held as Record<string, unknown>;
    }
    if (document !== null && typeof document === "object" && "permissions" in document) {
      top = document.permissions;
      topDeclared = true;
    }
  } catch {
    // A workflow this cannot parse is one GitHub cannot run either, and saying
    // so is `tests/workflows.test.ts`'s job in the repo that owns the file. Here
    // it is simply not a caller.
    return [];
  }

  return Object.entries(jobs).flatMap(([jobId, entry]) => {
    const job = (typeof entry === "object" && entry !== null ? entry : {}) as {
      readonly uses?: unknown;
      readonly name?: unknown;
      readonly permissions?: unknown;
      readonly with?: unknown;
      readonly secrets?: unknown;
    };
    const match = typeof job.uses === "string" ? uses.exec(job.uses.trim()) : null;
    if (match === null) return [];

    const inputs = asStringMap(job.with);
    const selfCheck = inputs["self-check"];
    return [
      {
        file,
        workflow: match[1] ?? "",
        jobId,
        // GitHub's own fallback, and the reason it is read at all: a caller
        // that declares no `name:` puts its id in the check run, which is every
        // caller in `examples/callers/` and none of the renamed ones.
        jobName: typeof job.name === "string" ? job.name : jobId,
        ref: match[2] ?? "",
        ...grantsFor(job, top, topDeclared),
        selfCheck,
        autoFix: autoFixOf(job.with),
        secrets: secretsOf(job.secrets),
        pullRequestTypes,
        events,
      },
    ];
  });
};

/** `on:` in any of the three shapes GitHub takes it in. */
const eventsOf = (on: unknown): readonly string[] =>
  typeof on === "string"
    ? [on]
    : Array.isArray(on)
      ? on.filter((event): event is string => typeof event === "string")
      : typeof on === "object" && on !== null
        ? Object.keys(on)
        : [];

/** Forward slashes, because the result is quoted back to a human. */
const workflowFiles = (dir: string): readonly string[] => {
  const full = path.join(dir, ...WORKFLOW_DIR.split("/"));
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .sort();
};

/** Every caller for this package installed under `dir`, in filename order. */
export const readInstalledCallers = (
  dir: string,
  packageName: string,
): readonly InstalledCaller[] =>
  workflowFiles(dir).flatMap((entry) =>
    callersIn(
      fs.readFileSync(path.join(dir, ...WORKFLOW_DIR.split("/"), entry), "utf8"),
      packageName,
      `${WORKFLOW_DIR}/${entry}`,
    ),
  );

/**
 * A branch the PRD chain opens slice PRs into: `agent/prd-<parent>-<slug>`, the
 * name `implement-prd` gives it. What a CI trigger is measured against (#209).
 */
export const PRD_BRANCH_EXAMPLE = "agent/prd-209-a-slug";

/**
 * How one workflow that is not the loop's own answers a pull request into a PRD
 * branch (#209): it has no `pull_request` trigger, its branch filter leaves the
 * PRD branch out, or it runs. `undefined` where the file could not be read or
 * its trigger could not be made sense of, which is not an answer either way.
 */
export interface OtherWorkflow {
  /** Repo-relative and forward-slashed, like a caller's. */
  readonly file: string;
  readonly onSlicePrs: "no pull_request trigger" | "filtered out" | "runs" | undefined;
}

/**
 * One GitHub branch-filter pattern as a regular expression: `*` is anything but
 * `/`, `**` is anything, `?` and `+` quantify the character before them, and
 * `[…]` is a class. `undefined` for a pattern that makes no expression, so a
 * filter holding one is unreadable rather than a miss.
 */
const branchPattern = (pattern: string): RegExp | undefined => {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? "";
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?" || ch === "+") {
      source += ch;
    } else if (ch === "[" && pattern.indexOf("]", i) > i) {
      const end = pattern.indexOf("]", i);
      source += pattern.slice(i, end + 1);
      i = end;
    } else {
      source += escapeRe(ch);
    }
  }
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return undefined;
  }
};

const patternsOf = (value: unknown): readonly string[] | undefined =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? (value as string[])
      : undefined;

/**
 * Whether a `pull_request` trigger's filters let `branch` through. No filter
 * matches everything; `branches` is read in order, a later `!pattern` taking a
 * branch back out; `branches-ignore` lets through what it does not name.
 */
const filterPasses = (trigger: unknown, branch: string): boolean | undefined => {
  if (trigger === null || trigger === undefined) return true;
  if (typeof trigger !== "object" || Array.isArray(trigger)) return undefined;
  const filters = trigger as { readonly branches?: unknown; readonly "branches-ignore"?: unknown };
  // GitHub refuses a trigger carrying both.
  if ("branches" in filters && "branches-ignore" in filters) return undefined;

  if ("branches" in filters) {
    const patterns = patternsOf(filters.branches);
    if (patterns === undefined) return undefined;
    let passes = false;
    for (const raw of patterns) {
      const negated = raw.startsWith("!");
      const regex = branchPattern(negated ? raw.slice(1) : raw);
      if (regex === undefined) return undefined;
      if (regex.test(branch)) passes = !negated;
    }
    return passes;
  }
  if ("branches-ignore" in filters) {
    const patterns = patternsOf(filters["branches-ignore"]);
    if (patterns === undefined) return undefined;
    const regexes = patterns.map(branchPattern);
    if (regexes.some((regex) => regex === undefined)) return undefined;
    return !regexes.some((regex) => regex?.test(branch));
  }
  return true;
};

/**
 * How one workflow file answers a pull request into a PRD branch, or nothing
 * for a file that is the loop's own: a caller runs on `pull_request_target`
 * and is not CI. Text in, like `callersIn`.
 */
export const otherWorkflowIn = (
  text: string,
  packageName: string,
  file: string,
): OtherWorkflow | undefined => {
  if (callersIn(text, packageName, file).length > 0) return undefined;

  let on: unknown;
  try {
    const document = parse(text) as { readonly on?: unknown } | null;
    if (document === null || typeof document !== "object") return { file, onSlicePrs: undefined };
    on = document.on;
  } catch {
    return { file, onSlicePrs: undefined };
  }

  const verdict = (passes: boolean | undefined): OtherWorkflow => ({
    file,
    onSlicePrs: passes === undefined ? undefined : passes ? "runs" : "filtered out",
  });
  if (typeof on === "string") {
    return on === "pull_request" ? verdict(true) : { file, onSlicePrs: "no pull_request trigger" };
  }
  if (Array.isArray(on)) {
    return on.includes("pull_request")
      ? verdict(true)
      : { file, onSlicePrs: "no pull_request trigger" };
  }
  if (typeof on === "object" && on !== null) {
    return "pull_request" in on
      ? verdict(filterPasses((on as Record<string, unknown>)["pull_request"], PRD_BRANCH_EXAMPLE))
      : { file, onSlicePrs: "no pull_request trigger" };
  }
  return { file, onSlicePrs: undefined };
};

/** Every workflow under `dir` that is not a caller for this package, in filename order. */
export const readOtherWorkflows = (
  dir: string,
  packageName: string,
): readonly OtherWorkflow[] =>
  workflowFiles(dir).flatMap((entry) => {
    const file = `${WORKFLOW_DIR}/${entry}`;
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, ...WORKFLOW_DIR.split("/"), entry), "utf8");
    } catch {
      return [{ file, onSlicePrs: undefined }];
    }
    const workflow = otherWorkflowIn(text, packageName, file);
    return workflow === undefined ? [] : [workflow];
  });
