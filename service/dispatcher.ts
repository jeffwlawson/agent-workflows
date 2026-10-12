import { randomUUID } from "node:crypto";
import { ORCHESTRATOR_VARIABLE, SERVICE_LABELS, SERVICE_ORCHESTRATOR } from "../shared/record.js";
import {
  parseTokenRequest,
  REVIEW_VARIABLES,
  reviewTimeLimit,
  SIGNATURE_HEADER,
  sign,
  verifySignature,
  type ReviewJob,
  type ReviewVariable,
  type TokenGrant,
  type TokenKind,
} from "./job.js";

/**
 * The service orchestrator's dispatcher (#456): the only holder of the GitHub
 * App's key. It has two doors. GitHub's webhook deliveries come in at one, and
 * an `agent:review` delivery on a repository that opted in becomes a job,
 * posted to the worker with no token in it. The worker's token requests come
 * in at the other, and each is answered with a token scoped to the job's
 * repository, for the one phase it asks for, while the job is live and the
 * repository still opts in.
 *
 * Its decisions are here, over edges it is handed: the App's view of GitHub,
 * the worker, the clock and the job ids. `serve.ts` puts them behind HTTP.
 */

/** What the App's own record says of it. */
export interface AppRecord {
  /** The App's slug, which its login is made from. */
  readonly slug: string;
  /** The login of the account that owns the App. */
  readonly owner: string;
}

/** What the dispatcher asks of GitHub, as its App. */
export interface AppGitHub {
  /** The App's own record. */
  app(): Promise<AppRecord>;
  /**
   * The login of the account the App's installation on `repo` is on, or
   * `undefined` where the App is not installed on `repo`.
   */
  installation(repo: string): Promise<string | undefined>;
  /**
   * A variable's value as `vars` resolves it for `repo`: the repository's own,
   * else its organization's shared with it, or `undefined` where neither is
   * set. Throws where it could not be read.
   */
  variable(repo: string, name: string): Promise<string | undefined>;
  /** `login`'s permission on `repo`, `admin`, `maintain`, `write`, `triage` or `read`, or `undefined` for none. */
  permission(repo: string, login: string): Promise<string | undefined>;
  /** A token for `repo` alone, with `permissions`. */
  mint(repo: string, permissions: Readonly<Record<string, string>>): Promise<TokenGrant>;
}

/** Where a job goes: posts the signed body, and answers with the HTTP status the worker gave. */
export type WorkerPost = (body: string, headers: Readonly<Record<string, string>>) => Promise<number>;

export interface DispatcherEdges {
  readonly github: AppGitHub;
  readonly postJob: WorkerPost;
  /** The App's webhook secret. */
  readonly webhookSecret: string;
  /** The secret shared with the worker. */
  readonly workerSecret: string;
  /**
   * The accounts whose installations the dispatcher serves: the App's owner,
   * read off the App's own record at start, and the extra owners its settings
   * list. Any other account's is refused, even where the App is installed
   * there and the repository opts in.
   */
  readonly owners: readonly string[];
  /** Added to review's time limit for a job's deadline. */
  readonly deadlineMarginMinutes: number;
  /** The release this dispatcher is, which each job carries. */
  readonly version: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** A request as either door received it: its headers, lower-cased, and its raw body. */
export interface DoorRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Buffer;
}

/** A door's answer. */
export interface DoorResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * The webhook door's answer, which is sent at once, and the work it goes on
 * to do, which ends in the line the dispatcher logs: GitHub gives up on a
 * delivery after ten seconds, and reading the repository takes several calls.
 */
export interface Delivery {
  readonly response: DoorResponse;
  readonly outcome: Promise<string>;
}

/**
 * The token permissions of each kind. `read` is what every phase reads with:
 * the code, the pull request and its conversation, checks and statuses.
 * `write` adds what review's posting commands write: the review and the ready
 * mark, comments and labels, and the verdict's statuses.
 */
export const TOKEN_PERMISSIONS: Readonly<Record<TokenKind, Readonly<Record<string, string>>>> = {
  read: { contents: "read", pull_requests: "read", issues: "read", checks: "read", statuses: "read" },
  write: { contents: "read", pull_requests: "write", issues: "write", checks: "read", statuses: "write" },
};

/** The permissions a label's sender needs on the repository: the loop's author gate. */
const WRITERS = ["admin", "maintain", "write"];

/** The login an App posts as, in the REST spelling: `<slug>[bot]`. */
export const appLogin = (slug: string): string => `${slug}[bot]`;

/** The parts of a `pull_request` delivery the dispatcher reads. */
interface LabelEvent {
  readonly action?: unknown;
  readonly label?: { readonly name?: unknown };
  readonly sender?: { readonly login?: unknown };
  readonly repository?: { readonly full_name?: unknown };
  readonly pull_request?: {
    readonly number?: unknown;
    readonly state?: unknown;
    readonly merged?: unknown;
    readonly head?: { readonly ref?: unknown; readonly sha?: unknown; readonly repo?: { readonly full_name?: unknown } | null };
    readonly base?: { readonly ref?: unknown };
  };
}

const text = (headers: DoorRequest["headers"], name: string): string | undefined => headers[name];

/** A JSON body, or `undefined` where it is not JSON. */
const json = (body: Buffer): unknown => {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
};

const answer = (status: number, body: unknown): DoorResponse => ({ status, body: JSON.stringify(body) });

/** What the dispatcher remembers of a job it dispatched: enough to mint for it, and no more. */
interface Dispatched {
  readonly repo: string;
  readonly deadline: Date;
}

/**
 * The extra owners a setting lists, comma-separated, each trimmed, an empty
 * entry dropped: `""` is none.
 */
export const parseOwners = (setting: string): readonly string[] =>
  setting
    .split(",")
    .map((owner) => owner.trim())
    .filter((owner) => owner !== "");

export const createDispatcher = (edges: DispatcherEdges) => {
  const now = edges.now ?? (() => new Date());
  // GitHub's logins are case-insensitive, so the comparison is too.
  const owners = new Set(edges.owners.map((owner) => owner.toLowerCase()));
  /**
   * Why an installation on `account` is not served, or `undefined` where it
   * is: on the App's owner's account, or one the settings list.
   */
  const foreign = (account: string): string | undefined =>
    owners.has(account.toLowerCase())
      ? undefined
      : `the App's installation is on ${account}, which is neither the App's owner nor an account EXTRA_OWNERS lists`;
  const newId = edges.newId ?? randomUUID;
  const jobs = new Map<string, Dispatched>();

  /**
   * Forget every job past its deadline, which no request can be granted for
   * again, so a dispatcher that runs for months holds only live ones. Done at
   * each dispatch; a token request for a forgotten job is refused as unknown.
   */
  const prune = (): void => {
    for (const [id, job] of jobs) if (job.deadline.getTime() <= now().getTime()) jobs.delete(id);
  };

  /**
   * Whether a delivery is a job, and the job where it is; otherwise the
   * reason it is not, which is logged. The cheap refusals, read off the
   * payload, are left until after the opt-in, so a repository that has not
   * opted in is always logged as that.
   */
  const decide = async (event: string | undefined, payload: unknown): Promise<string> => {
    if (event === "ping") return "ping: answered";
    if (event !== "pull_request") return `ignored: a \`${event ?? "unnamed"}\` event, not a pull request's`;
    const p = (payload ?? {}) as LabelEvent;
    if (p.action !== "labeled") return `ignored: a pull request \`${String(p.action)}\`, not labelled`;
    const label = p.label?.name;
    const repo = p.repository?.full_name;
    const pr = p.pull_request?.number;
    const branch = p.pull_request?.head?.ref;
    const headSha = p.pull_request?.head?.sha;
    const baseRef = p.pull_request?.base?.ref;
    const state = p.pull_request?.state;
    const sender = p.sender?.login;
    if (
      typeof label !== "string" ||
      typeof repo !== "string" ||
      typeof pr !== "number" ||
      typeof branch !== "string" ||
      typeof headSha !== "string" ||
      typeof baseRef !== "string" ||
      typeof state !== "string" ||
      typeof sender !== "string"
    ) {
      return "refused: the delivery is missing a field a job needs";
    }
    const where = `${repo}#${pr}`;
    // `SERVICE_LABELS` is the one list of what the service answers, and
    // review is the one job it runs at this release.
    if (!SERVICE_LABELS.includes(label)) return `ignored on ${where}: \`${label}\` is not a label this release's service answers`;
    const account = await edges.github.installation(repo);
    if (account === undefined) return `refused on ${where}: the App is not installed on ${repo}`;
    // Ahead of the opt-in, so a stranger's repository is never read further.
    const stranger = foreign(account);
    if (stranger !== undefined) return `refused on ${where}: ${stranger}`;
    const orchestrator = await edges.github.variable(repo, ORCHESTRATOR_VARIABLE);
    if (orchestrator !== SERVICE_ORCHESTRATOR) {
      return `refused on ${where}: ${ORCHESTRATOR_VARIABLE} is ${orchestrator === undefined ? "unset" : `\`${orchestrator}\``}, not \`${SERVICE_ORCHESTRATOR}\``;
    }
    if (p.pull_request?.head?.repo?.full_name !== repo) return `refused on ${where}: the head is on a fork`;
    if (state !== "open") return `refused on ${where}: the pull request is ${state}, not open`;
    const permission = await edges.github.permission(repo, sender);
    if (permission === undefined || !WRITERS.includes(permission)) {
      return `refused on ${where}: ${sender} cannot write to ${repo}`;
    }

    const variables = Object.fromEntries(
      await Promise.all(REVIEW_VARIABLES.map(async (name) => [name, (await edges.github.variable(repo, name)) ?? ""] as const)),
    ) as Record<ReviewVariable, string>;
    const minutes = reviewTimeLimit(variables.AGENT_REVIEW_TIMEOUT_MINUTES) + edges.deadlineMarginMinutes;
    const deadline = new Date(now().getTime() + minutes * 60_000);
    const job: ReviewJob = {
      id: newId(),
      version: edges.version,
      deadline: deadline.toISOString(),
      repo,
      pr,
      branch,
      headSha,
      baseRef,
      state,
      merged: p.pull_request?.merged === true,
      appLogin: appLogin((await edges.github.app()).slug),
      variables,
    };

    prune();
    // Known before the worker hears of it, so its first token request cannot
    // arrive ahead of the job it names.
    jobs.set(job.id, { repo, deadline });
    const body = JSON.stringify(job);
    let status: number;
    try {
      status = await edges.postJob(body, { "content-type": "application/json", [SIGNATURE_HEADER]: sign(edges.workerSecret, body) });
    } catch (error) {
      jobs.delete(job.id);
      return `failed on ${where}: the worker could not be reached: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (status < 200 || status >= 300) {
      jobs.delete(job.id);
      return `failed on ${where}: the worker answered ${status}`;
    }
    return `dispatched ${where} at ${headSha} as job ${job.id}, deadline ${job.deadline}`;
  };

  /**
   * **The webhook door.** A delivery whose signature does not verify is
   * refused, `401`; every other is answered `202` at once, and the outcome
   * follows, a job or the reason it is not one.
   */
  const delivery = (request: DoorRequest): Delivery => {
    if (!verifySignature(edges.webhookSecret, request.body, text(request.headers, "x-hub-signature-256"))) {
      return { response: answer(401, { refusal: "bad signature" }), outcome: Promise.resolve("refused: bad signature") };
    }
    const event = text(request.headers, "x-github-event");
    const payload = json(request.body);
    const outcome =
      payload === undefined
        ? Promise.resolve("refused: the body is not JSON")
        : decide(event, payload).catch(
            (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`,
          );
    return { response: answer(202, { accepted: true }), outcome };
  };

  /**
   * **The token door.** A request whose signature does not verify is refused.
   * One that does gets a token only for a job this dispatcher dispatched,
   * before that job's deadline, for that job's repository alone, with the
   * permissions of the kind it asks for, and only while the repository still
   * opts in, read again for each request: a repository switched back to Actions
   * stops a job in flight at its next phase.
   */
  const token = async (request: DoorRequest): Promise<DoorResponse> => {
    if (!verifySignature(edges.workerSecret, request.body, text(request.headers, SIGNATURE_HEADER))) {
      return answer(401, { refusal: "bad signature" });
    }
    const asked = parseTokenRequest(json(request.body));
    if (typeof asked === "string") return answer(400, { refusal: asked });
    const job = jobs.get(asked.jobId);
    if (job === undefined) return answer(404, { refusal: `job ${asked.jobId} is not one this dispatcher dispatched` });
    if (job.deadline.getTime() <= now().getTime()) {
      jobs.delete(asked.jobId);
      return answer(403, { refusal: `job ${asked.jobId} is past its deadline, ${job.deadline.toISOString()}` });
    }
    // A GitHub that cannot be read is refused like a repository that has
    // opted out: the dispatcher mints for nothing it cannot confirm.
    try {
      const account = await edges.github.installation(job.repo);
      if (account === undefined) return answer(403, { refusal: `the App is no longer installed on ${job.repo}` });
      const stranger = foreign(account);
      if (stranger !== undefined) return answer(403, { refusal: stranger });
      if ((await edges.github.variable(job.repo, ORCHESTRATOR_VARIABLE)) !== SERVICE_ORCHESTRATOR) {
        return answer(403, { refusal: `${job.repo} no longer has ${ORCHESTRATOR_VARIABLE} set to \`${SERVICE_ORCHESTRATOR}\`` });
      }
      return answer(200, await edges.github.mint(job.repo, TOKEN_PERMISSIONS[asked.kind]));
    } catch (error) {
      return answer(502, { refusal: `GitHub could not be read or could not mint: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  return { delivery, token };
};

export type Dispatcher = ReturnType<typeof createDispatcher>;
