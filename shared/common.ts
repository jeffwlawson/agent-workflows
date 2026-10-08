import { execFileSync, execSync, spawnSync } from "node:child_process";
import type { StandardSchemaV1 } from "@standard-schema/spec";

export {
  commonWriters,
  fail,
  input,
  outputDir,
  readInputs,
  scrubGitHubTokens,
  writers,
  type InputValues,
} from "./env.js";

/**
 * Run a **literal** command through a shell, throwing on a non-zero exit. The
 * rule is *variables go through argv*, not *never use `sh`*: anything
 * holding a value goes to `git()`, and anything reaching a GitHub surface to
 * `gh()` or `safeGh()`, neither of which spawns a shell. Three `gh` calls were
 * once built as text for this, and the only thing keeping a crafted issue
 * reference out of `/bin/sh` was a regex three files away (#2, #10). A test
 * walks the runner surface for that shape, so a fourth is caught on arrival.
 */
export const sh = (cmd: string): string =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * Where `gh` should think it is. `gh` resolves `{owner}/{repo}` and every
 * repo-scoped subcommand from the git remote of its working directory, so a
 * command asked about *another* checkout — which is what `doctor --dir` is —
 * answers about this one unless it is told otherwise, and answers confidently.
 */
export interface GhOptions {
  readonly cwd?: string | undefined;
  /** The whole environment `gh` runs with, where it must not be this process's. */
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/** Run `gh` with argv (no shell), so arguments with spaces/quotes are safe. */
export const gh = (args: string[], options: GhOptions = {}): string =>
  execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });

/**
 * `gh` with argv, returning "" instead of throwing when it exits non-zero.
 *
 * Both halves are load-bearing. The argv half is the same rule as `gh` and
 * `git`: a variable reaching a subprocess must arrive as one argument, not as
 * text a shell re-parses. The swallowing half is what `fetchTrustedIssue` and
 * `fetchTrustedComments` need — for them a missing issue is an ordinary outcome
 * absorbed by `|| "{}"` / `|| "[]"`, so `gh()`'s throw would turn an absence
 * into an exception mid-run. That mismatch is why this is a wrapper rather than
 * a call-site swap (issue #2).
 */
export const safeGh = (args: readonly string[], options: GhOptions = {}): string => {
  try {
    return gh([...args], options);
  } catch {
    return "";
  }
};

/** What `gh` did, when the caller has to rule on the answer rather than on the exit code. */
export interface GhOutcome {
  /**
   * True when `gh` ran and exited zero. A kill by signal is not a zero exit,
   * and neither is a binary that never started.
   */
  readonly ok: boolean;
  /** What `gh` printed to stdout — present on a non-zero exit too, and often the whole answer. */
  readonly stdout: string;
  /**
   * What `gh` printed to stderr, which is where it explains a refusal in words.
   * Carried on **every** path, the zero-exit one included: `gh` warns there
   * while exiting zero, and a caller ruling on the answer rather than on the
   * exit code is exactly the one those words are for (#90).
   */
  readonly stderr: string;
  /**
   * Node's own diagnosis when the run failed around `gh` rather than in it —
   * `spawnSync gh ENOENT` for a binary that never started, `spawnSync gh
   * ENOBUFS` for output cut off at the buffer. Absent whenever `spawnSync`
   * reported no error, which is every exit and every kill by signal.
   *
   * Beside `stderr` rather than folded into it, because `stderr` is what `gh`
   * printed and nothing else (#90); these are words `gh` never said. Read for
   * `ok` and then dropped, a missing binary spoke as "no output at all" and an
   * overrun buffer as its own severed JSON (#131).
   */
  readonly spawnError?: string;
}

/**
 * `spawnSync` hands back whatever the stdio encoding produced, and `null` on
 * both streams when the binary never ran at all; normalise it to text.
 */
const capturedText = (value: unknown): string =>
  typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";

/**
 * `gh` with argv, returning its **output** on a non-zero exit rather than
 * throwing it away.
 *
 * The third wrapper, and the reason it is not one of the other two: GraphQL
 * answers partially. A query whose selections are mostly fine and one of which
 * is forbidden returns `200` with valid `data` *and* an `errors[]` array, and
 * `gh` exits non-zero on that response while printing the good data to stdout
 * (#76). `gh()` throws it away because `execFileSync` throws; `safeGh()`
 * swallows it into `""`, which its two callers want — for them a missing issue
 * is an ordinary absence — and which here is the same information loss by a
 * politer route.
 *
 * So this is for the caller that must *inspect* what came back: a response is
 * the evidence, the exit code is not. Deliberately not a widening of `safeGh`,
 * whose swallowing is load-bearing where it is used.
 *
 * And spawned here rather than run through `gh()`, which is what makes `stderr`
 * true on both paths. `execFileSync` returns stdout and puts stderr only on the
 * object it throws, so built on it this wrapper reported `stderr: ""` on every
 * zero exit while its own interface said stderr is where a refusal is explained
 * — and `gh` exits zero with words on stderr, beside an answer that may still
 * be unusable (#90). `spawnSync` reports instead of throwing: both streams
 * captured, the exit status beside them, which is the shape this returns
 * anyway. `gh()` and `safeGh()` keep `execFileSync` — their contract is a
 * stdout string and a throw, and every caller of those two reads it that way.
 *
 * `ok` is therefore a judgement made here rather than one the call stack made
 * by throwing. Both ways a run ends without an exit code — killed by a signal,
 * or a binary that never started — leave `status` null, and neither is success.
 */
export const ghOutcome = (args: readonly string[], options: GhOptions = {}): GhOutcome => {
  const result = spawnSync("gh", [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  return {
    ok: result.error === undefined && result.status === 0,
    stdout: capturedText(result.stdout),
    stderr: capturedText(result.stderr),
    ...(result.error === undefined ? {} : { spawnError: result.error.message }),
  };
};

/**
 * Run `git` with argv (no shell) — the same decision as `gh`, for the same
 * reason. Use this whenever a **variable** reaches git: `execFileSync` passes
 * each element as one argument and never spawns `/bin/sh`, so a value cannot be
 * re-parsed as syntax. Git ref names may legally contain `` ` ``, `$()`, `;`,
 * `|` and `&` (`git check-ref-format --branch` permits all five), so "it's only
 * a branch name" is not a reason to skip it.
 *
 * Literal `sh("git ...")` calls elsewhere are fine and deliberately left alone:
 * the rule is *variables go through argv*, not *never use `sh`*.
 *
 * `maxBuffer` is `execFileSync`'s, 1 MiB where it is not given. Past it the
 * read throws `ENOBUFS` rather than returning part of the output.
 */
export const git = (args: readonly string[], options: { readonly maxBuffer?: number } = {}): string =>
  execFileSync("git", [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
  });

/**
 * What the association half of the gate establishes is **org-adjacent or
 * better**, which is not the same thing as repository write access. Only
 * `OWNER` is write-gated by its own definition; GraphQL describes the other
 * two as "Author has been invited to collaborate on the repository"
 * (`COLLABORATOR` — which includes the Read and Triage roles, neither of which
 * can push) and "Author is a member of the organization that owns the
 * repository" (`MEMBER` — org membership, implying no repository grant at
 * all). Introspected from `CommentAuthorAssociation` on 2026-09-20; evidence
 * and method in #35.
 *
 * The two readings coincide on a personal repository — a collaborator there
 * has write, and `MEMBER` cannot occur without an owning org — and come apart
 * on an organization one. So this set is write-gated *here* and not in
 * general, which is the wrong way round: the adopter is the one exposed.
 *
 * The belief that association implied write access was adopted locally from a
 * community pattern, not from GitHub, which describes the field only as "How
 * the author is associated with the repository" and publishes the
 * OWNER/MEMBER/COLLABORATOR triple nowhere (#71).
 *
 * Whether the set itself should narrow is the open decision at #68. Until it
 * is taken, every description of this gate says what it establishes rather
 * than what it was believed to.
 */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Our own workflows post as `github-actions[bot]`, and its
 * `author_association` is never one this gate trusts — the value is
 * repository-dependent, `NONE` where the bot has never committed and
 * `CONTRIBUTOR` where it has (nodejs/node#66163 and nodejs/node#65881, checked
 * 2026-09-20, #71), and neither is in the set above. So an association-only
 * gate would discard the review agent's own findings and break the review
 * → fix handoff, on this repository and on an adopter's alike.
 *
 * Trusting this one login is sound because the identity is *transitively
 * write-gated*: only a workflow in this repository can post as it, and adding
 * or editing a workflow requires write access. That is a property of the
 * login. The association half above establishes rather less (#68), so this is
 * the stronger of the two halves rather than a convenience on top of it.
 *
 * Deliberately NOT `user.type === "Bot"` in general — that would also trust
 * Dependabot and any GitHub App an admin installs, which is a far wider
 * surface for a workflow that commits code.
 */
// Both spellings on purpose: the REST API reports this account as
// `github-actions[bot]`, GraphQL reports the same account as `github-actions`.
// Listing only one silently drops our own review's comments on whichever path
// uses the other.
const WORKFLOW_BOT_LOGINS = new Set(["github-actions[bot]", "github-actions"]);

/**
 * The login half of the gate on its own, for the one caller that must **not**
 * take the association half: filing issues from a review body asks "is this the
 * review runner's own output", not "is this from someone trusted", and the
 * wider question would admit a human collaborator's hand-written review.
 *
 * Named rather than re-listed there, so the two spellings above stay one fact.
 *
 * What this does not establish, stated so it is not mistaken for an oversight:
 * the workflow bot is the identity of *every* workflow in a repository, so this
 * says a workflow posted it and never *which* workflow did.
 */
export const isWorkflowBot = (login: string | undefined): boolean =>
  WORKFLOW_BOT_LOGINS.has(login ?? "");

export const isTrustedAuthor = (association: string | undefined, login: string | undefined): boolean =>
  TRUSTED_ASSOCIATIONS.has(association ?? "") || isWorkflowBot(login);

export interface TrustedIssue {
  readonly title: string;
  readonly body: string;
  /**
   * True only when the author passes `isTrustedAuthor`: a trusted association
   * — org-adjacent or better, which on an organization repository is weaker
   * than write access (#68) — or our own workflow login.
   */
  readonly trusted: boolean;
}

/**
 * The trusted fetches read a failure as an absence, which is what a missing
 * issue is, but say so: on a private repository a token without `issues: read`
 * fails the same read, and the review was handed no linked issue and no
 * criteria with nothing in the log to say why (#348).
 */
const warnUnreadable = (what: string): void =>
  console.log(
    `::warning::${what} could not be read, so it is treated as having no trusted text. ` +
      "On a private repository, a job without `issues: read` gets exactly this.",
  );

/**
 * Fetch an issue's title and body, but treat them as usable ONLY when the issue
 * author is OWNER / MEMBER / COLLABORATOR — org-adjacent or better, not
 * necessarily write-gated; see `TRUSTED_ASSOCIATIONS` and #68.
 *
 * Why: on a public repo anyone can *open* an issue with arbitrary title and
 * body, and this text is fed verbatim to an unsandboxed agent that holds tokens
 * and produces public output — a prompt-injection / exfiltration source. Author
 * association is the structural boundary, not the field: title and body from an
 * author the repository already knows sit behind the same trust boundary the
 * rest of the loop assumes. Comments are never fetched at all — they are
 * world-writable regardless of who opened the issue.
 */
export const fetchTrustedIssue = (ghRepo: string, issueNumber: string): TrustedIssue => {
  let parsed: {
    title?: string;
    body?: string | null;
    author_association?: string;
    user?: { login?: string };
  } = {};
  const text = safeGh(["api", `repos/${ghRepo}/issues/${issueNumber}`]);
  if (text === "") warnUnreadable(`Issue #${issueNumber}`);
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    parsed = {};
  }
  if (!isTrustedAuthor(parsed.author_association, parsed.user?.login)) {
    return { title: "", body: "", trusted: false };
  }
  return { title: parsed.title ?? "", body: (parsed.body ?? "").trim(), trusted: true };
};

/**
 * Fetch the conversation comments on an issue or PR, keeping ONLY those authored
 * by a repo collaborator (same trust boundary as `fetchTrustedIssue`). This is
 * what lets a maintainer steer the agent with a comment; a drive-by comment from
 * a non-collaborator is dropped. Returns "" when there are none.
 *
 * The `issues/{n}/comments` endpoint serves both issues and PRs (a PR is an
 * issue for this endpoint). It does NOT include inline review-thread comments —
 * those are a separate surface handled by the full review workflow, and would
 * need the same author gate. Only the first page (~30, oldest-first) is read;
 * that is plenty for steering and avoids pulling a huge thread into the prompt.
 */
export const fetchTrustedComments = (ghRepo: string, number: string): string =>
  renderTrustedComments(fetchTrustedCommentList(ghRepo, number));

/** One trusted comment, as `fetchTrustedCommentList` returns it. */
export interface TrustedComment {
  readonly login: string;
  readonly body: string;
}

/**
 * The same comments as `fetchTrustedComments`, behind the same gate and from
 * the same page, as a list oldest first, for a caller that reads them rather
 * than handing them on as one text: the review reads a triage brief's
 * acceptance criteria out of one (#214).
 */
export const fetchTrustedCommentList = (ghRepo: string, number: string): TrustedComment[] => {
  let comments: { body?: string; author_association?: string; user?: { login?: string } }[] = [];
  const text = safeGh(["api", `repos/${ghRepo}/issues/${number}/comments`]);
  if (text === "") warnUnreadable(`The comments on #${number}`);
  try {
    comments = JSON.parse(text || "[]");
  } catch {
    comments = [];
  }
  return comments
    .filter((c) => isTrustedAuthor(c.author_association, c.user?.login))
    .map((c) => ({ login: c.user?.login ?? "unknown", body: (c.body ?? "").trim() }));
};

/** Trusted comments as the one text a prompt is handed, or "" for none. */
export const renderTrustedComments = (comments: readonly TrustedComment[]): string =>
  comments
    .map((c) => `**@${c.login}:**\n${c.body}`)
    .filter((text) => text.trim().length > 0)
    .join("\n\n---\n\n");

/**
 * The Actions run this process is part of, or `undefined` off a runner.
 *
 * Composed from the three variables every Actions step is given rather than
 * from an input the workflow sets, because that is what they are: a step that
 * had to pass them could forget to, and there is nothing a runner could do
 * about a link it was not handed. A runner declares them optional and empty
 * by default, and hands them in. `undefined` where any is empty rather than a
 * guess, so a caller renders no link instead of a dead one.
 */
export const workflowRunUrl = (inputs: {
  readonly GITHUB_SERVER_URL: string;
  readonly GITHUB_REPOSITORY: string;
  readonly GITHUB_RUN_ID: string;
}): string | undefined => {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId } = inputs;
  if (!server || !repo || !runId) return undefined;
  return `${server}/${repo}/actions/runs/${runId}`;
};

/**
 * Renders a pull request as a Markdown heading and its description, in jq
 * because `gh` will do it in one call and there is nothing to parse on this
 * side. The `\n\n` here is a real newline pair, not a backslash and an `n`:
 * as argv it reaches jq exactly as written, and re-escaping it would put a
 * literal `\n` into the middle of the prompt.
 *
 * `// ""` is load-bearing — `gh` reports an empty PR description as JSON null,
 * and `string + null` is an error in jq rather than an empty string.
 */
const PR_HEADING_JQ = `"# " + .title + "\n\n" + (.body // "")`;

/**
 * The PR's title and body as one block of Markdown, for a runner that needs the
 * PR's own words as context.
 *
 * Read through `safeGh` on both counts. Argv, because a command string is where
 * the value of a variable becomes syntax — `PR_NUMBER` is a GitHub-produced
 * integer, but "safe because of what it happens to hold" is the argument the
 * argv boundary exists to stop making (#10). And swallowing, because the caller
 * is `update-branch`, which the workflow only reaches once git has left the tree
 * conflicted: an unreadable `gh pr view` is an API blip, not a reason to abandon
 * a merge resolution, so the fallback is the reference itself.
 */
export const fetchPullRequestHeading = (prNumber: string): string =>
  safeGh(["pr", "view", prNumber, "--json", "title,body", "--jq", PR_HEADING_JQ]) ||
  `PR #${prNumber}`;

/**
 * A pull request's body, byte for byte. `--json` and a parse rather than
 * `--jq .body`, which prints a newline after the body that is not in it — and a
 * caller that writes the body back would add one on every run.
 */
export const fetchPullRequestBody = (prNumber: string): string => {
  const pr = JSON.parse(gh(["pr", "view", prNumber, "--json", "body"])) as { readonly body?: unknown };
  return typeof pr.body === "string" ? pr.body : "";
};

/**
 * Wrap a plain validation function as a Standard Schema, so it can be handed to
 * `sandcastle.Output.object({ schema })` without pulling in a schema library.
 * On a thrown error the message is surfaced as a validation issue, which the
 * extraction retry loop feeds back to the agent.
 *
 * `vendor` names the library implementing the schema, so it is these runners —
 * not whichever repo they happen to be installed in. It read as the host repo's
 * name while the two were the same thing.
 */
export const standardSchema = <T>(
  validate: (value: unknown) => T,
): StandardSchemaV1<unknown, T> => ({
  "~standard": {
    version: 1,
    vendor: "agent-workflows",
    validate: (value: unknown) => {
      try {
        return { value: validate(value) };
      } catch (error) {
        return {
          issues: [{ message: error instanceof Error ? error.message : "Validation failed" }],
        };
      }
    },
  },
});

export const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

export const asString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

export const asArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
};
