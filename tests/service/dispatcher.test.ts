import { describe, expect, it } from "vitest";
import { CI_WAIT_SECONDS } from "../../review/collect-checks.js";
import {
  appGaps,
  COMMENT_PERMISSIONS,
  createDispatcher,
  LABEL_KINDS,
  parseOwners,
  READER_PERMISSIONS,
  SCAN_PERMISSIONS,
  SERVICE_APP_EVENTS,
  SERVICE_APP_PERMISSIONS,
  SERVICE_LABELS,
  TOKEN_PERMISSIONS,
  type AppGitHub,
  type Labelled,
} from "../../service/dispatcher.js";
import {
  DEFAULT_FIX_MINUTES,
  DEFAULT_REVIEW_MINUTES,
  FOLLOW_UPS_MINUTES,
  HELD_REQUEST_MAX_AGE_MINUTES,
  HELD_REQUEST_MAX_SKEW_MINUTES,
  heldOf,
  IMPLEMENT_PRD_OTHER_MINUTES,
  JOB_KINDS,
  MERGE_MINUTES,
  parseJob,
  sign,
  SIGNATURE_HEADER,
  TOKEN_KINDS,
  verifySignature,
  type Job,
} from "../../service/job.js";
import { admit, heldDoor, jobDoor, lanes } from "../../service/worker.js";
import { STUB_LABELS } from "../../shared/follow-up-plan.js";
import {
  FIX_LABEL,
  FOLLOW_UPS_LABEL,
  IMPLEMENT_LABEL,
  MERGE_LABEL,
  ORCHESTRATOR_VARIABLE,
  REVIEW_LABEL,
  resumeNoteMark,
  SERVICE_ORCHESTRATOR,
  UPDATE_BRANCH_LABEL,
} from "../../shared/record.js";

/**
 * Seam 2 of PRD #453: the dispatcher's two doors, driven through the request
 * each receives, over a fake GitHub and a fake worker. What is asserted is
 * what reached the worker and what GitHub was asked to mint, never the order
 * of the dispatcher's own calls.
 */

const WEBHOOK_SECRET = "the-webhook-secret";
const WORKER_SECRET = "the-worker-secret";
const MARGIN = 30;
const REPO = "owner/repo";
const HEAD = "a".repeat(40);
/** Spelled as a product: the suite-wide timeout is the same number, and a test may not write it out. */
const MINUTE_MS = 60 * 1000;
const START = new Date("2026-10-11T12:00:00.000Z");

/** The repository's state as the fake GitHub holds it, which a test changes between requests. */
interface Repository {
  installed: boolean;
  /** The account the App's installation on the repository is on. */
  account: string;
  variables: Record<string, string>;
  permissions: Record<string, string>;
  /** Whether reading a variable fails, as a GitHub outage does. */
  unreadable?: boolean;
  /** The open items carrying each label, as a scan lists them, with who added each label last. */
  items: (Labelled & { labels: string[]; labellers: Record<string, string> })[];
  /** The comments a test put on each item, by its number, oldest first, with who posted each (#635). */
  conversations?: Record<number, { body: string; author: string }[]>;
}

/** The world a scan reads beyond the one repository: each installation's account to its repositories. */
interface Installations {
  accounts: Record<string, string[]>;
  /** The repositories whose items could not be listed. */
  unlistable: string[];
  /** Each account whose repositories were listed. */
  listed: string[];
  /** Each label a listing was asked for. */
  labels: string[];
}

/** The App's owner, which is the repository's owner too, unless a test says otherwise. */
const APP_OWNER = "owner";

const setup = (
  options: {
    workerStatus?: number;
    owners?: readonly string[];
    holdPosts?: boolean;
    holdLabeller?: boolean;
    holdPermission?: boolean;
    scanLimit?: number;
    /** Whether the worker is the real queue behind its real doors, each job's work held until a test ends it (#597). */
    queue?: boolean;
    /** How many minutes the worker's clock runs ahead of the dispatcher's, behind where negative (#601). */
    workerAhead?: number;
  } = {},
) => {
  const repository: Repository = {
    installed: true,
    account: APP_OWNER,
    variables: { [ORCHESTRATOR_VARIABLE]: SERVICE_ORCHESTRATOR, AGENT_MODEL: "a-model", AGENT_MAX_FIX_ROUNDS: "2", AGENT_FIX_MIN_SEVERITY: "low" },
    permissions: { maintainer: "write", triager: "triage" },
    items: [],
  };
  const installations: Installations = { accounts: { [APP_OWNER]: [REPO] }, unlistable: [], listed: [], labels: [] };
  /** The worker: what it holds, every job posted to it until it restarts, and whether it can be reached. */
  const worker = { holds: [] as Job[], down: false, asked: 0 };
  /** Each post held back until a test lets it through, where `holdPosts` says so. */
  const heldPosts: (() => void)[] = [];
  /** Each `labeled` event read held back until a test lets it through, where `holdLabeller` says so. */
  const heldLabellers: (() => void)[] = [];
  /** Each permission look-up held back until a test lets it through, where `holdPermission` says so. */
  const heldPermissions: (() => void)[] = [];
  const lines: string[] = [];
  const minted: { repo: string; permissions: Readonly<Record<string, string>> }[] = [];
  const posted: { body: string; headers: Readonly<Record<string, string>> }[] = [];
  /** Each login whose permission was looked up. */
  const looked: string[] = [];
  /** Each comment posted, and whether posting one fails, as a GitHub outage does. */
  const comments: { repo: string; number: number; body: string; token: string }[] = [];
  const commenting = { fails: false };
  /** Each commit whose pull requests were read, for a check suite's or a status's delivery. */
  const pullsRead: string[] = [];
  let clock = START;
  let ids = 0;
  let starts = 0;
  /** The real worker, where `queue` says so: each job whose work started, and the way to end the one running. */
  const ran: Job[] = [];
  const finishes: (() => void)[] = [];
  const queue = lanes(
    (job) =>
      new Promise<void>((resolve) => {
        ran.push(job);
        finishes.push(resolve);
      }),
    () => {},
  );
  /** Each line the worker's door logged for a merge job it coalesced (#591). */
  const coalesced: string[] = [];
  const jobs = jobDoor({
    secret: WORKER_SECRET,
    version: "9.9.9",
    accept: (job) => {
      const line = admit(queue, job);
      if (line !== undefined) coalesced.push(line);
    },
  });
  const held = heldDoor({ secret: WORKER_SECRET, held: queue.held, drop: queue.drop, now: () => new Date(clock.getTime() + (options.workerAhead ?? 0) * MINUTE_MS) });
  const github: AppGitHub = {
    app: async () => ({ slug: "loop-app", owner: APP_OWNER, permissions: {}, events: [] }),
    installation: async (repo) =>
      repo === REPO
        ? repository.installed
          ? repository.account
          : undefined
        : Object.entries(installations.accounts).find(([, repos]) => repos.includes(repo))?.[0],
    variable: async (repo, name) => {
      if (repository.unreadable === true && repo === REPO) throw new Error("GitHub answered 503");
      return repo === REPO ? repository.variables[name] : undefined;
    },
    permission: async (repo, login) => {
      looked.push(login);
      if (options.holdPermission === true) await new Promise<void>((resolve) => heldPermissions.push(resolve));
      return repo === REPO ? repository.permissions[login] : undefined;
    },
    mint: async (repo, permissions) => {
      minted.push({ repo, permissions });
      return { token: `minted-token-${minted.length}`, expiresAt: "2026-10-11T13:00:00Z" };
    },
    installations: async () => Object.keys(installations.accounts),
    repositories: async (account) => {
      installations.listed.push(account);
      return installations.accounts[account] ?? [];
    },
    labelled: async (repo, label) => {
      installations.labels.push(label);
      if (installations.unlistable.includes(repo)) throw new Error("GitHub answered 502");
      return repo === REPO ? repository.items.filter((item) => item.labels.includes(label)) : [];
    },
    labeller: async (repo, number, label) => {
      if (options.holdLabeller === true) await new Promise<void>((resolve) => heldLabellers.push(resolve));
      return repo === REPO ? repository.items.find((item) => item.number === number)?.labellers[label] : undefined;
    },
    comments: async (repo, number) => (repo === REPO ? (repository.conversations?.[number] ?? []) : []),
    defaultBranch: async () => "main",
    pullsAt: async (repo, sha) => {
      pullsRead.push(sha);
      if (repo !== REPO) return [];
      return repository.items.flatMap(({ labellers: _, ...item }) => (item.type === "pull_request" && item.headSha === sha ? [(({ type: __, ...pull }) => pull)(item)] : []));
    },
    comment: async (repo, number, body, token) => {
      if (commenting.fails) throw new Error("GitHub answered 502");
      comments.push({ repo, number, body, token });
    },
  };
  const start = (workerSecret = WORKER_SECRET) =>
    createDispatcher({
      github,
      postJob: async (body, headers) => {
        posted.push({ body, headers });
        if (options.holdPosts === true) await new Promise<void>((resolve) => heldPosts.push(resolve));
        if (options.queue === true) return jobs({ headers, body: Buffer.from(body) }).status;
        const status = options.workerStatus ?? 202;
        if (status === 202) worker.holds.push(parseJob(JSON.parse(body)) as Job);
        return status;
      },
      askHeld: async (body, headers) => {
        worker.asked += 1;
        if (worker.down) throw new Error("connect ECONNREFUSED");
        if (options.queue === true) return held({ headers, body: Buffer.from(body) });
        if (!verifySignature(WORKER_SECRET, body, headers[SIGNATURE_HEADER])) return { status: 401, body: "{}" };
        return { status: 200, body: JSON.stringify({ jobs: worker.holds.map(heldOf) }) };
      },
      log: (line) => lines.push(line),
      webhookSecret: WEBHOOK_SECRET,
      workerSecret,
      owners: options.owners ?? [APP_OWNER],
      deadlineMarginMinutes: MARGIN,
      scanLimit: options.scanLimit ?? 2,
      version: "9.9.9",
      instance: `dispatcher-${(starts += 1)}`,
      now: () => clock,
      newId: () => `job-${(ids += 1)}`,
    });
  const s = {
    dispatcher: start(),
    /** A restart of the dispatcher alone: a new instance, remembering no job, over the same GitHub and worker. */
    restart: (workerSecret?: string) => {
      s.dispatcher = start(workerSecret);
    },
    queue,
    ran,
    coalesced,
    /** Ends the job whose work is running, and lets the queue move on. */
    finish: async () => {
      finishes.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
    repository,
    installations,
    worker,
    heldPosts,
    heldLabellers,
    heldPermissions,
    lines,
    minted,
    posted,
    looked,
    comments,
    commenting,
    pullsRead,
    advance: (minutes: number) => {
      clock = new Date(clock.getTime() + minutes * MINUTE_MS);
    },
  };
  return s;
};

/** A `pull_request` `labeled` delivery, as GitHub sends it, with `change` laid over its parts. */
const labelled = (change: { label?: string; state?: string; headRepo?: string | null; sender?: string; merged?: boolean } = {}) => ({
  action: "labeled",
  label: { name: change.label ?? REVIEW_LABEL },
  sender: { login: change.sender ?? "maintainer" },
  repository: { full_name: REPO },
  pull_request: {
    number: 7,
    state: change.state ?? "open",
    merged: change.merged ?? false,
    head: { ref: "agent/issue-7-a-thing", sha: HEAD, repo: change.headRepo === null ? null : { full_name: change.headRepo ?? REPO } },
    base: { ref: "main" },
  },
});

const signed = (payload: unknown, secret = WEBHOOK_SECRET, event = "pull_request") => {
  const body = Buffer.from(JSON.stringify(payload));
  return { headers: { "x-github-event": event, "x-hub-signature-256": sign(secret, body) }, body };
};

const tokenRequest = (request: unknown, secret = WORKER_SECRET) => {
  const body = Buffer.from(JSON.stringify(request));
  return { headers: { [SIGNATURE_HEADER]: sign(secret, body) }, body };
};

/** A delivery, answered and worked through. */
const deliver = async (setupd: ReturnType<typeof setup>, payload: unknown, secret?: string, event?: string) => {
  const { response, outcome } = setupd.dispatcher.delivery(signed(payload, secret, event));
  return { status: response.status, outcome: await outcome };
};

/** The job a delivery posted to the worker. */
const dispatched = async (s: ReturnType<typeof setup>, payload: unknown = labelled()): Promise<Job> => {
  await deliver(s, payload);
  const post = s.posted.at(-1);
  if (post === undefined) throw new Error("nothing was posted to the worker");
  const job = parseJob(JSON.parse(post.body));
  if (typeof job === "string") throw new Error(job);
  return job;
};

describe("the webhook door", () => {
  it("refuses a delivery whose signature does not verify, and does nothing with it", async () => {
    const s = setup();
    const result = await deliver(s, labelled(), "someone-elses-secret");

    expect(result.status).toBe(401);
    expect(result.outcome).toBe("refused: bad signature");
    expect(s.posted).toEqual([]);
  });

  it("refuses a delivery with no signature", async () => {
    const s = setup();
    const { body } = signed(labelled());
    const { response } = s.dispatcher.delivery({ headers: { "x-github-event": "pull_request" }, body });

    expect(response.status).toBe(401);
  });

  it.each<[string, (s: ReturnType<typeof setup>) => unknown, RegExp]>([
    ["a label the service does not answer", () => labelled({ label: "agent:blocked" }), /`agent:blocked` is not a label this release's service answers/],
    ["an event the service does not answer", () => labelled(), /`push` is not an event this release's service answers/],
    [
      "a repository the App is not installed on",
      (s) => {
        s.repository.installed = false;
        return labelled();
      },
      /the App is not installed on owner\/repo/,
    ],
    [
      "a repository with AGENT_ORCHESTRATOR unset",
      (s) => {
        delete s.repository.variables[ORCHESTRATOR_VARIABLE];
        return labelled();
      },
      /AGENT_ORCHESTRATOR is unset, not `service`/,
    ],
    [
      "a repository with AGENT_ORCHESTRATOR another value",
      (s) => {
        s.repository.variables[ORCHESTRATOR_VARIABLE] = "Service";
        return labelled();
      },
      /AGENT_ORCHESTRATOR is `Service`, not `service`/,
    ],
    ["a head on a fork", () => labelled({ headRepo: "someone/fork" }), /the head is on a fork/],
    ["a head on a deleted fork", () => labelled({ headRepo: null }), /the head is on a fork/],
    ["a closed pull request", () => labelled({ state: "closed" }), /the pull request is closed, not open/],
    ["a sender who can only triage", () => labelled({ sender: "triager" }), /triager cannot write to owner\/repo/],
    ["a sender with no access", () => labelled({ sender: "stranger" }), /stranger cannot write to owner\/repo/],
  ])("answers %s with 202, posts no job, and gives the reason", async (name, arrange, reason) => {
    const s = setup();
    const payload = arrange(s);
    const result = await deliver(s, payload, undefined, name.includes("event") ? "push" : "pull_request");

    expect(result.status).toBe(202);
    expect(result.outcome).toMatch(reason);
    expect(s.posted).toEqual([]);
  });

  it("posts a job to the worker, signed with the shared secret, carrying the event and the repository's variables", async () => {
    const s = setup();
    const result = await deliver(s, labelled({ merged: false }));

    expect(result.status).toBe(202);
    expect(result.outcome).toMatch(/^dispatched owner\/repo#7/);
    expect(s.posted).toHaveLength(1);
    const [post] = s.posted;
    expect(verifySignature(WORKER_SECRET, post!.body, post!.headers[SIGNATURE_HEADER])).toBe(true);
    expect(parseJob(JSON.parse(post!.body))).toEqual({
      workflow: "review",
      id: "job-1",
      version: "9.9.9",
      instance: "dispatcher-1",
      deadline: new Date(START.getTime() + (CI_WAIT_SECONDS / 60 + DEFAULT_REVIEW_MINUTES + MARGIN) * MINUTE_MS).toISOString(),
      repo: REPO,
      pr: 7,
      branch: "agent/issue-7-a-thing",
      headSha: HEAD,
      baseRef: "main",
      state: "open",
      merged: false,
      appLogin: "loop-app[bot]",
      variables: {
        AGENT_MODEL: "a-model",
        AGENT_MODEL_REVIEW: "",
        AGENT_MODEL_FIX: "",
        AGENT_MODEL_UPDATE_BRANCH: "",
        AGENT_MODEL_IMPLEMENT: "",
        AGENT_MODEL_IMPLEMENT_PRD: "",
        AGENT_EFFORT: "",
        AGENT_EFFORT_REVIEW: "",
        AGENT_EFFORT_FIX: "",
        AGENT_EFFORT_UPDATE_BRANCH: "",
        AGENT_EFFORT_IMPLEMENT: "",
        AGENT_EFFORT_IMPLEMENT_PRD: "",
        AGENT_PROMPT_CACHE_TTL: "",
        AGENT_REVIEW_TIMEOUT_MINUTES: "",
        AGENT_TIMEOUT_MINUTES: "",
        AGENT_MAX_FIX_ROUNDS: "2",
        AGENT_FIX_MIN_SEVERITY: "low",
        AGENT_SETUP: "",
      },
    });
  });

  it("carries the repository's setup as the repository set it, unevaluated", async () => {
    const s = setup();
    s.repository.variables["AGENT_SETUP"] = "npm ci && echo \"$HOME\" `id` $(whoami); exit 3";
    const job = await dispatched(s);

    expect(job.variables.AGENT_SETUP).toBe("npm ci && echo \"$HOME\" `id` $(whoami); exit 3");
  });

  it("works the App's login out of the App's own record, as its REST spelling", async () => {
    const job = await dispatched(setup());

    expect(job.appLogin).toBe("loop-app[bot]");
  });

  it("carries no token, and nothing was minted to make the job", async () => {
    const s = setup();
    await dispatched(s);

    expect(s.minted).toEqual([]);
    expect(Object.keys(JSON.parse(s.posted[0]!.body) as object)).not.toContain("token");
    expect(s.posted[0]!.body).not.toMatch(/minted-token|ghs_/);
  });

  it("sets the deadline from the repository's own time limit, where it gives one", async () => {
    const s = setup();
    s.repository.variables["AGENT_REVIEW_TIMEOUT_MINUTES"] = "12";
    const job = await dispatched(s);

    expect(job.deadline).toBe(new Date(START.getTime() + (CI_WAIT_SECONDS / 60 + 12 + MARGIN) * MINUTE_MS).toISOString());
  });

  it("says so where the worker refuses the job, and mints nothing for it after", async () => {
    const s = setup({ workerStatus: 503 });
    const result = await deliver(s, labelled());

    expect(result.outcome).toMatch(/the worker answered 503/);
    const response = await s.dispatcher.token(tokenRequest({ jobId: "job-1", kind: "read" }));
    expect(response.status).toBe(404);
    expect(s.minted).toEqual([]);
  });
});

/**
 * Each trigger label the service answers starts one kind of job (ADR 0008),
 * and the list of what it answers is that map's keys.
 */
describe("the labels the dispatcher routes", () => {
  it("answers exactly the labels that map to a job kind, on either event, and each maps to a kind this release runs", () => {
    const routed = [...Object.entries(LABEL_KINDS.pull_request).map(([label, kind]) => [label, [kind]] as const), ...Object.entries(LABEL_KINDS.issues)];
    expect(SERVICE_LABELS).toEqual(routed.map(([label]) => label));
    for (const [, kinds] of routed) for (const kind of kinds) expect(JOB_KINDS).toContain(kind);
    expect(new Set(SERVICE_LABELS).size).toBe(SERVICE_LABELS.length);
  });

  it("answers agent:implement on an issue's event, with both implement and implement-prd, and every other label on a pull request's", () => {
    expect(LABEL_KINDS.issues).toEqual({ [IMPLEMENT_LABEL]: ["implement", "implement-prd"] });
    expect(Object.keys(LABEL_KINDS.pull_request)).toEqual([REVIEW_LABEL, FIX_LABEL, UPDATE_BRANCH_LABEL, FOLLOW_UPS_LABEL, MERGE_LABEL]);
    expect(SERVICE_LABELS).toContain(IMPLEMENT_LABEL);
  });

  it("names the job's kind from its label", async () => {
    expect((await dispatched(setup(), labelled({ label: REVIEW_LABEL }))).workflow).toBe("review");
    expect((await dispatched(setup(), labelled({ label: FIX_LABEL }))).workflow).toBe("fix");
    expect((await dispatched(setup(), labelled({ label: UPDATE_BRANCH_LABEL }))).workflow).toBe("update-branch");
  });

  it("answers agent:update-branch among the labels it lists", () => {
    expect(SERVICE_LABELS).toContain(UPDATE_BRANCH_LABEL);
  });

  it("dispatches an agent:fix from a person who can write, and from the App's own login alike", async () => {
    for (const sender of ["maintainer", "loop-app[bot]"]) {
      const s = setup();
      const job = await dispatched(s, labelled({ label: FIX_LABEL, sender }));

      expect(job.workflow, sender).toBe("fix");
      expect(job, sender).toMatchObject({ pr: 7, branch: "agent/issue-7-a-thing", headSha: HEAD, baseRef: "main", appLogin: "loop-app[bot]" });
      expect(job.variables.AGENT_MAX_FIX_ROUNDS, sender).toBe("2");
      expect(job.variables.AGENT_FIX_MIN_SEVERITY, sender).toBe("low");
    }
  });

  it("sets a fix job's deadline from the agent's time limit, AGENT_TIMEOUT_MINUTES, or its default", async () => {
    const unset = await dispatched(setup(), labelled({ label: FIX_LABEL }));
    expect(unset.deadline).toBe(new Date(START.getTime() + (DEFAULT_FIX_MINUTES + MARGIN) * MINUTE_MS).toISOString());

    const s = setup();
    s.repository.variables["AGENT_TIMEOUT_MINUTES"] = "45";
    s.repository.variables["AGENT_REVIEW_TIMEOUT_MINUTES"] = "12";
    const set = await dispatched(s, labelled({ label: FIX_LABEL }));
    expect(set.deadline).toBe(new Date(START.getTime() + (45 + MARGIN) * MINUTE_MS).toISOString());
  });

  it("dispatches an agent:update-branch from a person who can write, and from the App's own login alike", async () => {
    for (const sender of ["maintainer", "loop-app[bot]"]) {
      const s = setup();
      s.repository.variables["AGENT_MODEL_UPDATE_BRANCH"] = "a-merge-model";
      const job = await dispatched(s, labelled({ label: UPDATE_BRANCH_LABEL, sender }));

      expect(job.workflow, sender).toBe("update-branch");
      expect(job, sender).toMatchObject({ pr: 7, branch: "agent/issue-7-a-thing", headSha: HEAD, baseRef: "main", appLogin: "loop-app[bot]" });
      expect(job.variables.AGENT_MODEL_UPDATE_BRANCH, sender).toBe("a-merge-model");
    }
  });

  it("sets an update-branch job's deadline from the agent's time limit, AGENT_TIMEOUT_MINUTES, or its default", async () => {
    const unset = await dispatched(setup(), labelled({ label: UPDATE_BRANCH_LABEL }));
    expect(unset.deadline).toBe(new Date(START.getTime() + (DEFAULT_FIX_MINUTES + MARGIN) * MINUTE_MS).toISOString());

    const s = setup();
    s.repository.variables["AGENT_TIMEOUT_MINUTES"] = "45";
    const set = await dispatched(s, labelled({ label: UPDATE_BRANCH_LABEL }));
    expect(set.deadline).toBe(new Date(START.getTime() + (45 + MARGIN) * MINUTE_MS).toISOString());
  });

  it("ignores a label that names an inherited property, not a kind", async () => {
    const s = setup();
    const result = await deliver(s, labelled({ label: "constructor" }));

    expect(result.outcome).toMatch(/`constructor` is not a label this release's service answers/);
    expect(s.posted).toEqual([]);
  });
});

/**
 * The label's sender is the loop's author gate: a person must be able to
 * write to the repository. The App's own label is the loop's, added under the
 * repository's budget, so its login is trusted without a lookup (ADR 0008).
 */
describe("the label's sender", () => {
  it("dispatches a label the App itself added, and looks up no permission for it", async () => {
    const s = setup();
    const result = await deliver(s, labelled({ sender: "loop-app[bot]" }));

    expect(result.outcome).toMatch(/^dispatched owner\/repo#7/);
    expect(s.looked).toEqual([]);
  });

  it("matches the App's login whatever its case, as GitHub does", async () => {
    const s = setup();

    expect((await deliver(s, labelled({ sender: "Loop-App[bot]" }))).outcome).toMatch(/^dispatched owner\/repo#7/);
    expect(s.looked).toEqual([]);
  });

  it("looks up a person's permission, and dispatches for one who can write", async () => {
    const s = setup();

    expect((await deliver(s, labelled({ sender: "maintainer" }))).outcome).toMatch(/^dispatched owner\/repo#7/);
    expect(s.looked).toEqual(["maintainer"]);
  });

  it("refuses another App's label, with today's sentence, after looking it up", async () => {
    const s = setup();
    const result = await deliver(s, labelled({ sender: "other-app[bot]" }));

    expect(result.outcome).toBe("refused on owner/repo#7: other-app[bot] cannot write to owner/repo");
    expect(s.looked).toEqual(["other-app[bot]"]);
    expect(s.posted).toEqual([]);
  });
});

/**
 * The App's owner is the account whose installations are served, with any the
 * dispatcher's `EXTRA_OWNERS` lists: an App installed on a stranger's account
 * serves nothing there, though the stranger's repository opts in and the
 * stranger can write to it.
 */
describe("the accounts the dispatcher serves", () => {
  it("refuses a delivery from an installation on another account, with the reason, and reads nothing more", async () => {
    const s = setup();
    s.repository.account = "stranger";
    s.repository.unreadable = true;
    const result = await deliver(s, labelled());

    expect(result.status).toBe(202);
    expect(result.outcome).toBe(
      "refused on owner/repo#7: the App's installation is on stranger, which is neither the App's owner nor an account EXTRA_OWNERS lists",
    );
    expect(s.posted).toEqual([]);
  });

  it("serves an installation on the App's owner's account, whatever the case of its login", async () => {
    const s = setup({ owners: ["Owner"] });

    expect((await deliver(s, labelled())).outcome).toMatch(/^dispatched owner\/repo#7/);
  });

  it("serves an installation on an account the setting lists", async () => {
    const s = setup({ owners: [APP_OWNER, ...parseOwners(" partner , ,another ")] });
    s.repository.account = "another";

    expect((await deliver(s, labelled())).outcome).toMatch(/^dispatched owner\/repo#7/);
  });

  it("reads an empty setting as no extra owner", () => {
    expect(parseOwners("")).toEqual([]);
    expect(parseOwners(" a,b ,, c ")).toEqual(["a", "b", "c"]);
  });

  it("mints nothing for a job whose installation has moved to another account", async () => {
    const s = setup();
    const job = await dispatched(s);
    s.repository.account = "stranger";
    const response = await s.dispatcher.token(tokenRequest({ jobId: job.id, kind: "read" }));

    expect(response.status).toBe(403);
    expect(response.body).toContain("stranger");
    expect(s.minted).toEqual([]);
  });
});

describe("the token door", () => {
  it.each(TOKEN_KINDS)("mints a %s token for a dispatched job, for its repository, with that kind's permissions", async (kind) => {
    const s = setup();
    const job = await dispatched(s);
    const response = await s.dispatcher.token(tokenRequest({ jobId: job.id, kind }));

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ token: "minted-token-1", expiresAt: "2026-10-11T13:00:00Z" });
    expect(s.minted).toEqual([{ repo: REPO, permissions: TOKEN_PERMISSIONS[kind] }]);
  });

  it("gives a read token no write, and a write token only what review's posting writes", () => {
    expect(TOKEN_PERMISSIONS.read).toEqual({ contents: "read", pull_requests: "read", issues: "read", checks: "read", statuses: "read" });
    expect(TOKEN_PERMISSIONS.write).toEqual({ contents: "read", pull_requests: "write", issues: "write", checks: "read", statuses: "write" });
  });

  it("gives a resolve token exactly write's permissions, with contents written and no workflows", () => {
    expect(TOKEN_PERMISSIONS.resolve).toEqual({ ...TOKEN_PERMISSIONS.write, contents: "write" });
    expect(TOKEN_PERMISSIONS.resolve).not.toHaveProperty("workflows");
  });

  it("declares a permission set for each token kind, and no other", () => {
    expect(Object.keys(TOKEN_PERMISSIONS)).toEqual([...TOKEN_KINDS]);
  });

  it("gives a push token exactly write's permissions, with contents and workflows written", () => {
    expect(TOKEN_PERMISSIONS.push).toEqual({ ...TOKEN_PERMISSIONS.write, contents: "write", workflows: "write" });
    expect(TOKEN_PERMISSIONS.push).toEqual({ contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "write", workflows: "write" });
  });

  it("mints a fresh token at each request, one per phase", async () => {
    const s = setup();
    const job = await dispatched(s);
    await s.dispatcher.token(tokenRequest({ jobId: job.id, kind: "read" }));
    s.advance(10);
    await s.dispatcher.token(tokenRequest({ jobId: job.id, kind: "write" }));

    expect(s.minted.map((m) => m.permissions)).toEqual([TOKEN_PERMISSIONS.read, TOKEN_PERMISSIONS.write]);
  });

  it("refuses a request whose signature does not verify", async () => {
    const s = setup();
    const job = await dispatched(s);
    const response = await s.dispatcher.token(tokenRequest({ jobId: job.id, kind: "write" }, WEBHOOK_SECRET));

    expect(response.status).toBe(401);
    expect(s.minted).toEqual([]);
  });

  it("refuses a job it never dispatched", async () => {
    const s = setup();
    await dispatched(s);
    const response = await s.dispatcher.token(tokenRequest({ jobId: "job-99", kind: "read" }));

    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ refusal: "job job-99 is not one this dispatcher dispatched" });
    expect(s.minted).toEqual([]);
  });

  it("refuses a job past its deadline", async () => {
    const s = setup();
    const job = await dispatched(s);
    s.advance(CI_WAIT_SECONDS / 60 + DEFAULT_REVIEW_MINUTES + MARGIN);
    const response = await s.dispatcher.token(tokenRequest({ jobId: job.id, kind: "read" }));

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ refusal: `job ${job.id} is past its deadline, ${job.deadline}` });
    expect(s.minted).toEqual([]);
  });

  it("holds a resolve token to the rules every kind is held to: a job it dispatched, before its deadline, on a repository still opted in", async () => {
    const s = setup();
    const job = await dispatched(s);
    expect((await s.dispatcher.token(tokenRequest({ jobId: "job-99", kind: "resolve" }))).status).toBe(404);
    s.repository.variables[ORCHESTRATOR_VARIABLE] = "actions";
    expect((await s.dispatcher.token(tokenRequest({ jobId: job.id, kind: "resolve" }))).status).toBe(403);
    s.repository.variables[ORCHESTRATOR_VARIABLE] = SERVICE_ORCHESTRATOR;
    s.advance(CI_WAIT_SECONDS / 60 + DEFAULT_REVIEW_MINUTES + MARGIN);
    expect((await s.dispatcher.token(tokenRequest({ jobId: job.id, kind: "resolve" }))).status).toBe(403);
    expect(s.minted).toEqual([]);
  });

  it("mints right up to the deadline", async () => {
    const s = setup();
    const job = await dispatched(s);
    s.advance(CI_WAIT_SECONDS / 60 + DEFAULT_REVIEW_MINUTES + MARGIN - 1);
    const response = await s.dispatcher.token(tokenRequest({ jobId: job.id, kind: "read" }));

    expect(response.status).toBe(200);
  });

  it.each<[string, (repository: Repository) => void]>([
    [
      "switched back to Actions by deleting the variable",
      (repository) => {
        delete repository.variables[ORCHESTRATOR_VARIABLE];
      },
    ],
    [
      "given another value",
      (repository) => {
        repository.variables[ORCHESTRATOR_VARIABLE] = "actions";
      },
    ],
  ])("refuses a job in flight on a repository %s, re-reading the opt-in each time", async (_name, change) => {
    const s = setup();
    const job = await dispatched(s);
    expect((await s.dispatcher.token(tokenRequest({ jobId: job.id, kind: "read" }))).status).toBe(200);

    change(s.repository);
    const response = await s.dispatcher.token(tokenRequest({ jobId: job.id, kind: "write" }));

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ refusal: "owner/repo no longer has AGENT_ORCHESTRATOR set to `service`" });
    expect(s.minted).toHaveLength(1);
  });

  it("refuses, rather than mints, where the opt-in cannot be read", async () => {
    const s = setup();
    const job = await dispatched(s);
    s.repository.unreadable = true;
    const response = await s.dispatcher.token(tokenRequest({ jobId: job.id, kind: "write" }));

    expect(response.status).toBe(502);
    expect(s.minted).toEqual([]);
  });

  it("refuses a job on a repository the App was removed from", async () => {
    const s = setup();
    const job = await dispatched(s);
    s.repository.installed = false;
    const response = await s.dispatcher.token(tokenRequest({ jobId: job.id, kind: "read" }));

    expect(response.status).toBe(403);
    expect(s.minted).toEqual([]);
  });

  it.each([{ jobId: "job-1", kind: "admin" }, { jobId: "", kind: "read" }, "not an object"])("refuses a malformed request: %j", async (request) => {
    const s = setup();
    await dispatched(s);
    const response = await s.dispatcher.token(tokenRequest(request));

    expect(response.status).toBe(400);
    expect(s.minted).toEqual([]);
  });
});

/** An `issues` `labeled` delivery, as GitHub sends it, with `change` laid over its parts. */
const issueLabelled = (
  change: { label?: string; state?: string; sender?: string; title?: string; pullRequest?: boolean; defaultBranch?: string } = {},
) => ({
  action: "labeled",
  label: { name: change.label ?? IMPLEMENT_LABEL },
  sender: { login: change.sender ?? "maintainer" },
  repository: { full_name: REPO, default_branch: change.defaultBranch ?? "main" },
  issue: {
    number: 12,
    title: change.title ?? "Add a thing",
    state: change.state ?? "open",
    ...(change.pullRequest === true ? { pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/12" } } : {}),
  },
});

/** Every job an `issues` delivery posted to the worker, in the order posted. */
const dispatchedIssue = async (s: ReturnType<typeof setup>, payload: unknown = issueLabelled()): Promise<readonly Job[]> => {
  const result = await deliver(s, payload, undefined, "issues");
  if (s.posted.length === 0) throw new Error(`nothing was posted to the worker: ${result.outcome}`);
  return s.posted.map(({ body }) => {
    const job = parseJob(JSON.parse(body));
    if (typeof job === "string") throw new Error(job);
    return job;
  });
};

/**
 * An issue's route (#517, #518): an `issues` delivery adding
 * `agent:implement` to an issue becomes two jobs, an implement job and an
 * implement-prd job, after the same checks a pull request's delivery passes,
 * in the same order, and with no head to check. Actions starts both
 * workflows on the label, and each gate defers the other's issue shape
 * without a word, so the dispatcher reads nothing of the shape.
 */
describe("the issue route", () => {
  it("dispatches an implement job and an implement-prd job for agent:implement on an issue, from a person who can write and from the App's own login alike", async () => {
    for (const sender of ["maintainer", "loop-app[bot]"]) {
      const s = setup();
      s.repository.variables["AGENT_MODEL_IMPLEMENT"] = "a-build-model";
      s.repository.variables["AGENT_MODEL_IMPLEMENT_PRD"] = "a-chain-model";
      const result = await deliver(s, issueLabelled({ sender }), undefined, "issues");

      expect(result.status, sender).toBe(202);
      expect(result.outcome, sender).toMatch(
        /^dispatched owner\/repo#12 to implement as job job-1, deadline [^;]+; dispatched owner\/repo#12 to implement-prd as job job-2, deadline /,
      );
      expect(s.posted, sender).toHaveLength(2);
      const issue = {
        version: "9.9.9",
        instance: "dispatcher-1",
        repo: REPO,
        issue: 12,
        title: "Add a thing",
        state: "open",
        baseRef: "main",
        appLogin: "loop-app[bot]",
        variables: {
          AGENT_MODEL: "a-model",
          AGENT_MODEL_REVIEW: "",
          AGENT_MODEL_FIX: "",
          AGENT_MODEL_UPDATE_BRANCH: "",
          AGENT_MODEL_IMPLEMENT: "a-build-model",
          AGENT_MODEL_IMPLEMENT_PRD: "a-chain-model",
          AGENT_EFFORT: "",
          AGENT_EFFORT_REVIEW: "",
          AGENT_EFFORT_FIX: "",
          AGENT_EFFORT_UPDATE_BRANCH: "",
          AGENT_EFFORT_IMPLEMENT: "",
          AGENT_EFFORT_IMPLEMENT_PRD: "",
          AGENT_PROMPT_CACHE_TTL: "",
          AGENT_REVIEW_TIMEOUT_MINUTES: "",
          AGENT_TIMEOUT_MINUTES: "",
          AGENT_MAX_FIX_ROUNDS: "2",
          AGENT_FIX_MIN_SEVERITY: "low",
          AGENT_SETUP: "",
        },
      };
      expect(s.posted.map(({ body }) => parseJob(JSON.parse(body))), sender).toEqual([
        { ...issue, workflow: "implement", id: "job-1", deadline: new Date(START.getTime() + (DEFAULT_FIX_MINUTES + MARGIN) * MINUTE_MS).toISOString() },
        {
          ...issue,
          workflow: "implement-prd",
          id: "job-2",
          deadline: new Date(START.getTime() + (IMPLEMENT_PRD_OTHER_MINUTES + DEFAULT_FIX_MINUTES + MARGIN) * MINUTE_MS).toISOString(),
        },
      ]);
      expect(s.looked, sender).toEqual(sender === "maintainer" ? ["maintainer"] : []);
    }
  });

  it("reads nothing of the issue's shape: both jobs carry the same, what the event carried, whatever the issue is", async () => {
    const [implement, prd] = await dispatchedIssue(setup());

    // `AppGitHub` has no read of an issue at all, so the shape cannot decide
    // which job is dispatched: each gate decides it, from the record.
    const carried = (job: Job | undefined) => ({ ...job, workflow: undefined, id: undefined, deadline: undefined });
    expect(carried(prd)).toEqual(carried(implement));
  });

  it("dispatches a closed issue too, carrying its state, so the gate whose issue it is refuses it on the issue as on Actions", async () => {
    const s = setup();
    const jobs = await dispatchedIssue(s, issueLabelled({ state: "closed" }));

    expect(jobs).toMatchObject([
      { workflow: "implement", issue: 12, state: "closed" },
      { workflow: "implement-prd", issue: 12, state: "closed" },
    ]);
  });

  it("takes the base from the repository's default branch, as the event carries it", async () => {
    const jobs = await dispatchedIssue(setup(), issueLabelled({ defaultBranch: "trunk" }));

    expect(jobs).toMatchObject([
      { workflow: "implement", baseRef: "trunk" },
      { workflow: "implement-prd", baseRef: "trunk" },
    ]);
  });

  it("sets an implement job's deadline from the agent's time limit, and an implement-prd job's from the sum of its jobs' limits", async () => {
    const s = setup();
    s.repository.variables["AGENT_TIMEOUT_MINUTES"] = "45";
    const [implement, prd] = await dispatchedIssue(s);

    expect(implement!.deadline).toBe(new Date(START.getTime() + (45 + MARGIN) * MINUTE_MS).toISOString());
    // The gate's 10, the catch-up's 10, the agent's 45 and publish's 15.
    expect(IMPLEMENT_PRD_OTHER_MINUTES).toBe(35);
    expect(prd!.deadline).toBe(new Date(START.getTime() + (35 + 45 + MARGIN) * MINUTE_MS).toISOString());
  });

  it("logs each dispatch's outcome, where the worker refuses one", async () => {
    const s = setup({ workerStatus: 503 });
    const result = await deliver(s, issueLabelled(), undefined, "issues");

    expect(result.outcome).toBe("failed on owner/repo#12: the worker answered 503; failed on owner/repo#12: the worker answered 503");
    expect(s.posted.map(({ body }) => (JSON.parse(body) as { workflow: string }).workflow)).toEqual(["implement", "implement-prd"]);
  });

  it.each<[string, (s: ReturnType<typeof setup>) => unknown, string]>([
    ["a label not answered on an issue", () => issueLabelled({ label: REVIEW_LABEL }), "ignored on owner/repo#12: `agent:review` is not a label this release's service answers on an issue"],
    ["an inherited property's name", () => issueLabelled({ label: "constructor" }), "ignored on owner/repo#12: `constructor` is not a label this release's service answers on an issue"],
    [
      "an issue that is a pull request",
      () => issueLabelled({ pullRequest: true }),
      "ignored on owner/repo#12: the issue is a pull request, whose labels are answered on its `pull_request` event",
    ],
    ["a sender who can only triage", () => issueLabelled({ sender: "triager" }), "refused on owner/repo#12: triager cannot write to owner/repo"],
    ["another App's label", () => issueLabelled({ sender: "other-app[bot]" }), "refused on owner/repo#12: other-app[bot] cannot write to owner/repo"],
    [
      "a repository that has not opted in",
      (s) => {
        delete s.repository.variables[ORCHESTRATOR_VARIABLE];
        return issueLabelled();
      },
      "refused on owner/repo#12: AGENT_ORCHESTRATOR is unset, not `service`",
    ],
    [
      "a repository the App is not installed on",
      (s) => {
        s.repository.installed = false;
        return issueLabelled();
      },
      "refused on owner/repo#12: the App is not installed on owner/repo",
    ],
    [
      "an installation on an account not served",
      (s) => {
        s.repository.account = "stranger";
        return issueLabelled();
      },
      "refused on owner/repo#12: the App's installation is on stranger, which is neither the App's owner nor an account EXTRA_OWNERS lists",
    ],
    ["an issue event that is not a label's", () => ({ ...issueLabelled(), action: "opened" }), "ignored: an issue `opened`, not labelled"],
    ["a delivery missing the default branch", () => ({ ...issueLabelled(), repository: { full_name: REPO } }), "refused: the delivery is missing a field a job needs"],
  ])("answers %s with 202, posts no job, and gives the reason", async (_name, arrange, reason) => {
    const s = setup();
    const payload = arrange(s);
    const result = await deliver(s, payload, undefined, "issues");

    expect(result.status).toBe(202);
    expect(result.outcome).toBe(reason);
    expect(s.posted).toEqual([]);
  });

  it("reads the opt-in before the issue's own fields, so a repository that has not opted in is logged as that", async () => {
    const s = setup();
    delete s.repository.variables[ORCHESTRATOR_VARIABLE];
    const result = await deliver(s, issueLabelled({ state: "closed", sender: "stranger" }), undefined, "issues");

    expect(result.outcome).toBe("refused on owner/repo#12: AGENT_ORCHESTRATOR is unset, not `service`");
    expect(s.looked).toEqual([]);
  });

  it("answers agent:implement on a pull request's event with nothing, and agent:review on an issue's with nothing", async () => {
    const s = setup();
    const onPullRequest = await deliver(s, labelled({ label: IMPLEMENT_LABEL }));
    const onIssue = await deliver(s, issueLabelled({ label: REVIEW_LABEL }), undefined, "issues");

    expect(onPullRequest.outcome).toBe("ignored on owner/repo#7: `agent:implement` is not a label this release's service answers on a pull request");
    expect(onIssue.outcome).toMatch(/`agent:review` is not a label this release's service answers on an issue/);
    expect(s.posted).toEqual([]);
  });

  it("mints for each job it dispatched, for that repository alone", async () => {
    const s = setup();
    const jobs = await dispatchedIssue(s);
    for (const job of jobs) expect((await s.dispatcher.token(tokenRequest({ jobId: job.id, kind: "push" }))).status, job.workflow).toBe(200);

    expect(s.minted).toEqual([
      { repo: REPO, permissions: TOKEN_PERMISSIONS.push },
      { repo: REPO, permissions: TOKEN_PERMISSIONS.push },
    ]);
  });
});

/**
 * The hand-off to review (#517): `implement:publish` opens the pull request as
 * the App and adds `agent:review` with the App's token, so the `pull_request`
 * delivery that follows names the App's login as its sender. The dispatcher
 * trusts that login, so it answers the label as a review job.
 */
describe("the hand-off from implement to review", () => {
  it("dispatches a review job for the agent:review implement:publish adds, delivered with the App's login as sender", async () => {
    const s = setup();
    await dispatchedIssue(s);
    const job = await dispatched(s, labelled({ label: REVIEW_LABEL, sender: "loop-app[bot]" }));

    expect(job).toMatchObject({ workflow: "review", pr: 7, branch: "agent/issue-7-a-thing", appLogin: "loop-app[bot]" });
    expect(s.posted.map(({ body }) => (JSON.parse(body) as { workflow: string }).workflow)).toEqual(["implement", "implement-prd", "review"]);
    expect(s.looked).toEqual(["maintainer"]);
  });
});

/** A `pull_request` `closed` delivery, as GitHub sends it, with `change` laid over its parts. */
const closed = (change: { merged?: boolean; labels?: readonly string[]; headRepo?: string | null; sender?: string } = {}) => ({
  action: "closed",
  sender: { login: change.sender ?? "maintainer" },
  repository: { full_name: REPO },
  pull_request: {
    number: 7,
    state: "closed",
    merged: change.merged ?? true,
    labels: (change.labels ?? [FOLLOW_UPS_LABEL]).map((name) => ({ name })),
    head: { ref: "agent/issue-7-a-thing", sha: HEAD, repo: change.headRepo === null ? null : { full_name: change.headRepo ?? REPO } },
    base: { ref: "main" },
  },
});

/**
 * Follow-ups (#519): `follow-ups.yml`'s two entry points, a merge and
 * `agent:follow-ups` added to a closed pull request, each a follow-ups job
 * carrying the pull request alone, since nothing is checked out. A merge is
 * a job whatever its labels (#544), as on Actions, and has no author gate,
 * which Actions does not have either.
 */
describe("the follow-ups route", () => {
  it("dispatches a merge carrying agent:follow-ups as a follow-ups job, with the job's time limit as its deadline", async () => {
    const s = setup();
    const result = await deliver(s, closed());

    expect(result.outcome).toMatch(/^dispatched owner\/repo#7 on its merge as job job-1, deadline /);
    const job = parseJob(JSON.parse(s.posted[0]!.body));
    expect(job).toEqual({
      workflow: "follow-ups",
      id: "job-1",
      version: "9.9.9",
      instance: "dispatcher-1",
      deadline: new Date(START.getTime() + (FOLLOW_UPS_MINUTES + MARGIN) * MINUTE_MS).toISOString(),
      repo: REPO,
      pr: 7,
      appLogin: "loop-app[bot]",
      variables: expect.objectContaining({ AGENT_MODEL: "a-model" }),
    });
    expect(FOLLOW_UPS_MINUTES).toBe(10);
  });

  it("dispatches a merge whatever its sender's permission, and looks none up: a merge queue's bot without write access included", async () => {
    for (const sender of ["stranger", "merge-queue[bot]", "triager"]) {
      const s = setup();
      const job = await dispatched(s, closed({ sender }));

      expect(job.workflow, sender).toBe("follow-ups");
      expect(s.looked, sender).toEqual([]);
    }
  });

  it("dispatches agent:follow-ups added to a closed pull request, merged or not, by a person who can write or by the App", async () => {
    for (const [sender, merged] of [["maintainer", true], ["maintainer", false], ["loop-app[bot]", true]] as const) {
      const s = setup();
      const result = await deliver(s, labelled({ label: FOLLOW_UPS_LABEL, state: "closed", merged, sender }));

      expect(result.outcome, sender).toMatch(/^dispatched owner\/repo#7 on its label as job job-1/);
      expect(parseJob(JSON.parse(s.posted[0]!.body)), sender).toMatchObject({ workflow: "follow-ups", repo: REPO, pr: 7 });
    }
  });

  it.each<[string, (s: ReturnType<typeof setup>) => unknown, string]>([
    ["a close without a merge", () => closed({ merged: false }), "ignored on owner/repo#7: closed without being merged"],
    ["a merge from a fork", () => closed({ headRepo: "someone/fork" }), "refused on owner/repo#7: the head is on a fork"],
    ["a merge from a deleted fork", () => closed({ headRepo: null }), "refused on owner/repo#7: the head is on a fork"],
    [
      "a merge on a repository that has not opted in",
      (s) => {
        delete s.repository.variables[ORCHESTRATOR_VARIABLE];
        return closed();
      },
      "refused on owner/repo#7: AGENT_ORCHESTRATOR is unset, not `service`",
    ],
    [
      "agent:follow-ups on an open pull request",
      () => labelled({ label: FOLLOW_UPS_LABEL }),
      "refused on owner/repo#7: the pull request is open, and `agent:follow-ups` is answered on a closed one",
    ],
    [
      "agent:follow-ups from a fork",
      () => labelled({ label: FOLLOW_UPS_LABEL, state: "closed", merged: true, headRepo: "someone/fork" }),
      "refused on owner/repo#7: the head is on a fork",
    ],
    [
      "agent:follow-ups from a sender who cannot write",
      () => labelled({ label: FOLLOW_UPS_LABEL, state: "closed", merged: true, sender: "triager" }),
      "refused on owner/repo#7: triager cannot write to owner/repo",
    ],
  ])("answers %s with 202, posts no job, and gives the reason", async (_name, arrange, reason) => {
    const s = setup();
    const result = await deliver(s, arrange(s));

    expect(result.status).toBe(202);
    expect(result.outcome).toBe(reason);
    expect(s.posted).toEqual([]);
  });

  it("refuses the other labels on a closed pull request, as before", async () => {
    const result = await deliver(setup(), labelled({ label: FIX_LABEL, state: "closed", merged: true }));

    expect(result.outcome).toBe("refused on owner/repo#7: the pull request is closed, not open");
  });

  it("dispatches a merge without agent:follow-ups too, since the run posts the post-merge checklist on every merge (#544)", async () => {
    for (const labels of [[], [REVIEW_LABEL]]) {
      const s = setup();
      const result = await deliver(s, closed({ labels }));

      expect(result.outcome, labels.join()).toMatch(/^dispatched owner\/repo#7 on its merge as job job-1/);
      expect(parseJob(JSON.parse(s.posted[0]!.body)), labels.join()).toMatchObject({ workflow: "follow-ups", repo: REPO, pr: 7 });
    }
  });

  it("ignores every pull request action but a label, a push and a close", async () => {
    const result = await deliver(setup(), { ...closed(), action: "reopened" });

    expect(result.outcome).toBe("ignored: a pull request `reopened`, not labelled, pushed to or closed");
  });

  it("starts nothing for the labels a stub is filed with, which no route answers", async () => {
    expect(STUB_LABELS).toEqual(["needs-triage", "pr-follow-up"]);
    for (const label of STUB_LABELS) {
      const s = setup();
      const result = await deliver(s, issueLabelled({ label, sender: "loop-app[bot]" }), undefined, "issues");

      expect(result.outcome, label).toBe(`ignored on owner/repo#12: \`${label}\` is not a label this release's service answers on an issue`);
      expect(s.posted, label).toEqual([]);
      expect(SERVICE_LABELS, label).not.toContain(label);
    }
  });
});

describe("the App's permissions and events, checked at start (#560)", () => {
  const FULL = {
    permissions: { metadata: "read", actions_variables: "read", contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "write", workflows: "write" },
    events: ["issues", "pull_request", "check_suite", "status"],
  };

  it("needs each permission at the highest access a token it mints asks for", () => {
    expect(SERVICE_APP_PERMISSIONS).toEqual(FULL.permissions);
    expect(SERVICE_APP_EVENTS).toEqual(["pull_request", "issues", "check_suite", "status"]);
  });

  it("finds no gap in a record that meets the whole set", () => {
    expect(appGaps(FULL)).toEqual([]);
  });

  it("finds no gap in a permission granted above the access needed", () => {
    expect(appGaps({ ...FULL, permissions: { ...FULL.permissions, checks: "write", metadata: "admin" } })).toEqual([]);
  });

  it("names a permission not granted, and the tokens it fails", () => {
    const { actions_variables: _, ...rest } = FULL.permissions;

    expect(appGaps({ ...FULL, permissions: rest })).toEqual([
      "the App's `actions_variables` permission needs read, not granted: the dispatcher's reads, the scan's reads will be refused, 422",
    ]);
  });

  it("names a permission granted below the access needed, and only the tokens that ask for more", () => {
    expect(appGaps({ ...FULL, permissions: { ...FULL.permissions, statuses: "read" } })).toEqual([
      "the App's `statuses` permission needs write, holds read: `write` tokens, `resolve` tokens, `push` tokens will be refused, 422",
    ]);
  });

  it("names the resolve and push tokens where Contents is granted read only", () => {
    expect(appGaps({ ...FULL, permissions: { ...FULL.permissions, contents: "read" } })).toEqual([
      "the App's `contents` permission needs write, holds read: `resolve` tokens, `push` tokens will be refused, 422",
    ]);
  });

  // #591: the dispatcher's own reads list a commit's pull requests, for a
  // check suite's or a status's delivery.
  it("names Pull requests among the dispatcher's reads where it is not granted", () => {
    const { pull_requests: _, ...rest } = FULL.permissions;

    expect(READER_PERMISSIONS).toEqual({ metadata: "read", actions_variables: "read", pull_requests: "read" });
    expect(appGaps({ ...FULL, permissions: rest })).toEqual([
      "the App's `pull_requests` permission needs write, not granted: the dispatcher's reads, the scan's reads, the scan's comment, `read` tokens, `write` tokens, `resolve` tokens, `push` tokens will be refused, 422",
    ]);
  });

  it("names an event the App is not subscribed to", () => {
    expect(appGaps({ ...FULL, events: ["pull_request"] })).toEqual([
      "the App is not subscribed to the `issues` event: no delivery of it reaches the dispatcher",
      "the App is not subscribed to the `check_suite` event: no delivery of it reaches the dispatcher",
      "the App is not subscribed to the `status` event: no delivery of it reaches the dispatcher",
    ]);
  });

  it("reads a record granting nothing as every permission and every event missing", () => {
    expect(appGaps({ permissions: {}, events: [] })).toHaveLength(Object.keys(SERVICE_APP_PERMISSIONS).length + SERVICE_APP_EVENTS.length);
  });
});

/** An open pull request as a scan lists it, carrying `labels`, each added last by `labeller`, with `change` laid over it. */
const pullItem = (labels: string[], change: Partial<Extract<Labelled, { type: "pull_request" }>> = {}, labeller = "maintainer") => ({
  type: "pull_request" as const,
  number: 7,
  state: "open",
  merged: false,
  draft: false,
  branch: "agent/issue-7-a-thing",
  headSha: HEAD,
  headRepo: REPO as string | undefined,
  baseRef: "main",
  ...change,
  labels,
  labellers: Object.fromEntries(labels.map((label) => [label, labeller])),
});

/** An open issue as a scan lists it, as `issueLabelled` delivers it. */
const issueItem = (labels: string[], labeller = "maintainer") => ({
  type: "issues" as const,
  number: 12,
  title: "Add a thing",
  state: "open",
  labels,
  labellers: Object.fromEntries(labels.map((label) => [label, labeller])),
});

/** Every job posted to the worker, in the order posted. */
const jobsPosted = (s: ReturnType<typeof setup>): Job[] => s.posted.map(({ body }) => parseJob(JSON.parse(body)) as Job);

/** A job without its id, which is all that tells two jobs made the same way apart. */
const unnamed = ({ id: _, ...job }: Job) => job;

/** The worker's start, announced at the start door, and the scan it starts, worked through. */
const announce = async (s: ReturnType<typeof setup>, secret = WORKER_SECRET) => {
  const body = Buffer.from(JSON.stringify({ version: "9.9.9", started: START.toISOString() }));
  const { response, scanned } = s.dispatcher.started({ headers: { [SIGNATURE_HEADER]: sign(secret, body) }, body });
  await scanned;
  return response;
};

/** The scan's lines about one item. */
const linesOn = (s: ReturnType<typeof setup>, where: string) => s.lines.filter((line) => line.includes(`${where}:`) || line.includes(`${where} `));

/**
 * The scan (#581): after a restart, the open items carrying a trigger label
 * nothing holds a job for are dispatched as their label's delivery would
 * have dispatched them, with the actor of the item's latest `labeled` event
 * standing in for the delivery's sender.
 */
describe("the scan after a restart", () => {
  it.each([REVIEW_LABEL, FIX_LABEL, UPDATE_BRANCH_LABEL])("dispatches an open pull request's %s at a dispatcher's start, as the job its label's delivery makes", async (label) => {
    const delivered = setup();
    const expected = await dispatched(delivered, labelled({ label }));
    const s = setup();
    s.repository.items = [pullItem([label])];

    await s.dispatcher.scan();

    expect(jobsPosted(s).map(unnamed)).toEqual([unnamed(expected)]);
    expect(s.lines).toContain(`scan: dispatched owner/repo#7 at ${HEAD} as job job-1, deadline ${expected.deadline}`);
    expect(s.lines.at(-1)).toBe("scan: done");
  });

  it("dispatches an open issue's agent:implement as the implement and implement-prd jobs its delivery makes", async () => {
    const delivered = setup();
    const expected = await dispatchedIssue(delivered);
    const s = setup();
    s.repository.items = [issueItem([IMPLEMENT_LABEL])];

    await s.dispatcher.scan();

    expect(jobsPosted(s).map(unnamed)).toEqual(expected.map(unnamed));
  });

  it("takes a label the App added last as the App's, and looks no permission up for it", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL], {}, "loop-app[bot]")];

    await s.dispatcher.scan();

    expect(jobsPosted(s).map((job) => job.workflow)).toEqual(["review"]);
    expect(s.looked).toEqual([]);
  });

  it("dispatches, at a worker's start, every job the restart dropped, running or queued, and forgets the ones it held", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL]), issueItem([IMPLEMENT_LABEL])];
    await deliver(s, labelled());
    await deliver(s, issueLabelled(), undefined, "issues");
    expect(s.posted).toHaveLength(3);

    // The worker restarts: it holds nothing it held before.
    s.worker.holds = [];
    expect((await announce(s)).status).toBe(202);

    expect(jobsPosted(s).slice(3).map((job) => job.workflow)).toEqual(["review", "implement", "implement-prd"]);
    expect((await s.dispatcher.token(tokenRequest({ jobId: "job-1", kind: "read" }))).status).toBe(404);
    expect((await s.dispatcher.token(tokenRequest({ jobId: "job-4", kind: "read" }))).status).toBe(200);
  });

  it("skips an item whose job the worker holds, queued or running, in a scan and between two scans", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL])];
    await deliver(s, labelled());

    await s.dispatcher.scan();
    await announce(s);

    expect(s.posted).toHaveLength(1);
    expect(linesOn(s, "owner/repo#7")).toEqual(Array(2).fill("scan: skipped on owner/repo#7: the worker holds a job for it"));
  });

  it("dispatches a scanned item once, however many scans follow", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL])];

    await s.dispatcher.scan();
    await s.dispatcher.scan();

    expect(s.posted).toHaveLength(1);
  });

  it("skips an item the dispatcher has dispatched a job for whose post the worker has not answered yet", async () => {
    const s = setup({ holdPosts: true });
    s.repository.items = [pullItem([REVIEW_LABEL])];
    const pending = deliver(s, labelled());
    while (s.heldPosts.length === 0) await new Promise((resolve) => setImmediate(resolve));

    await s.dispatcher.scan();
    s.heldPosts.forEach((release) => release());
    await pending;

    expect(s.posted).toHaveLength(1);
    expect(s.lines).toContain("scan: skipped on owner/repo#7: the dispatcher has dispatched a job for it");
    expect((await s.dispatcher.token(tokenRequest({ jobId: "job-1", kind: "read" }))).status).toBe(200);
  });

  it("dispatches once where a delivery for the item lands while the scan reads who labelled it, the delivery first", async () => {
    const s = setup({ holdLabeller: true });
    s.repository.items = [pullItem([REVIEW_LABEL])];
    const scanned = s.dispatcher.scan();
    while (s.heldLabellers.length === 0) await new Promise((resolve) => setImmediate(resolve));

    expect((await deliver(s, labelled())).outcome).toMatch(/^dispatched /);
    s.heldLabellers.forEach((release) => release());
    await scanned;

    expect(s.posted).toHaveLength(1);
    expect(s.lines).toContain(`scan: skipped on owner/repo#7 at ${HEAD}: the dispatcher has dispatched a job for it`);
  });

  it("dispatches once where a delivery for the item lands while the scan's post is in flight, the scan first", async () => {
    const s = setup({ holdPosts: true });
    s.repository.items = [pullItem([REVIEW_LABEL])];
    const scanned = s.dispatcher.scan();
    while (s.heldPosts.length === 0) await new Promise((resolve) => setImmediate(resolve));

    expect((await deliver(s, labelled())).outcome).toBe(`skipped on owner/repo#7 at ${HEAD}: a scan has dispatched a job for it`);
    s.heldPosts.forEach((release) => release());
    await scanned;

    expect(jobsPosted(s).map((job) => job.workflow)).toEqual(["review"]);
  });

  it("dispatches once where a delivery arrives before the scan's dispatch and decides after the worker has taken it", async () => {
    const s = setup({ holdPermission: true });
    s.repository.items = [pullItem([REVIEW_LABEL], {}, "loop-app[bot]"), issueItem([IMPLEMENT_LABEL], "loop-app[bot]")];
    const pending = deliver(s, labelled());
    while (s.heldPermissions.length === 0) await new Promise((resolve) => setImmediate(resolve));

    await s.dispatcher.scan();
    s.heldPermissions.forEach((release) => release());

    expect((await pending).outcome).toBe(`skipped on owner/repo#7 at ${HEAD}: a scan has dispatched a job for it`);
    expect(jobsPosted(s).map((job) => job.workflow)).toEqual(["review", "implement", "implement-prd"]);
  });

  it.each([
    ["a pull request's", () => pullItem([REVIEW_LABEL]), () => labelled(), undefined, ["review"]],
    ["an issue's", () => issueItem([IMPLEMENT_LABEL]), () => issueLabelled(), "issues", ["implement", "implement-prd"]],
  ])("dispatches %s label added again after a scan's job for it has ended, which nothing skips until a deadline", async (_, item, payload, event, kinds) => {
    const s = setup();
    s.repository.items = [item()];
    await s.dispatcher.scan();
    // The scan's job ran and ended, and a later run's ending added the label again.
    s.worker.holds = [];

    expect((await deliver(s, payload(), undefined, event)).outcome).toMatch(/^dispatched /);
    expect(jobsPosted(s).map((job) => job.workflow)).toEqual([...kinds, ...kinds]);
  });

  it("still dispatches a delivery for an item a delivery already dispatched: a label added again is asked for again", async () => {
    const s = setup();
    await deliver(s, labelled());

    expect((await deliver(s, labelled())).outcome).toMatch(/^dispatched /);
    expect(s.posted).toHaveLength(2);
  });

  it("does not skip an issue's other kind's job: either one held skips the label", async () => {
    const s = setup();
    s.repository.items = [issueItem([IMPLEMENT_LABEL])];
    await deliver(s, issueLabelled(), undefined, "issues");
    // The implement-prd job ran and ended; the implement one is still queued.
    s.worker.holds = s.worker.holds.filter((job) => job.workflow === "implement");

    await s.dispatcher.scan();

    expect(s.posted).toHaveLength(2);
    expect(s.lines).toContain("scan: skipped on owner/repo#12: the worker holds a job for it");
  });

  it("refuses an item whose label was added last by someone who cannot write, as a delivery's sender is refused", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL], {}, "triager"), { ...issueItem([IMPLEMENT_LABEL], "a-stranger") }];

    await s.dispatcher.scan();

    expect(s.posted).toEqual([]);
    expect(s.lines).toContain("scan: refused on owner/repo#7: triager cannot write to owner/repo, and added `agent:review` last");
    expect(s.lines).toContain("scan: refused on owner/repo#12: a-stranger cannot write to owner/repo, and added `agent:implement` last");
  });

  it("skips an item with no `labeled` event for its label, rather than dispatching on a guess", async () => {
    const s = setup();
    s.repository.items = [{ ...pullItem([REVIEW_LABEL]), labellers: {} }];

    await s.dispatcher.scan();

    expect(s.posted).toEqual([]);
    expect(s.lines).toContain("scan: skipped on owner/repo#7: no `labeled` event for `agent:review` was found, so there is no one it was asked by to check");
  });

  it("refuses a repository that has not opted in, and reads none of its items", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL])];
    delete s.repository.variables[ORCHESTRATOR_VARIABLE];

    await s.dispatcher.scan();

    expect(s.posted).toEqual([]);
    expect(s.installations.labels).toEqual([]);
    expect(s.lines).toContain(`scan: refused on owner/repo: ${ORCHESTRATOR_VARIABLE} is unset, not \`${SERVICE_ORCHESTRATOR}\``);
  });

  it("refuses an installation on a foreign account, and lists none of its repositories", async () => {
    const s = setup();
    s.installations.accounts["stranger"] = ["stranger/repo"];

    await s.dispatcher.scan();

    expect(s.installations.listed).toEqual([APP_OWNER]);
    expect(s.lines).toContain(
      "scan: refused the installation on stranger: the App's installation is on stranger, which is neither the App's owner nor an account EXTRA_OWNERS lists",
    );
  });

  it.each([
    ["a fork's pull request", { headRepo: "someone/fork" }, "the head is on a fork"],
    ["a pull request whose head repository is gone", { headRepo: undefined }, "the head is on a fork"],
    ["a closed pull request", { state: "closed" }, "the pull request is closed, not open"],
  ])("refuses %s, as a delivery is refused", async (_, change, reason) => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL], change)];

    await s.dispatcher.scan();

    expect(s.posted).toEqual([]);
    expect(s.lines).toContain(`scan: refused on owner/repo#7: ${reason}`);
  });

  it("never dispatches agent:follow-ups, and never lists it", async () => {
    const s = setup();
    s.repository.items = [pullItem([FOLLOW_UPS_LABEL], { state: "closed", merged: true }), { ...pullItem([FOLLOW_UPS_LABEL]), number: 8 }];

    await s.dispatcher.scan();

    expect(s.posted).toEqual([]);
    expect(s.installations.labels).not.toContain(FOLLOW_UPS_LABEL);
    expect([...s.installations.labels].sort()).toEqual([REVIEW_LABEL, FIX_LABEL, UPDATE_BRANCH_LABEL, MERGE_LABEL, IMPLEMENT_LABEL].sort());
  });

  it("dispatches nothing for an item with no trigger label on it, a run's ending having taken it off or left agent:blocked", async () => {
    const s = setup();
    s.repository.items = [pullItem(["agent:blocked"]), issueItem([])];

    await s.dispatcher.scan();

    expect(s.posted).toEqual([]);
  });

  it("ignores a label listed on the other event's item: agent:implement on a pull request", async () => {
    const s = setup();
    s.repository.items = [pullItem([IMPLEMENT_LABEL])];

    await s.dispatcher.scan();

    expect(s.posted).toEqual([]);
    expect(s.lines).toContain("scan: ignored on owner/repo#7: `agent:implement` is not a label a scan answers on a pull request");
  });

  it("logs a repository it cannot read, and goes on to the rest of the scan", async () => {
    const s = setup();
    s.installations.accounts[APP_OWNER] = [REPO, "owner/other"];
    s.repository.unreadable = true;

    await s.dispatcher.scan();

    expect(s.lines).toContain("scan: failed on owner/repo: GitHub answered 503");
    expect(s.lines).toContain(`scan: refused on owner/other: ${ORCHESTRATOR_VARIABLE} is unset, not \`${SERVICE_ORCHESTRATOR}\``);
    expect(s.lines.at(-1)).toBe("scan: done");
  });

  it("logs each label whose items cannot be listed, and lists the others", async () => {
    const s = setup();
    s.installations.unlistable = [REPO];

    await s.dispatcher.scan();

    expect(s.lines.filter((line) => line.startsWith("scan: failed on owner/repo: its "))).toHaveLength(5);
    expect(s.lines.at(-1)).toBe("scan: done");
  });

  it("skips the scan where the worker cannot be reached, reads nothing of GitHub, and scans again at the worker's start", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL])];
    s.worker.down = true;

    await s.dispatcher.scan();

    expect(s.posted).toEqual([]);
    expect(s.installations.listed).toEqual([]);
    expect(s.lines).toEqual(["scan: skipped: the worker could not say which jobs it holds: connect ECONNREFUSED. Its start scans again"]);

    s.worker.down = false;
    await announce(s);

    expect(s.posted).toHaveLength(1);
  });

  it("refuses a start announcement whose signature does not verify, and scans nothing", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL])];

    expect((await announce(s, "someone-elses-secret")).status).toBe(401);
    expect(s.worker.asked).toBe(0);
    expect(s.posted).toEqual([]);
  });

  it("runs one pass at a time: a request while one waits is folded into it, and one while a pass runs waits behind it", async () => {
    const s = setup({ holdPosts: true });
    s.repository.items = [pullItem([REVIEW_LABEL])];

    const first = s.dispatcher.scan();
    expect(s.dispatcher.scan()).toBe(first);
    while (s.heldPosts.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const second = s.dispatcher.scan();
    expect(s.dispatcher.scan()).toBe(second);
    expect(s.worker.asked).toBe(1);

    s.heldPosts.forEach((release) => release());
    await second;

    expect(s.worker.asked).toBe(2);
    expect(s.posted).toHaveLength(1);
  });

  it("reads with the dispatcher's reads and issues and pull requests read, which the App already needs", () => {
    expect(SCAN_PERMISSIONS).toEqual({ ...READER_PERMISSIONS, issues: "read", pull_requests: "read" });
    for (const name of Object.keys(SCAN_PERMISSIONS)) expect(SERVICE_APP_PERMISSIONS).toHaveProperty(name);
  });
});

/** A worker's process ended by its job: it holds nothing, and its restart announces its start and is scanned for. */
const crash = async (s: ReturnType<typeof setup>) => {
  s.worker.holds = [];
  await announce(s);
};

const STOPPED = (where: string, label: string) =>
  `scan: skipped on ${where}: a scan has dispatched it for \`${label}\` 2 times, SCAN_DISPATCH_LIMIT's 2, so it is left for a person to add \`${label}\` again`;

/**
 * A dispatcher's restart alone (#597): the worker still holds the jobs the old
 * instance queued, whose ids no dispatcher running now knows. The new
 * instance's start scan names it at the held door, the worker drops every job
 * it holds queued from another, never one that has started, running in
 * either lane or waiting for the agent lane, and the scan dispatches their
 * items again. Driven over the real queue and doors.
 */
describe("a dispatcher's restart, with the worker still up", () => {
  const ids = (jobs: readonly Job[]) => jobs.map((job) => job.id);
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  /**
   * A worker running a fix job whose label has since come off, job-1, with an
   * issue's implement and implement-prd jobs queued behind it, job-2 and job-3,
   * whose label is still on: all three from the first instance.
   */
  const busy = async () => {
    const s = setup({ queue: true });
    await deliver(s, labelled({ label: FIX_LABEL }));
    await deliver(s, issueLabelled(), undefined, "issues");
    s.repository.items = [issueItem([IMPLEMENT_LABEL])];
    await tick();
    expect(ids(s.ran)).toEqual(["job-1"]);
    expect(ids(s.queue.held())).toEqual(["job-1", "job-2", "job-3"]);
    return s;
  };

  it("drops each job queued from the previous instance, never runs it, and dispatches its item again, which runs once", async () => {
    const s = await busy();

    s.restart();
    await s.dispatcher.scan();

    expect(ids(s.queue.held())).toEqual(["job-1", "job-4", "job-5"]);
    expect(s.queue.held().map((job) => job.instance)).toEqual(["dispatcher-1", "dispatcher-2", "dispatcher-2"]);
    expect(linesOn(s, "owner/repo#12")).toEqual([
      expect.stringMatching(/^scan: dispatched owner\/repo#12 to implement as job job-4, deadline [^;]+; dispatched owner\/repo#12 to implement-prd as job job-5, /),
    ]);
    expect((await s.dispatcher.token(tokenRequest({ jobId: "job-4", kind: "read" }))).status).toBe(200);

    await s.finish();
    await s.finish();
    await s.finish();
    expect(ids(s.ran)).toEqual(["job-1", "job-4", "job-5"]);
    expect(s.queue.held()).toEqual([]);
  });

  it("never drops a job queued from the current instance, whichever scan or delivery asked", async () => {
    const s = setup({ queue: true });
    await deliver(s, labelled({ label: FIX_LABEL }));
    s.restart();
    await s.dispatcher.scan();
    await deliver(s, issueLabelled(), undefined, "issues");
    s.repository.items = [issueItem([IMPLEMENT_LABEL])];

    await s.dispatcher.scan();
    await announce(s);

    expect(ids(s.queue.held())).toEqual(["job-1", "job-2", "job-3"]);
    expect(s.posted).toHaveLength(3);
    expect(linesOn(s, "owner/repo#12")).toEqual(Array(2).fill("scan: skipped on owner/repo#12: the worker holds a job for it"));
  });

  it("keeps the running job, skipping its item, and dispatches the queued ones again in order behind it", async () => {
    const s = setup({ queue: true });
    s.repository.items = [pullItem([REVIEW_LABEL]), issueItem([IMPLEMENT_LABEL])];
    await deliver(s, labelled());
    await deliver(s, issueLabelled(), undefined, "issues");
    await tick();

    s.restart();
    await s.dispatcher.scan();

    expect(ids(s.queue.held())).toEqual(["job-1", "job-4", "job-5"]);
    expect(s.queue.held().map((job) => job.workflow)).toEqual(["review", "implement", "implement-prd"]);
    expect(linesOn(s, "owner/repo#7")).toEqual(["scan: skipped on owner/repo#7: the worker holds a job for it"]);
    // The running job ends at its next token request, as it did before.
    expect((await s.dispatcher.token(tokenRequest({ jobId: "job-1", kind: "write" }))).status).toBe(404);

    await s.finish();
    await s.finish();
    await s.finish();
    expect(ids(s.ran)).toEqual(["job-1", "job-4", "job-5"]);
  });

  it("skips the pass, logged, and drops nothing where the worker cannot be reached at its start; the next scan recovers them", async () => {
    const s = await busy();

    s.restart();
    s.worker.down = true;
    await s.dispatcher.scan();

    expect(s.lines).toContain("scan: skipped: the worker could not say which jobs it holds: connect ECONNREFUSED. Its start scans again");
    expect(ids(s.queue.held())).toEqual(["job-1", "job-2", "job-3"]);
    expect(s.posted).toHaveLength(3);

    s.worker.down = false;
    await announce(s);

    expect(ids(s.queue.held())).toEqual(["job-1", "job-4", "job-5"]);
  });

  it("skips the pass and drops nothing where the held door refuses the question's signature", async () => {
    const s = await busy();

    s.restart("someone-elses-secret");
    await s.dispatcher.scan();

    expect(s.lines).toContain("scan: skipped: the worker refused to say which jobs it holds: the worker answered 401: bad signature");
    expect(ids(s.queue.held())).toEqual(["job-1", "job-2", "job-3"]);
    expect(s.posted).toHaveLength(3);
  });

  it.each<[string, number, string]>([
    ["ahead", HELD_REQUEST_MAX_AGE_MINUTES + 1, `more than ${HELD_REQUEST_MAX_AGE_MINUTES} minutes ago by this worker's clock`],
    ["behind", -HELD_REQUEST_MAX_SKEW_MINUTES - 1, `more than ${HELD_REQUEST_MAX_SKEW_MINUTES} minute ahead of this worker's clock`],
  ])("logs the held door's refusal where the worker's clock runs %s, at the start scan and the announcement's alike, and drops nothing (#601)", async (_name, workerAhead, refused) => {
    const s = setup({ queue: true, workerAhead });
    s.repository.items = [pullItem([REVIEW_LABEL])];

    await s.dispatcher.scan();
    await announce(s);

    const line = `scan: skipped: the worker refused to say which jobs it holds: the worker answered 400: \`asked\` is ${START.toISOString()}, ${refused}`;
    expect(s.lines.filter((logged) => logged.startsWith("scan: skipped: the worker"))).toEqual([line, line]);
    expect(s.lines.some((logged) => logged.includes("Its start scans again"))).toBe(false);
    expect(s.posted).toEqual([]);
  });
});

/**
 * The scan's limit (#596): a job that ends the worker's process keeps its
 * label, and every restart's scan would dispatch it again, so the scan counts
 * its dispatches per item and label and stops at the limit.
 */
describe("the scan's limit", () => {
  it("dispatches an item whose label stays on the limit's number of times, then skips it with a line naming the item, the label and the limit", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL])];

    await s.dispatcher.scan();
    await crash(s);
    await crash(s);
    await crash(s);

    expect(s.posted).toHaveLength(2);
    expect(linesOn(s, "owner/repo#7").slice(2)).toEqual([`${STOPPED("owner/repo#7", REVIEW_LABEL)}; commented on it`, STOPPED("owner/repo#7", REVIEW_LABEL)]);
    expect(s.lines.at(-1)).toBe("scan: done");
  });

  it("comments once when it first stops, naming the label to add again by hand, with a token minted for the comment alone", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL])];

    await s.dispatcher.scan();
    for (let restart = 0; restart < 4; restart += 1) await crash(s);

    expect(s.comments).toHaveLength(1);
    const [comment] = s.comments;
    expect(comment?.repo).toBe(REPO);
    expect(comment?.number).toBe(7);
    expect(comment?.body).toContain(`remove \`${REVIEW_LABEL}\` and add it again by hand`);
    const commentMints = s.minted.filter(({ permissions }) => permissions === COMMENT_PERMISSIONS);
    expect(commentMints).toEqual([{ repo: REPO, permissions: COMMENT_PERMISSIONS }]);
    expect(comment?.token).toBe(`minted-token-${s.minted.findIndex(({ permissions }) => permissions === COMMENT_PERMISSIONS) + 1}`);
    expect(COMMENT_PERMISSIONS).toEqual({ issues: "write", pull_requests: "write" });
    for (const [name, access] of Object.entries(COMMENT_PERMISSIONS)) expect(SERVICE_APP_PERMISSIONS[name]).toBe(access);
  });

  it("dispatches a person's delivery for a counted-out label, and the scan answers the item again from zero, up to the limit", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL])];
    await s.dispatcher.scan();
    await crash(s);
    await crash(s);
    expect(s.posted).toHaveLength(2);

    expect((await deliver(s, labelled())).outcome).toMatch(/^dispatched owner\/repo#7/);
    await crash(s);
    await crash(s);
    await crash(s);

    expect(s.posted).toHaveLength(5);
    expect(s.lines.at(-2)).toBe(`${STOPPED("owner/repo#7", REVIEW_LABEL)}; commented on it`);
    expect(s.comments).toHaveLength(2);
  });

  it("does not reset the count for a delivery that fails the author gate", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL])];
    await s.dispatcher.scan();
    await crash(s);

    await deliver(s, labelled({ sender: "triager" }));
    await crash(s);

    expect(s.posted).toHaveLength(2);
    expect(s.lines.at(-2)).toBe(`${STOPPED("owner/repo#7", REVIEW_LABEL)}; commented on it`);
  });

  it("counts each item and each label on an item apart, and an issue's label once however many kinds it starts", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL, FIX_LABEL]), issueItem([IMPLEMENT_LABEL])];
    await s.dispatcher.scan();
    s.repository.items.push(pullItem([REVIEW_LABEL], { number: 8 }));
    await crash(s);
    await crash(s);

    expect(jobsPosted(s).slice(9).map((job) => `${job.workflow} ${"issue" in job ? job.issue : job.pr}`)).toEqual(["review 8"]);
    expect(s.lines).toContain(STOPPED("owner/repo#7", REVIEW_LABEL) + "; commented on it");
    expect(s.lines).toContain(STOPPED("owner/repo#7", FIX_LABEL) + "; commented on it");
    expect(s.lines).toContain(STOPPED("owner/repo#12", IMPLEMENT_LABEL) + "; commented on it");
    expect(s.comments.map(({ number, body }) => [number, body.includes(`\`${FIX_LABEL}\``)])).toEqual([
      [7, false],
      [7, true],
      [12, false],
    ]);

    await crash(s);

    expect(s.posted).toHaveLength(10);
    expect(s.lines).toContain(`${STOPPED("owner/repo#8", REVIEW_LABEL)}; commented on it`);
  });

  it("forgets a label a later scan no longer lists, so a fresh label on the same item is answered from zero", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL])];
    await s.dispatcher.scan();
    await crash(s);
    await crash(s);
    expect(s.posted).toHaveLength(2);

    s.repository.items = [];
    await crash(s);
    s.repository.items = [pullItem([REVIEW_LABEL])];
    await crash(s);
    await crash(s);
    await crash(s);

    expect(s.posted).toHaveLength(4);
    expect(s.comments).toHaveLength(2);
    expect(linesOn(s, "owner/repo#7").at(-1)).toBe(`${STOPPED("owner/repo#7", REVIEW_LABEL)}; commented on it`);
  });

  it("keeps the count of a label whose items could not be listed", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL])];
    await s.dispatcher.scan();
    await crash(s);

    s.installations.unlistable = [REPO];
    await crash(s);
    s.installations.unlistable = [];
    await crash(s);

    expect(s.posted).toHaveLength(2);
    expect(s.lines.at(-2)).toBe(`${STOPPED("owner/repo#7", REVIEW_LABEL)}; commented on it`);
  });

  it("logs a comment that cannot be posted, goes on with the pass, and tries the comment again at the next scan", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL])];
    await s.dispatcher.scan();
    await crash(s);

    s.commenting.fails = true;
    s.repository.items.push(pullItem([REVIEW_LABEL], { number: 8 }));
    await crash(s);

    expect(s.lines).toContain(
      `${STOPPED("owner/repo#7", REVIEW_LABEL)}; the comment saying so could not be posted, and is tried again at the next scan: GitHub answered 502`,
    );
    expect(jobsPosted(s).map((job) => ("pr" in job ? job.pr : 0))).toEqual([7, 7, 8]);
    expect(s.lines.at(-1)).toBe("scan: done");

    s.commenting.fails = false;
    await crash(s);
    await crash(s);

    expect(s.comments.map(({ number }) => number)).toEqual([7, 8]);
  });

  it("dispatches once and stops where the limit is 1, and says so on the item", async () => {
    const s = setup({ scanLimit: 1 });
    s.repository.items = [pullItem([REVIEW_LABEL])];
    await s.dispatcher.scan();
    await crash(s);

    expect(s.posted).toHaveLength(1);
    expect(s.comments[0]?.body).toContain(`for \`${REVIEW_LABEL}\` once`);
  });

  it("counts no delivery's dispatch", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL])];
    await deliver(s, labelled());
    await crash(s);
    await crash(s);
    await crash(s);

    expect(s.posted).toHaveLength(3);
    expect(s.comments).toHaveLength(1);
  });
});

describe("the scan and the plan's usage limit (#635)", () => {
  /** The resume note the service's conclude posts, as the App. */
  const note = (until: string, stopped: string, author = "loop-app[bot]") => ({
    body: `**\`${REVIEW_LABEL}\` is waiting:** It hit the plan's usage limit.\n\n${resumeNoteMark(until, stopped)}\n`,
    author,
  });

  it("skips an item whose newest resume note names a time still ahead, and dispatches it once at the scan the reset asks for, its label still on", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL])];
    s.repository.conversations = { 7: [note("2026-10-11T13:00:00.000Z", "2026-10-11T11:50:00.000Z")] };

    await s.dispatcher.scan();
    expect(s.posted).toHaveLength(0);
    expect(linesOn(s, "owner/repo#7")).toEqual([
      "scan: skipped on owner/repo#7: it waits on the plan's usage limit, which resets at 2026-10-11T13:00:00.000Z, and the worker asks for a scan then",
    ]);

    // The worker's announcement, a margin after the reset.
    s.advance(62);
    await announce(s);
    await announce(s);

    expect(jobsPosted(s).map((job) => job.workflow)).toEqual(["review"]);
    expect(s.comments).toEqual([]);
  });

  it("reads only a note the App posted, so anyone else's marker holds nothing", async () => {
    const s = setup();
    s.repository.items = [pullItem([REVIEW_LABEL])];
    s.repository.conversations = { 7: [note("2026-10-11T13:00:00.000Z", "2026-10-11T11:50:00.000Z", "someone")] };

    await s.dispatcher.scan();

    expect(s.posted).toHaveLength(1);
  });

  it("does not count an item out while it waits, nor say its job ended before its run did, and counts the resume like any scan's dispatch", async () => {
    const s = setup({ scanLimit: 1 });
    s.repository.items = [issueItem([IMPLEMENT_LABEL])];
    await s.dispatcher.scan();
    expect(jobsPosted(s).map((job) => job.workflow)).toEqual(["implement", "implement-prd"]);

    // The job ran, the plan's limit stopped it, and its conclude left the note with the label on.
    s.advance(10);
    s.repository.conversations = { 12: [note("2026-10-11T13:00:00.000Z", "2026-10-11T12:10:00.000Z")] };
    await crash(s);
    expect(s.posted).toHaveLength(2);
    expect(s.comments).toEqual([]);

    s.advance(52);
    await crash(s);
    expect(jobsPosted(s).slice(2).map((job) => job.workflow)).toEqual(["implement", "implement-prd"]);
    expect(s.comments).toEqual([]);

    // The resume's job ends before its run does: that is the scan's limit, as for any dispatch.
    await crash(s);
    expect(s.posted).toHaveLength(4);
    expect(s.comments[0]?.body).toContain(`for \`${IMPLEMENT_LABEL}\` once`);
  });
});

/** A `pull_request` `synchronize` delivery, a push to the pull request, carrying `labels`. */
const pushedTo = (change: { labels?: readonly string[]; state?: string; headRepo?: string; sender?: string; draft?: boolean; number?: number } = {}) => ({
  action: "synchronize",
  sender: { login: change.sender ?? "pusher" },
  repository: { full_name: REPO },
  pull_request: {
    number: change.number ?? 7,
    state: change.state ?? "open",
    merged: false,
    draft: change.draft ?? false,
    labels: (change.labels ?? [MERGE_LABEL]).map((name) => ({ name })),
    head: { ref: "agent/issue-7-a-thing", sha: HEAD, repo: { full_name: change.headRepo ?? REPO } },
    base: { ref: "main" },
  },
});

/** A `check_suite` delivery on `sha`, `completed` unless said. */
const checkSuite = (change: { action?: string; sha?: string } = {}) => ({
  action: change.action ?? "completed",
  sender: { login: "ci-bot[bot]" },
  repository: { full_name: REPO },
  check_suite: { head_sha: change.sha ?? HEAD, conclusion: "success" },
});

/** A `status` delivery on `sha`, `success` from a CI's context unless said. */
const statusOn = (change: { context?: string; state?: string; sha?: string } = {}) => ({
  sender: { login: "ci-bot[bot]" },
  repository: { full_name: REPO },
  sha: change.sha ?? HEAD,
  context: change.context ?? "ci/build",
  state: change.state ?? "success",
});

/** An armed pull request, as GitHub lists it: open, carrying `agent:merge`, added by the maintainer. */
const armed = (change: Partial<Extract<Labelled, { type: "pull_request" }>> = {}, labels: string[] = [MERGE_LABEL]) => pullItem(labels, change);

/**
 * The service's `merge` job kind (#591): `agent:merge` itself, and the events
 * that can change the gate's answer on an armed head, a push, a check suite's
 * completion and a final status, each start a merge job.
 */
describe("the merge route", () => {
  it("dispatches agent:merge added by someone who can write as a merge job that may arm, carrying what the gate is told", async () => {
    const s = setup();
    const job = await dispatched(s, { ...labelled({ label: MERGE_LABEL }), pull_request: { ...labelled().pull_request, draft: false } });

    expect(job).toMatchObject({
      workflow: "merge",
      repo: REPO,
      pr: 7,
      branch: "agent/issue-7-a-thing",
      headSha: HEAD,
      baseRef: "main",
      state: "open",
      merged: false,
      draft: false,
      action: "labeled",
      sender: "maintainer",
      appLogin: "loop-app[bot]",
      deadline: new Date(START.getTime() + (MERGE_MINUTES + MARGIN) * MINUTE_MS).toISOString(),
    });
    expect(MERGE_MINUTES).toBe(20);
    expect(SERVICE_LABELS).toContain(MERGE_LABEL);
  });

  it("dispatches the App's own agent:merge without a look-up, and refuses a sender who cannot write", async () => {
    const byApp = setup();
    expect(await dispatched(byApp, labelled({ label: MERGE_LABEL, sender: "loop-app[bot]" }))).toMatchObject({ workflow: "merge", action: "labeled", sender: "loop-app[bot]" });
    expect(byApp.looked).toEqual([]);

    const s = setup();
    const result = await deliver(s, labelled({ label: MERGE_LABEL, sender: "triager" }));
    expect(result.outcome).toBe("refused on owner/repo#7: triager cannot write to owner/repo");
    expect(s.posted).toEqual([]);
  });

  it("carries a draft as a draft, for the gate to refuse", async () => {
    const job = await dispatched(setup(), { ...labelled({ label: MERGE_LABEL }), pull_request: { ...labelled().pull_request, draft: true } });

    expect(job).toMatchObject({ workflow: "merge", draft: true });
  });

  it("dispatches a push to a pull request carrying agent:merge as a merge job that arms nothing, with no author gate", async () => {
    const s = setup();
    const job = await dispatched(s, pushedTo({ sender: "stranger" }));

    expect(job).toMatchObject({ workflow: "merge", pr: 7, headSha: HEAD, action: "synchronize", sender: "stranger", draft: false });
    expect(s.looked).toEqual([]);
    expect(s.lines).toEqual([]);
  });

  it.each<[string, () => unknown, string]>([
    ["not carrying agent:merge", () => pushedTo({ labels: [REVIEW_LABEL] }), "ignored on owner/repo#7: a push to a pull request not carrying `agent:merge`"],
    ["that is closed", () => pushedTo({ state: "closed" }), "refused on owner/repo#7: the pull request is closed, not open"],
    ["from a fork", () => pushedTo({ headRepo: "someone/fork" }), "refused on owner/repo#7: the head is on a fork"],
  ])("starts nothing for a push to a pull request %s", async (_name, payload, outcome) => {
    const s = setup();
    const result = await deliver(s, payload());

    expect(result.outcome).toBe(outcome);
    expect(s.posted).toEqual([]);
  });

  it("dispatches a check suite's completion on an armed head as a merge job that arms nothing, reading the commit's pull requests", async () => {
    const s = setup();
    s.repository.items = [armed()];
    const result = await deliver(s, checkSuite(), undefined, "check_suite");

    expect(result.outcome).toMatch(/^dispatched owner\/repo#7 at a{40} on a check suite's completion as job job-1/);
    expect(jobsPosted(s)).toEqual([
      expect.objectContaining({ workflow: "merge", pr: 7, headSha: HEAD, baseRef: "main", draft: false, action: "synchronize", sender: "ci-bot[bot]" }),
    ]);
    expect(s.pullsRead).toEqual([HEAD]);
  });

  it.each(["success", "failure", "error"])("dispatches a final %s status from a context not the loop's own on an armed head", async (state) => {
    const s = setup();
    s.repository.items = [armed()];
    const result = await deliver(s, statusOn({ state }), undefined, "status");

    expect(result.outcome).toMatch(/^dispatched owner\/repo#7 at a{40} on a status as job job-1/);
    expect(jobsPosted(s).map((job) => job.workflow)).toEqual(["merge"]);
  });

  it.each<[string, string, () => unknown]>([
    ["a status for agent-merge", "status", () => statusOn({ context: "agent-merge" })],
    ["a status for agent-review", "status", () => statusOn({ context: "agent-review", state: "failure" })],
    ["a status for agent-fix-round", "status", () => statusOn({ context: "agent-fix-round" })],
    ["a pending status", "status", () => statusOn({ state: "pending" })],
    ["a check suite requested", "check_suite", () => checkSuite({ action: "requested" })],
    ["a check suite rerequested", "check_suite", () => checkSuite({ action: "rerequested" })],
  ])("starts nothing for %s on an armed head, and reads nothing to decide so", async (_name, event, payload) => {
    const s = setup();
    s.repository.items = [armed()];
    const result = await deliver(s, payload(), undefined, event);

    expect(result.outcome).toMatch(/^ignored: /);
    expect(s.posted).toEqual([]);
    expect(s.pullsRead).toEqual([]);
  });

  it.each<[string, () => (Labelled & { labels: string[]; labellers: Record<string, string> })[], RegExp]>([
    ["a pull request without agent:merge", () => [armed({}, [REVIEW_LABEL])], /^ignored on owner\/repo#7: a check suite's completion on a pull request not carrying `agent:merge`$/],
    ["a closed pull request", () => [armed({ state: "closed" })], /^ignored on owner\/repo@a{40}: a check suite's completion on a commit that is no open pull request's head$/],
    ["a commit no open pull request has as its head", () => [armed({ headSha: "b".repeat(40) })], /^ignored on owner\/repo@a{40}: a check suite's completion on a commit that is no open pull request's head$/],
    ["a pull request from a fork", () => [armed({ headRepo: "someone/fork" })], /^refused on owner\/repo#7: the head is on a fork$/],
  ])("starts nothing for a completed check suite on %s", async (_name, items, outcome) => {
    const s = setup();
    s.repository.items = items();
    const result = await deliver(s, checkSuite(), undefined, "check_suite");

    expect(result.outcome).toMatch(outcome);
    expect(s.posted).toEqual([]);
  });

  it("starts nothing on a repository that does not opt in, and reads none of its pull requests", async () => {
    const s = setup();
    s.repository.items = [armed()];
    delete s.repository.variables[ORCHESTRATOR_VARIABLE];
    const result = await deliver(s, statusOn(), undefined, "status");

    expect(result.outcome).toMatch(/^refused on owner\/repo@a{40}: AGENT_ORCHESTRATOR is unset/);
    expect(s.pullsRead).toEqual([]);
  });

  it("dispatches a merge job for each armed pull request whose head the commit is, and nothing for the others", async () => {
    const s = setup();
    s.repository.items = [armed(), armed({ number: 8 }, [REVIEW_LABEL]), armed({ number: 9 })];
    await deliver(s, statusOn(), undefined, "status");

    expect(jobsPosted(s).map((job) => [job.workflow, "pr" in job ? job.pr : 0])).toEqual([
      ["merge", 7],
      ["merge", 9],
    ]);
  });
});

/**
 * Coalescing (#591): per pull request, at most one merge job runs and at most
 * one waits, so merge jobs cannot pile up in the worker's one serial queue.
 * The worker's door holds the rule; driven here over the real queue and doors.
 */
describe("merge jobs coalesced in the worker's queue", () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  /** Five merge deliveries for #7, one of each trigger and the App's own label. */
  const five = async (s: ReturnType<typeof setup>) => {
    await deliver(s, pushedTo());
    await deliver(s, checkSuite(), undefined, "check_suite");
    await deliver(s, statusOn(), undefined, "status");
    await deliver(s, statusOn({ context: "ci/lint", state: "failure" }), undefined, "status");
    await deliver(s, labelled({ label: MERGE_LABEL, sender: "loop-app[bot]" }));
  };
  const held = (s: ReturnType<typeof setup>) => s.queue.held().map((job) => `${job.workflow} ${"pr" in job ? job.pr : ""}`);

  it("leaves one merge job queued for five deliveries while it waits, and absorbs each with a line naming it", async () => {
    const s = setup({ queue: true });
    s.repository.items = [armed()];
    // Something else runs first, so the merge job waits behind it.
    await deliver(s, labelled({ label: REVIEW_LABEL }));
    await deliver(s, pushedTo());
    await tick();

    await five(s);

    expect(s.posted).toHaveLength(7);
    expect(held(s)).toEqual(["review 7", "merge 7"]);
    expect(s.coalesced).toHaveLength(5);
    expect(s.coalesced[0]).toBe("job job-3: absorbed by merge job job-2, queued for owner/repo#7 and not yet started, which reads the record fresh when it starts");
  });

  it("leaves one merge job running and one queued for five deliveries while one runs", async () => {
    const s = setup({ queue: true });
    s.repository.items = [armed()];
    await deliver(s, pushedTo());
    await tick();
    expect(s.ran.map((job) => job.id)).toEqual(["job-1"]);

    await five(s);

    expect(held(s)).toEqual(["merge 7", "merge 7"]);
    expect(s.queue.running()?.id).toBe("job-1");
    expect(s.queue.held().map((job) => job.id)).toEqual(["job-1", "job-2"]);
    expect(s.coalesced).toHaveLength(4);

    // The successor runs once the first has ended, and reads the record then.
    await s.finish();
    expect(s.ran.map((job) => job.id)).toEqual(["job-1", "job-2"]);
  });

  it("does not absorb a delivery for another pull request, nor another kind's job for the same one", async () => {
    const s = setup({ queue: true });
    s.repository.items = [armed(), armed({ number: 8 })];
    await deliver(s, labelled({ label: REVIEW_LABEL }));
    await deliver(s, pushedTo());
    await deliver(s, pushedTo({ number: 8 }));
    await deliver(s, labelled({ label: FIX_LABEL }));
    await tick();

    expect(held(s)).toEqual(["review 7", "merge 7", "merge 8", "fix 7"]);
    expect(s.coalesced).toEqual([]);
  });

  it("lets a person's agent:merge replace the merge job queued, since it is the one delivery that arms", async () => {
    const s = setup({ queue: true });
    await deliver(s, labelled({ label: REVIEW_LABEL }));
    await deliver(s, pushedTo());
    await deliver(s, labelled({ label: MERGE_LABEL }));
    await deliver(s, pushedTo());
    await tick();

    expect(s.queue.held().map((job) => job.id)).toEqual(["job-1", "job-3"]);
    expect(s.queue.held()[1]).toMatchObject({ workflow: "merge", action: "labeled", sender: "maintainer" });
    expect(s.coalesced).toEqual([
      "job job-3: replaced merge job job-2, queued for owner/repo#7 and not yet started, since it is a person's `agent:merge` and arms the head its delivery named",
      "job job-4: absorbed by merge job job-3, queued for owner/repo#7 and not yet started, which reads the record fresh when it starts",
    ]);
  });
});

/**
 * The scan and `agent:merge` (#591): a standing authorisation, not a run's
 * label, so the scan dispatches a gate for an armed pull request nothing
 * holds one for, however many restarts there are, and never counts it.
 */
describe("the scan and agent:merge", () => {
  it("dispatches a merge job that arms nothing for an armed pull request nothing holds one for, the labeller as its sender", async () => {
    const s = setup();
    s.repository.items = [armed()];

    await s.dispatcher.scan();

    expect(jobsPosted(s)).toEqual([expect.objectContaining({ workflow: "merge", pr: 7, headSha: HEAD, action: "synchronize", sender: "maintainer", draft: false })]);
  });

  it("skips an armed pull request whose merge job the worker holds", async () => {
    const s = setup();
    s.repository.items = [armed()];
    await deliver(s, pushedTo());

    await s.dispatcher.scan();

    expect(s.posted).toHaveLength(1);
    expect(s.lines).toContain("scan: skipped on owner/repo#7: the worker holds a job for it");
  });

  it("still dispatches it after more restarts than SCAN_DISPATCH_LIMIT, and never says it was left for a person", async () => {
    const s = setup({ scanLimit: 2 });
    s.repository.items = [armed(), pullItem([REVIEW_LABEL], { number: 8 })];

    await s.dispatcher.scan();
    for (let restart = 0; restart < 4; restart += 1) await crash(s);

    expect(jobsPosted(s).filter((job) => job.workflow === "merge")).toHaveLength(5);
    expect(jobsPosted(s).filter((job) => job.workflow === "review")).toHaveLength(2);
    expect(s.comments.map(({ number }) => number)).toEqual([8]);
    expect(s.lines.filter((line) => line.includes("SCAN_DISPATCH_LIMIT") && line.includes(MERGE_LABEL))).toEqual([]);
  });

  it("refuses an armed pull request whose agent:merge was added last by someone who cannot write", async () => {
    const s = setup();
    s.repository.items = [pullItem([MERGE_LABEL], {}, "triager")];

    await s.dispatcher.scan();

    expect(s.posted).toEqual([]);
    expect(s.lines).toContain("scan: refused on owner/repo#7: triager cannot write to owner/repo, and added `agent:merge` last");
  });
});
