import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * What the service orchestrator's two processes say to each other (#456): the
 * job the dispatcher posts to the worker, the token request the worker makes
 * of the dispatcher, and the signature on both. One module, imported by both,
 * so the format only has to hold within one release; the job carries the
 * release that wrote it, for the worker to refuse another's.
 */

/**
 * The repository variables review reads, which the dispatcher reads off the
 * repository and the job carries, so a repository's settings mean the same
 * thing under both orchestrators. Unset is `""`, as an unset `vars.X` is on
 * Actions.
 */
export const REVIEW_VARIABLES = [
  "AGENT_MODEL",
  "AGENT_MODEL_REVIEW",
  "AGENT_REVIEW_TIMEOUT_MINUTES",
  "AGENT_MAX_FIX_ROUNDS",
] as const;

export type ReviewVariable = (typeof REVIEW_VARIABLES)[number];

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
 * One `agent:review` delivery, as a job for the worker: what the label's event
 * carried, what the dispatcher read, and nothing that grants anything. **It
 * carries no token**: the worker asks for one per phase, naming `id`.
 */
export interface ReviewJob {
  /** The dispatcher's name for the job, which a token request names. */
  readonly id: string;
  /** The release of the dispatcher that wrote it. */
  readonly version: string;
  /** When the dispatcher stops minting for it, as an ISO time. */
  readonly deadline: string;
  /** `owner/name`. */
  readonly repo: string;
  readonly pr: number;
  /** The head branch, as the event carried it. */
  readonly branch: string;
  /** The head commit, as the event carried it. */
  readonly headSha: string;
  /** The pull request's state, as the event carried it. */
  readonly state: string;
  readonly merged: boolean;
  /** The login the App posts as, `<slug>[bot]`, read off the App's own record. */
  readonly appLogin: string;
  readonly variables: Readonly<Record<ReviewVariable, string>>;
}

/** What a token is for: reading only, or the posting phases' writes as well. */
export const TOKEN_KINDS = ["read", "write"] as const;

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

/**
 * A job read off the wire, or the reason it is not one. The body is signed,
 * so this guards against a release's drift rather than an attacker: every
 * field is checked for the shape the worker hands on.
 */
export const parseJob = (value: unknown): ReviewJob | string => {
  if (!isObject(value)) return "the job is not an object";
  const { id, version, deadline, repo, pr, branch, headSha, state, merged, appLogin, variables } = value;
  if (typeof id !== "string" || id === "") return "`id` is not a non-empty string";
  if (typeof version !== "string" || version === "") return "`version` is not a non-empty string";
  if (typeof deadline !== "string" || Number.isNaN(Date.parse(deadline))) return "`deadline` is not a time";
  if (typeof repo !== "string" || !REPO.test(repo)) return "`repo` is not `owner/name`";
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0) return "`pr` is not a positive integer";
  if (typeof branch !== "string" || branch === "") return "`branch` is not a non-empty string";
  if (typeof headSha !== "string" || !SHA.test(headSha)) return "`headSha` is not a 40-character commit";
  if (typeof state !== "string" || state === "") return "`state` is not a non-empty string";
  if (typeof merged !== "boolean") return "`merged` is not a boolean";
  if (typeof appLogin !== "string" || appLogin === "") return "`appLogin` is not a non-empty string";
  if (!isObject(variables)) return "`variables` is not an object";
  const read: Partial<Record<ReviewVariable, string>> = {};
  for (const name of REVIEW_VARIABLES) {
    const given = variables[name];
    if (typeof given !== "string") return `\`variables.${name}\` is not a string`;
    read[name] = given;
  }
  return {
    id,
    version,
    deadline,
    repo,
    pr,
    branch,
    headSha,
    state,
    merged,
    appLogin,
    variables: read as Record<ReviewVariable, string>,
  };
};

/** A token request read off the wire, or the reason it is not one. */
export const parseTokenRequest = (value: unknown): TokenRequest | string => {
  if (!isObject(value)) return "the request is not an object";
  const { jobId, kind } = value;
  if (typeof jobId !== "string" || jobId === "") return "`jobId` is not a non-empty string";
  if (!TOKEN_KINDS.some((known) => known === kind)) return `\`kind\` is not one of ${TOKEN_KINDS.map((k) => `\`${k}\``).join(", ")}`;
  return { jobId, kind: kind as TokenKind };
};
