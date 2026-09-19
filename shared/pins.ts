/**
 * The version pin, and the rewrite both halves of the loop perform on it.
 *
 * A pin names this package and an exact version, in one of two forms: the npm
 * spec a reusable workflow hands to `npm exec`, and the `uses:` ref a caller
 * points at this repository with. Rewriting one is the same operation in two
 * places, for opposite reasons.
 *
 * `scripts/sync-version.ts` does it at **release** time, over this repository's
 * own fifteen sites, where a count that is not one is a broken release. `init`
 * (#6) does it at **adoption** time, writing this package's name and version
 * into *someone else's* repository, over whatever subset of the callers an
 * adopter took — where a varying count is the normal case.
 *
 * So the shared unit is narrow on purpose: one file's text in, the rewritten
 * text and the forms found out. It opens nothing, so it assumes nothing about
 * which directories a root has, and it takes the package name and the version as
 * **parameters** rather than reading either from the tree being rewritten —
 * which for `init` is an adopter's, whose `package.json` names an unrelated
 * project or is not there at all.
 *
 * It lives in `shared/` rather than beside `syncVersion` because this is the
 * half that **ships**. `tsconfig.build.json` keeps the release hook out of the
 * tarball by excluding it, and `exclude` does not stop `tsc` emitting a file
 * something *imports*: a runner importing the core from there would publish the
 * hook, CLI entry point and realpath guard included, compiled to a `dist/`
 * whose idea of the package root is one directory wrong. `ci.yml`'s tarball
 * guard filters test files only and would not see it.
 */

/** Forward slashes on purpose: this is a path *inside* YAML as much as on disk. */
export const WORKFLOW_DIR = ".github/workflows";

/**
 * A pin is an exact `major.minor.patch`, in both forms. `tests/workflows.test.ts`
 * matches no `^`, no `~` and no dist-tag in the `npm exec` line, and a `uses:`
 * ref has to be a tag `publish.yml` would accept. So a version that cannot be
 * written as a valid pin is refused rather than written into a file, whichever
 * half is doing the writing.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/** Which of the two pin forms a site carries. They are not interchangeable. */
export type PinForm = "package" | "ref";

/**
 * What a rewrite is written *for*: the package the pins name, and the version to
 * write into them.
 *
 * Both are parameters and neither is read from the tree being rewritten. For the
 * release the two happen to coincide with the target root's manifest; for `init`
 * they are this package's and the root is an adopter's.
 */
export interface Pinning {
  /** The npm name of the package a pin names — `@owner/repo`. */
  readonly packageName: string;
  /** Exact `major.minor.patch`; anything else is refused. */
  readonly version: string;
}

export interface PinRewrite {
  /** The text with every pin found rewritten. Unchanged if none was. */
  readonly text: string;
  /** One entry per pin rewritten, `package` pins first. */
  readonly found: readonly PinForm[];
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The one thing this refuses, and it refuses it in both halves: a version that
 * is not a pin. The release wants it raised before the first of fifteen files is
 * opened, so it is reachable on its own as well as through `rewritePins`.
 */
export const assertPinnable = (version: string): void => {
  if (!EXACT_VERSION.test(version)) {
    throw new Error(
      `Refusing to propagate the version ${JSON.stringify(version)}: a pin is an exact ` +
        `major.minor.patch version, with no range, no dist-tag and no \`v\`.`,
    );
  }
};

/** How each form is found and how each is written. The two are not interchangeable. */
const pinForms = ({ packageName, version }: Pinning): readonly {
  readonly form: PinForm;
  readonly pin: RegExp;
  readonly replacement: string;
}[] => [
  {
    form: "package",
    pin: new RegExp(`(--package=${escapeRe(packageName)}@)\\d+\\.\\d+\\.\\d+`, "g"),
    replacement: `$1${version}`,
  },
  {
    /**
     * Matched by shape rather than anchored to the workflow the file is expected
     * to call. A caller's count is the caller's business — `syncVersion` checks
     * it — and anchoring here would turn a caller that names the *wrong*
     * reusable into "no pin found": a true refusal with a misleading message,
     * for a mismatch `tests/workflows.test.ts` already reports by name.
     *
     * `@owner/repo` on npm is `owner/repo` on GitHub — one literal, not two. And
     * the directory is *this* package's layout, which is where an adopter's
     * caller points however their own repository is arranged.
     */
    form: "ref",
    pin: new RegExp(
      `(${escapeRe(packageName.replace(/^@/, ""))}/${escapeRe(WORKFLOW_DIR)}/[A-Za-z0-9._-]+\\.yml@)v\\d+\\.\\d+\\.\\d+`,
      "g",
    ),
    replacement: `$1v${version}`,
  },
];

/**
 * The shared core: rewrite every pin in one file's text, and say which form each
 * one was.
 *
 * It rules on nothing except the version it is asked to write. A count is
 * *reported*, and what an unexpected one means is the caller's to decide:
 * `syncVersion` refuses anything but one pin of the form it expected, because a
 * missed site is a broken release; `init` expects the count to vary, because an
 * adopter takes a subset.
 */
export const rewritePins = (text: string, pinning: Pinning): PinRewrite => {
  assertPinnable(pinning.version);

  let rewritten = text;
  const found: PinForm[] = [];
  for (const { form, pin, replacement } of pinForms(pinning)) {
    found.push(...(rewritten.match(pin) ?? []).map(() => form));
    rewritten = rewritten.replace(pin, replacement);
  }
  return { text: rewritten, found };
};
