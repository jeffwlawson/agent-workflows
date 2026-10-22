import { createHmac, timingSafeEqual } from "node:crypto";
import { CI_WAIT_SECONDS } from "../review/collect-checks.js";

/**
 * What the service orchestrator's two processes say to each other (#456): the
 * job the dispatcher posts to the worker, the token request the worker makes
 * of the dispatcher, and the signature on both. One module, imported by both,
 * so the format only has to hold within one release; the job carries the
 * release that wrote it, for the worker to refuse another's.
 */

/**
 * The repository variables the service reads, which the dispatcher reads off
 * the repository and the job carries, so a repository's settings mean the
 * same thing under both orchestrators. Unset is `""`, as an unset `vars.X` is
 * on Actions. `AGENT_SETUP` is the repository's setup, the script the worker
 * runs in the sandbox before a runner that needs the repository's
 * dependencies (PRD #515): an admin's to set, and handed to the sandbox's
 * shell unevaluated. `AGENT_MODEL_FIX` and `AGENT_TIMEOUT_MINUTES` are what
 * `fix.yml` reads: the fix runner's model, and the agent's job's time limit.
 * `AGENT_MODEL_UPDATE_BRANCH` is the update-branch runner's model, which
 * `update-branch.yml` reads beside the same time limit.
 */
export const REPOSITORY_VARIABLES = [
  "AGENT_MODEL",
  "AGENT_MODEL_REVIEW",
  "AGENT_MODEL_FIX",
  "AGENT_MODEL_UPDATE_BRANCH",
  "AGENT_REVIEW_TIMEOUT_MINUTES",
  "AGENT_TIMEOUT_MINUTES",
  "AGENT_MAX_FIX_ROUNDS",
  "AGENT_SETUP",
] as const;

export type RepositoryVariable = (typeof REPOSITORY_VARIABLES)[number];

/**
 * Review's own time where `AGENT_REVIEW_TIMEOUT_MINUTES` is unset or not a
 * positive integer: the figure `review.yml`'s `time-limit` job uses, which
 * `review:gate` names when it refuses the variable.
 */
export const DEFAULT_REVIEW_MINUTES = 5;

/** Review's own time, in minutes, from the variable as the job carries it. */
export const reviewMinutes = (variable: string): number =>
  /^[1-9][0-9]*$/.test(variable) ? Number(variable) : DEFAULT_REVIEW_MINUTES;

/**
 * Review's time limit, in minutes: its CI wait plus its own time, the sum
 * `review.yml`'s `time-limit` job makes. The dispatcher's deadline for a job
 * starts from it, and the worker holds the review's phases to it.
 */
export const reviewTimeLimit = (variable: string): number => CI_WAIT_SECONDS / 60 + reviewMinutes(variable);

/**
 * The fix agent's job's time limit where `AGENT_TIMEOUT_MINUTES` is unset or
 * not a positive integer: the figure `fix.yml`'s agent's job falls back to,
 * and `update-branch.yml`'s too.
 */
export const DEFAULT_FIX_MINUTES = 30;

/**
 * The fix agent's job's time limit, in minutes, from the variable as the job
 * carries it: the agent's job's `timeout-minutes` in `fix.yml`. The
 * dispatcher's deadline for a fix job starts from it, and the worker holds the
 * checkout, `fix:prepare`, the setup and the runner to it. `update-branch.yml`'s
 * agent's job reads the same variable with the same fallback, so an
 * update-branch job's limit is this one too.
 */
export const fixTimeLimit = (variable: string): number =>
  /^[1-9][0-9]*$/.test(variable) ? Number(variable) : DEFAULT_FIX_MINUTES;

/**
 * The workflows the service runs, one job kind each (ADR 0008): the field a
 * job names its workflow in, and the worker's run function for it, follow
 * from the kind. The dispatcher routes a trigger label to one.
 */
export const JOB_KINDS = ["review", "fix", "update-branch"] as const;

export type JobKind = (typeof JOB_KINDS)[number];

/** What every job carries, whatever its workflow. */
interface JobBase {
  /** The workflow the job runs, which decides the rest of its shape. */
  readonly workflow: JobKind;
  /** The dispatcher's name for the job, which a token request names. */
  readonly id: string;
  /** The release of the dispatcher that wrote it. */
  readonly version: string;
  /** When the dispatcher stops minting for it, as an ISO time. */
  readonly deadline: string;
  /** `owner/name`. */
  readonly repo: string;
  /** The login the App posts as, `<slug>[bot]`, read off the App's own record. */
  readonly appLogin: string;
}

/**
 * What a job on a pull request carries past the common fields: what the
 * label's event carried, what the dispatcher read, and nothing that grants
 * anything. **It carries no token**: the worker asks for one per phase,
 * naming `id`.
 */
interface PullRequestJob extends JobBase {
  readonly pr: number;
  /** The head branch, as the event carried it. */
  readonly branch: string;
  /** The head commit, as the event carried it. */
  readonly headSha: string;
  /** The base branch, as the event carried it, which the worker fetches for the diff. */
  readonly baseRef: string;
  /** The pull request's state, as the event carried it. */
  readonly state: string;
  readonly merged: boolean;
  readonly variables: Readonly<Record<RepositoryVariable, string>>;
}

/** One `agent:review` delivery, as a job for the worker. */
export interface ReviewJob extends PullRequestJob {
  readonly workflow: "review";
}

/** One `agent:fix` delivery, as a job for the worker. */
export interface FixJob extends PullRequestJob {
  readonly workflow: "fix";
}

/** One `agent:update-branch` delivery, as a job for the worker. */
export interface UpdateBranchJob extends PullRequestJob {
  readonly workflow: "update-branch";
}

/** A job the dispatcher posts and the worker runs: one member per workflow the service serves. */
export type Job = ReviewJob | FixJob | UpdateBranchJob;

/**
 * Each kind's time limit, in minutes, from the repository's variables: the
 * dispatcher's deadline for a job starts from it.
 */
export const TIME_LIMITS: Readonly<Record<JobKind, (variables: Readonly<Record<RepositoryVariable, string>>) => number>> = {
  review: (variables) => reviewTimeLimit(variables.AGENT_REVIEW_TIMEOUT_MINUTES),
  fix: (variables) => fixTimeLimit(variables.AGENT_TIMEOUT_MINUTES),
  "update-branch": (variables) => fixTimeLimit(variables.AGENT_TIMEOUT_MINUTES),
};

/** What a token is for: reading only, the posting phases' writes as well, or those and a push. */
export const TOKEN_KINDS = ["read", "write", "push"] as const;

export type TokenKind = (typeof TOKEN_KINDS)[number];

/** The worker's request for a token, for one phase of one job. */
export interface TokenRequest {
  readonly jobId: string;
  readonly kind: TokenKind;
}

/** The dispatcher's answer to a token request it granted. */
export interface TokenGrant {
  readonly token: string;
  readonly expiresAt: string;
}

/** The header a signed body's signature travels in, between the two processes. */
export const SIGNATURE_HEADER = "x-signature-256";

/**
 * `body`'s signature under `secret`, in the form GitHub signs its deliveries
 * with: `sha256=` and the HMAC's hex.
 */
export const sign = (secret: string, body: Buffer | string): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** Whether `signature` is `body`'s under `secret`, compared in constant time. */
export const verifySignature = (secret: string, body: Buffer | string, signature: string | undefined): boolean => {
  if (signature === undefined) return false;
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const REPO = /^[\w.-]+\/[\w.-]+$/;
const SHA = /^[0-9a-f]{40}$/;

type Fields = Readonly<Record<string, unknown>>;

/** A pull request job's own fields, past the common ones, or the reason they are not. */
const parsePullRequest = <K extends JobKind>(
  workflow: K,
  base: Omit<JobBase, "workflow">,
  value: Fields,
): (Omit<PullRequestJob, "workflow"> & { readonly workflow: K }) | string => {
  const { pr, branch, headSha, baseRef, state, merged, variables } = value;
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0) return "`pr` is not a positive integer";
  if (typeof branch !== "string" || branch === "") return "`branch` is not a non-empty string";
  if (typeof headSha !== "string" || !SHA.test(headSha)) return "`headSha` is not a 40-character commit";
  if (typeof baseRef !== "string" || baseRef === "") return "`baseRef` is not a non-empty string";
  if (typeof state !== "string" || state === "") return "`state` is not a non-empty string";
  if (typeof merged !== "boolean") return "`merged` is not a boolean";
  if (!isObject(variables)) return "`variables` is not an object";
  const read: Partial<Record<RepositoryVariable, string>> = {};
  for (const name of REPOSITORY_VARIABLES) {
    const given = variables[name];
    if (typeof given !== "string") return `\`variables.${name}\` is not a string`;
    read[name] = given;
  }
  return {
    workflow,
    ...base,
    pr,
    branch,
    headSha,
    baseRef,
    state,
    merged,
    variables: read as Record<RepositoryVariable, string>,
  };
};

/** Each kind's own fields, read once the common ones are. */
const PARSERS: Readonly<Record<JobKind, (base: Omit<JobBase, "workflow">, value: Fields) => Job | string>> = {
  review: (base, value) => parsePullRequest("review", base, value),
  fix: (base, value) => parsePullRequest("fix", base, value),
  "update-branch": (base, value) => parsePullRequest("update-branch", base, value),
};

/**
 * A job read off the wire, or the reason it is not one. The body is signed,
 * so this guards against a release's drift rather than an attacker: every
 * field is checked for the shape the worker hands on, and a kind this release
 * does not know is refused, as an unknown token kind is.
 */
export const parseJob = (value: unknown): Job | string => {
  if (!isObject(value)) return "the job is not an object";
  const { workflow, id, version, deadline, repo, appLogin } = value;
  if (!JOB_KINDS.some((known) => known === workflow)) return `\`workflow\` is not one of ${JOB_KINDS.map((k) => `\`${k}\``).join(", ")}`;
  if (typeof id !== "string" || id === "") return "`id` is not a non-empty string";
  if (typeof version !== "string" || version === "") return "`version` is not a non-empty string";
  if (typeof deadline !== "string" || Number.isNaN(Date.parse(deadline))) return "`deadline` is not a time";
  if (typeof repo !== "string" || !REPO.test(repo)) return "`repo` is not `owner/name`";
  if (typeof appLogin !== "string" || appLogin === "") return "`appLogin` is not a non-empty string";
  return PARSERS[workflow as JobKind]({ id, version, deadline, repo, appLogin }, value);
};

/** A token request read off the wire, or the reason it is not one. */
export const parseTokenRequest = (value: unknown): TokenRequest | string => {
  if (!isObject(value)) return "the request is not an object";
  const { jobId, kind } = value;
  if (typeof jobId !== "string" || jobId === "") return "`jobId` is not a non-empty string";
  if (!TOKEN_KINDS.some((known) => known === kind)) return `\`kind\` is not one of ${TOKEN_KINDS.map((k) => `\`${k}\``).join(", ")}`;
  return { jobId, kind: kind as TokenKind };
};
