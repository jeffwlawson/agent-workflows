import { ghOutcome, safeGh, type GhOptions } from "../shared/common.js";

/**
 * The repository's labels, as `init` converges them (#236): the half that asks
 * GitHub, beside `policies.ts`'s, and supplied by the tests the same way.
 *
 * `init` used to write no label at all and hand the create commands to
 * `SETUP.md`. That stops working the first time a release changes a label: a
 * create command fails on a label that exists, so the recolour of every
 * `agent:*` label by stage, and a label the loop retired, would each have been
 * a step an adopter had to notice and do by hand.
 */

/** A label as GitHub holds it. `color` is six hex digits with no `#`, in either case. */
export interface RepoLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

/** What `init` asks GitHub about labels and the three writes it may make. The tests supply their own. */
export interface LabelSurface {
  /** Every label in the repository, or `undefined` where they could not be listed. */
  readonly labels: () => readonly RepoLabel[] | undefined;
  /**
   * The open issues and pull requests carrying a label, by number, or
   * `undefined` where that could not be read, which is never "none": deleting a
   * label strips it from everything that carries it.
   */
  readonly carriers: (name: string) => readonly number[] | undefined;
  /** `undefined` on success, and GitHub's words for the refusal otherwise. */
  readonly create: (label: RepoLabel) => string | undefined;
  readonly edit: (label: RepoLabel) => string | undefined;
  readonly remove: (name: string) => string | undefined;
}

const parse = (out: string): unknown => {
  try {
    return JSON.parse(out) as unknown;
  } catch {
    return undefined;
  }
};

/** `gh label list --json name,color,description`, read, or `undefined` where it gave no list. */
export const parseLabels = (out: string): readonly RepoLabel[] | undefined => {
  const parsed = out.trim() === "" ? undefined : parse(out);
  if (!Array.isArray(parsed)) return undefined;
  return parsed.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { name, color, description } = entry as Record<string, unknown>;
    if (typeof name !== "string") return [];
    return [
      {
        name,
        color: typeof color === "string" ? color : "",
        description: typeof description === "string" ? description : "",
      },
    ];
  });
};

/** The first line of what `gh` said when it refused, for a note a human reads. */
const refusal = (args: readonly string[], options: GhOptions): string | undefined => {
  const outcome = ghOutcome(args, options);
  if (outcome.ok) return undefined;
  return (outcome.stderr.trim() || outcome.spawnError || outcome.stdout.trim() || "gh exited non-zero").split("\n")[0];
};

/**
 * `gh` against the repository `dir` is a checkout of, and no other, for
 * `livePolicySurface`'s reason: `GH_REPO` is set in every agent job this
 * repository runs, and a test calling `init` inside one would otherwise read,
 * and could rewrite, that repository's labels.
 */
export const liveLabelSurface = (dir: string): LabelSurface => {
  const { GH_REPO: _ignored, ...env } = process.env;
  const options: GhOptions = { cwd: dir, env };
  return {
    labels: () => parseLabels(safeGh(["label", "list", "--limit", "1000", "--json", "name,color,description"], options)),
    // The issues endpoint, because it lists pull requests too: `gh issue list`
    // leaves them out, and a pull request carrying a retired label is as much
    // a reason to keep it as an issue is.
    carriers: (name) => {
      const out = ghOutcome(
        [
          "api",
          `repos/{owner}/{repo}/issues?state=open&per_page=100&labels=${encodeURIComponent(name)}`,
          "--jq",
          ".[].number",
        ],
        options,
      );
      if (!out.ok) return undefined;
      return out.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^[0-9]+$/.test(line))
        .map(Number);
    },
    create: ({ name, color, description }) =>
      refusal(["label", "create", name, "--color", color, "--description", description], options),
    edit: ({ name, color, description }) =>
      refusal(["label", "edit", name, "--color", color, "--description", description], options),
    remove: (name) => refusal(["label", "delete", name, "--yes"], options),
  };
};
