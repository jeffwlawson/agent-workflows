// The orchestrator's own vocabulary. Everything past a source adapter speaks
// this, never a webhook payload, so any caller that can produce a Job can drive
// the core (#364, step 2). It is deliberately small: the core resolves the rest
// from the forge, which is where the prototype is still GitHub-bound (finding).

export interface ReviewJob {
  readonly kind: "review";
  /** `owner/name`. */
  readonly repo: string;
  readonly pr: number;
  /** The head the caller saw. A job whose head has moved is refused, as review.yml's pre-flight does. */
  readonly headSha?: string;
  /** Who asked: `github`, `generic`, … — for the log only. */
  readonly source: string;
  /**
   * A short-lived GitHub token for this job alone, minted by the dispatcher
   * from the loop's App key, which never enters the agent box. Absent, the
   * worker falls back to its own gh login (replay and local runs).
   */
  readonly token?: string;
}

export type Job = ReviewJob;

/** Parse an untrusted generic-endpoint body into a Job, or say why not. */
export const parseJob = (value: unknown): Job | string => {
  if (typeof value !== "object" || value === null) return "body is not an object";
  const v = value as Record<string, unknown>;
  if (v["kind"] !== "review") return `unknown kind: ${String(v["kind"])}`;
  const repo = v["repo"];
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return "repo must be owner/name";
  const pr = v["pr"];
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0) return "pr must be a positive integer";
  const headSha = v["headSha"];
  if (headSha !== undefined && (typeof headSha !== "string" || !/^[0-9a-f]{40}$/.test(headSha))) {
    return "headSha must be a 40-character sha";
  }
  const token = v["token"];
  if (token !== undefined && (typeof token !== "string" || !/^gh[sp]_[A-Za-z0-9_]{20,255}$/.test(token))) {
    return "token must be a GitHub installation or user token";
  }
  return {
    kind: "review",
    repo,
    pr,
    ...(headSha === undefined ? {} : { headSha }),
    ...(token === undefined ? {} : { token }),
    source: typeof v["source"] === "string" ? `generic:${v["source"]}` : "generic",
  };
};
