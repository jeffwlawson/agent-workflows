import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the two process-spawning exports are replaced; the rest of the module is
// left intact, because anything else in the graph that reaches for
// `node:child_process` must keep working.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

import { execFileSync, execSync } from "node:child_process";
import {
  agentModel,
  fetchTrustedComments,
  fetchTrustedIssue,
  isTrustedAuthor,
  safeGh,
} from "../shared/common.js";

const spawned = vi.mocked(execFileSync);
const shelled = vi.mocked(execSync);

/**
 * `isTrustedAuthor` is the security boundary of the agent loop: every
 * world-writable input (PR comments, review summaries, review threads, issue
 * bodies) passes through it before reaching an agent that acts with
 * `contents: write` and pushes. A silent widening of the trusted set steers
 * committed code, so these tests pin exactly who is trusted and who is not.
 *
 * The ground truth below is NOT inferred from the code under test — it is the
 * thing being checked. The enum and the two bot spellings are grounded in the
 * sources named in issue #63, not in `common.ts`.
 */

// The complete CommentAuthorAssociation enum, from GraphQL introspection on
// 2026-07-31:
//   gh api graphql -f query='{ __type(name: "CommentAuthorAssociation")
//                              { enumValues { name } } }'
// Three are write-gated and therefore trusted; the other five are not. All
// eight are listed so a later edit to TRUSTED_ASSOCIATIONS cannot widen the set
// without a test turning red.
const ASSOCIATIONS: [association: string, trusted: boolean][] = [
  ["OWNER", true],
  ["MEMBER", true],
  ["COLLABORATOR", true],
  ["MANNEQUIN", false],
  ["CONTRIBUTOR", false],
  ["FIRST_TIME_CONTRIBUTOR", false],
  ["FIRST_TIMER", false],
  ["NONE", false],
];

// A login that is not one of the trusted bot spellings, so each row exercises
// the association gate alone.
const NON_BOT_LOGIN = "octocat";

describe("isTrustedAuthor — author_association gate", () => {
  it("covers all eight enum values", () => {
    expect(ASSOCIATIONS).toHaveLength(8);
  });

  it.each(ASSOCIATIONS)(
    "%s with a non-bot login is trusted=%s",
    (association, trusted) => {
      expect(isTrustedAuthor(association, NON_BOT_LOGIN)).toBe(trusted);
    },
  );
});

describe("isTrustedAuthor — trusted bot logins", () => {
  // Regression tests. Our own workflow account is reported as
  // `github-actions[bot]` by the REST API and as `github-actions` by GraphQL —
  // the same account, two spellings. Its author_association is NONE, so an
  // association-only gate would discard it. Listing only the REST spelling was a
  // shipped bug (docs/friction.md, "Closing the loop"): GraphQL-sourced comments
  // from the review agent were silently dropped and the review → fix handoff
  // quietly did nothing. Both spellings must stay trusted even with NONE.
  it("trusts github-actions[bot] (the REST spelling) even with NONE", () => {
    expect(isTrustedAuthor("NONE", "github-actions[bot]")).toBe(true);
  });

  it("trusts github-actions (the GraphQL spelling) even with NONE", () => {
    expect(isTrustedAuthor("NONE", "github-actions")).toBe(true);
  });
});

describe("isTrustedAuthor — optional fields and non-bot identities", () => {
  // Both arguments are optional in the GraphQL response types, so an undefined
  // pair is a reachable state, not a defensive case. It must not be trusted.
  it("returns false when both association and login are undefined", () => {
    expect(isTrustedAuthor(undefined, undefined)).toBe(false);
  });

  // The gate deliberately trusts one specific login rather than
  // `user.type === "Bot"` — the latter would also trust Dependabot and every
  // GitHub App an admin installs, a far wider surface for a job that commits
  // code. This pins that decision (common.ts around line 79).
  it("does not trust dependabot[bot], another bot, with NONE", () => {
    expect(isTrustedAuthor("NONE", "dependabot[bot]")).toBe(false);
  });
});

describe("isTrustedAuthor — the two conditions are an OR, not an AND", () => {
  // Worth pinning explicitly: a later "tidy-up" that reads the two checks as one
  // condition could silently turn this OR into an AND, which would then require
  // BOTH a trusted association AND a trusted bot login — dropping every human
  // maintainer and every review-agent comment at once.
  it("trusts a trusted association even with an untrusted login", () => {
    expect(isTrustedAuthor("OWNER", "some-drive-by-account")).toBe(true);
  });

  it("trusts a trusted bot login even with an untrusted association", () => {
    expect(isTrustedAuthor("NONE", "github-actions")).toBe(true);
  });
});

/**
 * Model selection. The precedence chain is the kind of thing that breaks
 * silently — a wrong order does not error, it just quietly runs every agent on
 * the wrong model, and the only trace is a log line nobody reads until output
 * quality is questioned weeks later.
 */
describe("agentModel — precedence", () => {
  const VARS = [
    "AGENT_MODEL",
    "AGENT_MODEL_IMPLEMENT",
    "AGENT_MODEL_FIX",
    "AGENT_MODEL_REVIEW",
    "AGENT_MODEL_UPDATE_BRANCH",
  ] as const;

  beforeEach(() => {
    for (const v of VARS) delete process.env[v];
  });
  afterEach(() => {
    for (const v of VARS) delete process.env[v];
  });

  it("falls back to the global default when nothing is set", () => {
    expect(agentModel("implement")).toBe("claude-opus-5");
    expect(agentModel("review")).toBe("claude-opus-5");
  });

  it("uses the baked per-workflow default for update-branch", () => {
    expect(agentModel("update-branch")).toBe("claude-sonnet-5");
  });

  // The failure this guards: GitHub interpolates an UNSET repository variable
  // into the empty string, not into nothing, so on any repo that has not set
  // these the env vars arrive as "". Resolving with `??` instead of `||` would
  // pass that through and hand the CLI an empty model id.
  it("treats an empty string as unset, on both the global and the per-workflow var", () => {
    process.env["AGENT_MODEL"] = "";
    process.env["AGENT_MODEL_REVIEW"] = "";
    expect(agentModel("review")).toBe("claude-opus-5");

    process.env["AGENT_MODEL_UPDATE_BRANCH"] = "";
    expect(agentModel("update-branch")).toBe("claude-sonnet-5");
  });

  it("lets the global override beat a baked per-workflow default", () => {
    // "run everything on X" is the whole point of setting AGENT_MODEL, so it
    // must outrank the table — including update-branch's cheaper default.
    process.env["AGENT_MODEL"] = "claude-opus-5";
    expect(agentModel("update-branch")).toBe("claude-opus-5");
  });

  it("lets a per-workflow override beat the global override", () => {
    process.env["AGENT_MODEL"] = "claude-sonnet-5";
    process.env["AGENT_MODEL_REVIEW"] = "claude-opus-5";
    expect(agentModel("review")).toBe("claude-opus-5");
    expect(agentModel("implement")).toBe("claude-sonnet-5");
  });

  // update-branch -> AGENT_MODEL_UPDATE_BRANCH. A hyphen surviving into the
  // var name would make the override silently unreachable.
  it("maps a hyphenated workflow name onto an underscored var", () => {
    process.env["AGENT_MODEL_UPDATE_BRANCH"] = "claude-opus-5";
    expect(agentModel("update-branch")).toBe("claude-opus-5");
    expect(agentModel("implement")).toBe("claude-opus-5");
  });

  it("resolves the fix workflow, whose name has no hyphen", () => {
    process.env["AGENT_MODEL_FIX"] = "claude-sonnet-5";
    expect(agentModel("fix")).toBe("claude-sonnet-5");
    expect(agentModel("implement")).toBe("claude-opus-5");
  });
});

/**
 * `safeGh` exists so the two trusted-fetch helpers can reach `gh` the way
 * everything else does — argv, never `/bin/sh` — without giving up the one
 * behaviour they took from `safeSh`: a non-zero exit is an ordinary "no such
 * issue", not an error (issue #2).
 *
 * Those helpers used to interpolate into ``safeSh(`gh api …`)``, and the only
 * thing keeping `Closes #1;id` out of a shell was a `\d+` capture in
 * review-context.ts — a control three files from the interpolation it protected.
 * These tests are on the boundary, not on that regex: the argument arrives as
 * one element of an argv array, and `execSync` — the shell path — is not used at
 * all. Metacharacters are then just characters, whatever produced them.
 */
describe("safeGh — argv, with safeSh's swallowing", () => {
  beforeEach(() => {
    spawned.mockReset();
    shelled.mockReset();
  });

  it("runs gh with argv, and asks for no shell", () => {
    spawned.mockReturnValue("{}");

    expect(safeGh(["api", "repos/o/r/issues/12"])).toBe("{}");

    const [file, args, options] = spawned.mock.calls.at(-1)!;
    expect(file).toBe("gh");
    expect(args).toEqual(["api", "repos/o/r/issues/12"]);
    // `execFileSync` spawns the binary directly unless `shell` asks otherwise,
    // so the absence of that option is the "no shell" half of the guarantee.
    expect(options).not.toHaveProperty("shell");
    expect(shelled).not.toHaveBeenCalled();
  });

  // `git check-ref-format --branch` permits `$()`, backticks, `;`, `|` and `&`,
  // and a PR body can put anything at all in front of the parse that yields an
  // issue number. Under the string form each of these reached `/bin/sh`; as argv
  // they stay one unparsed argument.
  it.each(["$(id)", "a;id", "a|id", "a&b", "back`tick`", "1 2", "'quoted'", "*"])(
    "passes %s through intact rather than interpreting it",
    (hostile) => {
      spawned.mockReturnValue("{}");

      safeGh(["api", `repos/o/r/issues/${hostile}`]);

      const [, args] = spawned.mock.calls.at(-1)!;
      expect(args).toEqual(["api", `repos/o/r/issues/${hostile}`]);
      expect(shelled).not.toHaveBeenCalled();
    },
  );

  /**
   * The reason this is a wrapper and not a call-site swap to `gh()`. Both
   * callers read a missing issue as an ordinary outcome and lean on `|| "{}"` /
   * `|| "[]"`; `gh()` throws, which would turn a handled absence into an
   * exception in the middle of a review run.
   */
  it('returns "" on a non-zero exit rather than throwing', () => {
    spawned.mockImplementation(() => {
      throw new Error("gh: exit 1");
    });

    expect(safeGh(["api", "repos/o/r/issues/9999"])).toBe("");
  });
});

describe("the trusted fetches reach gh through argv", () => {
  const REPO = process.env["GH_REPO"];

  beforeEach(() => {
    spawned.mockReset();
    shelled.mockReset();
    process.env["GH_REPO"] = "o/r";
  });
  afterEach(() => {
    if (REPO === undefined) delete process.env["GH_REPO"];
    else process.env["GH_REPO"] = REPO;
  });

  it("keeps a metacharacter issue number as one argument to fetchTrustedIssue", () => {
    spawned.mockReturnValue(
      JSON.stringify({ title: "t", body: "b", author_association: "OWNER" }),
    );

    fetchTrustedIssue("1;id");

    expect(spawned.mock.calls.at(-1)![1]).toEqual(["api", "repos/o/r/issues/1;id"]);
    expect(shelled).not.toHaveBeenCalled();
  });

  it("keeps a metacharacter number as one argument to fetchTrustedComments", () => {
    spawned.mockReturnValue("[]");

    fetchTrustedComments("$(id)");

    expect(spawned.mock.calls.at(-1)![1]).toEqual([
      "api",
      "repos/o/r/issues/$(id)/comments",
    ]);
    expect(shelled).not.toHaveBeenCalled();
  });

  // The swallowing, seen from the callers: a `gh` that exits non-zero must read
  // as an absent issue with no comments, exactly as it did through `safeSh`.
  it("treats a failed fetch as an absent issue rather than an error", () => {
    spawned.mockImplementation(() => {
      throw new Error("gh: Not Found (HTTP 404)");
    });

    expect(fetchTrustedIssue("42")).toEqual({ title: "", body: "", trusted: false });
    expect(fetchTrustedComments("42")).toBe("");
  });
});
