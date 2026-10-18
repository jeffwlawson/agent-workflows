import { describe, expect, it } from "vitest";
import type { Transport } from "../engine/github.js";
import { githubReader, type CommitStatus } from "../engine/read.js";
import { loopAccounts } from "../shared/loop-accounts.js";
import { VERDICT_CONTEXT } from "../shared/record.js";
import { newestVerdict } from "../shared/verdict-status.js";

/**
 * `newestVerdict` (#484): the selection `review:conclude` and
 * `update-branch:publish` both make of the `agent-review` status that stands
 * on a commit. A read that failed is the caller's to tell apart from this
 * function's `undefined`, and is held in each command's tests.
 */

const ours = loopAccounts("");

const status = (over: Partial<CommitStatus> = {}): CommitStatus => ({
  context: VERDICT_CONTEXT,
  state: "success",
  targetUrl: null,
  description: "",
  creator: "github-actions[bot]",
  ...over,
});

describe("newestVerdict", () => {
  it("is the first of ours under the verdict's context, newest first as listed", () => {
    const statuses = [status({ context: "ci" }), status({ state: "failure" }), status({ state: "success" })];

    expect(newestVerdict(statuses, ours)).toBe(statuses[1]);
  });

  /** The hard-to-see failure: any token with `statuses: write` can post under the context. */
  it("never selects an outside integration's status under the same context, however new", () => {
    expect(newestVerdict([status({ creator: "deploy-bot[bot]" }), status({ creator: "someone" })], ours)).toBeUndefined();
  });

  it("recognises an account the loop's list names, in either spelling", () => {
    const service = status({ creator: "my-loop[bot]", state: "failure" });

    expect(newestVerdict([service], ours)).toBeUndefined();
    expect(newestVerdict([service], loopAccounts("my-loop"))).toBe(service);
  });

  it("is undefined on a commit with no verdict", () => {
    expect(newestVerdict([], ours)).toBeUndefined();
    expect(newestVerdict([status({ context: "ci" })], ours)).toBeUndefined();
  });

  /**
   * The newest of ours wins across pages: a repository with a deploy bot on
   * every commit has more than a page of statuses, and the older the verdict,
   * the likelier an unpaginated read silently misses it.
   */
  it("finds the newest of ours past the first page of a commit's statuses", async () => {
    const raw = (n: number, login: string, context = "deploy") => ({
      context,
      state: n % 2 === 0 ? "failure" : "success",
      target_url: `https://example.invalid/${n}`,
      description: `${n}`,
      creator: { login },
    });
    const pages: Record<number, unknown[]> = {
      1: [raw(0, "deploy-bot[bot]", VERDICT_CONTEXT), ...Array.from({ length: 99 }, (_, i) => raw(i + 1, "deploy-bot[bot]"))],
      2: [raw(101, "github-actions[bot]", VERDICT_CONTEXT), raw(102, "github-actions[bot]", VERDICT_CONTEXT)],
    };
    const transport: Transport = {
      rest: async ({ path }) => pages[Number(/page=(\d+)$/.exec(path)?.[1])] ?? [],
      graphql: async () => ({}),
    };

    const verdict = newestVerdict(await githubReader("o/r", transport).commitStatuses("a".repeat(40)), ours);

    expect(verdict).toEqual({
      context: VERDICT_CONTEXT,
      state: "success",
      targetUrl: "https://example.invalid/101",
      description: "101",
      creator: "github-actions[bot]",
    });
  });
});
