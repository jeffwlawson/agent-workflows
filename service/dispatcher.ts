import { randomUUID } from "node:crypto";
import { FIX_LABEL, FOLLOW_UPS_LABEL, IMPLEMENT_LABEL, ORCHESTRATOR_VARIABLE, REVIEW_LABEL, SERVICE_ORCHESTRATOR, UPDATE_BRANCH_LABEL } from "../shared/record.js";
import {
  parseTokenRequest,
  REPOSITORY_VARIABLES,
  SIGNATURE_HEADER,
  sign,
  TIME_LIMITS,
  verifySignature,
  type Job,
  type JobKind,
  type RepositoryVariable,
  type TokenGrant,
  type TokenKind,
} from "./job.js";

/**
 * The service orchestrator's dispatcher (#456): the only holder of the GitHub
 * App's key. It has two doors. GitHub's webhook deliveries come in at one, and
 * a trigger label's delivery on a repository that opted in becomes a job of
 * the kind its label maps to, posted to the worker with no token in it. The
 * worker's token requests come in at the other, and each is answered with a
 * token scoped to the job's repository, for the one phase it asks for, while
 * the job is live and the repository still opts in.
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
  /** Added to a job's own time limit, its kind's, for its deadline. */
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
 * the code, the pull request or the issue and its conversation, checks and
 * statuses.
 * `write` adds what review's posting commands write: the review and the ready
 * mark, comments and labels, and the verdict's statuses. `push` adds a push to
 * `write`: the branch's contents, and `workflows`, without which GitHub refuses
 * a push touching `.github/workflows/**`. It is for the phases that push and
 * run no agent; the runner only ever gets `read`.
 */
export const TOKEN_PERMISSIONS: Readonly<Record<TokenKind, Readonly<Record<string, string>>>> = {
  read: { contents: "read", pull_requests: "read", issues: "read", checks: "read", statuses: "read" },
  write: { contents: "read", pull_requests: "write", issues: "write", checks: "read", statuses: "write" },
  push: { contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "write", workflows: "write" },
};

/**
 * The job kind each trigger label the service answers starts (ADR 0008), by
 * the event it is answered on: a label is answered on the event type it
 * belongs to, and on no other. `agent:implement` on a pull request starts
 * nothing, and neither does `agent:review` on an issue. Every trigger label
 * the loop has is here: `agent:follow-ups` is the last (#519), answered on a
 * closed pull request, where every other pull request label is answered on an
 * open one, and as the label a merge is filtered on.
 *
 * An issue's label starts a list of kinds: `agent:implement` starts both
 * `implement` and `implement-prd`, as Actions starts both workflows on it.
 * Each one's gate partitions on the issue's shape and defers the other's
 * without a word, so the dispatcher reads nothing of the shape itself.
 */
export const LABEL_KINDS: {
  readonly pull_request: Readonly<Record<string, Exclude<JobKind, "implement" | "implement-prd">>>;
  readonly issues: Readonly<Record<string, readonly ("implement" | "implement-prd")[]>>;
} = {
  pull_request: {
    [REVIEW_LABEL]: "review",
    [FIX_LABEL]: "fix",
    [UPDATE_BRANCH_LABEL]: "update-branch",
    [FOLLOW_UPS_LABEL]: "follow-ups",
  },
  issues: {
    [IMPLEMENT_LABEL]: ["implement", "implement-prd"],
  },
};

/**
 * The trigger labels the service orchestrator answers on a repository that
 * opts in, and the one list of them: `LABEL_KINDS`' keys, on either event, so
 * no label is answered that starts no job. `doctor` reads it to name the
 * labels nothing answers there.
 */
export const SERVICE_LABELS: readonly string[] = Object.values(LABEL_KINDS).flatMap((kinds) => Object.keys(kinds));

/** What `label` starts in one event's map, or `undefined` where it starts nothing there, an inherited property's name included. */
const kindOf = <K>(kinds: Readonly<Record<string, K>>, label: string): K | undefined =>
  Object.hasOwn(kinds, label) ? kinds[label] : undefined;

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
    readonly labels?: readonly ({ readonly name?: unknown } | null)[];
    readonly head?: { readonly ref?: unknown; readonly sha?: unknown; readonly repo?: { readonly full_name?: unknown } | null };
    readonly base?: { readonly ref?: unknown };
  };
}

/** The parts of an `issues` delivery the dispatcher reads. */
interface IssueLabelEvent {
  readonly action?: unknown;
  readonly label?: { readonly name?: unknown };
  readonly sender?: { readonly login?: unknown };
  readonly repository?: { readonly full_name?: unknown; readonly default_branch?: unknown };
  readonly issue?: {
    readonly number?: unknown;
    readonly title?: unknown;
    readonly state?: unknown;
    /** Present where the issue is a pull request's. */
    readonly pull_request?: unknown;
  };
}

/** A job's own fields, without those every job carries, which the dispatcher fills in. */
type OwnFields<J> = J extends Job ? Omit<J, "id" | "version" | "deadline" | "appLogin" | "variables"> : never;
type Dispatchable = OwnFields<Job>;

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
   * Why the delivery's repository is not served, or `undefined` where it is:
   * the App is installed, on an account it serves, and the repository opts in.
   */
  const unserved = async (repo: string): Promise<string | undefined> => {
    const account = await edges.github.installation(repo);
    if (account === undefined) return `the App is not installed on ${repo}`;
    // Ahead of the opt-in, so a stranger's repository is never read further.
    const stranger = foreign(account);
    if (stranger !== undefined) return stranger;
    const orchestrator = await edges.github.variable(repo, ORCHESTRATOR_VARIABLE);
    if (orchestrator !== SERVICE_ORCHESTRATOR) {
      return `${ORCHESTRATOR_VARIABLE} is ${orchestrator === undefined ? "unset" : `\`${orchestrator}\``}, not \`${SERVICE_ORCHESTRATOR}\``;
    }
    return undefined;
  };

  /**
   * Why the label's sender is not answered, or `undefined` where it is. The
   * App's own label is the loop's: it adds one only where a command decided
   * to, under the repository's budget, so its login is trusted without a
   * lookup (ADR 0008). Every other sender is a person's, who must be able to
   * write.
   */
  const untrusted = async (repo: string, sender: string, login: string): Promise<string | undefined> => {
    if (sender.toLowerCase() === login.toLowerCase()) return undefined;
    const permission = await edges.github.permission(repo, sender);
    return permission === undefined || !WRITERS.includes(permission) ? `${sender} cannot write to ${repo}` : undefined;
  };

  /**
   * Posts a job of `fields`' kind to the worker: the repository's variables
   * read, and its deadline from its kind's own time limit.
   */
  const dispatch = async (fields: Dispatchable, login: string, where: string, at: string): Promise<string> => {
    const variables = Object.fromEntries(
      await Promise.all(REPOSITORY_VARIABLES.map(async (name) => [name, (await edges.github.variable(fields.repo, name)) ?? ""] as const)),
    ) as Record<RepositoryVariable, string>;
    const minutes = TIME_LIMITS[fields.workflow](variables) + edges.deadlineMarginMinutes;
    const deadline = new Date(now().getTime() + minutes * 60_000);
    const job = { ...fields, id: newId(), version: edges.version, deadline: deadline.toISOString(), appLogin: login, variables } as Job;

    prune();
    // Known before the worker hears of it, so its first token request cannot
    // arrive ahead of the job it names.
    jobs.set(job.id, { repo: job.repo, deadline });
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
    return `dispatched ${where}${at} as job ${job.id}, deadline ${job.deadline}`;
  };

  /**
   * **A merge's route** (#519), `follow-ups.yml`'s other entry point: a
   * follow-ups job for every pull request merged, whatever its labels, as
   * Actions starts its job on every merge. The run posts the post-merge
   * checklist on every merge (#544), and `follow-ups:file` reads the
   * `agent:follow-ups` marker itself, live, to decide whether to file; a merge
   * with neither ends silently. A close without a merge is ignored, as Actions
   * never starts its job for one.
   *
   * **No author gate.** Whoever merged could write, and a merge queue or
   * auto-merge can send the event as a bot the gate would refuse, which would
   * drop the follow-ups without a word. Actions' job checks no sender either.
   */
  const merge = async (p: LabelEvent): Promise<string> => {
    const repo = p.repository?.full_name;
    const pr = p.pull_request?.number;
    if (typeof repo !== "string" || typeof pr !== "number") return "refused: the delivery is missing a field a job needs";
    const where = `${repo}#${pr}`;
    // Literally `true`, as `follow-ups.yml`'s condition reads it.
    if (p.pull_request?.merged !== true) return `ignored on ${where}: closed without being merged`;
    const why = await unserved(repo);
    if (why !== undefined) return `refused on ${where}: ${why}`;
    if (p.pull_request.head?.repo?.full_name !== repo) return `refused on ${where}: the head is on a fork`;
    const login = appLogin((await edges.github.app()).slug);
    return dispatch({ workflow: "follow-ups", repo, pr }, login, where, " on its merge");
  };

  /**
   * **A pull request's route**: whether a `pull_request` delivery is a job,
   * and the job where it is; otherwise the reason it is not, which is logged.
   * What there is nothing to answer, a label no job starts on or a close
   * without a merge, is ignored first, before anything of the
   * repository is read. The cheap refusals, the fork and the state, are left
   * until after the opt-in, so a repository that has not opted in is logged
   * as that rather than as one of them.
   * A label is answered on an open pull request, but for `agent:follow-ups`,
   * which is answered on a closed one, merged or not, as `follow-ups.yml`'s
   * condition answers it, author gate and all; a close is a merge's route.
   */
  const pullRequest = async (payload: unknown): Promise<string> => {
    const p = (payload ?? {}) as LabelEvent;
    if (p.action === "closed") return merge(p);
    if (p.action !== "labeled") return `ignored: a pull request \`${String(p.action)}\`, not labelled or closed`;
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
    const kind = kindOf(LABEL_KINDS.pull_request, label);
    if (kind === undefined) return `ignored on ${where}: \`${label}\` is not a label this release's service answers on a pull request`;
    const why = await unserved(repo);
    if (why !== undefined) return `refused on ${where}: ${why}`;
    if (p.pull_request?.head?.repo?.full_name !== repo) return `refused on ${where}: the head is on a fork`;
    if (kind === "follow-ups") {
      if (state !== "closed") return `refused on ${where}: the pull request is ${state}, and \`${FOLLOW_UPS_LABEL}\` is answered on a closed one`;
    } else if (state !== "open") return `refused on ${where}: the pull request is ${state}, not open`;
    const login = appLogin((await edges.github.app()).slug);
    const distrust = await untrusted(repo, sender, login);
    if (distrust !== undefined) return `refused on ${where}: ${distrust}`;
    if (kind === "follow-ups") return dispatch({ workflow: kind, repo, pr }, login, where, " on its label");
    return dispatch(
      { workflow: kind, repo, pr, branch, headSha, baseRef, state, merged: p.pull_request?.merged === true },
      login,
      where,
      ` at ${headSha}`,
    );
  };

  /**
   * **An issue's route**, as a pull request's, in the same order, and with
   * no head to check: an issue has none. Nor is its state checked: a closed
   * issue goes to the gates carrying its state, and the one whose issue it is
   * says so on the issue and takes the label off, as on Actions. Nor is its
   * shape: a job of each kind the label starts is dispatched, in turn, and the
   * gate of the one whose shape it is not defers without a word. Its base is
   * the repository's default branch, the nearest the event has to the
   * `default-branch` a caller hands `implement.yml` and `implement-prd.yml`.
   * An `issues` delivery about a pull request is ignored: a pull request's
   * labels are answered on its own route. The line logged is each dispatch's.
   */
  const issue = async (payload: unknown): Promise<string> => {
    const p = (payload ?? {}) as IssueLabelEvent;
    if (p.action !== "labeled") return `ignored: an issue \`${String(p.action)}\`, not labelled`;
    const label = p.label?.name;
    const repo = p.repository?.full_name;
    const baseRef = p.repository?.default_branch;
    const number = p.issue?.number;
    const title = p.issue?.title;
    const state = p.issue?.state;
    const sender = p.sender?.login;
    if (
      typeof label !== "string" ||
      typeof repo !== "string" ||
      typeof baseRef !== "string" ||
      typeof number !== "number" ||
      typeof title !== "string" ||
      typeof state !== "string" ||
      typeof sender !== "string"
    ) {
      return "refused: the delivery is missing a field a job needs";
    }
    const where = `${repo}#${number}`;
    if (p.issue?.pull_request !== undefined && p.issue.pull_request !== null) {
      return `ignored on ${where}: the issue is a pull request, whose labels are answered on its \`pull_request\` event`;
    }
    const kinds = kindOf(LABEL_KINDS.issues, label);
    if (kinds === undefined) return `ignored on ${where}: \`${label}\` is not a label this release's service answers on an issue`;
    const why = await unserved(repo);
    if (why !== undefined) return `refused on ${where}: ${why}`;
    const login = appLogin((await edges.github.app()).slug);
    const distrust = await untrusted(repo, sender, login);
    if (distrust !== undefined) return `refused on ${where}: ${distrust}`;
    const outcomes: string[] = [];
    for (const kind of kinds) outcomes.push(await dispatch({ workflow: kind, repo, issue: number, title, state, baseRef }, login, where, ` to ${kind}`));
    return outcomes.join("; ");
  };

  /** Whether a delivery is a job, routed by its event type; otherwise the reason it is not, which is logged. */
  const decide = async (event: string | undefined, payload: unknown): Promise<string> => {
    if (event === "ping") return "ping: answered";
    if (event === "pull_request") return pullRequest(payload);
    if (event === "issues") return issue(payload);
    return `ignored: \`${event ?? "unnamed"}\` is neither a pull request's nor an issue's event`;
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
