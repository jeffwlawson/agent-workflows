import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ghOutcome, safeGh, type GhOptions } from "../shared/common.js";
import { escapeRe } from "../shared/pins.js";
import { repoSlug, type InstalledCaller } from "./callers.js";
import { PACKAGE_NAME } from "../shared/manifest.js";

/**
 * The Actions event policy the loop's callers need on a **public** repository
 * (#219), and the half `init` and `doctor` both use to rule on it.
 *
 * GitHub's workflow execution protections (GA 2026-09-17) add a default rule
 * that blocks `pull_request_target` on every public repository with no
 * applicable event policy, enforced from 2026-11-02. `review`, `fix`,
 * `update-branch` and `follow-ups` all run on that trigger, so on that date they
 * stop, and nothing in the loop reports why: a run blocked by a policy is not a
 * run any step of ours gets to explain. Private and internal repositories are
 * not affected.
 *
 * The trigger stays (the triage on #219 settled why), so the fix is the one
 * GitHub gives for workflows that depend on it: an event policy that allows it,
 * **targeted by workflow path** at the callers, so every other workflow in the
 * repository stays under the default block. The callers are the ones found by
 * what they call, as everywhere in `setup/`, never by filename.
 *
 * The rule lists **every** event the targeted files trigger on, not only
 * `pull_request_target`. Whether `allowed_events` is an allowlist for the files
 * it targets or only adds to what they may already do is not something the
 * documentation states, and listing the rest is right either way: if it only
 * adds, the extra entries cost nothing; if it is exhaustive, a rule naming the
 * one trigger would block a caller that also listens for something else.
 */

/**
 * What the policy is called. Stable, because it is how a re-run finds the
 * policy it created to extend it rather than creating a second; and free of
 * quotes, because it is printed inside a shell command below.
 */
export const POLICY_NAME = `${repoSlug(PACKAGE_NAME)} callers: allow pull_request_target`;

export const POLICY_SETTINGS = "Settings → Actions → Policies";

/** The trigger the default rule blocks. */
const TRIGGER = "pull_request_target";

/**
 * A policy as far as this rules on it. Everything else a policy can say (actor
 * rules, required workflows) is not the question here.
 */
export interface ActionsPolicy {
  readonly id: number | undefined;
  readonly name: string;
  /** `active`, `evaluate` or `disabled`. Only `active` allows anything. */
  readonly enforcement: string;
  /**
   * The `workflow_path` condition's `include`, or `undefined` where the policy
   * stores none, which targets every workflow.
   */
  readonly include: readonly string[] | undefined;
  readonly exclude: readonly string[];
  /** Its `restrict_action_events` rule's `allowed_events`, or `undefined` where it has none. */
  readonly allowedEvents: readonly string[] | undefined;
}

/** The request body `POST` and `PUT` take. */
export interface PolicyBody {
  readonly name: string;
  readonly enforcement: "active";
  readonly conditions: {
    readonly workflow_path: { readonly include: readonly string[]; readonly exclude: readonly string[] };
  };
  readonly rules: readonly [
    { readonly type: "restrict_action_events"; readonly parameters: { readonly allowed_events: readonly string[] } },
  ];
}

const strings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * The list endpoint's answer, read as policies, or `undefined` where there was
 * no answer to read, which is never the same as an empty list: "no policy
 * allows the trigger" is an error on a public repository, and "could not ask"
 * is not.
 *
 * Accepts the documented `{ total_count, policies }` and a bare array, since
 * the reference describes the first by reference to another endpoint rather
 * than by example.
 */
export const parsePolicies = (out: string): readonly ActionsPolicy[] | undefined => {
  if (out.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return undefined;
  }
  const list = Array.isArray(parsed) ? parsed : record(parsed)["policies"];
  if (!Array.isArray(list)) return undefined;

  return list.map((entry): ActionsPolicy => {
    const policy = record(entry);
    const workflowPath = record(record(policy["conditions"])["workflow_path"]);
    const events = (Array.isArray(policy["rules"]) ? policy["rules"] : [])
      .map(record)
      .find((rule) => rule["type"] === "restrict_action_events");
    return {
      id: typeof policy["id"] === "number" ? policy["id"] : undefined,
      name: typeof policy["name"] === "string" ? policy["name"] : "",
      enforcement: typeof policy["enforcement"] === "string" ? policy["enforcement"] : "",
      include: strings(workflowPath["include"]),
      exclude: strings(workflowPath["exclude"]) ?? [],
      allowedEvents:
        events === undefined ? undefined : (strings(record(events["parameters"])["allowed_events"]) ?? []),
    };
  });
};

/** A `workflow_path` pattern: `*` stays inside a path segment, `**` crosses them. */
const pathPattern = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split("**")
      .map((part) => part.split("*").map((piece) => piece.split("?").map(escapeRe).join("[^/]")).join("[^/]*"))
      .join(".*")}$`,
  );

const targets = (policy: ActionsPolicy, file: string): boolean => {
  if (policy.exclude.some((pattern) => pathPattern(pattern).test(file))) return false;
  // An empty `include` matches everything not excluded, and `~ALL` everything.
  if (policy.include === undefined || policy.include.length === 0) return true;
  return policy.include.some((pattern) => pattern === "~ALL" || pathPattern(pattern).test(file));
};

const allows = (policy: ActionsPolicy, file: string): boolean =>
  policy.enforcement === "active" && (policy.allowedEvents?.includes(TRIGGER) ?? false) && targets(policy, file);

/** The caller files that run on the blocked trigger, each once, in a stable order. */
export const triggeredFiles = (callers: readonly InstalledCaller[]): readonly string[] =>
  [...new Set(callers.filter((caller) => caller.events.includes(TRIGGER)).map((caller) => caller.file))].sort();

/** Those of them no active policy allows the trigger for. Pure. */
export const unallowedFiles = (
  callers: readonly InstalledCaller[],
  policies: readonly ActionsPolicy[],
): readonly string[] =>
  triggeredFiles(callers).filter((file) => !policies.some((policy) => allows(policy, file)));

/**
 * The policy for exactly these files: every event any of them triggers on (see
 * the header), and `extra` for the ones an existing policy already listed.
 */
export const policyBody = (
  callers: readonly InstalledCaller[],
  files: readonly string[],
  extra: readonly string[] = [],
): PolicyBody => ({
  name: POLICY_NAME,
  enforcement: "active",
  conditions: { workflow_path: { include: [...files], exclude: [] } },
  rules: [
    {
      type: "restrict_action_events",
      parameters: {
        allowed_events: [
          ...new Set([
            ...callers.filter((caller) => files.includes(caller.file)).flatMap((caller) => caller.events),
            ...extra,
          ]),
        ].sort(),
      },
    },
  ],
});

/**
 * The call a human makes where this could not: printed by `init` when the
 * token it runs with is refused, and by `doctor` as the fix. `{owner}/{repo}`
 * is `gh`'s own placeholder, resolved from the checkout it is run in.
 */
export const policyCommand = (body: PolicyBody): string =>
  `echo '${JSON.stringify(body)}' | gh api --method POST repos/{owner}/{repo}/actions/policies --input -`;

/**
 * `gh`'s answer for a repository's visibility, as the two cases anything here
 * would distinguish. An **internal** repository is private as far as this loop
 * is concerned: the check-runs API 403s without the scope exactly as it does on
 * a private one, and GitHub's default `pull_request_target` block leaves it
 * alone as it does a private one.
 *
 * Folded to one case rather than matched in two, because which case `gh` emits
 * is version-dependent: `repo view --json visibility` has answered both
 * `PUBLIC` and `public` across releases. Accepting one spelling of `INTERNAL`
 * and both of the others would be an asymmetry with a consequence, since the
 * fall-through is `undefined`: an internal repository whose `gh` lowercased the
 * field would read as one whose visibility could not be read at all.
 */
export const asVisibility = (raw: string | undefined): "public" | "private" | undefined => {
  const held = raw?.trim().toUpperCase();
  if (held === "PUBLIC") return "public";
  if (held === "PRIVATE" || held === "INTERNAL") return "private";
  return undefined;
};

/**
 * Every policy that applies here: the repository's own and, through
 * `has_parents`, its organization's and enterprise's, since an allowing policy
 * up there covers the callers as well as one down here does.
 */
export const readPolicies = (dir: string, options: GhOptions = { cwd: dir }): readonly ActionsPolicy[] | undefined =>
  parsePolicies(safeGh(["api", "repos/{owner}/{repo}/actions/policies?per_page=100&has_parents=true"], options));

/** What `init` asks GitHub and the two writes it may make. The tests supply their own. */
export interface PolicySurface {
  readonly visibility: () => "public" | "private" | undefined;
  readonly policies: () => readonly ActionsPolicy[] | undefined;
  /** `undefined` on success, and GitHub's words for the refusal otherwise. */
  readonly create: (body: PolicyBody) => string | undefined;
  readonly update: (id: number, body: PolicyBody) => string | undefined;
}

/**
 * The body goes through a file rather than stdin, because the `gh` helpers
 * give it none, and rather than `-f` fields, which cannot spell an array of
 * objects.
 */
const send = (
  options: GhOptions,
  method: "POST" | "PUT",
  endpoint: string,
  body: PolicyBody,
): string | undefined => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-policy-"));
  const file = path.join(scratch, "policy.json");
  try {
    fs.writeFileSync(file, JSON.stringify(body));
    const outcome = ghOutcome(["api", "--method", method, endpoint, "--input", file], options);
    if (outcome.ok) return undefined;
    return (outcome.stderr.trim() || outcome.spawnError || outcome.stdout.trim() || "gh exited non-zero").split("\n")[0];
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};

/**
 * `gh` against the repository **`dir` is a checkout of**, and no other. The
 * callers this targets are the ones just written there, so a policy anywhere
 * else allows nothing for them; and `GH_REPO`, which `gh` prefers over the
 * checkout's remote, is set in every agent job this repository runs. Without
 * this, a test calling `init` inside one would read, and could write, the
 * policies of the repository the job runs for. Outside a checkout `gh` cannot
 * name a repository at all, so the step reports itself unreadable and writes
 * nothing.
 */
export const livePolicySurface = (dir: string): PolicySurface => {
  const { GH_REPO: _ignored, ...env } = process.env;
  const options: GhOptions = { cwd: dir, env };
  return {
    visibility: () =>
      asVisibility(safeGh(["repo", "view", "--json", "visibility", "--jq", ".visibility"], options)),
    policies: () => readPolicies(dir, options),
    create: (body) => send(options, "POST", "repos/{owner}/{repo}/actions/policies", body),
    update: (id, body) => send(options, "PUT", `repos/{owner}/{repo}/actions/policies/${id}`, body),
  };
};
