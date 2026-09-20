import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS, run, type CliIo } from "../cli.js";
import { copyAssets } from "../scripts/copy-assets.js";
import {
  advisoryLabelSpecsFor,
  init,
  labelCommand,
  labelSpecsFor,
  STATE_LABELS,
  TRIGGER_LABELS,
} from "../setup/init.js";
import {
  asVisibility,
  availableSecrets,
  parseList,
  runDoctor,
  type RepoFacts,
} from "../setup/doctor.js";

/**
 * The runners ship as one versioned package with one binary (#96), so the entry
 * point is a subcommand table rather than five scripts addressed by path. Two
 * properties are worth holding mechanically:
 *
 * - **every runner is reachable.** A workflow directory with no table entry is a
 *   runner that exists and cannot be invoked, and nothing else would notice —
 *   the old form named the file directly, so adding one was self-wiring.
 * - **every asset a runner reads is shipped.** `files: ["dist"]` publishes
 *   compiled JS and nothing else, so a prompt that the build does not copy
 *   resolves to a path that exists in the source tree and not in the tarball.
 *   That failure only appears on a published version, in CI, in another repo.
 *
 * The table is deliberately open: `init` and `doctor` (#112) are two more
 * entries, so the checks below say *every runner is a command*, never *every
 * command is a runner*.
 */

const PACKAGE_DIR = ".";

/**
 * A workflow directory is one holding a runner named after it —
 * `implement/implement.ts`. Found by walking, so a runner added later is held to
 * the same rule on arrival: `shared/` and `scripts/` have no such file and drop
 * out without being listed.
 */
const runnerDirs = fs
  .readdirSync(PACKAGE_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => fs.existsSync(path.join(PACKAGE_DIR, name, `${name}.ts`)))
  .sort();

const manifest = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"),
) as { name: string; version: string };

interface Captured {
  code: number;
  out: string;
  err: string;
}

const invoke = async (argv: string[]): Promise<Captured> => {
  let out = "";
  let err = "";
  const io: CliIo = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
  };
  return { code: await run(argv, io), out, err };
};

/**
 * Every runner writes its failure reason to `OUTPUT_DIR` so the workflow's
 * `if: failure()` step can put it on the issue or PR. Point it at scratch for
 * the duration rather than letting the default (`/tmp`) collect test debris.
 */
let scratch = "";
const previousOutputDir = process.env["OUTPUT_DIR"];

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cli-"));
  process.env["OUTPUT_DIR"] = scratch;
});

afterEach(() => {
  if (previousOutputDir === undefined) delete process.env["OUTPUT_DIR"];
  else process.env["OUTPUT_DIR"] = previousOutputDir;
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("the runner CLI dispatches on a subcommand", () => {
  it("finds the runners to check", () => {
    expect(runnerDirs).toEqual([
      "fix",
      "follow-ups",
      "implement",
      "implement-prd",
      "review",
      "update-branch",
    ]);
  });

  it.each(runnerDirs)("%s: is reachable as a subcommand", (name: string) => {
    expect(Object.keys(COMMANDS)).toContain(name);
  });

  it("lists every command in its usage", async () => {
    const { code, out } = await invoke(["help"]);

    expect(code).toBe(0);
    for (const name of Object.keys(COMMANDS)) expect(out).toContain(name);
  });

  /**
   * The version the workflow pinned is the one question a run's log has to be
   * able to answer, for the same reason the model id is echoed: "which runner
   * produced this?" is asked of every output that looks wrong, and the answer
   * must not require knowing what the YAML said that week.
   */
  it("reports its own version", async () => {
    const { code, out } = await invoke(["--version"]);

    expect(code).toBe(0);
    expect(out.trim()).toBe(manifest.version);
  });

  /**
   * A mistyped subcommand is a workflow-YAML error, and the YAML is now the
   * base-controlled half — so it fails on the first run after the edit, at which
   * point the reason has to reach the human rather than the log. `fail()`'s
   * reasoning exactly: an issue comment that can only say "check the logs" is
   * one nobody checks.
   */
  it("refuses an unknown command, and says so where the workflow can read it", async () => {
    const { code, err } = await invoke(["implment"]);

    expect(code).toBe(2);
    expect(err).toContain("implment");
    expect(fs.readFileSync(path.join(scratch, "failure_reason.txt"), "utf8")).toContain("implment");
  });

  it("refuses an empty argv with usage", async () => {
    const { code, err } = await invoke([]);

    expect(code).toBe(2);
    expect(err).toContain("Usage");
  });

  /**
   * A runner takes its input from the environment, so an argument to one is a
   * misunderstanding of the interface — silently ignoring it would run the real
   * thing while the author believes a flag took effect. Refused *before* the
   * runner module is loaded: importing it starts the run, which is also why a
   * regression here fails by hanging or exiting the test process rather than by
   * a red assertion.
   *
   * The handover line is asserted on the same invocation, since it is printed
   * before the runner is reached: every run says which version it is on, for the
   * reason `shared/common.ts` echoes the model id.
   */
  it.each(runnerDirs)(
    "%s: refuses arguments rather than ignoring them",
    async (name: string) => {
      const { code, out, err } = await invoke([name, "--dry-run"]);

      expect(code).toBe(2);
      expect(err).toContain("--dry-run");
      expect(out).toContain(`agent-workflows ${manifest.version}: ${name}`);
    },
  );

  /**
   * `follow-ups` (#49) is the one runner that runs no model, and that is a
   * security property rather than an implementation detail: its workflow is the
   * only one in the loop holding `issues: write`, and a model reading arbitrary
   * issue bodies while holding it is a prompt-injection surface nothing here
   * currently has. So no prompt, no extraction, no agent.
   *
   * Asserted over the source because nothing else can see it. The permissions
   * half is the workflow's to state; this half is invisible until something
   * imports `claudeAgent` and the loop quietly grows a sixth model call.
   */
  it("follow-ups runs no model and holds no prompt", () => {
    const dir = path.join(PACKAGE_DIR, "follow-ups");

    expect(fs.readdirSync(dir).filter((entry) => entry.endsWith(".md"))).toEqual([]);
    const source = fs.readFileSync(path.join(dir, "follow-ups.ts"), "utf8");
    expect(source).not.toContain("claudeAgent");
    expect(source).not.toContain("sandcastle");
    expect(source).not.toContain("runWithExtraction");
  });
});

/**
 * The publish step. `tsc` emits `.js` and nothing else, so every `.md` a runner
 * reads at `import.meta.dirname` has to be copied into the same relative place
 * under `dist/` — otherwise the prompt resolves in a checkout and not in the
 * tarball, which is the one environment nothing here exercises.
 */
describe("the build ships every prompt beside its runner", () => {
  const mdFilesUnder = (dir: string, prefix = ""): readonly string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          return ["dist", "node_modules", "output", "docs"].includes(entry.name)
            ? []
            : mdFilesUnder(path.join(dir, entry.name), rel);
        }
        return entry.name.endsWith(".md") ? [rel] : [];
      })
      .sort();

  it("copies each one to the same relative path", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-assets-"));
    try {
      copyAssets(PACKAGE_DIR, out);

      const shipped = mdFilesUnder(PACKAGE_DIR).filter((rel) => rel.includes("/"));

      expect(shipped).not.toHaveLength(0);
      for (const rel of shipped) {
        expect(fs.readFileSync(path.join(out, rel), "utf8")).toBe(
          fs.readFileSync(path.join(PACKAGE_DIR, rel), "utf8"),
        );
      }
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  /**
   * `init` reads the reference callers out of the tarball the same way a runner
   * reads its prompt — at a path relative to its own module — so they are an
   * asset of exactly the kind this step exists for. `tsc` would leave them
   * behind, and the symptom is an `init` that works in a checkout and finds
   * nothing at all once published.
   */
  it("ships the reference callers init copies", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-assets-"));
    try {
      copyAssets(PACKAGE_DIR, out);

      const callers = fs
        .readdirSync(path.join(PACKAGE_DIR, "examples", "callers"))
        .filter((entry) => entry.endsWith(".yml"));

      expect(callers).not.toHaveLength(0);
      for (const file of callers) {
        expect(fs.readFileSync(path.join(out, "examples", "callers", file), "utf8")).toBe(
          fs.readFileSync(path.join(PACKAGE_DIR, "examples", "callers", file), "utf8"),
        );
      }
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  /**
   * The package's own README is documentation for whoever installs it, not an
   * asset a runner resolves — shipping it into `dist/` would put a second copy
   * beside `cli.js` for npm to serve from the tarball root anyway.
   */
  it("leaves the package's own documentation out of dist", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-assets-"));
    try {
      copyAssets(PACKAGE_DIR, out);

      expect(fs.existsSync(path.join(out, "README.md"))).toBe(false);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  /**
   * And neither is `docs/`. This one is load-bearing rather than tidy: while the
   * package lived at `.sandcastle/agent-workflows/` inside the linter, the repo's
   * `docs/` was outside it and unreachable by the walk. At a repository root it is
   * a sibling of the runner directories and looks exactly like one, so the walk
   * that exists to make sure no prompt is ever forgotten will happily ship
   * `friction.md`, `ADOPTING.md` and `parity.md` to every consumer — 30 kB to
   * 102 kB — unless it is told not to.
   */
  it("leaves docs/ out of dist", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-assets-"));
    try {
      copyAssets(PACKAGE_DIR, out);

      expect(fs.existsSync(path.join(out, "docs"))).toBe(false);
      expect(fs.existsSync(path.join(PACKAGE_DIR, "docs/ADOPTING.md"))).toBe(true);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});

/**
 * The second surface (#6). `init` and `doctor` are the **install path** rather
 * than runners: they are run by a human at a terminal, in somebody else's
 * checkout, and they take arguments — which is why they do not live in a
 * `<name>/<name>.ts` directory and why the table above says *every runner is a
 * command* and never the reverse.
 *
 * They are subcommands of the same binary on purpose. The version that writes a
 * pin has to be the version that pin names, and the version that diagnoses a
 * loop has to be the one whose guards it knows about — one install, one version,
 * no second thing to keep in step.
 */
describe("init installs the reference callers into an adopting repo", () => {
  /** An adopter's checkout: a repository, and nothing this loop put there. */
  const adopter = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-init-"));
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    return root;
  };

  const roots: string[] = [];
  const adopted = (): string => {
    const root = adopter();
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const read = (root: string, rel: string): string =>
    fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");

  const referenceNames = fs
    .readdirSync(path.join("examples", "callers"))
    .filter((entry) => entry.endsWith(".yml"))
    .map((entry) => entry.replace(/\.yml$/, ""))
    .sort();

  it("writes one caller per reference file, pinned to this package's own version", async () => {
    const root = adopted();

    const changes = await init({ dir: root });

    expect(changes.filter((c) => c.file.endsWith(".yml")).map((c) => c.action)).toEqual(
      referenceNames.map(() => "created"),
    );
    for (const name of referenceNames) {
      const text = read(root, `.github/workflows/agent-${name}.yml`);
      expect(text).toContain(`/.github/workflows/${name}.yml@v${manifest.version}`);
      expect(text).toContain("packages: read");
    }
  });

  /**
   * `self-check` is `<caller job id> / <called job id>` and is the one coupling
   * in a caller with no runtime symptom, so nothing is written without it
   * naming the job it sits in — `assertCoupled` reads the result back rather
   * than trusting that a rewrite was applied.
   */
  it("writes a self-check naming the job it sits in", async () => {
    const root = adopted();

    await init({ dir: root });

    expect(read(root, ".github/workflows/agent-review.yml")).toMatch(
      /^\s*self-check: review \/ review$/m,
    );
  });

  /**
   * Re-run updates rather than refusing (the opposite of upstream's `init`,
   * which tells you to remove it first): the commonest reason to run this twice
   * is a new release, and a scaffolder that refuses the second run is one an
   * adopter works around by hand.
   *
   * But an update is the **pin and nothing else**. A caller is the half an
   * adopter owns, and everything in this scenario is something they really do
   * set: the `with:` inputs `docs/ADOPTING.md` §4 ships commented out — a pnpm
   * repo whose `setup:` were reverted here dies at `npm ci` with nothing saying
   * why — a renamed job, and a permission of their own. A re-run that rewrote
   * the file from the reference would revert all of it and report `updated`,
   * which is the failure class this command exists to remove.
   */
  it("moves the pin on a re-run and changes nothing else in a caller", async () => {
    const root = adopted();
    await init({ dir: root });
    const theirs = read(root, ".github/workflows/agent-review.yml")
      .replace(/^  review:$/m, "  agent_review:")
      .replace(/self-check: review \/ review/, "self-check: agent_review / review")
      .replace(/^(    with:)$/m, "$1\n      default-branch: trunk\n      node-version-file: .tool-versions\n      setup: pnpm i --frozen-lockfile")
      .replace(/^      pull-requests: write$/m, "      pull-requests: write\n      issues: write")
      .replace(`@v${manifest.version}`, "@v0.0.1");
    fs.writeFileSync(path.join(root, ".github", "workflows", "agent-review.yml"), theirs);

    const changes = await init({ dir: root });

    const text = read(root, ".github/workflows/agent-review.yml");
    expect(text).toBe(theirs.replace("@v0.0.1", `@v${manifest.version}`));
    // Named as well as compared, so an edit above that silently matched
    // nothing cannot leave this asserting that two identical files are equal.
    expect(text).toContain("setup: pnpm i --frozen-lockfile");
    expect(text).toContain("default-branch: trunk");
    expect(text).toContain("issues: write");
    expect(text).toMatch(/^  agent_review:$/m);
    expect(changes.find((c) => c.file.endsWith("agent-review.yml"))?.action).toBe("updated");
  });

  /**
   * A caller an adopter deleted is a subset they chose — §4 says to take the
   * ones you want — and a re-run is how you take a release, not how you get the
   * loop's opinion about your workflows back. It is named rather than written,
   * so the same report also tells an adopter that a workflow added in a later
   * release exists at all, instead of a `pull_request_target` trigger appearing
   * in their tree behind them.
   */
  it("does not put back a caller the adopter deleted, and says it did not", async () => {
    const root = adopted();
    await init({ dir: root });
    fs.rmSync(path.join(root, ".github", "workflows", "agent-update-branch.yml"));

    const changes = await init({ dir: root });

    expect(fs.existsSync(path.join(root, ".github", "workflows", "agent-update-branch.yml"))).toBe(
      false,
    );
    const change = changes.find((c) => c.file.endsWith("agent-update-branch.yml"));
    expect(change?.action).toBe("kept");
    expect(change?.note ?? "").toContain("examples/callers/update-branch.yml");
  });

  /**
   * The filename is ours by convention only. A workflow of an adopter's own
   * that happens to be called `agent-fix.yml` is a file this never wrote, and
   * overwriting it is the same act the re-run above refuses — with worse
   * consequences, since nothing in it was ever a caller.
   */
  it("refuses to write over a file of the same name that is not a caller", async () => {
    const root = adopted();
    const theirs = "name: Our own fix job\non: workflow_dispatch\njobs:\n  fix:\n    runs-on: ubuntu-latest\n";
    fs.writeFileSync(path.join(root, ".github", "workflows", "agent-fix.yml"), theirs);

    const changes = await init({ dir: root });

    expect(read(root, ".github/workflows/agent-fix.yml")).toBe(theirs);
    expect(changes.find((c) => c.file.endsWith("agent-fix.yml"))?.action).toBe("kept");
  });

  it("reports an unchanged caller rather than rewriting it", async () => {
    const root = adopted();
    await init({ dir: root });

    const changes = await init({ dir: root });

    expect(changes.filter((c) => c.file.endsWith(".yml")).map((c) => c.action)).toEqual(
      referenceNames.map(() => "unchanged"),
    );
  });

  /**
   * The judgement work, handed to the adopter's own agent the way sandcastle's
   * `init` hands over a tracker it cannot configure: secrets, a repository
   * setting, the labels, and the two documents that decide whether the output is
   * any good. None of it is detectable from a checkout.
   */
  it("emits a SETUP.md prompt for the work it cannot do", async () => {
    const root = adopted();

    await init({ dir: root });

    const setup = read(root, "SETUP.md");
    expect(setup).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(setup).toContain("AGENT_PAT");
    expect(setup).toContain("agent:in-progress");
    expect(setup).toContain("doctor");
    expect(setup).toContain(manifest.name);
  });

  /**
   * `SETUP.md` is a name an adopter may already be using. Overwriting the
   * callers is the point; overwriting a document somebody wrote is not, so the
   * one file that is not ours by construction is the one that carries a marker
   * and is left alone without it.
   */
  it("leaves a SETUP.md it did not write alone, and says so", async () => {
    const root = adopted();
    fs.writeFileSync(path.join(root, "SETUP.md"), "# How we set this repo up\n");

    const changes = await init({ dir: root });

    expect(read(root, "SETUP.md")).toBe("# How we set this repo up\n");
    const change = changes.find((c) => c.file === "SETUP.md");
    expect(change?.action).toBe("kept");
    expect(change?.note ?? "").toMatch(/not written by/i);
  });

  it("is reachable as a subcommand and takes a directory", async () => {
    const root = adopted();

    const { code, out } = await invoke(["init", "--dir", root]);

    expect(code).toBe(0);
    expect(out).toContain("agent-implement.yml");
    expect(fs.existsSync(path.join(root, "SETUP.md"))).toBe(true);
  });

  it("refuses a flag it does not know rather than ignoring it", async () => {
    const { code, err } = await invoke(["init", "--force"]);

    expect(code).toBe(2);
    expect(err).toContain("--force");
  });

  /**
   * A `--dir` that is not there is a typo rather than a request, and `put`
   * mkdirs recursively: it would scaffold a whole repository under a directory
   * nobody has — reporting the same repo-relative lines a correct run does,
   * with the repository being adopted untouched. Refused as bad usage, which is
   * what a mistyped path is, and on the same grounds as the `SETUP.md` and the
   * filename this will not write over.
   */
  it("refuses a --dir that does not exist rather than scaffolding one", async () => {
    const missing = path.join(os.tmpdir(), "agent-init-absent", "typo", "path");

    const { code, err } = await invoke(["init", "--dir", missing]);

    expect(code).toBe(2);
    expect(err).toContain(missing);
    expect(fs.existsSync(missing)).toBe(false);
  });

  /**
   * And a `--dir` that exists but is a *file* is the same typo with a worse
   * ending: `put`'s recursive mkdir throws `ENOTDIR` from inside the
   * scaffolding, so the same mistake exits 1 with a message about a directory
   * nobody named. Both commands take it, so both are checked.
   */
  it.each(["init", "doctor"])("refuses a --dir that is a file rather than a directory", async (command: string) => {
    const file = path.join(os.tmpdir(), `agent-dir-file-${command}-${process.pid}`);
    fs.writeFileSync(file, "");
    try {
      const { code, err } = await invoke([command, "--dir", file]);

      expect(code).toBe(2);
      expect(err).toContain(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  /** And where it did work, since every other line it prints is repo-relative. */
  it("names the directory it worked in", async () => {
    const root = adopted();

    const { out } = await invoke(["init", "--dir", root]);

    expect(out).toContain(path.resolve(root));
  });

  /**
   * Every `{{…}}` in the template has a substitution behind it. One added to
   * `setup/SETUP.md` without a `replaceAll` for it ships as literal braces into
   * an adopter's tree, inside a command they are told to run.
   */
  it("leaves no placeholder unsubstituted in the prompt it writes", async () => {
    const root = adopted();

    await init({ dir: root });

    expect(read(root, "SETUP.md")).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  /**
   * Every `gh label create` block §3 ships, in the order it ships them: the
   * labels it **mandates** first, then the ones it documents conditionally.
   * Scoped to §3 so a block added to another section cannot become the first.
   */
  const documentedLabels = (): readonly { name: string; color: string; description: string }[][] =>
    ((fs
      .readFileSync(path.join("docs", "ADOPTING.md"), "utf8")
      .split(/^(?=## )/m)
      .find((section) => section.startsWith("## 3.")) ?? "").match(/```bash\n[\s\S]*?```/g) ?? [])
      .map((block) =>
        [
          ...block.matchAll(/^gh label create +"([^"]+)" +--color +(\S+) +--description +"([^"]+)"$/gm),
        ].map(([, name, color, description]) => ({
          name: name ?? "",
          color: color ?? "",
          description: description ?? "",
        })),
      )
      .filter((block) => block.length > 0);

  const byName = (labels: readonly { name: string }[]) =>
    [...labels].sort((a, b) => a.name.localeCompare(b.name));

  /**
   * The label table in `setup/init.ts` is a **second copy** of `docs/ADOPTING.md`
   * §3: the doc is what a human reads, the table is what `SETUP.md` tells them
   * to run and what `doctor` demands exists. Nothing else holds the two in step,
   * and a rename in either place — or in the `if:` a workflow filters on — would
   * leave `init` scaffolding one string and the loop waiting for another, which
   * is a transition that no-ops rather than anything that errors.
   *
   * So this is `PIN`'s trick for labels: parse the block the doc actually ships
   * and compare it, colour and description included — **the mandated block**,
   * which is the first of the two §3 now carries (#51).
   */
  it("scaffolds exactly the labels docs/ADOPTING.md §3 mandates", () => {
    const mandated = documentedLabels()[0] ?? [];

    // The block itself has to still be there: a doc restructure that moved it
    // would otherwise make this pass by comparing nothing.
    expect(mandated).toHaveLength(6);
    expect(byName([...TRIGGER_LABELS, ...STATE_LABELS])).toEqual(byName(mandated));
  });

  /**
   * And scaffolds none of the ones it documents **conditionally**.
   *
   * `pr-follow-up` and `needs-triage` matter only to a repository that installed
   * the filing caller, and `agent:follow-ups` is added by a step that warns
   * rather than failing. Putting any of them in the tables above would put them
   * in `SETUP.md` — which is fine — *and* in `doctor`'s missing-label check,
   * which is not: a preflight that fails a correctly-installed loop over a label
   * its workflows never look for is a preflight people learn to ignore.
   *
   * Asserted from the doc rather than from a list, so a fourth conditional label
   * is covered by arriving in that block. The block has to exist for the same
   * reason the one above does.
   */
  it("scaffolds none of the labels §3 documents conditionally", () => {
    const conditional = documentedLabels().slice(1).flat();
    const scaffolded = new Set([...TRIGGER_LABELS, ...STATE_LABELS].map((label) => label.name));
    // The function `doctor` demands from, named rather than inferred from the
    // tables: what must not happen is a preflight erroring over one of these.
    const demanded = new Set(labelSpecsFor(referenceNames).map((label) => label.name));

    expect(conditional.length).toBeGreaterThan(0);
    for (const label of conditional) {
      expect(scaffolded).not.toContain(label.name);
      expect(demanded).not.toContain(label.name);
    }
  });

  /**
   * …and **names** them in the `SETUP.md` it writes, which is the other half of
   * that decision rather than a contradiction of it (#54).
   *
   * `init` scaffolds the filing caller on a first run, so an adopter who ran it
   * has a live feature whose three labels no artifact they hold mentions — the
   * review marks nothing, the stubs file unlabelled, and the only signal is a
   * `::warning::` inside a green run, which is §1's own signature. Telling them
   * is free; failing them over it is what `doctor` still declines to do.
   *
   * Compared against the doc block rather than a list here too, so the third
   * copy of these strings — `ADVISORY_LABELS` — cannot drift from §3 either.
   */
  it("names the conditional labels in the prompt when it installed the caller that wants them", async () => {
    const root = adopted();
    const conditional = documentedLabels().slice(1).flat();

    await init({ dir: root });

    expect(byName(advisoryLabelSpecsFor(referenceNames))).toEqual(byName(conditional));
    for (const label of conditional) expect(read(root, "SETUP.md")).toContain(labelCommand(label));
  });

  /**
   * And says nothing about them to a repository that declined that caller (§4).
   * Three labels prescribed to a repository where nothing will ever read them
   * is a setup list with a step that cannot be completed for a reason — which
   * is how a checklist stops being worked through.
   */
  it("says nothing about them once the caller that wants them is gone", async () => {
    const root = adopted();
    await init({ dir: root });

    fs.rmSync(path.join(root, ".github", "workflows", "agent-follow-ups.yml"));
    await init({ dir: root });

    const setup = read(root, "SETUP.md");
    for (const label of documentedLabels().slice(1).flat()) {
      expect(setup).not.toContain(label.name);
    }
    // The mandated six are untouched by any of that.
    for (const label of [...TRIGGER_LABELS, ...STATE_LABELS]) {
      expect(setup).toContain(labelCommand(label));
    }
  });
});

/**
 * `doctor` is the other half: every check below is a failure `docs/ADOPTING.md`
 * §1 describes as announcing itself as something else. The facts it cannot read
 * from a checkout — the secrets, the repository setting, the labels, this repo's
 * releases — are gathered through `gh` and passed in, so the diagnosis is
 * exercised here without depending on whoever is running the suite being
 * authenticated to anything.
 */
describe("doctor names the failures that otherwise look like something else", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  /** A repository `init` has just finished with — the state doctor should pass. */
  const installed = async (): Promise<string> => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-doctor-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    await init({ dir: root });
    return root;
  };

  /**
   * A caller written by hand rather than copied, for the shapes the reference
   * set does not ship: it puts `permissions:` on the job, and what is worth
   * exercising here is where else an adopter may legally put it.
   */
  const adoptedWith = (top: readonly string[], jobPermissions: readonly string[] = []): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-doctor-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".github", "workflows", "agent-review.yml"),
      [
        "name: Agent Review",
        "on:",
        "  pull_request_target:",
        "    types: [labeled]",
        ...top,
        "jobs:",
        "  review:",
        `    uses: ${manifest.name.replace(/^@/, "")}/.github/workflows/review.yml@v${manifest.version}`,
        ...jobPermissions,
        "    with:",
        "      self-check: review / review",
        // The wires a real caller carries, since every scenario built from this
        // helper is about somewhere *else* being wrong.
        "    secrets:",
        "      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
        "      AGENT_PAT: ${{ secrets.AGENT_PAT }}",
        "",
      ].join("\n"),
    );
    return root;
  };

  /** Everything `gh` would have answered, on a correctly configured repository. */
  const healthy = (): RepoFacts => ({
    secrets: ["CLAUDE_CODE_OAUTH_TOKEN", "AGENT_PAT"],
    canCreatePullRequests: true,
    // The restricted default, which is what a repository created since February
    // 2023 has. Every reference caller declares its own block, so it is the
    // callers that declare *none* the setting decides anything for.
    defaultWorkflowPermissions: "read",
    labels: [
      "agent:implement",
      "agent:review",
      "agent:fix",
      "agent:update-branch",
      "agent:in-progress",
      "agent:blocked",
    ],
    visibility: "private",
    releases: [`v${manifest.version}`],
  });

  /**
   * Break one caller, and insist that the break landed. Every scenario below is
   * a text edit against the real reference callers, so a comment reworded there
   * would otherwise turn a scenario into a test of nothing that still passes.
   */
  const edit = (root: string, file: string, change: (text: string) => string): void => {
    const full = path.join(root, ".github", "workflows", file);
    const before = fs.readFileSync(full, "utf8");
    const after = change(before);

    expect(after).not.toBe(before);
    fs.writeFileSync(full, after);
  };

  const check = async (
    root: string,
    facts: RepoFacts,
  ): Promise<{ code: number; out: string; err: string }> => {
    let out = "";
    let err = "";
    const io: CliIo = {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    };
    return { code: await runDoctor({ dir: root, facts }, io), out, err };
  };

  it("passes a repository init has just set up", async () => {
    const { code, err } = await check(await installed(), healthy());

    expect(err).toBe("");
    expect(code).toBe(0);
  });

  it("fails a repository with no caller at all, and names init", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-doctor-"));
    roots.push(root);

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("init");
  });

  it.each([
    ["CLAUDE_CODE_OAUTH_TOKEN", ["AGENT_PAT"]],
    ["AGENT_PAT", ["CLAUDE_CODE_OAUTH_TOKEN"]],
  ])("fails when the %s secret is missing", async (missing: string, present: string[]) => {
    const { code, err } = await check(await installed(), { ...healthy(), secrets: present });

    expect(code).toBe(1);
    expect(err).toContain(missing);
  });

  /**
   * §1's first failure. A PAT bypasses the setting entirely — a user token is
   * not the Actions bot — so the severity depends on the other answer rather
   * than on this one alone.
   */
  it("fails the repository setting only when no PAT makes it moot", async () => {
    const root = await installed();

    const off = await check(root, { ...healthy(), canCreatePullRequests: false });
    expect(off.code).toBe(0);
    expect(off.out).toMatch(/create.*pull request/i);

    const alone = await check(root, {
      ...healthy(),
      canCreatePullRequests: false,
      secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
    });
    expect(alone.code).toBe(1);
    expect(alone.err).toMatch(/create.*pull request/i);
  });

  it("fails a caller that dropped packages: read, and names the grant", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) => text.replace(/^ *packages: read$/m, ""));

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("packages: read");
    expect(err).toContain("agent-fix.yml");
  });

  /**
   * The sixth silent failure, and the one that only exists on a private repo:
   * the check-runs API serves a public repository without the scope, so v0.1.0
   * through v0.1.4 shipped without it and nothing failed until the first private
   * adopter reviewed with no CI evidence at all.
   */
  it("fails a private repo's review caller without checks: read, and warns a public one", async () => {
    const root = await installed();
    edit(root, "agent-review.yml", (text) => text.replace(/^ *checks: read$/m, ""));

    const isPrivate = await check(root, healthy());
    expect(isPrivate.code).toBe(1);
    expect(isPrivate.err).toContain("checks: read");

    const isPublic = await check(root, { ...healthy(), visibility: "public" });
    expect(isPublic.code).toBe(0);
    expect(isPublic.out).toContain("checks: read");
  });

  /**
   * `permissions: write-all` is a string where the block is usually a map, and a
   * blanket grant really does include the scope. Telling someone to add a
   * permission they already hold is the one thing a preflight cannot afford: a
   * wrong finding is how a list of real ones stops being read.
   */
  it("does not invent a missing grant on a caller that granted everything", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) =>
      text.replace(/^    permissions:\n(?:.*\n)*?    # No `with:`/m, "    permissions: write-all\n    # No `with:`"),
    );

    const { code, err } = await check(root, healthy());

    expect(err).not.toContain("packages: read");
    expect(code).toBe(0);
  });

  /**
   * `permissions:` is equally legal at the **workflow top level**, where GitHub
   * applies it to every job — a `uses:` job included — and an adopter who keeps
   * one block above `jobs:` rather than repeating it per job is correctly
   * permissioned. Reading only the job's own block reports every grant missing
   * and offers a fix that changes nothing, which is the wrong-diagnosis class
   * the `write-all` case above exists to prevent, on a shape far more common.
   */
  it("reads permissions declared above jobs: as the grants the job runs with", async () => {
    const root = adoptedWith([
      "permissions:",
      "  checks: read",
      "  contents: read",
      "  packages: read",
      "  pull-requests: write",
    ]);

    const { code, err } = await check(root, healthy());

    expect(err).toBe("");
    expect(code).toBe(0);
  });

  /**
   * Which also decides what the *fix* says. A job that inherits and is told to
   * add the grant to its own block would be told to create one — replacing the
   * top-level block and losing every grant it currently holds. A preflight that
   * hands out that instruction is worse than one that said nothing.
   */
  it("points a caller that inherits at the block it actually has", async () => {
    const root = adoptedWith(["permissions:", "  checks: read", "  contents: read"]);

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("packages: read");
    expect(err).toMatch(/top-level `permissions:` block/);
  });

  /**
   * And the other half of the same rule: a job's own block **replaces** the
   * top-level one wholesale rather than merging into it, so a top-level grant
   * the job then narrows past is genuinely gone at run time.
   */
  it("treats a job's own permissions as replacing the top-level block", async () => {
    const root = adoptedWith(
      ["permissions:", "  packages: read", "  pull-requests: write"],
      ["    permissions:", "      checks: read", "      contents: read"],
    );

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("packages: read");
  });

  /**
   * `checks: read` is the one row whose severity depends on a fact `gh` may not
   * be able to read, and unknown resolves to the private branch on purpose — a
   * needless grant costs nothing and a missing one reviews blind. What must not
   * happen is the guess arriving as a determination: unlike the secrets, the
   * setting and the labels, an unreadable visibility raises no finding of its
   * own, so an unauthenticated run against a public repo would otherwise exit 1
   * with nothing at all saying the severity was assumed.
   */
  it("says the private-only grant was failed on an assumption when visibility is unknown", async () => {
    const root = await installed();
    edit(root, "agent-review.yml", (text) => text.replace(/^ *checks: read$/m, ""));

    const { code, err } = await check(root, { ...healthy(), visibility: undefined });

    expect(code).toBe(1);
    expect(err).toContain("checks: read");
    expect(err).toMatch(/could not be read[\s\S]*private/);
  });

  /**
   * The third place a grant can come from is nowhere at all: a job with no
   * `permissions:` block on it and none above `jobs:` runs with the repository's
   * default `GITHUB_TOKEN`, and **both** defaults grant `packages: read` — the
   * restricted one is worded "read repository contents and packages
   * permissions". So the scope rows must not fire here, and above all the fix
   * must not be "add `packages: read` to that job": a job-level block replaces
   * the inherited token rather than adding to it, so following that instruction
   * would drop `pull-requests: write` on a loop that was working.
   */
  it("does not demand packages: read of a caller that inherits the default token", async () => {
    const { err } = await check(adoptedWith([]), healthy());

    expect(err).not.toContain("packages: read");
    expect(err).not.toMatch(/to that job's `permissions:` block/);
  });

  /**
   * What is wrong with that caller is the block, not a scope. Under the
   * restricted default it installs the runner and then 403s on every write it
   * makes, so it is one finding whose fix is the whole reference block.
   */
  it("names the absent permissions block, and points at the whole reference block", async () => {
    const { code, err } = await check(adoptedWith([]), healthy());

    expect(code).toBe(1);
    expect(err).toContain("declares no `permissions:` block");
    expect(err).toContain("examples/callers/review.yml");
  });

  it("says nothing about a caller inheriting a permissive default token", async () => {
    const { code, err } = await check(adoptedWith([]), {
      ...healthy(),
      defaultWorkflowPermissions: "write",
    });

    expect(err).toBe("");
    expect(code).toBe(0);
  });

  /**
   * And here the unreadable fact errs the *other* way from the visibility guess
   * above, deliberately: there the cost of being wrong was a grant nobody
   * needed, and here it would be exit 1 on a repository whose default is the
   * permissive one and whose loop works.
   */
  it("reports an inherited token it could not read as something to check", async () => {
    const { code, out } = await check(adoptedWith([]), {
      ...healthy(),
      defaultWorkflowPermissions: undefined,
    });

    expect(code).toBe(0);
    expect(out).toContain("could not be read");
  });

  /**
   * `gh repo view --json visibility` has answered both `PUBLIC` and `public`
   * across releases, so the reader folds the case once rather than listing
   * spellings. An internal repository whose `gh` lowercased the field would
   * otherwise fall through to `undefined` and be failed with a sentence saying
   * its visibility could not be read — severity right, sentence untrue. Internal
   * counts as private because the check-runs API 403s on it just the same.
   */
  it("reads a visibility in whichever case gh answered it", () => {
    expect(["PUBLIC", "public", "Public"].map((raw) => asVisibility(raw))).toEqual([
      "public",
      "public",
      "public",
    ]);
    expect(["PRIVATE", "private", "INTERNAL", "internal"].map((raw) => asVisibility(raw))).toEqual([
      "private",
      "private",
      "private",
      "private",
    ]);
    expect(asVisibility("")).toBeUndefined();
    expect(asVisibility(undefined)).toBeUndefined();
  });

  /**
   * A mistyped `--dir` would otherwise be diagnosed as "no workflow here calls
   * this package, run `init`" — a real finding about a directory that does not
   * exist, with `gh` asked about whatever repository the shell happened to be
   * in. Bad usage, like `init`'s.
   */
  it("refuses a --dir that does not exist rather than diagnosing it", async () => {
    const missing = path.join(os.tmpdir(), "agent-doctor-absent", "typo");

    const { code, err } = await invoke(["doctor", "--dir", missing]);

    expect(code).toBe(2);
    expect(err).toContain(missing);
  });

  it("fails a caller pinned to a branch rather than a tag or a SHA", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) => text.replace(`@v${manifest.version}`, "@main"));

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toMatch(/tag|sha/i);
  });

  /**
   * Pin *shape* is what the check above covers, and freshness is the one that
   * has actually rotted: the repository this loop was piloted on sat four
   * releases behind, silently. A report rather than a failure — a stale pin is
   * a working loop on an old version, not a broken one.
   */
  it("reports how many releases a pin is behind, without failing on it", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) => text.replace(`@v${manifest.version}`, "@v0.1.1"));

    const { code, out } = await check(root, {
      ...healthy(),
      releases: [`v${manifest.version}`, "v0.1.3", "v0.1.2", "v0.1.1"],
    });

    expect(code).toBe(0);
    expect(out).toContain("3 releases behind");
  });

  /**
   * The tags endpoint answers a page at a time, so the pin most likely to have
   * rotted is the one most likely to have fallen off the end of it. Reporting
   * nothing there would make the stalest pins the quiet ones — the exact
   * inversion this check exists to undo.
   */
  it("still reports a pin older than the latest tag it could not find in the list", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) => text.replace(`@v${manifest.version}`, "@v0.0.1"));

    const { code, out } = await check(root, { ...healthy(), releases: [`v${manifest.version}`] });

    expect(code).toBe(0);
    expect(out).toMatch(/older than/);
  });

  it("fails a missing trigger label and gives the command that creates it", async () => {
    const root = await installed();
    const facts = healthy();

    const { code, err } = await check(root, {
      ...facts,
      labels: (facts.labels ?? []).filter((name) => name !== "agent:blocked"),
    });

    expect(code).toBe(1);
    expect(err).toContain("agent:blocked");
    expect(err).toContain("gh label create");
  });

  /**
   * And it is the *same* command `init` told them to run, colour and
   * description included. Only the name decides anything at run time, so this
   * breaks no loop — but the two halves of one install path handing out two
   * different definitions of a label is how `docs/ADOPTING.md` §3 stops being
   * true of a repository that did what it was told.
   */
  it("offers the label command init's SETUP.md already listed", async () => {
    const root = await installed();
    const facts = healthy();
    const command =
      STATE_LABELS.filter((label) => label.name === "agent:blocked").map(labelCommand)[0] ?? "";

    const { err } = await check(root, {
      ...facts,
      labels: (facts.labels ?? []).filter((name) => name !== "agent:blocked"),
    });

    expect(command).toContain("--color");
    expect(err).toContain(command);
    expect(fs.readFileSync(path.join(root, "SETUP.md"), "utf8")).toContain(command);
  });

  /**
   * `self-check` has no runtime symptom at all: a job that does not recognise
   * its own check run waits for itself, for 15 of its 20 minutes, and then
   * reviews on degraded evidence.
   */
  it("fails a self-check that does not name the job it is in", async () => {
    const root = await installed();
    edit(root, "agent-review.yml", (text) => text.replace(/^  review:$/m, "  reviewer:"));

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("self-check");
  });

  /**
   * Both halves of the name, because a check run named wrongly in either is a
   * check run that does not exist — and the consequence is identical. A
   * `self-check` with no `/` in it is what somebody writes from memory; one
   * naming the wrong called job is what a rename leaves behind. Neither says
   * anything at run time, so a check that read only the first half passed both
   * and left the wait counting its own job among the ones to wait for.
   *
   * The called half is the reusable's job id, which is its filename
   * (`tests/workflows.test.ts`), so the fix can name the whole of it rather
   * than re-emitting whichever wrong half was already there.
   */
  it.each([
    ["names no called job at all", "self-check: review"],
    ["names the wrong called job", "self-check: review / reviewer"],
    // And the whitespace, which is not whitespace: `review.yml` filters with
    // `select(.name != env.SELF_CHECK)`, a byte comparison against the check
    // run's own name, so ` / ` is part of the value rather than spacing around
    // it. `review/review` is what somebody writes from memory and it excludes
    // nothing — the same silence as a wrong job id, reached the other way.
    ["leaves out the spaces around the slash", "self-check: review/review"],
  ])("fails a self-check that %s", async (_case: string, written: string) => {
    const root = await installed();
    edit(root, "agent-review.yml", (text) =>
      text.replace(/self-check: review \/ review/, written),
    );

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("self-check");
    expect(err).toContain("Set `self-check: review / review`");
  });

  /**
   * The calling half is the job's **display name**, which is the id only when
   * the job declares no `name:`. GitHub writes `jobs.<id>.name` into the check
   * run where it has one, and `docs/ADOPTING.md` §4 invites exactly that
   * rename — so composing the id here would fail a correctly-configured caller
   * and hand it a `fix:` that breaks a loop which currently works. The one
   * wrong finding a preflight cannot afford.
   *
   * The findings still name the job by **id**, because that is what an adopter
   * greps their YAML for.
   */
  it("reads the calling job's display name, not its id, as the first half", async () => {
    const root = await installed();
    edit(root, "agent-review.yml", (text) =>
      text
        .replace(/^  review:$/m, "  review:\n    name: Agent review")
        .replace("self-check: review / review", "self-check: Agent review / review"),
    );

    const { code, err } = await check(root, healthy());

    expect(err).toBe("");
    expect(code).toBe(0);
  });

  /** …and the id-shaped one is now the wrong answer on that same caller. */
  it("fails a named job whose self-check still states the job id", async () => {
    const root = await installed();
    edit(root, "agent-review.yml", (text) =>
      text.replace(/^  review:$/m, "  review:\n    name: Agent review"),
    );

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("Set `self-check: Agent review / review`");
    // Named by id, since that is what they will search their YAML for.
    expect(err).toContain("`review` job");
  });

  /**
   * The secret being *set* and the job being *handed* it are two facts, and
   * only the first is a repository setting. A `workflow_call` job receives what
   * its caller passes and nothing else, `AGENT_PAT` is optional on the other
   * side, and the `secrets.AGENT_PAT || secrets.GITHUB_TOKEN` fallback absorbs
   * the empty string it arrives as — so a caller an adopter rewrote without the
   * line runs the loop under the built-in token with the secret correctly set.
   * That is `docs/ADOPTING.md` §1's failures two, three and four, reached from
   * the one place nothing else here looks.
   */
  it("fails a caller that does not pass AGENT_PAT to the workflow it calls", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) =>
      text.replace(/^ *AGENT_PAT: .*$/m, ""),
    );

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("AGENT_PAT");
    expect(err).toContain("agent-fix.yml");
    expect(err).toContain("secrets: inherit");
  });

  /**
   * …and the caller that is *supposed* to hand over nothing (#50).
   *
   * `follow-ups.yml` declares no secrets at all: it runs no model, so there is
   * no `CLAUDE_CODE_OAUTH_TOKEN` to take, and it creates its issues with the
   * workflow token, so there is no `AGENT_PAT` either. The generic wiring check
   * above reads a caller's `secrets:` block and not the workflow behind it, so
   * without a fixed-list exemption it reports the reference caller this package
   * ships — and its `fix:` would have an adopter add a secret GitHub refuses to
   * pass to a workflow that does not declare it. A preflight whose advice breaks
   * a working loop is worse than no preflight.
   *
   * Run against the caller `init` really wrote rather than a fixture, so this is
   * the file an adopter would be handed the advice about. That it declares no
   * `secrets:` block at all is the other half of the pair, and is asserted where
   * the workflow shapes are — `tests/workflows.test.ts`, on both halves at once.
   */
  it("asks for no AGENT_PAT wire on the caller whose workflow takes no secrets", async () => {
    const root = await installed();

    const { code, out, err } = await check(root, healthy());

    expect(`${out}${err}`).not.toContain("agent-follow-ups.yml");
    expect(code).toBe(0);
  });

  /**
   * `secrets: inherit` hands over every secret the repository holds, which is
   * what the reference callers decline to do — but it does hand over this one,
   * so it is a wire rather than a fault. Reporting it would be a preflight
   * arguing with a choice.
   */
  it("accepts a caller that inherits every secret", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) =>
      text.replace(/^    secrets:\n(?:      .*\n)+/m, "    secrets: inherit\n"),
    );

    const { code, err } = await check(root, healthy());

    expect(err).toBe("");
    expect(code).toBe(0);
  });

  /**
   * And where the secret is not set either, the missing wire is the next thing
   * to do rather than a second fault: one error about the secret, and this
   * reported as something to know. Two errors for one cause is how a list of
   * real findings stops being read.
   */
  it("reports the missing wire as a warning when the secret is not set either", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) => text.replace(/^ *AGENT_PAT: .*$/m, ""));

    const { out, err } = await check(root, {
      ...healthy(),
      secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
    });

    expect(out).toContain("secrets wiring");
    expect(err).not.toContain("secrets wiring");
  });

  /**
   * GitHub keeps repository secrets and the organization secrets shared with a
   * repository at two endpoints, and an organization holding one Claude token
   * and one bot PAT centrally answers the first with nothing. Reading only that
   * one is two errors and exit 1 on a working loop, with a fix telling them to
   * duplicate an organization secret.
   *
   * The judgement is the third argument: `safeGh` renders the organization
   * endpoint's refusal of a user-owned repository (422 against this repository's
   * `gh`) and a 403 on an organization's as the same empty string, so knowing
   * there is no organization is what lets the first be read as "there are none"
   * rather than collapsing every org-less repository into unknown.
   */
  it("counts an organization's shared secrets as set, without collapsing repos that have none", () => {
    expect(availableSecrets([], ["AGENT_PAT"], true)).toEqual(["AGENT_PAT"]);
    expect(availableSecrets(["CLAUDE_CODE_OAUTH_TOKEN"], [], true)).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    // No organization to ask about: the absent list is the answer, not a silence.
    expect(availableSecrets([], undefined, false)).toEqual([]);
    // One that has an organization, whose list could not be read: absence
    // cannot be concluded from a list nobody was served.
    expect(availableSecrets([], undefined, true)).toBeUndefined();
    expect(availableSecrets([], undefined, undefined)).toBeUndefined();
    expect(availableSecrets(undefined, ["AGENT_PAT"], false)).toBeUndefined();
  });

  /** A fact `gh` could not answer is reported as unknown, never as a pass. */
  it("says what it could not read rather than treating it as fine", async () => {
    const { code, out } = await check(await installed(), {
      secrets: undefined,
      canCreatePullRequests: undefined,
      defaultWorkflowPermissions: undefined,
      labels: undefined,
      visibility: undefined,
      releases: undefined,
    });

    expect(code).toBe(0);
    expect(out).toMatch(/could not/i);
  });

  /**
   * …and the last line a human's eye lands on has to say the same thing. With
   * no `gh`, no auth or no admin, the only thing checked was the callers, and
   * "nothing broken" is then a claim about a repository nothing was read from —
   * at exactly the moment `setup/SETUP.md` §5 sends somebody here, and
   * permanently for an adopter who is not an admin. Exit 0 is still right:
   * nothing was found to be wrong.
   */
  it("does not say nothing is broken when no repository fact was read", async () => {
    const { code, out } = await check(await installed(), {
      secrets: undefined,
      canCreatePullRequests: undefined,
      defaultWorkflowPermissions: undefined,
      labels: undefined,
      visibility: undefined,
      releases: undefined,
    });

    expect(code).toBe(0);
    expect(out).not.toContain("nothing broken");
    expect(out).toContain("No repository fact could be read");

    // And it is still said where something *was* read, so the sentence stays
    // the one a working run ends on.
    const known = await check(await installed(), healthy());
    expect(known.out).toContain("nothing broken");
  });

  /**
   * The other side of that, and the one the shape of `gh`'s output decides: a
   * repository with **no** secrets is a fact, not a silence, and it is the state
   * a repository is in at exactly the moment `SETUP.md` §5 says to run this.
   * Asked for as lines, `[]` and "could not read" are both empty output and the
   * first run would pass on the first day. So the query asks for a JSON array,
   * and only a `gh` that answered nothing at all is unknown.
   */
  it("reads an empty list as empty rather than as unreadable", async () => {
    expect(parseList('["AGENT_PAT"]')).toEqual(["AGENT_PAT"]);
    expect(parseList("[]")).toEqual([]);
    expect(parseList("")).toBeUndefined();

    const fresh = await check(await installed(), { ...healthy(), secrets: [], labels: [] });

    expect(fresh.code).toBe(1);
    expect(fresh.err).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(fresh.err).toContain("AGENT_PAT");
    expect(fresh.err).toContain("agent:implement");
  });

  /**
   * The same reasoning as every runner's `fail()`: a doctor run that is part of
   * a workflow has to leave its reason somewhere the `if: failure()` step can
   * put in front of a human.
   */
  it("writes its reasons where a workflow can read them", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) => text.replace(/^ *packages: read$/m, ""));

    await check(root, healthy());

    expect(fs.readFileSync(path.join(scratch, "failure_reason.txt"), "utf8")).toContain(
      "packages: read",
    );
  });

  it("is reachable as a subcommand and refuses a flag it does not know", async () => {
    expect(Object.keys(COMMANDS)).toContain("doctor");

    const { code, err } = await invoke(["doctor", "--fix"]);

    expect(code).toBe(2);
    expect(err).toContain("--fix");
  });
});
