import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMENT_PERMISSIONS, LABEL_PERMISSIONS, SCAN_PERMISSIONS, TOKEN_PERMISSIONS } from "../../service/dispatcher.js";
import { liveAppGitHub } from "../../service/github-app.js";

/**
 * The live GitHub's variable read, over a stand-in `fetch` answering in the
 * shapes GitHub's REST API documents. A variable resolves as `vars` resolves
 * it on Actions, and as `doctor`'s `gatherFacts` reads it: the repository's
 * own, else an organization variable shared with the repository.
 */

const REPO = "owner/repo";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

interface World {
  repository: Record<string, string>;
  /** The organization's variables shared with the repository, or `undefined` on a user-owned one. */
  organization: Record<string, string> | undefined;
  /** A path answered with this status instead, as an outage or a refusal is. */
  failing?: { path: RegExp; status: number };
  /** The App's own record, where it is not the loop's App's. */
  app?: unknown;
  /** The repository's issues and pull requests as the issues list gives them, each with its labels' names. */
  issues: { number: number; title: string; state: string; labels: string[]; pull?: boolean }[];
  /** Each pull request's own record, by number. */
  pulls: Record<number, unknown>;
  /** Each item's events, oldest first, by number. */
  events: Record<number, unknown[]>;
  /** Each item's comments, oldest first, by number, as the comments list gives them. */
  comments?: Record<number, unknown[]>;
  /** The App's recent webhook deliveries, as GitHub's list of them gives them (#774). */
  deliveries?: unknown[];
  /** The repository's labels, as its labels list gives them (#823). */
  labels?: unknown[];
}

/**
 * The permissions an installation holds, by the names GitHub gives them: the
 * loop's App's, as GitHub reported them in an `installation` webhook on
 * 2026-10-12. GitHub refuses a token asking for any other, `422`, as it
 * refused the dispatcher's first live mint, which asked for `variables`.
 * `actions` was added for #632, by the name GitHub's REST reference gives
 * Actions in an installation token's permissions.
 */
const GRANTED: Readonly<Record<string, string>> = {
  actions: "read",
  actions_variables: "read",
  checks: "read",
  contents: "write",
  issues: "write",
  metadata: "read",
  pull_requests: "write",
  statuses: "write",
  workflows: "write",
};

const LEVEL: Readonly<Record<string, number>> = { read: 1, write: 2 };

let world: World;
const asked: string[] = [];
/** The permissions each token was asked for, in order. */
const minted: Record<string, string>[] = [];
/** The repositories each token was asked for, in order: `undefined` for the whole installation. */
const mintedFor: (string[] | undefined)[] = [];
/** Each request's path and query. */
const queried: string[] = [];
/** Each comment posted: its path, its body and the token it was posted with. */
const commented: { path: string; body: unknown; authorization: string | null }[] = [];
/** Each label write (#823): its method, path, body and the token it was made with. */
const labelWrites: { method: string; path: string; body: unknown; authorization: string | null }[] = [];
/** Each request to the App's webhook deliveries (#774): its method and the authorization it carried. */
const hooked: { method: string; authorization: string | null }[] = [];

const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

const mintAnswer = (body: string | undefined): Response => {
  const parsed = JSON.parse(body ?? "{}") as { permissions?: Record<string, string>; repositories?: string[] };
  const permissions = parsed.permissions ?? {};
  minted.push(permissions);
  mintedFor.push(parsed.repositories);
  const refused = Object.entries(permissions).some(
    ([name, level]) => GRANTED[name] === undefined || (LEVEL[level] ?? 3) > (LEVEL[GRANTED[name]] ?? 0),
  );
  return refused
    ? reply(422, { message: "The permissions requested are not granted to this installation." })
    : reply(201, { token: "ghs_reader", expires_at: "2099-01-01T00:00:00Z" });
};

const answer = (url: string, init?: RequestInit): Response => {
  const { pathname, searchParams } = new URL(url);
  asked.push(pathname);
  queried.push(`${pathname}${searchParams.size === 0 ? "" : `?${searchParams.toString()}`}`);
  const size = Number(searchParams.get("per_page"));
  const page = Number(searchParams.get("page"));
  const paged = <T>(all: readonly T[]): T[] => all.slice((page - 1) * size, page * size);
  if (world.failing?.path.test(pathname)) return reply(world.failing.status, { message: "no" });
  if (pathname === `/repos/${REPO}/installation`) return reply(200, { id: 1, account: { login: "owner", type: "User" } });
  if (pathname === "/app") return reply(200, world.app ?? { id: 1, slug: "loop-app", owner: { login: "Owner", type: "User" }, permissions: GRANTED, events: ["issues", "pull_request"] });
  if (pathname === "/app/installations/1/access_tokens") return mintAnswer(typeof init?.body === "string" ? init.body : undefined);
  if (pathname === `/repos/${REPO}`) return reply(200, { default_branch: "trunk", owner: { type: world.organization === undefined ? "User" : "Organization" } });
  if (pathname === "/app/installations") return reply(200, paged([{ id: 1, account: { login: "owner" } }, { id: 2, account: { login: "elsewhere" } }]));
  if (pathname === "/installation/repositories") {
    const all = Array.from({ length: 101 }, (_, i) => ({ full_name: i === 0 ? REPO : `owner/repo-${i}` }));
    return reply(200, { total_count: all.length, repositories: paged(all) });
  }
  if (pathname === `/repos/${REPO}/issues`) {
    const label = searchParams.get("labels") ?? "";
    const listed = world.issues
      .filter((issue) => issue.labels.includes(label) && (searchParams.get("state") ?? "open") === issue.state)
      .map(({ labels, pull, ...issue }) => ({ ...issue, labels: labels.map((name) => ({ name })), ...(pull === true ? { pull_request: { url: "…" } } : {}) }));
    return reply(200, paged(listed));
  }
  if (pathname === `/repos/${REPO}/labels` && init?.method === "POST") {
    labelWrites.push({ method: "POST", path: pathname, body: JSON.parse(typeof init.body === "string" ? init.body : "{}"), authorization: new Headers(init.headers).get("authorization") });
    return reply(201, {});
  }
  if (pathname.startsWith(`/repos/${REPO}/labels/`) && init?.method === "PATCH") {
    labelWrites.push({ method: "PATCH", path: pathname, body: JSON.parse(typeof init.body === "string" ? init.body : "{}"), authorization: new Headers(init.headers).get("authorization") });
    return reply(200, {});
  }
  if (pathname === `/repos/${REPO}/labels`) return reply(200, paged(world.labels ?? []));
  const pull = /^\/repos\/owner\/repo\/pulls\/(\d+)$/.exec(pathname);
  if (pull !== null) {
    const record = world.pulls[Number(pull[1])];
    return record === undefined ? reply(404, { message: "Not Found" }) : reply(200, record);
  }
  if (/^\/repos\/owner\/repo\/issues\/\d+\/comments$/.test(pathname) && init?.method === "POST") {
    commented.push({ path: pathname, body: JSON.parse(typeof init.body === "string" ? init.body : "{}"), authorization: new Headers(init.headers).get("authorization") });
    return reply(201, { id: 1 });
  }
  const conversation = /^\/repos\/owner\/repo\/issues\/(\d+)\/comments$/.exec(pathname);
  if (conversation !== null) return reply(200, paged(world.comments?.[Number(conversation[1])] ?? []));
  const events = /^\/repos\/owner\/repo\/issues\/(\d+)\/events$/.exec(pathname);
  if (events !== null) return reply(200, paged(world.events[Number(events[1])] ?? []));
  const labels = /^\/repos\/owner\/repo\/issues\/(\d+)\/labels$/.exec(pathname);
  if (labels !== null) return reply(200, paged((world.issues.find((issue) => issue.number === Number(labels[1]))?.labels ?? []).map((name) => ({ name }))));
  if (pathname === "/app/hook/deliveries") {
    hooked.push({ method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") });
    return reply(200, world.deliveries ?? []);
  }
  if (/^\/app\/hook\/deliveries\/\d+\/attempts$/.test(pathname)) {
    hooked.push({ method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") });
    return reply(202, {});
  }
  const own = /^\/repos\/owner\/repo\/actions\/variables\/(.+)$/.exec(pathname);
  if (own !== null) {
    const value = world.repository[own[1] ?? ""];
    return value === undefined ? reply(404, { message: "Not Found" }) : reply(200, { name: own[1], value });
  }
  if (pathname === `/repos/${REPO}/actions/organization-variables`) {
    const all = Object.entries(world.organization ?? {}).map(([name, value]) => ({ name, value, visibility: "all" }));
    return reply(200, { total_count: all.length, variables: all.slice((page - 1) * size, page * size) });
  }
  return reply(404, { message: "Not Found" });
};

beforeEach(() => {
  world = { repository: {}, organization: {}, issues: [], pulls: {}, events: {} };
  asked.length = 0;
  minted.length = 0;
  mintedFor.length = 0;
  queried.length = 0;
  commented.length = 0;
  labelWrites.length = 0;
  hooked.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => answer(url, init));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("liveAppGitHub: a variable, as `vars` resolves it", () => {
  const read = (name: string) => liveAppGitHub("1", KEY).variable(REPO, name);

  it("reads the repository's own, over an organization one of the same name", async () => {
    world.repository = { AGENT_ORCHESTRATOR: "service" };
    world.organization = { AGENT_ORCHESTRATOR: "other" };

    expect(await read("AGENT_ORCHESTRATOR")).toBe("service");
    expect(asked).not.toContain(`/repos/${REPO}/actions/organization-variables`);
  });

  it.each(["AGENT_ORCHESTRATOR", "AGENT_MODEL", "AGENT_MODEL_REVIEW", "AGENT_REVIEW_TIMEOUT_MINUTES", "AGENT_MAX_FIX_ROUNDS", "AGENT_FIX_MIN_SEVERITY"])(
    "falls back to an organization variable shared with the repository: %s",
    async (name) => {
      world.organization = { [name]: "from-the-organization" };

      expect(await read(name)).toBe("from-the-organization");
    },
  );

  it("finds an organization variable past the first page", async () => {
    world.organization = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`OTHER_${i}`, "x"]));
    world.organization["AGENT_ORCHESTRATOR"] = "service";

    expect(await read("AGENT_ORCHESTRATOR")).toBe("service");
  });

  it("is unset where neither has it", async () => {
    world.organization = { OTHER: "x" };

    expect(await read("AGENT_ORCHESTRATOR")).toBeUndefined();
  });

  it("is unset on a repository no organization owns, without asking for organization variables", async () => {
    world.organization = undefined;

    expect(await read("AGENT_ORCHESTRATOR")).toBeUndefined();
    expect(asked).not.toContain(`/repos/${REPO}/actions/organization-variables`);
  });

  it.each([
    ["the repository's variable", /\/actions\/variables\//, 403],
    ["the repository's owner", /^\/repos\/owner\/repo$/, 502],
    ["the organization's variables", /organization-variables/, 403],
  ])("throws, rather than reading unset, where %s could not be read", async (_, path, status) => {
    world.failing = { path, status };

    await expect(read("AGENT_ORCHESTRATOR")).rejects.toThrow(new RegExp(`answered ${status}`));
  });
});

describe("liveAppGitHub: the App and its installation, as GitHub records them", () => {
  it("reads the App's slug, its owner's login, its permissions and its events off the App's own record, in one request", async () => {
    expect(await liveAppGitHub("1", KEY).app()).toEqual({ slug: "loop-app", owner: "Owner", permissions: GRANTED, events: ["issues", "pull_request"] });
    expect(asked).toEqual(["/app"]);
  });

  // #560: a record GitHub sends without them grants nothing, so every need is a gap rather than a pass.
  it("reads a record without permissions or events as granting none and subscribing to none", async () => {
    world.app = { id: 1, slug: "loop-app", owner: { login: "Owner", type: "User" } };

    expect(await liveAppGitHub("1", KEY).app()).toEqual({ slug: "loop-app", owner: "Owner", permissions: {}, events: [] });
  });

  it("reads the account the App's installation on a repository is on", async () => {
    expect(await liveAppGitHub("1", KEY).installation(REPO)).toBe("owner");
  });

  it("is no installation where the App is not installed", async () => {
    world.failing = { path: /\/installation$/, status: 404 };

    expect(await liveAppGitHub("1", KEY).installation(REPO)).toBeUndefined();
  });

  it("throws where the App's own record could not be read", async () => {
    world.failing = { path: /^\/app$/, status: 401 };

    await expect(liveAppGitHub("1", KEY).app()).rejects.toThrow(/answered 401/);
  });
});

describe("liveAppGitHub: the tokens it mints, by the names GitHub gives permissions", () => {
  it("reads a variable with a token asking for metadata, the repository's variables and its pull requests alone", async () => {
    world.repository = { AGENT_ORCHESTRATOR: "service" };

    expect(await liveAppGitHub("1", KEY).variable(REPO, "AGENT_ORCHESTRATOR")).toBe("service");
    expect(minted).toEqual([{ metadata: "read", actions_variables: "read", pull_requests: "read" }]);
  });

  it.each(Object.entries(TOKEN_PERMISSIONS))("mints a worker's `%s` token", async (_, permissions) => {
    await expect(liveAppGitHub("1", KEY).mint(REPO, permissions)).resolves.toMatchObject({ token: "ghs_reader" });
  });
});

/** A pull request's own record, as GitHub answers it. */
const PULL = {
  number: 7,
  state: "open",
  merged: false,
  head: { ref: "agent/issue-7-a-thing", sha: "a".repeat(40), repo: { full_name: REPO } },
  base: { ref: "main" },
};

/** A `labeled` event, as the issue events API lists it. */
const labeledBy = (login: string | null, label: string, event = "labeled") => ({ event, actor: login === null ? null : { login }, label: { name: label } });

describe("liveAppGitHub: what the scan reads (#581)", () => {
  it("lists the App's installations, then an installation's repositories past the first page, with a token for the whole installation reading metadata alone", async () => {
    const github = liveAppGitHub("1", KEY);

    expect(await github.installations()).toEqual(["owner", "elsewhere"]);
    const repositories = await github.repositories("Owner");

    expect(repositories).toHaveLength(101);
    expect(repositories[0]).toBe(REPO);
    expect(minted).toEqual([{ metadata: "read" }]);
    expect(mintedFor).toEqual([undefined]);
  });

  it("refuses to list the repositories of an installation it has not listed", async () => {
    await expect(liveAppGitHub("1", KEY).repositories("owner")).rejects.toThrow(/no installation on owner was listed/);
  });

  it("lists the open issues and pull requests carrying a label, a pull request as its own record reads it, with a token reading issues and pull requests besides", async () => {
    world.issues = [
      { number: 12, title: "Add a thing", state: "open", labels: ["agent:review"] },
      { number: 7, title: "A thing", state: "open", labels: ["agent:review"], pull: true },
      { number: 8, title: "Another", state: "open", labels: ["agent:fix"], pull: true },
      { number: 9, title: "Closed", state: "closed", labels: ["agent:review"] },
    ];
    world.pulls = { 7: PULL };

    expect(await liveAppGitHub("1", KEY).labelled(REPO, "agent:review")).toEqual([
      { type: "issues", number: 12, title: "Add a thing", state: "open" },
      { type: "pull_request", number: 7, state: "open", merged: false, draft: false, branch: PULL.head.ref, headSha: PULL.head.sha, headRepo: REPO, baseRef: "main" },
    ]);
    expect(queried).toContain(`/repos/${REPO}/issues?state=open&labels=agent%3Areview&per_page=100&page=1`);
    expect(minted).toEqual([SCAN_PERMISSIONS]);
    expect(mintedFor).toEqual([["repo"]]);
  });

  it("lists the merged pull requests carrying a label from `since` on, each as its own record reads it, and no other closed item (#603)", async () => {
    world.issues = [
      { number: 7, title: "Merged inside", state: "closed", labels: ["agent:follow-ups"], pull: true },
      { number: 8, title: "Merged before", state: "closed", labels: ["agent:follow-ups"], pull: true },
      { number: 9, title: "Closed unmerged", state: "closed", labels: ["agent:follow-ups"], pull: true },
      { number: 10, title: "Open", state: "open", labels: ["agent:follow-ups"], pull: true },
      { number: 11, title: "An issue", state: "closed", labels: ["agent:follow-ups"] },
    ];
    const merged = { ...PULL, state: "closed", merged: true };
    world.pulls = {
      7: { ...merged, number: 7, merged_at: "2026-10-30T09:00:00Z" },
      8: { ...merged, number: 8, merged_at: "2026-10-20T09:00:00Z" },
      9: { ...PULL, number: 9, state: "closed", merged_at: null },
      10: { ...PULL, number: 10 },
    };
    const since = new Date("2026-10-26T00:00:00Z");

    expect(await liveAppGitHub("1", KEY).mergedLabelled(REPO, "agent:follow-ups", since)).toEqual([
      {
        type: "pull_request",
        number: 7,
        state: "closed",
        merged: true,
        draft: false,
        branch: PULL.head.ref,
        headSha: PULL.head.sha,
        headRepo: REPO,
        baseRef: "main",
        mergedAt: new Date("2026-10-30T09:00:00Z"),
      },
    ]);
    expect(queried).toContain(`/repos/${REPO}/issues?state=closed&labels=agent%3Afollow-ups&since=2026-10-26T00%3A00%3A00.000Z&per_page=100&page=1`);
    expect(minted).toEqual([SCAN_PERMISSIONS]);
  });

  it("throws, rather than listing fewer, where a merged pull request's own record could not be read", async () => {
    world.issues = [{ number: 7, title: "A thing", state: "closed", labels: ["agent:follow-ups"], pull: true }];

    await expect(liveAppGitHub("1", KEY).mergedLabelled(REPO, "agent:follow-ups", new Date(0))).rejects.toThrow(/owner\/repo#7 answered 404/);
  });

  it("reads a pull request whose head repository was deleted as having none", async () => {
    world.issues = [{ number: 7, title: "A thing", state: "open", labels: ["agent:review"], pull: true }];
    world.pulls = { 7: { ...PULL, head: { ...PULL.head, repo: null } } };

    expect(await liveAppGitHub("1", KEY).labelled(REPO, "agent:review")).toMatchObject([{ number: 7, headRepo: undefined }]);
  });

  it("lists past the first page", async () => {
    world.issues = Array.from({ length: 150 }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}`, state: "open", labels: ["agent:implement"] }));

    expect(await liveAppGitHub("1", KEY).labelled(REPO, "agent:implement")).toHaveLength(150);
  });

  it("throws, rather than listing fewer, where a pull request's own record could not be read", async () => {
    world.issues = [{ number: 7, title: "A thing", state: "open", labels: ["agent:review"], pull: true }];

    await expect(liveAppGitHub("1", KEY).labelled(REPO, "agent:review")).rejects.toThrow(/owner\/repo#7 answered 404/);
  });

  it("names the actor of the latest `labeled` event for the label, past the first page, and no other event's", async () => {
    world.events = {
      7: [
        labeledBy("first", "agent:review"),
        ...Array.from({ length: 120 }, () => labeledBy("someone", "agent:fix")),
        labeledBy("latest", "agent:review"),
        labeledBy("remover", "agent:review", "unlabeled"),
        labeledBy("other", "agent:fix"),
      ],
    };

    expect(await liveAppGitHub("1", KEY).labeller(REPO, 7, "agent:review")).toBe("latest");
  });

  it("names no one where no `labeled` event for the label is found, or its actor is gone", async () => {
    world.events = { 7: [labeledBy("other", "agent:fix")], 8: [labeledBy("first", "agent:review"), labeledBy(null, "agent:review")] };
    const github = liveAppGitHub("1", KEY);

    expect(await github.labeller(REPO, 7, "agent:review")).toBeUndefined();
    expect(await github.labeller(REPO, 8, "agent:review")).toBeUndefined();
  });

  // #635: where the scan reads the newest resume note.
  it("reads every comment on an item, oldest first, past the first page, each with who posted it", async () => {
    world.comments = {
      7: [
        ...Array.from({ length: 120 }, (_, i) => ({ body: `comment ${i}`, user: { login: "someone" } })),
        { body: "the newest", user: { login: "loop-app[bot]" } },
        { body: "a deleted account's", user: null },
      ],
    };

    const comments = await liveAppGitHub("1", KEY).comments(REPO, 7);

    expect(comments).toHaveLength(122);
    expect(comments.slice(-2)).toEqual([
      { body: "the newest", author: "loop-app[bot]" },
      { body: "a deleted account's", author: "" },
    ]);
  });

  it("reads the repository's default branch", async () => {
    expect(await liveAppGitHub("1", KEY).defaultBranch(REPO)).toBe("trunk");
  });

  // #596: the comment a scan leaves on an item it stops dispatching.
  it("posts a comment on an issue or pull request with the token it is handed, one the installation can mint", async () => {
    const github = liveAppGitHub("1", KEY);
    const { token } = await github.mint(REPO, COMMENT_PERMISSIONS);

    await github.comment(REPO, 7, "a comment", token);

    expect(commented).toEqual([{ path: `/repos/${REPO}/issues/7/comments`, body: { body: "a comment" }, authorization: `Bearer ${token}` }]);
  });

  it("throws where the comment is refused", async () => {
    world.failing = { path: /\/comments$/, status: 403 };

    await expect(liveAppGitHub("1", KEY).comment(REPO, 7, "a comment", "ghs_writer")).rejects.toThrow("commenting on owner/repo#7 answered 403");
  });
});

describe("liveAppGitHub: a repository's labels (#823)", () => {
  it("lists every label past the first page, with the scan's reader, read into a name, a colour and a description", async () => {
    world.labels = [
      { id: 1, name: "agent:review", color: "0969da", description: "Review this PR." },
      { id: 2, name: "bare", color: "ffffff", description: null },
      ...Array.from({ length: 120 }, (_, i) => ({ id: i + 3, name: `other-${i}`, color: "000000", description: "" })),
    ];

    const labels = await liveAppGitHub("1", KEY).repoLabels(REPO);

    expect(labels).toHaveLength(122);
    expect(labels.slice(0, 2)).toEqual([
      { name: "agent:review", color: "0969da", description: "Review this PR." },
      { name: "bare", color: "ffffff", description: "" },
    ]);
    expect(minted).toEqual([SCAN_PERMISSIONS]);
  });

  it("creates a label and edits one, with the token it is handed, one the installation can mint", async () => {
    const github = liveAppGitHub("1", KEY);
    const { token } = await github.mint(REPO, LABEL_PERMISSIONS);
    const label = { name: "agent:update-branch", color: "1B7C83", description: "Merge the base branch into this PR." };

    await github.createLabel(REPO, label, token);
    await github.editLabel(REPO, label, token);

    expect(labelWrites).toEqual([
      { method: "POST", path: `/repos/${REPO}/labels`, body: label, authorization: `Bearer ${token}` },
      { method: "PATCH", path: `/repos/${REPO}/labels/agent%3Aupdate-branch`, body: { color: label.color, description: label.description }, authorization: `Bearer ${token}` },
    ]);
  });

  it("throws where a label write is refused, naming the label and the repository", async () => {
    world.failing = { path: /\/labels/, status: 403 };
    const github = liveAppGitHub("1", KEY);
    const label = { name: "agent:blocked", color: "CF222E", description: "x" };

    await expect(github.createLabel(REPO, label, "ghs_writer")).rejects.toThrow("creating the label `agent:blocked` on owner/repo answered 403");
    await expect(github.editLabel(REPO, label, "ghs_writer")).rejects.toThrow("editing the label `agent:blocked` on owner/repo answered 403");
  });
});

describe("liveAppGitHub: the App's webhook deliveries (#774)", () => {
  it("lists one page of the newest deliveries, with the App's JWT, read into what the poll compares", async () => {
    world.deliveries = [
      {
        id: 12,
        guid: "0b989ba4-242f-11e5-81e1-c7b6966d2516",
        delivered_at: "2026-11-05T00:29:33Z",
        redelivery: false,
        duration: 10.01,
        status: "timed out",
        status_code: 0,
        event: "issues",
        action: "labeled",
        installation_id: 1,
        repository_id: 2,
      },
      { id: 11, guid: "g-2", delivered_at: "2026-11-05T00:20:00Z", redelivery: true, status: "OK", status_code: 202, event: "ping", action: null },
      { id: "not a number", guid: "g-3", delivered_at: "2026-11-05T00:10:00Z", event: "issues" },
    ];

    expect(await liveAppGitHub("1", KEY).deliveries()).toEqual([
      {
        id: 12,
        guid: "0b989ba4-242f-11e5-81e1-c7b6966d2516",
        deliveredAt: new Date("2026-11-05T00:29:33Z"),
        redelivery: false,
        statusCode: 0,
        event: "issues",
        action: "labeled",
      },
      { id: 11, guid: "g-2", deliveredAt: new Date("2026-11-05T00:20:00Z"), redelivery: true, statusCode: 202, event: "ping", action: undefined },
    ]);
    expect(queried).toEqual(["/app/hook/deliveries?per_page=100"]);
    expect(hooked).toEqual([{ method: "GET", authorization: expect.stringMatching(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/) }]);
    expect(minted).toEqual([]);
  });

  it("throws where the list is refused", async () => {
    world.failing = { path: /^\/app\/hook\/deliveries$/, status: 401 };

    await expect(liveAppGitHub("1", KEY).deliveries()).rejects.toThrow("reading the App's webhook deliveries answered 401");
  });

  it("asks for a redelivery by the delivery's id, with the App's JWT and no installation token", async () => {
    await liveAppGitHub("1", KEY).redeliver(12);

    expect(asked).toEqual(["/app/hook/deliveries/12/attempts"]);
    expect(hooked).toEqual([{ method: "POST", authorization: expect.stringMatching(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/) }]);
    expect(minted).toEqual([]);
  });

  it("throws where the redelivery is refused", async () => {
    world.failing = { path: /attempts$/, status: 422 };

    await expect(liveAppGitHub("1", KEY).redeliver(12)).rejects.toThrow("redelivering delivery 12 answered 422");
  });

  it("reads an item's labels now, with the scan's reader", async () => {
    world.issues = [{ number: 7, title: "a thing", state: "open", labels: ["agent:review", "bug"] }];

    expect(await liveAppGitHub("1", KEY).labels(REPO, 7)).toEqual(["agent:review", "bug"]);
    expect(minted).toEqual([SCAN_PERMISSIONS]);
  });
});
