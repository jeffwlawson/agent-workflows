import type { GitHubReader } from "../engine/read.js";

/**
 * **The wait for a pull request to show a pushed head** (#229), before a
 * command asks for the review of what it pushed. GitHub moves a pull request's
 * head asynchronously after a push, and a label added before it has would
 * carry the commit before the push in its payload.
 *
 * Bounded: past `waitSeconds` the label goes on anyway, with a warning, since
 * review reads the branch tip itself and refuses by name where it cannot
 * settle on it. An unreadable head keeps waiting, as one that has not moved
 * yet does. It writes nothing.
 *
 * `fix:publish` waits with it (#468), and `update-branch:publish` (#484),
 * which replaced the shell copy `update-branch.yml` kept.
 */
export const waitForHead = async (
  github: Pick<GitHubReader, "pullRequest">,
  pr: number,
  pushed: string,
  bound: { readonly waitSeconds: number; readonly pollSeconds: number },
): Promise<void> => {
  const deadline = Date.now() + bound.waitSeconds * 1000;
  for (;;) {
    let head: string | undefined;
    try {
      head = (await github.pullRequest(pr)).headSha;
    } catch {
      head = undefined;
    }
    if (head === pushed) return;
    if (Date.now() >= deadline) {
      console.log(
        `::warning::PR #${pr} still shows ${head ?? "an unreadable head"} as its head ${bound.waitSeconds}s after ${pushed} was pushed. Asking for the review anyway: it reads the branch tip itself, and refuses by name if it cannot settle on ${pushed}.`,
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, bound.pollSeconds * 1000));
  }
};
