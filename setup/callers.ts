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
   * What this job hands the workflow it calls: the names in its `secrets:`
   * block, the literal `"inherit"`, or `undefined` where it declares no block.
   *
   * Read for the same reason `with:` and `permissions:` are — it is a wire the
   * caller owns and the called half cannot make up for. A `workflow_call` job
   * receives *only* what it is passed; there is no inheritance without
   * `secrets: inherit`.
   */
  readonly secrets: readonly string[] | "inherit" | undefined;
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
  try {
    const document = parse(text) as
      | { readonly jobs?: unknown; readonly permissions?: unknown }
      | null;
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

    const selfCheck = asStringMap(job.with)["self-check"];
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
        secrets: secretsOf(job.secrets),
      },
    ];
  });
};

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
