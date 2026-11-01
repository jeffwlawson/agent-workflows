import { randomUUID } from "node:crypto";
import { FIX_LABEL, FOLLOW_UPS_LABEL, IMPLEMENT_LABEL, ORCHESTRATOR_VARIABLE, REVIEW_LABEL, SERVICE_ORCHESTRATOR, UPDATE_BRANCH_LABEL } from "../shared/record.js";
import {
  parseHeld,
  parseTokenRequest,
  REPOSITORY_VARIABLES,
  SIGNATURE_HEADER,
  sign,
  TIME_LIMITS,
  verifySignature,
  type HeldJob,
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
  /** The repository permissions the App is granted, by the names GitHub gives them, each to its access. */
  readonly permissions: Readonly<Record<string, string>>;
  /** The webhook events the App is subscribed to. */
  readonly events: readonly string[];
}

/**
 * An open issue or pull request carrying a label, as the scan lists it
 * (#581): what a label's delivery would have carried of it, read now. `type`
 * is the event its labels are answered on.
 */
export type Labelled =
  | {
      readonly type: "issues";
      readonly number: number;
      readonly title: string;
      readonly state: string;
    }
  | {
      readonly type: "pull_request";
      readonly number: number;
      readonly state: string;
      readonly merged: boolean;
      readonly branch: string;
      readonly headSha: string;
      /** The head's repository, `owner/name`, or `undefined` where it was deleted. */
      readonly headRepo: string | undefined;
      readonly baseRef: string;
    };

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
  /** The login of each account the App is installed on. */
  installations(): Promise<readonly string[]>;
  /** The repositories the App's installation on `account` reaches, each `owner/name`. */
  repositories(account: string): Promise<readonly string[]>;
  /** The open issues and pull requests on `repo` carrying `label`, each as it reads now. */
  labelled(repo: string, label: string): Promise<readonly Labelled[]>;
  /**
   * The login of the actor of the latest `labeled` event for `label` on
   * `repo`'s issue or pull request `number`, or `undefined` where there is none.
   */
  labeller(repo: string, number: number, label: string): Promise<string | undefined>;
  /** `repo`'s default branch. */
  defaultBranch(repo: string): Promise<string>;
}

/** Where a job goes: posts the signed body, and answers with the HTTP status the worker gave. */
export type WorkerPost = (body: string, headers: Readonly<Record<string, string>>) => Promise<number>;

/** The worker's held door: posts the signed body, and answers with the worker's status and body. */
export type WorkerQuery = (body: string, headers: Readonly<Record<string, string>>) => Promise<{ readonly status: number; readonly body: string }>;

export interface DispatcherEdges {
  readonly github: AppGitHub;
  readonly postJob: WorkerPost;
  /** Asks the worker which jobs it holds, queued or running. */
  readonly askHeld: WorkerQuery;
  /** Where the scan's lines go, one per item it decided on. */
  readonly log: (line: string) => void;
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
 * The permissions the dispatcher's own reads mint with, a repository's
 * variables and a sender's permission. `actions_variables` is GitHub's name
 * for the App's "Variables" permission; a token asking for `variables` is
 * refused, 422.
 */
export const READER_PERMISSIONS: Readonly<Record<string, string>> = { metadata: "read", actions_variables: "read" };

/**
 * The permissions the scan's reads mint with (#581): the dispatcher's own
 * reads, and the open issues and pull requests, their labels and events.
 */
export const SCAN_PERMISSIONS: Readonly<Record<string, string>> = { ...READER_PERMISSIONS, issues: "read", pull_requests: "read" };

/** Access levels, lowest first: a grant at a later one covers a need at an earlier one. */
const ACCESS = ["read", "write", "admin"];

const covers = (held: string | undefined, needed: string): boolean => held !== undefined && ACCESS.indexOf(held) >= ACCESS.indexOf(needed);

/** Each token the dispatcher mints, by what it is called in a gap's line, to the permissions it asks for. */
const MINTS: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
  ["the dispatcher's reads", READER_PERMISSIONS],
  ["the scan's reads", SCAN_PERMISSIONS],
  ...Object.entries(TOKEN_PERMISSIONS).map(([kind, permissions]) => [`\`${kind}\` tokens`, permissions] as const),
];

/**
 * What the service needs of the App, and the one declaration of it: each
 * permission at the highest access a token it mints asks for it at, which the
 * deployment guide's Permissions table is held equal to.
 */
export const SERVICE_APP_PERMISSIONS: Readonly<Record<string, string>> = MINTS.reduce<Record<string, string>>((needed, [, permissions]) => {
  for (const [name, access] of Object.entries(permissions)) if (!covers(needed[name], access)) needed[name] = access;
  return needed;
}, {});

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

/**
 * The trigger labels a scan lists (#581): every one but `agent:follow-ups`,
 * a marker that stays on until the pull request is merged and filed, not a
 * label that says a run is working; a merge's follow-ups job comes from the
 * merge's own delivery.
 */
const SCAN_LABELS: readonly string[] = SERVICE_LABELS.filter((label) => label !== FOLLOW_UPS_LABEL);

/** What `label` starts in one event's map, or `undefined` where it starts nothing there, an inherited property's name included. */
const kindOf = <K>(kinds: Readonly<Record<string, K>>, label: string): K | undefined =>
  Object.hasOwn(kinds, label) ? kinds[label] : undefined;

/**
 * The webhook events the App must be subscribed to: the ones a trigger label
 * is answered on, which the deployment guide's event list is held equal to.
 */
export const SERVICE_APP_EVENTS: readonly string[] = Object.keys(LABEL_KINDS);

/**
 * Each way the App's own record falls short of what the service needs, one
 * line each: a permission not granted or granted below the access needed,
 * with the tokens whose mint it fails, and an event the App is not subscribed
 * to. Empty where the record meets the whole set. A gap is the operator's to
 * close, and the dispatcher starts regardless: review alone needs less.
 */
export const appGaps = (record: Pick<AppRecord, "permissions" | "events">): string[] => [
  ...Object.entries(SERVICE_APP_PERMISSIONS).flatMap(([name, needed]) => {
    const held = Object.hasOwn(record.permissions, name) ? record.permissions[name] : undefined;
    if (covers(held, needed)) return [];
    const failing = MINTS.filter(([, permissions]) => {
      const asked = permissions[name];
      return asked !== undefined && !covers(held, asked);
    }).map(([what]) => what);
    return [
      `the App's \`${name}\` permission needs ${needed}, ${held === undefined ? "not granted" : `holds ${held}`}: ${failing.join(", ")} will be refused, 422`,
    ];
  }),
  ...SERVICE_APP_EVENTS.filter((event) => !record.events.includes(event)).map(
    (event) => `the App is not subscribed to the \`${event}\` event: no delivery of it reaches the dispatcher`,
  ),
];

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

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * What the dispatcher remembers of a job it dispatched: enough to mint for
 * it, to tell a scan what it is on, and whether the worker has answered its
 * post yet.
 */
interface Dispatched {
  readonly repo: string;
  readonly deadline: Date;
  readonly workflow: JobKind;
  readonly number: number;
  readonly posted: boolean;
}

/** A scan's door's answer, sent at once, and the scan it starts. */
export interface Announcement {
  readonly response: DoorResponse;
  readonly scanned: Promise<void>;
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
    const entry = { repo: job.repo, deadline, workflow: job.workflow, number: "issue" in job ? job.issue : job.pr };
    jobs.set(job.id, { ...entry, posted: false });
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
    if (jobs.has(job.id)) jobs.set(job.id, { ...entry, posted: true });
    return `dispatched ${where}${at} as job ${job.id}, deadline ${job.deadline}`;
  };

  /**
   * Why a pull request is not answered for `kind`, past the opt-in, or
   * `undefined` where it is: its head is in the repository, and it is open,
   * but for `agent:follow-ups`, which is answered on a closed one.
   */
  const pullRefusal = (repo: string, kind: JobKind, state: string, headRepo: unknown): string | undefined => {
    if (headRepo !== repo) return "the head is on a fork";
    if (kind === "follow-ups") {
      if (state !== "closed") return `the pull request is ${state}, and \`${FOLLOW_UPS_LABEL}\` is answered on a closed one`;
    } else if (state !== "open") return `the pull request is ${state}, not open`;
    return undefined;
  };

  /** Dispatches a job of each kind an issue's label starts, in turn; the line is each dispatch's. */
  const dispatchIssue = async (
    kinds: readonly ("implement" | "implement-prd")[],
    fields: { readonly repo: string; readonly issue: number; readonly title: string; readonly state: string; readonly baseRef: string },
    login: string,
    where: string,
  ): Promise<string> => {
    const outcomes: string[] = [];
    for (const kind of kinds) outcomes.push(await dispatch({ workflow: kind, ...fields }, login, where, ` to ${kind}`));
    return outcomes.join("; ");
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
    const refusal = pullRefusal(repo, kind, state, p.pull_request?.head?.repo?.full_name);
    if (refusal !== undefined) return `refused on ${where}: ${refusal}`;
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
    return dispatchIssue(kinds, { repo, issue: number, title, state, baseRef }, login, where);
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

  /**
   * The jobs the worker holds, queued or running, read off its held door, and
   * the dispatcher's own remembered ones it can forget for it: every job whose
   * post the worker had answered before it was asked and which it no longer
   * holds has ended, or was dropped by a restart, and asks for no token again.
   * One whose post is still in flight is kept.
   */
  const askWorker = async (): Promise<readonly HeldJob[]> => {
    const answered = [...jobs].filter(([, job]) => job.posted).map(([id]) => id);
    const body = JSON.stringify({ asked: now().toISOString() });
    const reply = await edges.askHeld(body, { "content-type": "application/json", [SIGNATURE_HEADER]: sign(edges.workerSecret, body) });
    if (reply.status !== 200) throw new Error(`the worker answered ${reply.status}`);
    const held = parseHeld(json(Buffer.from(reply.body)));
    if (typeof held === "string") throw new Error(`the worker's answer is not a list of jobs: ${held}`);
    const ids = new Set(held.map((job) => job.id));
    for (const id of answered) if (!ids.has(id)) jobs.delete(id);
    return held;
  };

  /**
   * Why `repo`'s item `number` is skipped for `kinds`, or `undefined` where it
   * is not: the worker holds a job of one of the kinds for it, or the
   * dispatcher has dispatched one whose post it has not forgotten.
   */
  const heldFor = (repo: string, number: number, kinds: readonly JobKind[], held: readonly HeldJob[]): string | undefined => {
    prune();
    const holding = (job: { readonly workflow: JobKind; readonly repo: string; readonly number: number }): boolean =>
      job.repo === repo && job.number === number && kinds.includes(job.workflow);
    if (held.some(holding)) return "the worker holds a job for it";
    if ([...jobs.values()].some(holding)) return "the dispatcher has dispatched a job for it";
    return undefined;
  };

  /**
   * Why a scanned item's label is not answered, or `undefined` where it is.
   * The actor of the item's latest `labeled` event for it stands in for a
   * delivery's sender, held to `untrusted` as a sender is, and refused as one
   * is; with no such event the item is skipped, since a scan never dispatches
   * on a guess. The line is the whole outcome, `where` and all.
   */
  const unasked = async (repo: string, number: number, label: string, login: string, where: string): Promise<string | undefined> => {
    const sender = await edges.github.labeller(repo, number, label);
    if (sender === undefined) return `skipped on ${where}: no \`labeled\` event for \`${label}\` was found, so there is no one it was asked by to check`;
    const distrust = await untrusted(repo, sender, login);
    return distrust === undefined ? undefined : `refused on ${where}: ${distrust}, and added \`${label}\` last`;
  };

  /**
   * One item a scan lists, decided as its label's delivery would be past the
   * opt-in, which its repository passed, and built into the same job. An item
   * the system already holds a job for, of a kind its label starts, is skipped.
   */
  const rescan = async (repo: string, label: string, item: Labelled, held: readonly HeldJob[], login: string, baseRef: () => Promise<string>): Promise<string> => {
    const where = `${repo}#${item.number}`;
    if (item.type === "issues") {
      const kinds = kindOf(LABEL_KINDS.issues, label);
      if (kinds === undefined) return `ignored on ${where}: \`${label}\` is not a label a scan answers on an issue`;
      const skip = heldFor(repo, item.number, kinds, held);
      if (skip !== undefined) return `skipped on ${where}: ${skip}`;
      const refusal = await unasked(repo, item.number, label, login, where);
      if (refusal !== undefined) return refusal;
      return dispatchIssue(kinds, { repo, issue: item.number, title: item.title, state: item.state, baseRef: await baseRef() }, login, where);
    }
    const kind = kindOf(LABEL_KINDS.pull_request, label);
    if (kind === undefined || kind === "follow-ups") return `ignored on ${where}: \`${label}\` is not a label a scan answers on a pull request`;
    const skip = heldFor(repo, item.number, [kind], held);
    if (skip !== undefined) return `skipped on ${where}: ${skip}`;
    const refusal = pullRefusal(repo, kind, item.state, item.headRepo);
    if (refusal !== undefined) return `refused on ${where}: ${refusal}`;
    const unanswered = await unasked(repo, item.number, label, login, where);
    if (unanswered !== undefined) return unanswered;
    const { number: pr, branch, headSha, baseRef: base, state, merged } = item;
    return dispatch({ workflow: kind, repo, pr, branch, headSha, baseRef: base, state, merged }, login, where, ` at ${headSha}`);
  };

  /** One repository's part of a scan: refused where it is not served, and each labelled item decided otherwise. */
  const scanRepository = async (repo: string, held: readonly HeldJob[], login: string): Promise<void> => {
    const why = await unserved(repo);
    if (why !== undefined) return edges.log(`scan: refused on ${repo}: ${why}`);
    let branch: Promise<string> | undefined;
    const baseRef = (): Promise<string> => (branch ??= edges.github.defaultBranch(repo));
    for (const label of SCAN_LABELS) {
      let items: readonly Labelled[];
      try {
        items = await edges.github.labelled(repo, label);
      } catch (error) {
        edges.log(`scan: failed on ${repo}: its \`${label}\` items could not be listed: ${message(error)}`);
        continue;
      }
      for (const item of items) {
        const line = await rescan(repo, label, item, held, login, baseRef).catch((error: unknown) => `failed on ${repo}#${item.number}: ${message(error)}`);
        edges.log(`scan: ${line}`);
      }
    }
  };

  /**
   * One pass of the scan: the worker asked what it holds, then each
   * repository of each installation served. A worker that cannot be reached
   * skips the pass, since nothing could say what it holds, and its own start
   * announcement scans again. Nothing here throws: each failure is logged,
   * and the rest of the pass goes on.
   */
  const pass = async (): Promise<void> => {
    let held: readonly HeldJob[];
    try {
      held = await askWorker();
    } catch (error) {
      return edges.log(`scan: skipped: the worker could not say which jobs it holds: ${message(error)}. Its start scans again`);
    }
    let accounts: readonly string[];
    let login: string;
    try {
      accounts = await edges.github.installations();
      login = appLogin((await edges.github.app()).slug);
    } catch (error) {
      return edges.log(`scan: skipped: the App's installations could not be read: ${message(error)}`);
    }
    for (const account of accounts) {
      const stranger = foreign(account);
      if (stranger !== undefined) {
        edges.log(`scan: refused the installation on ${account}: ${stranger}`);
        continue;
      }
      let repos: readonly string[];
      try {
        repos = await edges.github.repositories(account);
      } catch (error) {
        edges.log(`scan: failed on the installation on ${account}: its repositories could not be listed: ${message(error)}`);
        continue;
      }
      for (const repo of repos) {
        await scanRepository(repo, held, login).catch((error: unknown) => edges.log(`scan: failed on ${repo}: ${message(error)}`));
      }
    }
    edges.log("scan: done");
  };

  let tail: Promise<void> = Promise.resolve();
  let waiting: Promise<void> | undefined;

  /**
   * **The scan** (#581): every open item carrying a trigger label a scan
   * answers, in every repository served, dispatched where nothing holds a job
   * for it, so a restart does not strand labelled work. One pass at a time: a
   * request while one runs queues a pass behind it, and a request while that
   * one waits is folded into it.
   */
  const scan = (): Promise<void> => {
    if (waiting !== undefined) return waiting;
    const queued = tail.then(() => {
      waiting = undefined;
      return pass();
    });
    waiting = queued;
    tail = queued;
    return queued;
  };

  /**
   * **The start door** (#581), beside the token door: the worker announces
   * its start here, signed with the shared secret. One whose signature does
   * not verify is refused, `401`; every other is answered `202` at once, and
   * a scan follows, whose ask of the worker forgets the jobs the restart
   * dropped.
   */
  const started = (request: DoorRequest): Announcement => {
    if (!verifySignature(edges.workerSecret, request.body, text(request.headers, SIGNATURE_HEADER))) {
      return { response: answer(401, { refusal: "bad signature" }), scanned: Promise.resolve() };
    }
    return { response: answer(202, { accepted: true }), scanned: scan() };
  };

  return { delivery, token, scan, started };
};

export type Dispatcher = ReturnType<typeof createDispatcher>;
