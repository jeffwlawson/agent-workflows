import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentModel, isTrustedAuthor } from "../shared/common.js";

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
