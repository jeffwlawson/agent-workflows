import { MERGE_LABEL } from "./record.js";

/**
 * The loop's own labels, and the one definition of them (#823): `init`
 * creates and recolours them in a repository it is run in, `doctor` demands
 * them, and the service's dispatcher converges them on every repository it
 * serves. Here rather than in `setup/` so the dispatcher reads them without
 * importing `init`.
 *
 * A label exactly as it has to be created: the name a workflow filters on, and
 * the colour and description `docs/ADOPTING.md` §3 gives it.
 *
 * Both tables below are a **second copy** of that §3 block: this one feeds
 * `SETUP.md`'s create commands and `doctor`'s missing-label errors, and the doc
 * is what a human reads. Held in step by `tests/agent-cli.test.ts`, which parses
 * §3 and compares, in the spirit of `PIN` in `tests/workflows.test.ts`: a rename
 * or a recolour in either place fails the build by name rather than leaving
 * `init` scaffolding one string and a workflow filtering on another.
 */
export interface LabelSpec {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

/**
 * The state labels every installation needs, whichever callers were taken.
 * The trigger labels are derived from the callers instead: see `labelSpecsFor`.
 */
export const STATE_LABELS: readonly LabelSpec[] = [
  { name: "agent:blocked", color: "CF222E", description: "A run failed or was refused. Needs you." },
];

/**
 * Coloured by **stage** (#236), so the colour on an issue or a pull request
 * says where in the lifecycle it is: build, review, fix, refresh, merge. Each
 * of the first four is on while its run works and comes off when the run ends,
 * which is what retired `agent:in-progress`; the descriptions say so, since
 * they are what GitHub shows on hover.
 *
 * `agent:merge` (ADR 0009) is the one that is not: it is the maintainer's
 * merge decision, **armed until merged or disarmed**, and its description says
 * that instead. It is a trigger label all the same, demanded only where its
 * caller is installed, since the `merge` caller is opt-in by its job.
 */
export const TRIGGER_LABELS: readonly LabelSpec[] = [
  {
    name: "agent:implement",
    color: "8250DF",
    description: "Build this issue, or the next slice of this PRD. On while the run works.",
  },
  { name: "agent:review", color: "0969DA", description: "Review this PR. On while the review runs." },
  { name: "agent:fix", color: "D4A72C", description: "Act on review findings. On while the fix runs." },
  {
    name: "agent:update-branch",
    color: "1B7C83",
    description: "Merge the base branch into this PR. On while it runs.",
  },
  {
    name: MERGE_LABEL,
    color: "1A7F37",
    description: "Merge this PR once current, green and approved. Armed until merged or disarmed.",
  },
];

/**
 * Labels the loop wrote once and writes no longer. `init` deletes each where
 * no open issue or pull request still carries it, and `doctor` reports one
 * that is still there. Deleting a label strips it from everything carrying it,
 * so one still in use is left for a human, named. The dispatcher never
 * deletes one.
 */
export const RETIRED_LABELS: readonly string[] = ["agent:in-progress", "agent:auto-fixed", "agent:queued"];

/** What a convergence does to one wanted label: create it, edit it to the list's, or leave it. */
export type LabelWrite = "create" | "edit" | "unchanged";

/**
 * What converging `wanted` over the labels a repository holds, `present`,
 * writes to each wanted label, in `wanted`'s order: one missing is created,
 * one whose colour (compared without regard to case, since GitHub answers it
 * in lower case whatever it was given) or description differs is edited, and
 * one that matches is left. A label of `present` that is not wanted is never
 * named, so nothing here deletes or renames one.
 */
export const labelWrites = (
  wanted: readonly LabelSpec[],
  present: readonly LabelSpec[],
): readonly { readonly label: LabelSpec; readonly write: LabelWrite }[] => {
  const byName = new Map(present.map((label) => [label.name, label]));
  return wanted.map((label) => {
    const current = byName.get(label.name);
    if (current === undefined) return { label, write: "create" };
    const same = current.color.toLowerCase() === label.color.toLowerCase() && current.description === label.description;
    return { label, write: same ? "unchanged" : "edit" };
  });
};
