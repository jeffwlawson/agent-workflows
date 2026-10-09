import { DEFAULT_LOOP_ACCOUNT } from "./record.js";

/**
 * **The loop's accounts** (`docs/platform-spec.md` §4.1, #376): the logins a
 * runner or a command reads as the loop's own, in both the spellings GitHub
 * reports each. Round counting, the verdict history, the fix-round budget,
 * "verified fixed", the follow-ups the review recorded and the trust gate all
 * ask this one set.
 *
 * Built once, by `loopAccounts`, from the list the orchestrator passes in
 * (`AGENT_LOOP_LOGINS`) and `DEFAULT_LOOP_ACCOUNT`, and handed down to every
 * site that asks. Nothing else spells a login the loop posts as.
 *
 * Imports nothing but `shared/record.ts`, so a command can load it beside the
 * loop's write token (ADR 0004).
 */
export interface LoopAccounts {
  /** Every spelling of every account, lower-cased: GitHub logins differ by case only in how they are typed. */
  readonly logins: ReadonlySet<string>;
}

/** What GraphQL calls an App that REST calls `<slug>[bot]`. */
const BOT_SUFFIX = "[bot]";

/** A GitHub login, or an App's REST spelling of one. */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/;

/**
 * Both spellings of one account: REST reports an App as `<slug>[bot]` and
 * GraphQL as `<slug>`, and either may be the one given. Listing only one
 * silently drops the loop's own posts on whichever path uses the other.
 */
const spellings = (login: string): string[] => {
  const lower = login.toLowerCase();
  const slug = lower.endsWith(BOT_SUFFIX) ? lower.slice(0, -BOT_SUFFIX.length) : lower;
  return [slug, `${slug}${BOT_SUFFIX}`];
};

/**
 * The loop's accounts: `DEFAULT_LOOP_ACCOUNT`, always, and each account in
 * `list`, a comma-separated list of logins, each in either spelling. An empty
 * entry, as a trailing comma leaves, is ignored, so an empty list is the
 * default alone, which is the loop's identity before this could be passed in.
 *
 * A malformed entry throws, naming it: an account nobody can post as is a
 * list the orchestrator got wrong, and reading past it would leave the loop's
 * own posts unrecognised with nothing to say why (#60, decision 5).
 */
export const loopAccounts = (list: string): LoopAccounts => {
  const logins = new Set(spellings(DEFAULT_LOOP_ACCOUNT));
  for (const entry of list.split(",").map((e) => e.trim())) {
    if (entry === "") continue;
    if (!LOGIN.test(entry)) {
      throw new Error(
        `\`AGENT_LOOP_LOGINS\` holds \`${entry}\`, which is not a GitHub login. ` +
          "Give the loop's accounts as a comma-separated list of logins, each like `my-app[bot]` or `my-app`.",
      );
    }
    for (const login of spellings(entry)) logins.add(login);
  }
  return { logins };
};

/**
 * Whether `login` is one of the loop's accounts, in either spelling: the
 * question *did the loop post this*, without the association half of
 * `isTrustedAuthor`. Filing issues from a review body asks "is this the review
 * runner's own output", not "is this from someone trusted", and the wider
 * question would admit a human collaborator's hand-written review.
 *
 * What this does not establish, stated so it is not mistaken for an oversight:
 * an account the loop posts as may post for every workflow in a repository,
 * so this says the loop's identity posted it and never *which* run did.
 */
export const isWorkflowBot = (login: string | undefined, accounts: LoopAccounts): boolean =>
  login !== undefined && accounts.logins.has(login.toLowerCase());
