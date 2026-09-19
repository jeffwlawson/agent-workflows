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
 * takes whatever subset of the five they want, under whatever filenames, with
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
}

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
      readonly permissions?: unknown;
      readonly with?: unknown;
    };
    const match = typeof job.uses === "string" ? uses.exec(job.uses.trim()) : null;
    if (match === null) return [];

    const selfCheck = asStringMap(job.with)["self-check"];
    return [
      {
        file,
        workflow: match[1] ?? "",
        jobId,
        ref: match[2] ?? "",
        ...grantsFor(job, top, topDeclared),
        selfCheck,
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
