import { describe, expect, it } from "vitest";
import { CI_WAIT_SECONDS } from "../../review/collect-checks.js";
import { createDispatcher, LABEL_KINDS, parseOwners, SERVICE_LABELS, TOKEN_PERMISSIONS, type AppGitHub } from "../../service/dispatcher.js";
import { DEFAULT_FIX_MINUTES, DEFAULT_REVIEW_MINUTES, JOB_KINDS, parseJob, sign, SIGNATURE_HEADER, verifySignature, type Job } from "../../service/job.js";
import { FIX_LABEL, IMPLEMENT_LABEL, ORCHESTRATOR_VARIABLE, REVIEW_LABEL, SERVICE_ORCHESTRATOR, UPDATE_BRANCH_LABEL } from "../../shared/record.js";

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
}

/** The App's owner, which is the repository's owner too, unless a test says otherwise. */
const APP_OWNER = "owner";

const setup = (options: { workerStatus?: number; owners?: readonly string[] } = {}) => {
  const repository: Repository = {
    installed: true,
    account: APP_OWNER,
    variables: { [ORCHESTRATOR_VARIABLE]: SERVICE_ORCHESTRATOR, AGENT_MODEL: "a-model", AGENT_MAX_FIX_ROUNDS: "2" },
    permissions: { maintainer: "write", triager: "triage" },
  };
  const minted: { repo: string; permissions: Readonly<Record<string, string>> }[] = [];
  const posted: { body: string; headers: Readonly<Record<string, string>> }[] = [];
  /** Each login whose permission was looked up. */
  const looked: string[] = [];
  let clock = START;
  let ids = 0;
  const github: AppGitHub = {
    app: async () => ({ slug: "loop-app", owner: APP_OWNER }),
    installation: async (repo) => (repo === REPO && repository.installed ? repository.account : undefined),
    variable: async (repo, name) => {
      if (repository.unreadable === true) throw new Error("GitHub answered 503");
      return repo === REPO ? repository.variables[name] : undefined;
    },
    permission: async (repo, login) => {
      looked.push(login);
      return repo === REPO ? repository.permissions[login] : undefined;
    },
    mint: async (repo, permissions) => {
      minted.push({ repo, permissions });
      return { token: `minted-token-${minted.length}`, expiresAt: "2026-10-11T13:00:00Z" };
    },
  };
  const dispatcher = createDispatcher({
    github,
    postJob: async (body, headers) => {
      posted.push({ body, headers });
      return options.workerStatus ?? 202;
    },
    webhookSecret: WEBHOOK_SECRET,
    workerSecret: WORKER_SECRET,
    owners: options.owners ?? [APP_OWNER],
    deadlineMarginMinutes: MARGIN,
    version: "9.9.9",
    now: () => clock,
    newId: () => `job-${(ids += 1)}`,
  });
  return {
    dispatcher,
    repository,
    minted,
    posted,
    looked,
    advance: (minutes: number) => {
      clock = new Date(clock.getTime() + minutes * MINUTE_MS);
    },
  };
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
    ["a label the service does not answer", () => labelled({ label: "agent:follow-ups" }), /`agent:follow-ups` is not a label this release's service answers/],
    ["an event that is neither a pull request's nor an issue's", () => labelled(), /not a pull request's or an issue's/],
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
        AGENT_REVIEW_TIMEOUT_MINUTES: "",
        AGENT_TIMEOUT_MINUTES: "",
        AGENT_MAX_FIX_ROUNDS: "2",
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
    const routed = [...Object.entries(LABEL_KINDS.pull_request), ...Object.entries(LABEL_KINDS.issues)];
    expect(SERVICE_LABELS).toEqual(routed.map(([label]) => label));
    for (const [, kind] of routed) expect(JOB_KINDS).toContain(kind);
    expect(new Set(SERVICE_LABELS).size).toBe(SERVICE_LABELS.length);
  });

  it("answers agent:implement on an issue's event, and every other label on a pull request's", () => {
    expect(LABEL_KINDS.issues).toEqual({ [IMPLEMENT_LABEL]: "implement" });
    expect(Object.keys(LABEL_KINDS.pull_request)).toEqual([REVIEW_LABEL, FIX_LABEL, UPDATE_BRANCH_LABEL]);
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
  it.each(["read", "write", "push"] as const)("mints a %s token for a dispatched job, for its repository, with that kind's permissions", async (kind) => {
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

/** The job an `issues` delivery posted to the worker. */
const dispatchedIssue = async (s: ReturnType<typeof setup>, payload: unknown = issueLabelled()): Promise<Job> => {
  const result = await deliver(s, payload, undefined, "issues");
  const post = s.posted.at(-1);
  if (post === undefined) throw new Error(`nothing was posted to the worker: ${result.outcome}`);
  const job = parseJob(JSON.parse(post.body));
  if (typeof job === "string") throw new Error(job);
  return job;
};

/**
 * An issue's route (#517): an `issues` delivery adding `agent:implement` to
 * an open, regular issue becomes an implement job, after the same checks a
 * pull request's delivery passes, in the same order, and with no head to
 * check.
 */
describe("the issue route", () => {
  it("dispatches one implement job for agent:implement on an open issue, from a person who can write and from the App's own login alike", async () => {
    for (const sender of ["maintainer", "loop-app[bot]"]) {
      const s = setup();
      s.repository.variables["AGENT_MODEL_IMPLEMENT"] = "a-build-model";
      const result = await deliver(s, issueLabelled({ sender }), undefined, "issues");

      expect(result.status, sender).toBe(202);
      expect(result.outcome, sender).toMatch(/^dispatched owner\/repo#12 as job job-1, deadline /);
      expect(s.posted, sender).toHaveLength(1);
      const job = parseJob(JSON.parse(s.posted[0]!.body));
      expect(job, sender).toEqual({
        workflow: "implement",
        id: "job-1",
        version: "9.9.9",
        deadline: new Date(START.getTime() + (DEFAULT_FIX_MINUTES + MARGIN) * MINUTE_MS).toISOString(),
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
          AGENT_REVIEW_TIMEOUT_MINUTES: "",
          AGENT_TIMEOUT_MINUTES: "",
          AGENT_MAX_FIX_ROUNDS: "2",
          AGENT_SETUP: "",
        },
      });
      expect(s.looked, sender).toEqual(sender === "maintainer" ? ["maintainer"] : []);
    }
  });

  it("takes the base from the repository's default branch, as the event carries it", async () => {
    const job = await dispatchedIssue(setup(), issueLabelled({ defaultBranch: "trunk" }));

    expect(job).toMatchObject({ workflow: "implement", baseRef: "trunk" });
  });

  it("sets an implement job's deadline from the agent's time limit, AGENT_TIMEOUT_MINUTES", async () => {
    const s = setup();
    s.repository.variables["AGENT_TIMEOUT_MINUTES"] = "45";
    const job = await dispatchedIssue(s);

    expect(job.deadline).toBe(new Date(START.getTime() + (45 + MARGIN) * MINUTE_MS).toISOString());
  });

  it.each<[string, (s: ReturnType<typeof setup>) => unknown, string]>([
    ["a label not answered on an issue", () => issueLabelled({ label: REVIEW_LABEL }), "ignored on owner/repo#12: `agent:review` is not a label this release's service answers on an issue"],
    ["an inherited property's name", () => issueLabelled({ label: "constructor" }), "ignored on owner/repo#12: `constructor` is not a label this release's service answers on an issue"],
    ["a closed issue", () => issueLabelled({ state: "closed" }), "refused on owner/repo#12: the issue is closed, not open"],
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

  it("mints for an implement job it dispatched, for that repository alone", async () => {
    const s = setup();
    const job = await dispatchedIssue(s);
    const response = await s.dispatcher.token(tokenRequest({ jobId: job.id, kind: "push" }));

    expect(response.status).toBe(200);
    expect(s.minted).toEqual([{ repo: REPO, permissions: TOKEN_PERMISSIONS.push }]);
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
    expect(s.posted.map(({ body }) => (JSON.parse(body) as { workflow: string }).workflow)).toEqual(["implement", "review"]);
    expect(s.looked).toEqual(["maintainer"]);
  });
});
