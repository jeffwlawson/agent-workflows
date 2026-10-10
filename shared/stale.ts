/**
 * The reason an implementing agent gives for stopping on an issue whose
 * premise no longer matches the code (#447): what the issue removes is already
 * gone, or what it fixes was replaced. The prompt tells the agent to commit
 * nothing and end its output with `<stale>…</stale>` around the reason, the
 * way it ends a finished run with `<promise>COMPLETE</promise>`.
 *
 * Read from the agent's output, the last tag where it wrote more than one: the
 * output carries its final message twice, and an earlier one may only quote
 * the instruction. Undefined where there is no tag or the tag is empty, so a
 * run without one behaves exactly as it did before the tag existed.
 */
export const staleReason = (output: string): string | undefined => {
  const reasons = [...output.matchAll(/<stale>([\s\S]*?)<\/stale>/g)].map((m) => (m[1] ?? "").trim());
  const reason = reasons.at(-1);
  return reason === undefined || reason === "" ? undefined : reason;
};

/** The failure a runner reports for that reason, framed for the human who reads it. */
export const staleFailure = (issue: string, reason: string): string =>
  `The agent stopped because ${issue} no longer matches the code: ${reason}`;
